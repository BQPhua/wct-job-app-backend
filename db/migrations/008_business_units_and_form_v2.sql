-- ============================================================================
-- 008 — Business units become a managed list + application form v2
--       (stakeholder feedback, 14 Oct 2026)
--
--   1. business_units: the list of business units now lives in a table that
--      Super Admins manage from Business Unit Settings, instead of being
--      hard-coded as ('E&C', 'Land', 'Mall') in CHECK constraints. The old
--      entity categories become business units in their own right:
--        code       name                   reference prefix
--        E&C        E&C                    WCT-EC-
--        Land       Property Development   WCT-LAND-   (code kept: old links/data)
--        Mall       Malls Management       WCT-MALL-   (code kept: old links/data)
--        REIT       REIT                   WCT-REIT-
--        Aviation   Aviation               WCT-AV-
--        F&B        F&B                    WCT-FNB-
--        Hotels     Hotels                 WCT-HTL-
--      Every table's business_unit CHECK becomes a foreign key to
--      business_units(code) (ON UPDATE CASCADE).
--   2. Companies filed under an entity category move to the matching
--      business unit, and the companies named in the stakeholder feedback
--      are added if missing.
--   3. Payroll PIC can be granted per business unit again (business_unit
--      NULL still means "all business units").
--   4. applications: two-line addresses (+ city/state), "no previous
--      working experience", and spouse/children details (moved here from
--      onboarding; optional for the candidate).
--   5. onboarding_records: the typed digital-signature name for each
--      confirmation; salary_company is no longer limited to 4 E&C names.
--
-- Additive, keeps every existing value, and safe to run more than once:
-- the seed data (units, PIC emails, company moves/additions) is applied only
-- on the first run, so a re-run never undoes changes made in the admin
-- dashboard afterwards.
-- ============================================================================
BEGIN;

-- Remember whether this is the first run (business_units not created yet).
CREATE TEMP TABLE m008_run ON COMMIT DROP AS
  SELECT to_regclass('business_units') IS NULL AS first_run;

-- ---------------------------------------------------------------------------
-- 1. business_units
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_units (
  code       text PRIMARY KEY,               -- stored on every row; used in ?bu= links
  name       text NOT NULL,                  -- what people see
  ref_code   text NOT NULL,                  -- WCT-<ref_code>-<year>-<seq>
  pic_email  text,                           -- designated PIC: new-application emails
  sort_order integer NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true,  -- inactive: hidden from candidates and pickers
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_business_units_code CHECK (code ~ '^[A-Za-z0-9&]{1,20}$'),
  CONSTRAINT chk_business_units_ref_code CHECK (ref_code ~ '^[A-Z0-9]{2,8}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_units_name ON business_units (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_units_ref_code ON business_units (ref_code);

DROP TRIGGER IF EXISTS trg_business_units_updated_at ON business_units;
CREATE TRIGGER trg_business_units_updated_at
  BEFORE UPDATE ON business_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO business_units (code, name, ref_code, sort_order)
SELECT * FROM (VALUES
  ('E&C',      'E&C',                  'EC',   10),
  ('Land',     'Property Development', 'LAND', 20),
  ('Mall',     'Malls Management',     'MALL', 30),
  ('REIT',     'REIT',                 'REIT', 40),
  ('Aviation', 'Aviation',             'AV',   50),
  ('F&B',      'F&B',                  'FNB',  60),
  ('Hotels',   'Hotels',               'HTL',  70)
) AS seed
WHERE (SELECT first_run FROM m008_run)
ON CONFLICT (code) DO NOTHING;

-- Carry over any manager notification addresses already configured.
DO $$
DECLARE ms record;
BEGIN
  IF (SELECT first_run FROM m008_run) AND to_regclass('manager_settings') IS NOT NULL THEN
    SELECT * INTO ms FROM manager_settings ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      UPDATE business_units SET pic_email = ms.manager_email_ec   WHERE code = 'E&C'  AND pic_email IS NULL AND ms.manager_email_ec   <> '';
      UPDATE business_units SET pic_email = ms.manager_email_land WHERE code = 'Land' AND pic_email IS NULL AND ms.manager_email_land <> '';
      UPDATE business_units SET pic_email = ms.manager_email_mall WHERE code = 'Mall' AND pic_email IS NULL AND ms.manager_email_mall <> '';
    END IF;
  END IF;
END $$;

-- Drop every hard-coded business-unit CHECK (E&C/Land/Mall), whatever it is
-- called, plus the fixed salary-company list.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid::regclass::text IN ('companies', 'applications', 'admin_grants', 'admin_sessions',
                                        'admin_unit_permissions', 'offboarding_cases', 'onboarding_records')
       AND (pg_get_constraintdef(oid) LIKE '%''Land''%' OR pg_get_constraintdef(oid) LIKE '%''WCT Berhad''%')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- Foreign keys to the managed list.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'applications', 'admin_grants', 'offboarding_cases'] LOOP
    IF to_regclass(t) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || t || '_business_unit'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (business_unit) REFERENCES business_units (code) ON UPDATE CASCADE',
        t, 'fk_' || t || '_business_unit');
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Companies: entity category -> business unit, plus the missing companies
-- ---------------------------------------------------------------------------
UPDATE companies SET business_unit = m.bu
  FROM (VALUES ('E&C', 'E&C'), ('Property', 'Land'), ('Malls', 'Mall'), ('REIT', 'REIT'),
               ('Aviation', 'Aviation'), ('F&B', 'F&B'), ('Hotel', 'Hotels'), ('Hotels', 'Hotels')) AS m(category, bu)
 WHERE lower(companies.category) = lower(m.category)
    AND companies.business_unit <> m.bu
   AND (SELECT first_run FROM m008_run);

INSERT INTO companies (name, business_unit)
SELECT v.name, v.bu
  FROM (VALUES
    ('Labur Bina Sdn Bhd', 'Land'),
    ('Kekal Kirana Sdn Bhd', 'Land'),
    ('One Medini Sdn Bhd', 'Land'),
    ('WCT Green Sdn Bhd', 'Land'),
    ('WCT OUG Development Sdn Bhd', 'Land'),
    ('WCT Properties Sdn Bhd', 'Land'),
    ('Aliran Tiasa Sdn Bhd', 'F&B'),
    ('Champion Vista Sdn Bhd', 'F&B'),
    ('RASA by Grandmamas Sdn Bhd', 'F&B'),
    ('Skypark FBO Malaysia Sdn Bhd', 'Aviation'),
    ('Skypark RAC Sdn Bhd', 'Aviation'),
    ('WCT Berhad', 'E&C'),
    ('WCT Construction Sdn Bhd', 'E&C'),
    ('WCT Machinery Sdn Bhd', 'E&C'),
    ('Intraxis Engineering Sdn Bhd', 'E&C')
  ) AS v(name, bu)
 WHERE (SELECT first_run FROM m008_run)
   AND NOT EXISTS (SELECT 1 FROM companies c WHERE lower(c.name) = lower(v.name));

-- ---------------------------------------------------------------------------
-- 3. Payroll PIC per business unit (NULL = all business units)
-- ---------------------------------------------------------------------------
ALTER TABLE admin_grants DROP CONSTRAINT IF EXISTS chk_admin_grants_bu_matches_role;
ALTER TABLE admin_grants ADD CONSTRAINT chk_admin_grants_bu_matches_role CHECK (
  (role = 'super_admin' AND business_unit IS NULL AND department_id IS NULL) OR
  (role = 'payroll_pic' AND department_id IS NULL) OR
  (role IN ('bu_admin', 'entity_admin') AND business_unit IS NOT NULL AND department_id IS NULL) OR
  (role = 'clearance_pic' AND business_unit IS NOT NULL AND department_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 4. applications: form v2 fields
-- ---------------------------------------------------------------------------
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS permanent_address2       text,
  ADD COLUMN IF NOT EXISTS permanent_city           text,
  ADD COLUMN IF NOT EXISTS permanent_state          text,
  ADD COLUMN IF NOT EXISTS correspondence_address2  text,
  ADD COLUMN IF NOT EXISTS correspondence_city      text,
  ADD COLUMN IF NOT EXISTS correspondence_state     text,
  ADD COLUMN IF NOT EXISTS no_working_experience    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spouse_name              text,
  ADD COLUMN IF NOT EXISTS spouse_nric              text,
  ADD COLUMN IF NOT EXISTS spouse_date_of_birth     date,
  ADD COLUMN IF NOT EXISTS spouse_working           text,
  ADD COLUMN IF NOT EXISTS children_below_18        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS children_18_to_23        jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 5. onboarding_records: typed signature names
-- ---------------------------------------------------------------------------
ALTER TABLE onboarding_records
  ADD COLUMN IF NOT EXISTS personal_details_signed_name text,
  ADD COLUMN IF NOT EXISTS salary_crediting_signed_name text;

COMMIT;
