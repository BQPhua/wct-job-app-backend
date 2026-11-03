-- ============================================================================
-- 013 — Stakeholder feedback, 3 Nov 2026
--
-- The reasons an employee can tick in the Exit Interview ("reasons that
-- contributed to your decision to leave") become a list HR manages in the
-- Admin Dashboard (Offboarding → Exit reasons) instead of being fixed in code.
-- Seeded with the 12 reasons from the WCT Exit Interview form.
--
-- Answers already given are stored as text on each Exit Interview, so
-- renaming or deleting a reason here never changes a submitted form.
--
-- (Notice period is no longer asked; the column stays for older cases.)
--
-- Additive and safe to run more than once.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS offboarding_exit_reasons (
  id            serial PRIMARY KEY,
  label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  display_order int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_offboarding_exit_reasons_label ON offboarding_exit_reasons (lower(btrim(label)));

INSERT INTO offboarding_exit_reasons (label, display_order) VALUES
  ('Compensation (Salary / Benefits)', 1), ('Conflict with colleague/superior', 2),
  ('Better Offer', 3), ('Relocation', 4),
  ('Career Advancement', 5), ('Retirement', 6),
  ('Lack of promotional opportunities', 7), ('Health', 8),
  ('Lack of training', 9), ('Return to Study', 10),
  ('Working Hours', 11), ('Distance travelled to work', 12)
ON CONFLICT DO NOTHING;

COMMIT;
