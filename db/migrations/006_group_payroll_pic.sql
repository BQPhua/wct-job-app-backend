-- ============================================================================
-- 006 — Payroll PIC is group-wide
--
-- One Payroll team serves every business unit, so a payroll_pic grant no
-- longer names a business unit (like super_admin). The app already treats
-- any payroll_pic grant as group-wide; this migration lets new grants be
-- saved without a business unit and folds existing per-BU payroll grants
-- into one grant per person.
--
-- Safe to run more than once.
-- ============================================================================
BEGIN;

ALTER TABLE admin_grants DROP CONSTRAINT IF EXISTS chk_admin_grants_bu_matches_role;

-- Keep one payroll_pic grant per person (the oldest) and clear its BU.
DELETE FROM admin_grants g
 USING admin_grants keep
 WHERE g.role = 'payroll_pic' AND keep.role = 'payroll_pic'
   AND g.admin_user_id = keep.admin_user_id
   AND (g.created_at, g.id) > (keep.created_at, keep.id);
UPDATE admin_grants SET business_unit = NULL WHERE role = 'payroll_pic' AND business_unit IS NOT NULL;

ALTER TABLE admin_grants ADD CONSTRAINT chk_admin_grants_bu_matches_role CHECK (
  (role IN ('super_admin', 'payroll_pic') AND business_unit IS NULL AND department_id IS NULL) OR
  (role IN ('bu_admin', 'entity_admin') AND business_unit IS NOT NULL AND department_id IS NULL) OR
  (role = 'clearance_pic' AND business_unit IS NOT NULL AND department_id IS NOT NULL)
);

COMMIT;
