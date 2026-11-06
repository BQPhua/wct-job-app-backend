-- ============================================================================
-- 014 — Stakeholder feedback, 6 Nov 2026
--
-- Onboarding details (EPF, income tax, SOCSO, bank account, spouse and
-- children NRIC, emergency contact, beneficiary) are sensitive. A Super Admin
-- now decides, per person, whether an admin may see them:
--
--   admin_users.can_view_onboarding
--     true  = sees the onboarding details, the onboarding PDF and the
--             onboarding columns in the export
--     false = sees the job application only (and whether onboarding is
--             done), but not the onboarding details
--
-- Super Admins always see everything, whatever this says.
-- Admins who already exist keep their access (true). Admins invited from now
-- on start without it (the column default is false) until a Super Admin turns
-- it on in Admin Access.
--
-- Safe to run twice.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_users' AND column_name = 'can_view_onboarding'
  ) THEN
    ALTER TABLE admin_users ADD COLUMN can_view_onboarding boolean NOT NULL DEFAULT false;
    -- Everyone who is an admin today keeps access.
    UPDATE admin_users SET can_view_onboarding = true;
  END IF;
END $$;

COMMIT;
