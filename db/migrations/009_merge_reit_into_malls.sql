-- ============================================================================
-- 009 — Malls feedback (29 Oct 2026)
--
--   1. REIT Management merges into Malls Management, so Malls keeps one
--      account. Every REIT application, company, admin grant and offboarding
--      case moves to the Mall unit; REIT is switched off and marked
--      `merged_into = 'Mall'`, so old ?bu=REIT links open the Malls form.
--      Existing reference numbers (WCT-REIT-2026-...) are kept as issued.
--      REIT's PIC email (if any) is added to Malls'.
--   2. applications.no_referees: the candidate ticked "I have no referee to
--      provide" (interns, fresh graduates).
--
-- Additive and safe to run more than once: the merge only runs while REIT
-- still has rows to move or is still active.
-- ============================================================================
BEGIN;

ALTER TABLE business_units ADD COLUMN IF NOT EXISTS merged_into text
  REFERENCES business_units (code) ON UPDATE CASCADE;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS no_referees boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  t text;
  moved integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_units WHERE code = 'REIT')
     OR NOT EXISTS (SELECT 1 FROM business_units WHERE code = 'Mall') THEN
    RAISE NOTICE '009: REIT or Mall unit not found, nothing to merge';
    RETURN;
  END IF;

  -- Admin grants: drop REIT grants the person already has for Mall (the
  -- unique index would refuse the move), then move the rest.
  DELETE FROM admin_grants r
   USING admin_grants m
   WHERE r.business_unit = 'REIT' AND m.business_unit = 'Mall'
     AND r.admin_user_id = m.admin_user_id AND r.role = m.role
     AND COALESCE(r.department_id, 0) = COALESCE(m.department_id, 0);
  UPDATE admin_grants SET business_unit = 'Mall' WHERE business_unit = 'REIT';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '009: % admin grant(s) moved to Mall', moved;

  -- Everything else that belongs to a unit.
  FOREACH t IN ARRAY ARRAY['applications', 'companies', 'offboarding_cases'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET business_unit = %L WHERE business_unit = %L', t, 'Mall', 'REIT');
      GET DIAGNOSTICS moved = ROW_COUNT;
      RAISE NOTICE '009: % % row(s) moved to Mall', moved, t;
    END IF;
  END LOOP;

  -- PIC emails: Malls gets REIT's too.
  UPDATE business_units m
     SET pic_email = (SELECT string_agg(DISTINCT e, ';' ORDER BY e)
                        FROM unnest(regexp_split_to_array(lower(concat_ws(';', m.pic_email, r.pic_email)), '\s*[;,]\s*')) AS e
                       WHERE e <> '')
    FROM business_units r
   WHERE m.code = 'Mall' AND r.code = 'REIT' AND r.pic_email IS NOT NULL AND r.pic_email <> '';

  UPDATE business_units SET is_active = false, merged_into = 'Mall' WHERE code = 'REIT';
END $$;

COMMIT;
