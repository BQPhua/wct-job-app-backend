-- ============================================================================
-- 011 — Stakeholder feedback, 3 Nov 2026
--
-- Onboarding: the spouse's citizenship, and a passport number for a spouse
-- who is not Malaysian (NRIC for a Malaysian spouse stays in spouse_nric).
-- Children's citizenship and passport numbers live inside the existing
-- children jsonb lists, so they need no new column.
--
-- Additive and safe to run more than once.
-- ============================================================================
BEGIN;

ALTER TABLE onboarding_records ADD COLUMN IF NOT EXISTS spouse_citizen text;
ALTER TABLE onboarding_records ADD COLUMN IF NOT EXISTS spouse_passport_no text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onboarding_spouse_citizen') THEN
    ALTER TABLE onboarding_records ADD CONSTRAINT chk_onboarding_spouse_citizen
      CHECK (spouse_citizen IS NULL OR spouse_citizen IN ('Malaysian', 'Non-Malaysian'));
  END IF;
END $$;

COMMIT;
