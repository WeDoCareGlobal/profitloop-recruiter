const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function cached(env, key, ttl, fn) {
  const hit = await env.CACHE.get(key, { type: "json" }).catch(() => null);
  if (hit) return { ...hit, cache: "hit" };
  const fresh = await fn();
  await env.CACHE.put(key, JSON.stringify(fresh), { expirationTtl: ttl }).catch(() => {});
  return { ...fresh, cache: "miss" };
}

// Small models wrap JSON in ``` fences and get truncated at max_tokens, so a
// strict JSON.parse throws on perfectly usable output. Parse, then repair.
function repairJSON(s) {
  // drop trailing commas before } or ]
  let t = s.replace(/,\s*([}\]])/g, "$1");
  // close unterminated strings
  const strCount = (t.match(/(?<!\\)"/g) || []).length;
  if (strCount % 2 === 1) t += '"';
  // close unclosed brackets/braces, respecting those inside strings
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // drop a dangling key/value fragment before closing
  while (stack.length) {
    const open = stack.pop();
    const close = open === "{" ? "}" : "]";
    const tail = t.slice(-1);
    if (/[\d"}\]]/.test(tail)) t += close;
    else if (/[,{[]/.test(tail)) t = t.replace(/[,{[]\s*$/, "") + close;
    else t = t.replace(/[^\s]*$/, "") + close;
  }
  return t;
}

function parseJSON(text) {
  if (!text) return null;
  let t = text.replace(/^\s*```(?:json)?/gi, "").replace(/```\s*$/, "").trim();
  const start = t.search(/[{[]/);
  if (start === -1) return null;
  t = t.slice(start);
  try { return JSON.parse(t); } catch {}
  // progressive repair: cut trailing chars until it parses
  for (let i = t.length - 1; i > 0 && t.length - i < 4000; i--) {
    try { const v = JSON.parse(repairJSON(t.slice(0, i))); if (v && typeof v === "object") return v; }
    catch {}
  }
  return null;
}

// Workers AI models return two different shapes:
//   - legacy:   { response: "<text>", ... }
//   - OpenAI:   { choices: [ { message: { content: "<text>" } } ], ... }
// Normalise both so a model swap never silently yields empty strings.
function extractText(res) {
  if (!res) return "";
  if (typeof res.response === "string" && res.response.length) return res.response;
  if (typeof res.response === "object" && res.response !== null) {
    try { return JSON.stringify(res.response); } catch {}
  }
  const c = res.choices;
  if (Array.isArray(c) && c.length) {
    const m = c[0] && c[0].message;
    if (m && typeof m.content === "string" && m.content.length) return m.content;
    if (m && typeof m.reasoning_content === "string" && m.reasoning_content.length) return m.reasoning_content;
    if (typeof c[0].text === "string") return c[0].text;
  }
  try { return JSON.stringify(res); } catch { return ""; }
}

async function runAI(env, system, user, maxTokens = 3000) {
  const res = await env.AI.run(env.AI_MODEL || FALLBACK_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  });
  return extractText(res);
}

const RESOURCES = ["jobs", "candidates", "applications", "interviews", "placements", "clients"];
const ACTS = {"screen": {"system": "candidate screening", "task": ["Screen this candidate against the job requirements.", "Response JSON only: {\"match_score\":0.0,\"verdict\":\"strong_fit|possible|reject\",\"strengths\":[],\"gaps\":[],\"salary_alignment\":\"below|within|above\"}"]}, "jd": {"system": "job description generation", "task": ["Write a job description from this role spec.", "Response JSON only: {\"title\":\"\",\"summary\":\"\",\"responsibilities\":[],\"requirements\":[],\"nice_to_have\":[]}"]}};


// ================= Stripe (test mode) =================
// Creates a real Stripe Checkout Session against api.stripe.com. mode flips to
// "test" only after Stripe confirms session creation -- never optimistically.

function stripeSigTime(sig) { const m = /t=(\d+)/.exec(sig || ""); return m ? m[1] : ""; }
function stripeSigV1(sig)   { const m = /v1=([a-f0-9]+)/.exec(sig || ""); return m ? m[1] : ""; }
async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function requestOrigin(req) {
  try { return new URL(req.url).origin; } catch { return "https://example.invalid"; }
}
function safeEqual(a, b) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const ORIGIN = (() => { try { return new URL(SELF_URL).origin; } catch { return "https://__SLUG__.mz-817.workers.dev"; } })();

export default {
  async fetch(request, env, ctx) {
    const SELF_URL = request.url;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (path === "/" && method === "GET") {
      return json({
        loop: env.LOOP_NAME || "recruiter",
        version: "1.0.0",
        status: "operational",
        description: "Placement engine: job intake -> candidate screening -> interview -> placement with fee tracking.",
        mode: env.STRIPE_SECRET_KEY ? "test" : "paper",
        stripe: env.STRIPE_SECRET_KEY ? "configured" : "absent",
        resources: RESOURCES,
        actions: Object.keys(ACTS),
        endpoints: [
          "GET  /api/health",
          "GET  /api/stats",
          "GET  /api/ledger",
          "GET  /api/:resource",
          "POST /api/:resource",
          "POST /api/act/screen",
          "POST /api/act/jd",
        ],
      });
    }

    if (path === "/api/health" && method === "GET") {
      let db = "down", d1rows = null, kv = "down";
      try {
        const r = await env.DB.prepare("SELECT 1 AS ok").first();
        db = r && r.ok === 1 ? "up" : "degraded";
      } catch (e) { db = "error: " + String(e).slice(0, 160); }
      try { await env.CACHE.put("health:" + Date.now(), "1", { expirationTtl: 60 }); kv = "up"; }
      catch (e) { kv = "error: " + String(e).slice(0, 160); }
      try {
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM placements").first();
        d1rows = c ? c.n : null;
      } catch (e) {}
      const ok = db === "up";
      return json({
        status: ok ? "healthy" : "degraded",
        d1: db, kv, ai_binding: env.AI ? "present" : "missing",
        d1_rows_in_ledger: d1rows,
        uptime_note: "stateless worker; per-request execution",
        ts: new Date().toISOString(),
      }, ok ? 200 : 503);
    }

    if (path === "/api/stats" && method === "GET") {
      return json(await cached(env, "stats:v1", 300, async () => {
        const counts = {};
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first(); counts["jobs"] = c ? c.n : 0; } catch (e) { counts["jobs"] = "err"; }
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates").first(); counts["candidates"] = c ? c.n : 0; } catch (e) { counts["candidates"] = "err"; }
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first(); counts["applications"] = c ? c.n : 0; } catch (e) { counts["applications"] = "err"; }
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM interviews").first(); counts["interviews"] = c ? c.n : 0; } catch (e) { counts["interviews"] = "err"; }
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM placements").first(); counts["placements"] = c ? c.n : 0; } catch (e) { counts["placements"] = "err"; }
        try { const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM clients").first(); counts["clients"] = c ? c.n : 0; } catch (e) { counts["clients"] = "err"; }
        return { counts, money_metric: "fee_usd", money_source: "placements" };
      }));
    }

    if (path === "/api/ledger" && method === "GET") {
      try {
        const r = await env.DB.prepare(
          "SELECT COALESCE(SUM(fee_usd),0) AS total, COUNT(*) AS entries FROM placements"
        ).first();
        const g = await env.DB.prepare(
          "SELECT job_id AS k, COALESCE(SUM(fee_usd),0) AS v FROM placements GROUP BY job_id ORDER BY v DESC LIMIT 25"
        ).all();
        return json({ total_usd: (r && r.total) || 0, entries: (r && r.entries) || 0, by_job_id: (g.results || []), note: "simulated paper ledger" });
      } catch (e) {
        return json({ error: "ledger_unavailable", detail: String(e).slice(0, 200), total_usd: 0, entries: 0 }, 500);
      }
    }

    const actMatch = path.match(/^\/api\/act\/([a-z_]+)$/);
    if (actMatch && method === "POST") {
      const key = actMatch[1];
      const spec = ACTS[key];
      if (!spec) return json({ error: "unknown_action", key, available: Object.keys(ACTS) }, 404);
      let body = {};
      try { body = await request.json(); } catch {}
      const payload = body.input !== undefined ? body.input : body;
      const cacheKey = "v3:" + key + ":" + (await sha(JSON.stringify(payload))).slice(0, 32);
      const cachedHit = await env.CACHE.get(cacheKey, { type: "json" }).catch(() => null);
      if (cachedHit) return json({ action: key, result: cachedHit.result, cached: true, simulated: true });
      let raw = "";
      try { raw = await runAI(env, spec.system, spec.task + "\n\nINPUT:\n" + JSON.stringify(payload)); }
      catch (e) { return json({ action: key, error: "ai_failed", detail: String(e).slice(0, 200) }, 502); }
      const parsed = parseJSON(raw);
      await env.CACHE.put(cacheKey, JSON.stringify({ result: parsed, raw: raw.slice(0, 2000) }), { expirationTtl: 3600 }).catch(() => {});
      return json({ action: key, result: parsed, raw_if_unparsed: parsed ? undefined : raw.slice(0, 1200), cached: false, simulated: true, model: env.AI_MODEL || FALLBACK_MODEL });
    }

    const parts = path.split("/").filter(Boolean);
    const resource = parts[0] === "api" ? parts[1] : null;
    const id = parts[0] === "api" ? parts[2] : null;
    if (resource && RESOURCES.includes(resource)) {
      if (method === "GET") {
        try {
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
          const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
          if (id) {
            const row = await env.DB.prepare("SELECT * FROM " + resource + " WHERE id = ?").bind(id).first();
            return row ? json({ [resource]: row }) : json({ error: "not_found" }, 404);
          }
          const r = await env.DB.prepare("SELECT * FROM " + resource + " ORDER BY id DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
          return json({ [resource]: r.results || [], count: (r.results || []).length, limit, offset });
        } catch (e) { return json({ error: "query_failed", detail: String(e).slice(0, 200) }, 500); }
      }
      if (method === "POST") {
        let body = {};
        try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
        const keys = Object.keys(body).filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (!keys.length) return json({ error: "no_valid_fields" }, 400);
        const vals = keys.map(k => body[k]);
        const sql = "INSERT INTO " + resource + " (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")";
        try {
          const r = await env.DB.prepare(sql).bind(...vals).run();
          const row = await env.DB.prepare("SELECT * FROM " + resource + " WHERE id = ?").bind(r.meta.last_row_id).first();
          return json({ created: true, [resource]: row }, 201);
        } catch (e) { return json({ error: "insert_failed", detail: String(e).slice(0, 250) }, 500); }
      }
      return json({ error: "method_not_allowed" }, 405);
    }


    // ---- POST /api/checkout ----
    if (path === "/api/checkout" && method === "POST") {
      if (!env.STRIPE_SECRET_KEY) {
        return json({ error: "stripe_not_configured", mode: "paper", hint: "STRIPE_SECRET_KEY secret missing" }, 503);
      }
      let body = {};
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const amountUsd = Number(body.amount_usd);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) return json({ error: "amount_usd_required" }, 400);
      const cents = Math.round(amountUsd * 100);
      const reference = String(body.reference || "placements:" + (body.resource_id || "adhoc")).slice(0, 180);

      try {
        const p = new URLSearchParams();
        p.set("mode", "payment");
        p.set("client_reference_id", reference);
        p.set("success_url", requestOrigin(request) + "/?paid=1&ref=" + encodeURIComponent(reference));
        p.set("cancel_url", requestOrigin(request) + "/?cancelled=1");
        p.append("line_items[0][quantity]", "1");
        p.append("line_items[0][price_data][currency]", "usd");
        p.append("line_items[0][price_data][unit_amount]", String(cents));
        p.append("line_items[0][price_data][product_data][name]", String(body.name || "Recruiter - placement fee").slice(0, 180));
        p.append("line_items[0][price_data][product_data][description]", "Placement service fee");
        p.append("metadata[loop]", "recruiter");
        p.append("metadata[reference]", reference);
        p.append("metadata[resource_id]", String(body.resource_id || ""));

        const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
          body: p.toString(),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "stripe_api_error", detail: j.error || j, mode: "paper" }, 502);
        return json({
          created: true, mode: "test", checkout_url: j.url, session_id: j.id,
          amount_usd: amountUsd, reference, expires_at: j.expires_at,
        }, 201);
      } catch (e) {
        return json({ error: "stripe_unreachable", detail: String(e).slice(0, 200), mode: "paper" }, 502);
      }
    }

    // ---- POST /api/stripe/webhook ----
    if (path === "/api/stripe/webhook" && method === "POST") {
      const payload = await request.text();
      const sig = request.headers.get("stripe-signature") || "";
      if (!env.STRIPE_WEBHOOK_SECRET) {
        return json({ error: "webhook_not_configured", rejected: true,
          hint: "Set STRIPE_WEBHOOK_SECRET (stripe listen --forward-to <this url>)" }, 503);
      }
      const t = stripeSigTime(sig), v1 = stripeSigV1(sig);
      if (!t || !v1) return json({ error: "signature_header_malformed", rejected: true }, 400);
      if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return json({ error: "signature_expired", rejected: true }, 400);
      // Stripe signs `${timestamp}.${payload}` -- timestamp FIRST.
      // Signing payload+"."+timestamp yields a mismatch that silently
      // rejects every real delivery.
      const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + payload);
      if (!safeEqual(v1, expected)) return json({ error: "signature_invalid", rejected: true }, 400);

      let evt; try { evt = JSON.parse(payload); } catch { return json({ error: "bad_payload" }, 400); }
      const ledger = [];
      if (evt.type === "checkout.session.completed") {
        const s = (evt.data && evt.data.object) || {};
        const md = s.metadata || {};
        // NOT NULL columns must all be supplied; a missing one aborts the whole
        // insert, so this is explicit per loop rather than best-effort.
        try {
          const ins = await env.DB.prepare(
            "INSERT INTO placements (application_id, job_id, candidate_id, client_id, start_date, salary_usd, fee_amount_usd, status) VALUES (?, ?, ?, ?, CURRENT_DATE, 0, ?, 'placed')"
          ).bind(Number(md.application_id) || Math.floor(Math.random()*1e9), Number(md.resource_id) || 0, Number(md.candidate_id) || 0, md.client || 'stripe_client', (s.amount_total || 0) / 100).run();
          ledger.push({ loop: "recruiter", table: "placements", ok: true, id: ins.meta && ins.meta.last_row_id });
        } catch (e) {
          // Surface the failure instead of reporting a payment that never landed.
          ledger.push({ loop: "recruiter", table: "placements", ok: false, error: String(e).slice(0, 200) });
        }
        // 10% foundation split, per the org ledger convention
        try {
          await env.DB.prepare(
            "INSERT INTO placements (application_id, job_id, candidate_id, client_id, start_date, salary_usd, fee_amount_usd, status) VALUES (?, ?, ?, ?, CURRENT_DATE, 0, ?, 'placed')"
          ).bind(Number(md.application_id) || Math.floor(Math.random()*1e9), Number(md.resource_id) || 0, Number(md.candidate_id) || 0, md.client || 'stripe_client', (s.amount_total || 0) / 100 * 0.10).run();
          ledger.push({ loop: "recruiter", table: "foundation_10pct", ok: true });
        } catch (e) {
          ledger.push({ loop: "recruiter", table: "foundation_10pct", ok: false, error: String(e).slice(0, 160) });
        }
        const failed = ledger.filter((x) => !x.ok);
        return json({
          received: true, type: evt.type, session_id: s.id,
          amount_usd: (s.amount_total || 0) / 100,
          ledger_written: failed.length === 0,
          ledger, mode: failed.length === 0 ? "test" : "test_with_ledger_errors",
        }, failed.length === 0 ? 200 : 207);
      }
      return json({ received: true, type: evt.type });
    }

    return json({ error: "not_found", path, hint: "GET / for endpoint map" }, 404);
  }
};
