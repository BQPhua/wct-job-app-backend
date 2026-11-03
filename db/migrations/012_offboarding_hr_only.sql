-- ============================================================================
-- 012 — Stakeholder decision, 3 Nov 2026: offboarding without clearance and
-- payroll, for now.
--
--   HR invites -> employee submits the Exit Interview -> HR signs Section D
--   -> case completed (employee emailed).
--
-- Each case remembers which flow it was created under (flow = 'hr_only' or
-- 'full'), so cases already in progress keep their own path whichever way
-- OFFBOARDING_CLEARANCE is set. New status 'pending_hr_signoff' = submitted,
-- waiting for HR. completed_at = when a case was closed (either flow).
--
-- Additive and safe to run more than once.
-- ============================================================================
BEGIN;

ALTER TABLE offboarding_cases ADD COLUMN IF NOT EXISTS flow text NOT NULL DEFAULT 'full';
ALTER TABLE offboarding_cases ADD COLUMN IF NOT EXISTS completed_at timestamptz;
UPDATE offboarding_cases SET completed_at = payroll_completed_at
 WHERE completed_at IS NULL AND status = 'completed' AND payroll_completed_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_offboarding_cases_flow') THEN
    ALTER TABLE offboarding_cases ADD CONSTRAINT chk_offboarding_cases_flow CHECK (flow IN ('full', 'hr_only'));
  END IF;
END $$;

ALTER TABLE offboarding_cases DROP CONSTRAINT IF EXISTS offboarding_cases_status_check;
ALTER TABLE offboarding_cases ADD CONSTRAINT offboarding_cases_status_check CHECK (status IN (
  'invited', 'pending_hr_signoff', 'clearance_in_progress', 'pending_acknowledgement',
  'pending_payroll', 'completed', 'cancelled'));

COMMIT;
