-- ============================================================================
-- Migration 005: Offboarding module (merge of the WCT Offboarding System).
--
-- Context (product owner instruction, 2026-09-30): offboarding is no longer
-- triggered by setting a job application's status to 'offboarding'. It
-- becomes a standalone, invite-driven module in the admin dashboard: HR
-- invites an employee by email → the employee submits the Exit Interview →
-- six departments clear them (Reporting Unit, IT, Administration, Finance,
-- Purchasing, Human Resources) → the employee acknowledges → the Payroll PIC
-- marks payroll done. Department checklists and the 12 resignation reasons
-- come from Qurratu's prototype (wct_offboarding_export.sql, 2026-09-29).
-- Design: docs/superpowers/specs/2026-09-30-offboarding-merge-design.md
--
-- What this file does, in ONE transaction:
--   1. Reference tables + seed (departments, 45 checklist template items).
--   2. Case tables (cases, exit interviews, clearance sections/items,
--      reminder log, activity timeline).
--   3. admin_grants: adds 'payroll_pic' and 'clearance_pic' roles and a
--      department_id column.
--   4. Moves every existing exit interview into a new offboarding case
--      (answers + signatures kept), sets those applications back to
--      'hired', removes 'offboarding' from the application status list and
--      renames exit_interviews → legacy_exit_interviews as a backup.
--
-- Safe to run more than once. Run it the same way as 004, e.g. in Azure
-- Cloud Shell:
--   psql "host=<PGHOST> dbname=<PGDATABASE> user=<PGUSER> sslmode=require" -f 005_offboarding_module.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clearance_departments (
  id                int PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  display_order     int  NOT NULL,
  is_reporting_unit boolean NOT NULL DEFAULT false
);

INSERT INTO clearance_departments (id, name, display_order, is_reporting_unit) VALUES
  (1, 'Reporting Unit', 1, true),
  (2, 'IT', 2, false),
  (3, 'Administration', 3, false),
  (4, 'Finance', 4, false),
  (5, 'Purchasing', 5, false),
  (6, 'Human Resources', 6, false)
ON CONFLICT (id) DO NOTHING;

-- "Others" items are free-text slots the PIC can fill in (is_other = true).
CREATE TABLE IF NOT EXISTS clearance_checklist_templates (
  id            int PRIMARY KEY,
  department_id int NOT NULL REFERENCES clearance_departments (id),
  item_text     text NOT NULL,
  display_order int NOT NULL,
  is_other      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_clearance_templates_department ON clearance_checklist_templates (department_id, display_order);

INSERT INTO clearance_checklist_templates (id, department_id, item_text, display_order, is_other) VALUES
  (1, 1, 'Resignee to fill up Exit Clearance Form for HR', 1, false),
  (2, 1, 'List of important contacts', 2, false),
  (3, 1, 'Location of records', 3, false),
  (4, 1, 'Status report of ongoing projects', 4, false),
  (5, 1, 'List of outstanding tasks', 5, false),
  (6, 1, 'Keys for drawers / cupboards', 6, false),
  (7, 1, 'Claims & Allowances', 7, false),
  (8, 1, 'Others', 8, true),
  (9, 1, 'Others', 9, true),
  (10, 1, 'Others', 10, true),
  (11, 2, 'Revoke employee''s system access & email', 1, false),
  (12, 2, 'Update directory & organisation chart (Outlook Property)', 2, false),
  (13, 2, 'Update company website (if any)', 3, false),
  (14, 2, 'Redirect emails', 4, false),
  (15, 2, 'Laptop/Desktop & peripherals', 5, false),
  (16, 2, 'Others', 6, true),
  (17, 2, 'Others', 7, true),
  (18, 2, 'Others', 8, true),
  (19, 3, 'Revoke employee''s access to office/building', 1, false),
  (20, 3, 'Employee''s staff id', 2, false),
  (21, 3, 'Update/Redirect phone calls & update telephone directory', 3, false),
  (22, 3, 'SIM Card for Mobile phone', 4, false),
  (23, 3, 'Season Parking Card', 5, false),
  (24, 3, 'Uniforms', 6, false),
  (25, 3, 'Toll and fuel card', 7, false),
  (26, 3, 'Motor Vehicle Key', 8, false),
  (27, 3, 'Traffic Summons /Fines', 9, false),
  (28, 3, 'Others', 10, true),
  (29, 3, 'Others', 11, true),
  (30, 3, 'Others', 12, true),
  (31, 4, 'Petty Cash (if any)', 1, false),
  (32, 4, 'Others', 2, true),
  (33, 4, 'Others', 3, true),
  (34, 4, 'Others', 4, true),
  (35, 5, 'Survey Equipment', 1, false),
  (36, 5, 'Handphone', 2, false),
  (37, 5, 'Radiophone/Walkie-talkie', 3, false),
  (38, 5, 'Others', 4, true),
  (39, 5, 'Others', 5, true),
  (40, 5, 'Others', 6, true),
  (41, 6, 'Return of medical card', 1, false),
  (42, 6, 'Exit interview questionnaire', 2, false),
  (43, 6, 'Others', 3, true),
  (44, 6, 'Others', 4, true),
  (45, 6, 'Others', 5, true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Case tables
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS offboarding_ref_seq;

CREATE TABLE IF NOT EXISTS offboarding_cases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no                      text NOT NULL UNIQUE,
  -- One-time secret in the invite link; proves the person opening the case
  -- received the invite email (password accounts don't verify their email).
  invite_token                text NOT NULL UNIQUE,
  employee_email              text NOT NULL,  -- always stored lower-case
  employee_name               text NOT NULL,
  employee_user_id            uuid REFERENCES users (id) ON DELETE SET NULL,
  application_id              uuid REFERENCES applications (id) ON DELETE SET NULL,
  business_unit               text NOT NULL CHECK (business_unit IN ('E&C', 'Land', 'Mall')),
  company_name                text,
  department                  text,
  position                    text,
  date_joined                 date,
  immediate_superior_name     text,
  immediate_superior_email    text,
  notice_period_days          int CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
  official_last_day           date,
  actual_last_day             date,
  status                      text NOT NULL DEFAULT 'invited' CHECK (status IN (
                                'invited', 'clearance_in_progress', 'pending_acknowledgement',
                                'pending_payroll', 'completed', 'cancelled')),
  invited_by_email            text NOT NULL,
  invited_at                  timestamptz NOT NULL DEFAULT now(),
  submitted_at                timestamptz,
  acknowledged_at             timestamptz,
  acknowledged_signature_name text,
  payroll_completed_at        timestamptz,
  payroll_completed_by_email  text,
  payroll_remarks             text,
  cancelled_at                timestamptz,
  cancelled_by_email          text,
  cancel_reason               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offboarding_cases_bu_status ON offboarding_cases (business_unit, status);
CREATE INDEX IF NOT EXISTS idx_offboarding_cases_email ON offboarding_cases (lower(employee_email));
CREATE INDEX IF NOT EXISTS idx_offboarding_cases_last_day ON offboarding_cases ((COALESCE(actual_last_day, official_last_day)));
DROP TRIGGER IF EXISTS trg_offboarding_cases_updated_at ON offboarding_cases;
CREATE TRIGGER trg_offboarding_cases_updated_at BEFORE UPDATE ON offboarding_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS offboarding_exit_interviews (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                  uuid NOT NULL UNIQUE REFERENCES offboarding_cases (id) ON DELETE CASCADE,
  reasons                  jsonb NOT NULL DEFAULT '[]'::jsonb, -- subset of the 12 standard reasons
  reasons_other            text[] NOT NULL DEFAULT '{}',       -- employee's own reasons
  comments                 text,
  employee_signature_name  text,
  employee_signed_at       timestamptz,
  hr_signed_name           text,
  hr_signed_position       text,
  hr_signed_at             timestamptz,
  hr_comments              text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_offboarding_exit_interviews_updated_at ON offboarding_exit_interviews;
CREATE TRIGGER trg_offboarding_exit_interviews_updated_at BEFORE UPDATE ON offboarding_exit_interviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS offboarding_clearance_sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES offboarding_cases (id) ON DELETE CASCADE,
  department_id     int  NOT NULL REFERENCES clearance_departments (id),
  -- Set for the Reporting Unit section when HR gave the immediate superior's
  -- email: that person (who may hold no admin grant at all) signs it.
  assignee_email    text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
  signed_by_email   text,
  signed_by_name    text,
  signed_at         timestamptz,
  signed_on_behalf  boolean NOT NULL DEFAULT false,
  last_reminded_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_offboarding_sections_assignee ON offboarding_clearance_sections (lower(assignee_email));
DROP TRIGGER IF EXISTS trg_offboarding_sections_updated_at ON offboarding_clearance_sections;
CREATE TRIGGER trg_offboarding_sections_updated_at BEFORE UPDATE ON offboarding_clearance_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Item text is copied from the template when the section is created, so a
-- later template edit never rewrites an old case's signed checklist.
CREATE TABLE IF NOT EXISTS offboarding_clearance_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id       uuid NOT NULL REFERENCES offboarding_clearance_sections (id) ON DELETE CASCADE,
  template_item_id int REFERENCES clearance_checklist_templates (id) ON DELETE SET NULL,
  item_text        text NOT NULL,
  is_other         boolean NOT NULL DEFAULT false,
  custom_text      text,
  is_checked       boolean NOT NULL DEFAULT false,
  remarks          text,
  display_order    int NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offboarding_items_section ON offboarding_clearance_items (section_id, display_order);
DROP TRIGGER IF EXISTS trg_offboarding_items_updated_at ON offboarding_clearance_items;
CREATE TRIGGER trg_offboarding_items_updated_at BEFORE UPDATE ON offboarding_clearance_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Only written after Power Automate accepted the reminder (2xx), so a failed
-- send is retried by the next daily run instead of being lost.
CREATE TABLE IF NOT EXISTS offboarding_reminder_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES offboarding_cases (id) ON DELETE CASCADE,
  department_id int  NOT NULL REFERENCES clearance_departments (id),
  days_before   int  NOT NULL CHECK (days_before IN (7, 3)),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, department_id, days_before)
);

CREATE TABLE IF NOT EXISTS offboarding_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES offboarding_cases (id) ON DELETE CASCADE,
  actor_email text,
  actor_role  text,
  event_type  text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offboarding_events_case ON offboarding_events (case_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. New staff roles on admin_grants
-- ---------------------------------------------------------------------------
ALTER TABLE admin_grants ADD COLUMN IF NOT EXISTS department_id int REFERENCES clearance_departments (id);
ALTER TABLE admin_grants DROP CONSTRAINT IF EXISTS admin_grants_role_check;
ALTER TABLE admin_grants ADD CONSTRAINT admin_grants_role_check
  CHECK (role IN ('super_admin', 'bu_admin', 'entity_admin', 'payroll_pic', 'clearance_pic'));
ALTER TABLE admin_grants DROP CONSTRAINT IF EXISTS chk_admin_grants_bu_matches_role;
ALTER TABLE admin_grants ADD CONSTRAINT chk_admin_grants_bu_matches_role CHECK (
  (role = 'super_admin' AND business_unit IS NULL AND department_id IS NULL) OR
  (role IN ('bu_admin', 'entity_admin', 'payroll_pic') AND business_unit IS NOT NULL AND department_id IS NULL) OR
  (role = 'clearance_pic' AND business_unit IS NOT NULL AND department_id IS NOT NULL)
);
-- A person can't hold the same role twice in the same scope. Exact
-- duplicate grants (same person, role, BU) are redundant, so any that
-- already exist are collapsed to one before the unique index is built.
DELETE FROM admin_grants g
 USING admin_grants keep
 WHERE g.admin_user_id = keep.admin_user_id
   AND g.role = keep.role
   AND COALESCE(g.business_unit, '') = COALESCE(keep.business_unit, '')
   AND COALESCE(g.department_id, 0) = COALESCE(keep.department_id, 0)
   AND (g.created_at, g.id) > (keep.created_at, keep.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_grants_role_scope
  ON admin_grants (admin_user_id, role, COALESCE(business_unit, ''), COALESCE(department_id, 0));

-- ---------------------------------------------------------------------------
-- 4. Move the old status-driven offboarding into cases
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  new_case uuid;
  sec record;
  np text;
  notice_days int;
BEGIN
  IF to_regclass('public.exit_interviews') IS NULL THEN
    RETURN;  -- already migrated
  END IF;

  FOR r IN
    SELECT ei.*, a.user_id, a.email AS app_email, a.name_nric, a.business_unit AS app_bu,
           a.position_applying, a.id AS app_id
      FROM exit_interviews ei
      JOIN applications a ON a.id = ei.application_id
     WHERE NOT EXISTS (SELECT 1 FROM offboarding_cases c WHERE c.application_id = a.id)
     ORDER BY ei.created_at
  LOOP
    -- The old form's notice period was free text ("30 days", "1 month" ...).
    -- Convert only unambiguous values to days; anything else becomes NULL
    -- (the original text is kept on the migrated case's timeline event).
    np := lower(trim(COALESCE(r.notice_period, '')));
    notice_days := CASE
      WHEN np ~ '^\d{1,4}\s*(d|day|days)?$' THEN substring(np FROM '^\d{1,4}')::int
      WHEN np ~ '^\d{1,2}\s*(w|wk|wks|week|weeks)$' THEN substring(np FROM '^\d{1,2}')::int * 7
      WHEN np ~ '^\d{1,2}\s*(m|mth|mths|month|months)$' THEN substring(np FROM '^\d{1,2}')::int * 30
      ELSE NULL
    END;

    INSERT INTO offboarding_cases (
      ref_no, invite_token, employee_email, employee_name, employee_user_id, application_id,
      business_unit, department, position, date_joined, immediate_superior_name,
      notice_period_days, official_last_day, actual_last_day, status, invited_by_email,
      invited_at, submitted_at)
    VALUES (
      'OFF-' || to_char(COALESCE(r.created_at, now()) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY') || '-' ||
        lpad(nextval('offboarding_ref_seq')::text, 4, '0'),
      -- 64 hex chars from two gen_random_uuid() values (core PostgreSQL,
      -- strong randomness) — pgcrypto's gen_random_bytes isn't enabled on
      -- the Azure server.
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      lower(COALESCE(r.app_email, 'unknown+' || r.app_id || '@invalid')),
      COALESCE(NULLIF(r.name_nric, ''), 'Unknown'),
      r.user_id, r.app_id, r.app_bu, r.dept_site,
      COALESCE(NULLIF(r.position, ''), r.position_applying), r.date_joined, r.immediate_superior,
      notice_days,
      r.official_last_day, r.actual_last_day,
      CASE WHEN r.employee_signed THEN 'clearance_in_progress' ELSE 'invited' END,
      'migration', COALESCE(r.created_at, now()),
      CASE WHEN r.employee_signed THEN r.employee_signed_at END)
    RETURNING id INTO new_case;

    INSERT INTO offboarding_exit_interviews (
      case_id, reasons, reasons_other, comments, employee_signature_name, employee_signed_at,
      hr_signed_name, hr_signed_position, hr_signed_at)
    VALUES (
      new_case, COALESCE(r.reasons, '[]'::jsonb),
      CASE WHEN NULLIF(r.reasons_other_specify, '') IS NULL THEN '{}'::text[] ELSE ARRAY[r.reasons_other_specify] END,
      r.comments,
      CASE WHEN r.employee_signed THEN r.employee_signed_name END,
      CASE WHEN r.employee_signed THEN r.employee_signed_at END,
      CASE WHEN r.hr_signed THEN r.hr_signed_name END,
      CASE WHEN r.hr_signed THEN r.hr_signed_position END,
      CASE WHEN r.hr_signed THEN r.hr_signed_at END);

    IF r.employee_signed THEN
      FOR sec IN SELECT id FROM clearance_departments ORDER BY display_order LOOP
        WITH s AS (
          INSERT INTO offboarding_clearance_sections (case_id, department_id)
          VALUES (new_case, sec.id) RETURNING id
        )
        INSERT INTO offboarding_clearance_items (section_id, template_item_id, item_text, is_other, display_order)
        SELECT s.id, t.id, t.item_text, t.is_other, t.display_order
          FROM s, clearance_checklist_templates t
         WHERE t.department_id = sec.id;
      END LOOP;
    END IF;

    INSERT INTO offboarding_events (case_id, actor_email, actor_role, event_type, detail)
    VALUES (new_case, 'migration', 'system', 'invited',
            jsonb_build_object('migrated', true, 'legacy_application_id', r.app_id,
                               'legacy_notice_period', r.notice_period));
  END LOOP;

  UPDATE applications SET status = 'hired' WHERE status = 'offboarding';
  ALTER TABLE exit_interviews RENAME TO legacy_exit_interviews;
END $$;

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK (status IN (
  'draft', 'submitted', 'under_review', 'shortlisted',
  'interview_scheduled', 'offer_sent', 'withdrawn', 'kiv', 'hired',
  'rejected', 'blacklisted'
));

COMMIT;
