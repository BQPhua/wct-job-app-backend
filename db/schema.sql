-- ============================================================================
-- WCT Job Application System — PostgreSQL schema
-- Target: Azure Database for PostgreSQL (Flexible Server), plain SQL only.
--
-- Migrated from a Supabase-based reference implementation. See the full
-- reverse-engineered spec this schema was derived from for section (§) refs
-- cited throughout this file (schema.sql comments reference spec §-numbers).
--
-- IMPORTANT — things intentionally NOT in this file, by design:
--   * No Supabase-specific features: no `auth.uid()`, no Row Level Security
--     policies, no `auth.users` table. Authentication and authorization are
--     handled entirely in the Node/Express API layer (see §3 of the spec).
--   * No reference-number generation logic (see `applications.reference_no`
--     below) — that logic lives in the API layer so it can be revised
--     without a schema migration (see §6.1 — format not finalized yet).
--   * No RPC-equivalent stored procedures — all business logic (patch/
--     coalesce semantics, status transitions, BU scoping, etc. — see §6.2)
--     is reimplemented in the API layer, once, generically.
-- ============================================================================

-- pgcrypto provides gen_random_uuid(), used as the default for every uuid
-- primary key below. This extension ships with Azure Database for
-- PostgreSQL Flexible Server and is allow-listed by default.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Reusable trigger function: bump `updated_at` to now() on every UPDATE.
-- Applied to every table below that has an `updated_at` column, instead of
-- reimplementing the same logic per table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- CANDIDATE ACCOUNTS
-- ============================================================================

-- `users` — candidate accounts. Replaces Supabase Auth (see spec §3.1) with
-- our own email+password auth AND Google/Microsoft OAuth sign-in, all
-- handled entirely in the API layer (password hashing, JWT issuance, ID-token
-- verification — see src/lib/oauthVerify.js, src/routes/auth.js — none of it
-- lives in the DB). `password_hash` is nullable because an OAuth-only
-- account (signed up via Google or Microsoft, never set a password) has no
-- password hash at all. `auth_provider`/`auth_subject` record which
-- identity provider created/owns a row and that provider's stable subject id
-- (Google `sub` / Microsoft `oid`) — see migration 003_oauth_login.sql.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text,
  full_name     text,
  auth_provider text NOT NULL DEFAULT 'password', -- 'password' | 'google' | 'microsoft'
  auth_subject  text, -- provider's stable subject id; NULL for 'password' rows
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users (email);
CREATE UNIQUE INDEX idx_users_auth_provider_subject
  ON users (auth_provider, auth_subject)
  WHERE auth_subject IS NOT NULL;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- COMPANIES / ENTITY DIRECTORY  (spec §2.2)
-- ============================================================================

-- `companies` — the entity/company directory that feeds the "assign to
-- company" dropdown on each application (rpc_admin_list_companies*,
-- rpc_admin_create_company / update / delete / assign — spec §1.5).
-- Ownership for BU-scoped admin CRUD is determined by `business_unit`.
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  category      text,  -- one of entity_categories.name, enforced at API layer
  business_unit text NOT NULL CHECK (business_unit IN ('E&C', 'Land', 'Mall')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_companies_business_unit ON companies (business_unit);
CREATE INDEX idx_companies_category ON companies (category);

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- APPLICATIONS  (spec §2.1 — the core candidate job-application record)
-- ============================================================================

-- `applications` — one row per candidate job application. Column list follows
-- spec §2.1 and is cross-checked against the CSV export header list in §2.5
-- (the single most authoritative "every field HR needs to see" source).
--
-- `status` lifecycle: see spec §6.4 for the full enumerated value list,
-- including legacy/historical values (`under_review`, `interview_scheduled`,
-- `offer_sent`, `withdrawn`) that are no longer HR-settable from the UI but
-- must remain valid for historical-data fidelity if existing rows are
-- migrated. Only {shortlisted, kiv, hired, offboarding, rejected,
-- blacklisted} are exposed as HR-initiated transitions in the API layer;
-- `offboarding` additionally requires creating the linked `exit_interviews`
-- row as a side effect (see spec §1.5 `rpc_admin_set_offboarding`).
CREATE TABLE applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),

  -- Reference number format CONFIRMED by the product owner (2026-09-11):
  -- `WCT-<BU>-<YYYY>-<seq>` (e.g. `WCT-EC-2026-000123`), generated by
  -- `generateReferenceNo(businessUnit)` in Node (src/lib/referenceNo.js),
  -- backed by a per-(business_unit, year) counter table — NOT a DB
  -- sequence/trigger, precisely so the format can be changed again without a
  -- schema migration.
  reference_no text NOT NULL UNIQUE,

  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'under_review', 'shortlisted',
    'interview_scheduled', 'offer_sent', 'withdrawn', 'kiv', 'hired',
    'offboarding', 'rejected', 'blacklisted'
  )),

  business_unit text NOT NULL CHECK (business_unit IN ('E&C', 'Land', 'Mall')),

  -- Which position/role the candidate is applying for. Free text (not an
  -- enum/FK) since open positions change far more often than this schema
  -- should. NOTE: this was removed on 2026-09-11 (migration 002) and
  -- reinstated on 2026-09-17 (migration 004) once the product owner asked
  -- for it back — candidate-set on the application form's first page,
  -- surfaced in the preview page, the exported PDF, and the admin
  -- dashboard/AI Insights. Distinct from `working_experience[].position`
  -- (candidate's own past-job titles) and `exit_interviews.position` (job
  -- title at time of exit) — those are unrelated fields.
  position_applying text,

  company_id  uuid REFERENCES companies (id),
  submitted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- ---- Personal particulars ----
  name_nric               text,
  alias                   text,
  permanent_address       text,
  permanent_postcode      text,
  correspondence_address  text,
  correspondence_postcode text,
  tel_residence           text,
  tel_office              text,
  mobile_phone            text,
  email                   text,
  place_of_birth          text,
  nric_new                text,  -- 12 digits, no dashes, Malaysians only
  passport_number         text,  -- non-Malaysians
  citizen                 text CHECK (citizen IN ('Malaysian', 'Non-Malaysian')),
  marital_status          text CHECK (marital_status IN ('Single', 'Married', 'Divorced', 'Widowed')),
  date_of_birth           date,  -- auto-derived from NRIC (spec §6.5), editable
  age                     integer,  -- client-computed but persisted (readonly derived field)
  bumiputra               text CHECK (bumiputra IN ('Yes', 'No')),
  race                    text,

  -- ---- Statutory (as collected on application — separate copy from onboarding's) ----
  epf_no             text,
  income_tax_no      text,
  tax_branch         text,
  socso_no           text,
  bank_account_no    text,
  cidb_green_card_no text,
  cidb_branch        text,  -- spec §9.3: no confirmed candidate input found; kept for CSV/legacy parity

  -- ---- Language / education / experience (arrays -> jsonb, spec §6.2 note 5:
  --      these are always sent/patched in full, never partially) ----
  language_ability   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{language, spoken, written}], spoken/written in Good|Fair|Slight|''
  education          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type, name, from_year, to_year, qualification, course_name}]
  working_experience jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{employer, from, to, is_current, position, remuneration, responsibilities}]

  -- ---- Employment questions ----
  resignation_notice_required text CHECK (resignation_notice_required IN ('Yes', 'No')),
  notice_period               text,
  date_available_to_start     date,
  expected_basic_salary       text,  -- free text (labelled "RM"), not numeric — matches reference implementation
  relatives_in_company        text,
  relatives_name               text,
  relatives_relationship       text,
  referral_person              text,
  referral_name                text,
  referral_department          text,
  own_transport_motorcar       text CHECK (own_transport_motorcar IN ('Yes', 'No')),
  own_transport_motorcycle     text CHECK (own_transport_motorcycle IN ('Yes', 'No')),
  willing_based_outside_klang_valley text CHECK (willing_based_outside_klang_valley IN ('Yes', 'No')),
  physical_defects              text,
  physical_defects_specify      text,
  arrested_convicted            text,
  arrested_convicted_specify    text,

  -- ---- Referees / declarations ----
  referee1 jsonb,  -- {name, designation, relationship, contact}
  referee2 jsonb,
  declaration_lawsuit               text,
  declaration_lawsuit_specify       text,
  declaration_other_matters         text,
  declaration_other_matters_specify text,

  -- ---- Attachments / consent ----
  profile_picture_url text,  -- required before Review step; Azure Blob Storage URL (spec §4)
  attachments          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, url, type, uploaded_at}]
  language_choice      text CHECK (language_choice IN ('BM', 'EN')),

  jts_agreed        boolean NOT NULL DEFAULT false,
  jts_agreed_name   text,
  jts_agreed_nric   text,
  jts_agreed_mobile text,
  jts_agreed_at     timestamptz,

  pdpa_agreed      boolean NOT NULL DEFAULT false,  -- gates submission (spec §1.1/§6.7)
  pdpa_agreed_name text,
  pdpa_agreed_nric text,
  pdpa_agreed_at   timestamptz
);

CREATE INDEX idx_applications_user_id ON applications (user_id);
CREATE INDEX idx_applications_status ON applications (status);
CREATE INDEX idx_applications_business_unit ON applications (business_unit);
CREATE INDEX idx_applications_reference_no ON applications (reference_no);
CREATE INDEX idx_applications_email ON applications (email);
CREATE INDEX idx_applications_company_id ON applications (company_id);
-- Composite index supporting the admin dashboard's common filter combo
-- (BU-scoped admin listing filtered/sorted by status) — spec §1.5 rpc_admin_search_applications.
CREATE INDEX idx_applications_business_unit_status ON applications (business_unit, status);

CREATE TRIGGER trg_applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- ONBOARDING RECORDS  (spec §2.3, §6.8 — 1:1 with a hired application)
-- ============================================================================

-- `onboarding_records` — reachable once an application's status = 'hired'.
-- 1:1 with `applications` via the unique `application_id`. Completion rule
-- (spec §2.3): `status` becomes 'completed' once personal_details_confirmed,
-- tp3_confirmed, and salary_crediting_confirmed are all true — enforced in
-- the API layer's equivalent of `rpc_confirm_onboarding_section`.
CREATE TABLE onboarding_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES applications (id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),

  -- Statutory details (separate copy from applications' own fields — can be
  -- updated post-hire during onboarding).
  epf_no             text,
  income_tax_no      text,
  tax_branch         text,
  socso_no           text,
  bank_account_no    text,
  cidb_green_card_no text,
  cidb_branch        text,

  -- Spouse
  spouse_name          text,
  spouse_nric          text,
  spouse_date_of_birth date,
  spouse_working       text CHECK (spouse_working IN ('Yes', 'No')),

  -- Children (dynamic tables -> jsonb arrays). course_name here is really an
  -- education-level enum: ''|'Kindergarten'|'Primary School'|
  -- 'Secondary School'|'College/University' — see spec §6.6 CHILD_EDUCATION_LEVELS.
  children_below_18 jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, gender, nric, date_of_birth, course_name, tax_relief}]
  children_18_to_23 jsonb NOT NULL DEFAULT '[]'::jsonb,  -- same shape; 18-23, unmarried & full-time student only

  emergency_contacts jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, relationship, contact}]

  beneficiary_name         text,
  beneficiary_relationship text,
  beneficiary_contact      text,

  -- Collected/structure never rendered in current candidate UI (step
  -- removed) but preserved for CSV export + confirmation-gating parity
  -- (spec §1.3).
  tp3_data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Salary Crediting Requisition Form (spec §6.8 step 4)
  salary_company     text CHECK (salary_company IN (
    'WCT Berhad', 'WCT Construction Sdn Bhd', 'WCT Machinery Sdn Bhd', 'Intraxis Engineering Sdn Bhd'
  )),
  salary_bank        text,
  salary_branch      text,  -- present in CSV export; no confirmed candidate input found (spec §9.3) — kept for parity
  salary_account_no  text,  -- auto-mirrors bank_account_no client-side until manually diverged (spec §6.5)
  salary_ic_submitted text,  -- defaults to nric_new or passport_number from the parent application

  personal_details_confirmed    boolean NOT NULL DEFAULT false,
  personal_details_confirmed_at timestamptz,
  tp3_confirmed                 boolean NOT NULL DEFAULT false,  -- auto-confirmed alongside personal_details, see spec §1.3
  tp3_confirmed_at              timestamptz,
  salary_crediting_confirmed    boolean NOT NULL DEFAULT false,
  salary_crediting_confirmed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_onboarding_records_application_id ON onboarding_records (application_id);
CREATE INDEX idx_onboarding_records_status ON onboarding_records (status);

CREATE TRIGGER trg_onboarding_records_updated_at
  BEFORE UPDATE ON onboarding_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- EXIT INTERVIEWS  (spec §2.4, §6.9 — 1:1 with an application once offboarding starts)
-- ============================================================================

-- `exit_interviews` — created as a side effect of the admin-only
-- 'offboarding' status transition (spec §1.5 rpc_admin_set_offboarding).
-- Sections A-C are filled/signed by the candidate; Section D (hr_signed_*)
-- is filled by HR and can only be completed after employee_signed = true.
CREATE TABLE exit_interviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES applications (id) ON DELETE CASCADE,

  -- Section A: Employee Details
  position           text,
  immediate_superior text,
  dept_site          text,
  date_joined        date,
  notice_period      text,
  official_last_day  date,
  actual_last_day    date,

  -- Section B: reasons (12 fixed checkboxes, spec §6.6 EXIT_REASONS_LEFT/RIGHT,
  -- + free-text "Others, specify") — stored as a jsonb array of the selected
  -- reason strings.
  reasons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasons_other_specify text,

  -- Section C: free-text comments
  comments text,

  -- Employee e-signature (checkbox + typed confirmation; no wet signature — spec §6.7/§6.9)
  employee_signed      boolean NOT NULL DEFAULT false,
  employee_signed_name text,  -- denormalized from applications.name_nric at signing time
  employee_signed_at   timestamptz,

  -- Section D: HR sign-off (admin-only)
  hr_signed          boolean NOT NULL DEFAULT false,
  hr_signed_name     text,
  hr_signed_position text,
  hr_signed_at       timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exit_interviews_application_id ON exit_interviews (application_id);
-- Supports rpc_admin_count_pending_exit_signatures-equivalent query
-- (employee_signed = true AND hr_signed = false), BU-scoped via a join to applications.
CREATE INDEX idx_exit_interviews_signed_flags ON exit_interviews (employee_signed, hr_signed);

CREATE TRIGGER trg_exit_interviews_updated_at
  BEFORE UPDATE ON exit_interviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- CANDIDATE BLACKLIST  (spec §1.1 rpc_check_blacklist, §2.6)
-- ============================================================================

-- `candidate_blacklist` — a dedicated table keyed by email, rather than a
-- boolean column bolted onto an auth table (we have no Supabase Auth table
-- to modify here — see task note). Checked at candidate login/boot time,
-- before any other data loads (spec §1.1, §3.1). Setting a candidate's
-- application status to 'blacklisted' (spec §6.4) should upsert a row here
-- with is_blacklisted = true as part of that same API-layer transaction.
CREATE TABLE candidate_blacklist (
  email           text PRIMARY KEY,
  is_blacklisted  boolean NOT NULL DEFAULT true,
  reason          text,
  blacklisted_at  timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_candidate_blacklist_is_blacklisted ON candidate_blacklist (is_blacklisted);

CREATE TRIGGER trg_candidate_blacklist_updated_at
  BEFORE UPDATE ON candidate_blacklist
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- ADMIN / AUTH TABLES  (spec §2.6, §3.2)
-- ============================================================================

-- `admin_users` — HR/admin identities, invited by email (spec §1.5
-- rpc_admin_invite_admin). `auth_user_id` links to the external identity
-- provider's subject/object id (Entra External ID `oid`, or equivalent) once
-- that person completes their first sign-in; stays NULL until then
-- ("linked" vs "not yet signed in" in the Admin Access UI, spec §1.5
-- rpc_admin_list_admins). Not an FK to `users` — admins and candidates are
-- separate identity spaces in this system.
CREATE TABLE admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,  -- expected @wct.my, enforced at API layer
  display_name  text,
  is_active     boolean NOT NULL DEFAULT true,
  auth_user_id  text,  -- external IdP subject id; NULL until first successful sign-in
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_users_email ON admin_users (email);
CREATE INDEX idx_admin_users_auth_user_id ON admin_users (auth_user_id);

CREATE TRIGGER trg_admin_users_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `admin_grants` — one row per role grant. A person can hold multiple
-- `bu_admin` grants (one per business unit) simultaneously (spec §1.5
-- rpc_admin_grant_role). `business_unit` is required for 'bu_admin' and
-- must be NULL for 'super_admin'. 'entity_admin' is defined per the spec as
-- a Phase 2 role placeholder — not implemented/enforced anywhere yet, but
-- the value is allowed here so the column isn't a migration blocker later.
CREATE TABLE admin_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('super_admin', 'bu_admin', 'entity_admin')),
  business_unit  text CHECK (business_unit IN ('E&C', 'Land', 'Mall')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_admin_grants_bu_matches_role CHECK (
    (role = 'super_admin' AND business_unit IS NULL) OR
    (role IN ('bu_admin', 'entity_admin') AND business_unit IS NOT NULL)
  )
);

CREATE INDEX idx_admin_grants_admin_user_id ON admin_grants (admin_user_id);
CREATE INDEX idx_admin_grants_business_unit ON admin_grants (business_unit);

CREATE TRIGGER trg_admin_grants_updated_at
  BEFORE UPDATE ON admin_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `admin_sessions` — backs the custom opaque `p_token` / adminToken model
-- (spec §1.5 rpc_admin_create_session, §3.2). `unit_scope` is 'ALL' for a
-- super admin acting session-wide, or a specific business unit chosen at
-- login time for a bu_admin. Every admin API call must independently
-- validate token liveness against `expires_at`.
CREATE TABLE admin_sessions (
  token         text PRIMARY KEY,  -- opaque server-issued session token
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  unit_scope    text NOT NULL CHECK (unit_scope IN ('ALL', 'E&C', 'Land', 'Mall')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_sessions_admin_user_id ON admin_sessions (admin_user_id);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions (expires_at);

CREATE TRIGGER trg_admin_sessions_updated_at
  BEFORE UPDATE ON admin_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `entity_categories` — controlled list of company/entity categories (spec
-- §2.6, §6.6), extensible by admins via "+ Add Entity". Seeded in seed.sql.
CREATE TABLE entity_categories (
  name       text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_entity_categories_updated_at
  BEFORE UPDATE ON entity_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `admin_unit_permissions` — the Business Unit permission matrix (spec §1.5
-- rpc_admin_get/save_permissions, §5.8, super-admin/All-Units only): which
-- business unit's admins may assign candidates to companies within a given
-- entity category. Composite key (category, unit_scope); a row's absence is
-- equivalent to granted = false (the API layer may choose to only store
-- granted rows, or all rows — either works against this schema).
CREATE TABLE admin_unit_permissions (
  category    text NOT NULL REFERENCES entity_categories (name) ON DELETE CASCADE,
  unit_scope  text NOT NULL CHECK (unit_scope IN ('E&C', 'Land', 'Mall')),
  granted     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (category, unit_scope)
);

CREATE INDEX idx_admin_unit_permissions_unit_scope ON admin_unit_permissions (unit_scope);

CREATE TRIGGER trg_admin_unit_permissions_updated_at
  BEFORE UPDATE ON admin_unit_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `admin_config` — legacy shared-passcode "break-glass" fallback backing
-- rpc_admin_login (spec §1.5, §3.2). Kept only so admin access isn't
-- silently lost if the Entra External ID integration ever breaks; not part
-- of the normal per-person login flow. Store a hash, never a plaintext
-- passcode. Expected to hold at most one row in practice.
CREATE TABLE admin_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passcode_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_admin_config_updated_at
  BEFORE UPDATE ON admin_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- `manager_settings` — per-business-unit manager notification email
-- addresses (spec §1.5 rpc_admin_get/update_settings, §2.6). Retired from
-- the current admin UI nav (notification recipients are now meant to be
-- derived live from `admin_grants` instead) but the table/columns are kept
-- for parity as a manual-override path. Expected to hold at most one row.
CREATE TABLE manager_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_email_ec   text,
  manager_email_mall text,
  manager_email_land text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_manager_settings_updated_at
  BEFORE UPDATE ON manager_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
