-- ============================================================================
-- 010 — Stakeholder feedback, 30 Oct 2026
--
--   1. Undo migration 009 (REIT into Malls was requested by mistake): REIT is
--      its own unit again and applications with a WCT-REIT-... reference go
--      back to it. The companies, admin access and PIC email 009 moved can't
--      be told apart from Malls' own here; scripts/restore-reit-from-backup.sh
--      puts them back exactly from the backup taken before 009.
--   2. Application form v3: the spouse's occupation, and only the NUMBER of
--      children (their details are collected at onboarding).
--   3. password_reset_tokens: forgot-password links that survive a restart.
--
-- Additive and safe to run more than once.
-- ============================================================================
BEGIN;

-- 1. REIT is its own unit again ------------------------------------------------
ALTER TABLE business_units ADD COLUMN IF NOT EXISTS merged_into text
  REFERENCES business_units (code) ON UPDATE CASCADE;

UPDATE business_units SET is_active = true, merged_into = NULL
 WHERE code = 'REIT' AND (merged_into IS NOT NULL OR is_active = false);

UPDATE applications SET business_unit = 'REIT'
 WHERE reference_no LIKE 'WCT-REIT-%' AND business_unit <> 'REIT'
   AND EXISTS (SELECT 1 FROM business_units WHERE code = 'REIT');

-- 2. Form v3 -------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS spouse_occupation text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS children_below_18_count integer;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS children_18_to_23_count integer;
ALTER TABLE applications DROP CONSTRAINT IF EXISTS chk_applications_children_counts;
ALTER TABLE applications ADD CONSTRAINT chk_applications_children_counts CHECK (
  (children_below_18_count IS NULL OR children_below_18_count BETWEEN 0 AND 20) AND
  (children_18_to_23_count IS NULL OR children_18_to_23_count BETWEEN 0 AND 20));

-- 3. Password reset links ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash  text        PRIMARY KEY,           -- sha256 of the emailed token
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens (user_id, created_at);

COMMIT;
