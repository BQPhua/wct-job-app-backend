-- ============================================================================
-- 007 — notification_log: remembers which automatic reminder emails have
-- been sent, so the daily reminder run sends each one exactly once.
--
--   kind     e.g. 'invite_reminder', 'ack_reminder', 'payroll_reminder',
--            'onboarding_reminder', 'hr_digest'
--   ref_key  what it is about (case id, application id, business unit)
--   step     which reminder in the series (days, or 0 for "first seen")
--
-- Additive and safe to run more than once.
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_log (
  kind     text        NOT NULL,
  ref_key  text        NOT NULL,
  step     integer     NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_key, step)
);
