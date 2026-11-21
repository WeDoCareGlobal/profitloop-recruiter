-- ProfitLoop Recruiter Schema
-- Tables: jobs, candidates, applications, interviews, placements, clients

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT, -- 'engineering', 'sales', 'marketing', 'product', 'design', 'ops'
  seniority TEXT, -- 'junior', 'mid', 'senior', 'lead', 'principal', 'director', 'vp', 'c-level'
  employment_type TEXT DEFAULT 'full-time', -- 'full-time', 'part-time', 'contract', 'contract-to-hire'
  location TEXT, -- 'remote', 'hybrid', 'onsite', 'city, country'
  salary_min_usd INTEGER,
  salary_max_usd INTEGER,
  equity_range TEXT, -- '0.1-0.5%', '1-2%'
  required_skills TEXT, -- JSON array
  preferred_skills TEXT, -- JSON array
  description TEXT,
  status TEXT DEFAULT 'open', -- 'open', 'paused', 'filled', 'closed'
  priority INTEGER DEFAULT 1, -- 1=low, 5=urgent
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  filled_at DATETIME
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  linkedin_url TEXT,
  github_url TEXT,
  portfolio_url TEXT,
  current_role TEXT,
  current_company TEXT,
  years_experience INTEGER,
  skills TEXT, -- JSON array
  location TEXT,
  salary_expectation_usd INTEGER,
  equity_expectation TEXT,
  notice_period_weeks INTEGER,
  status TEXT DEFAULT 'new', -- 'new', 'screening', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'
  source TEXT, -- 'linkedin', 'referral', 'job_board', 'career_page', 'agency', 'outreach'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  cover_letter TEXT,
  resume_path TEXT, -- KV/R2 path
  status TEXT DEFAULT 'applied', -- 'applied', 'screening', 'phone_screen', 'technical', 'onsite', 'offer', 'hired', 'rejected', 'withdrawn'
  score REAL, -- 0-100 matching score
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  UNIQUE(job_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  round INTEGER NOT NULL, -- 1, 2, 3, 4
  type TEXT, -- 'phone', 'video', 'technical', 'takehome', 'onsite', 'culture'
  interviewer_id TEXT, -- internal employee ID
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'scheduled', -- 'scheduled', 'completed', 'cancelled', 'no_show'
  score INTEGER, -- 1-10
  feedback TEXT,
  recommendation TEXT, -- 'hire', 'no_hire', 'maybe'
  completed_at DATETIME,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE,
  job_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  start_date DATE NOT NULL,
  salary_usd INTEGER NOT NULL,
  equity_pct REAL,
  signing_bonus_usd INTEGER DEFAULT 0,
  fee_structure TEXT DEFAULT 'contingency', -- 'contingency', 'retained', 'contract'
  fee_percentage REAL DEFAULT 20.0,
  fee_amount_usd REAL,
  guarantee_period_days INTEGER DEFAULT 90,
  status TEXT DEFAULT 'placed', -- 'placed', 'guarantee_active', 'completed', 'refunded'
  placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL UNIQUE,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  industry TEXT,
  company_size TEXT, -- 'startup', 'smb', 'mid-market', 'enterprise'
  headquarters TEXT,
  preferred_fee_structure TEXT,
  fee_percentage REAL,
  status TEXT DEFAULT 'active', -- 'active', 'inactive', 'churned'
  total_placements INTEGER DEFAULT 0,
  total_fees_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews(application_id);
CREATE INDEX IF NOT EXISTS idx_placements_client ON placements(client_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

INSERT OR IGNORE INTO clients (company_name, contact_email, contact_name, industry, company_size, headquarters, preferred_fee_structure, fee_percentage) VALUES
('TechCorp Inc', 'hiring@techcorp.io', 'Sarah Chen', 'SaaS', 'mid-market', 'San Francisco, CA', 'contingency', 20.0),
('FinanceFlow', 'talent@financeflow.com', 'Marcus Johnson', 'FinTech', 'enterprise', 'New York, NY', 'retained', 25.0),
('CryptoVentures', 'people@cryptoventures.xyz', 'Alex Kim', 'Crypto', 'startup', 'Remote', 'contingency', 20.0);