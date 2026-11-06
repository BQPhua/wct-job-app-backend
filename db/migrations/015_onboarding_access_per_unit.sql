-- ============================================================================
-- 015 — Stakeholder feedback, 6 Nov 2026 (follows 014)
--
-- Onboarding details access is now set per business unit, not per person:
-- someone who is HR Admin for two units can see onboarding details in one
-- and not the other.
--
--   admin_grants.can_view_onboarding  (only meaningful on HR Admin grants)
--     true  = in this unit, sees onboarding details, the onboarding PDF and
--             the onboarding columns in the export
--     false = in this unit, sees the job application only (and whether
--             onboarding is done)
--
-- Super Admins always see everything.
-- Existing HR Admin grants copy the person's setting from migration 014 when
-- it was run, otherwise they keep access (true). Grants added from now on
-- start without it unless the Super Admin ticks it.
-- admin_users.can_view_onboarding (014) is no longer read; it is left in
-- place so nothing breaks if an older backend is still running.
--
-- Run after 014. Safe to run twice.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_grants' AND column_name = 'can_view_onboarding'
  ) THEN
    ALTER TABLE admin_grants ADD COLUMN can_view_onboarding boolean NOT NULL DEFAULT false;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'admin_users' AND column_name = 'can_view_onboarding'
    ) THEN
      UPDATE admin_grants g SET can_view_onboarding = u.can_view_onboarding
        FROM admin_users u
       WHERE u.id = g.admin_user_id AND g.role = 'bu_admin';
    ELSE
      UPDATE admin_grants SET can_view_onboarding = true WHERE role = 'bu_admin';
    END IF;
  END IF;
END $$;

COMMIT;
