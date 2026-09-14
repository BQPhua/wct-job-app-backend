'use strict';

// ============================================================================
// Power Automate notification calls (spec §9.4; reverse-engineered from the
// original Supabase project's Postgres trigger/RPC functions on 2026-09-11
// via `pg_get_functiondef()` in the Supabase SQL Editor, per the product
// owner's instruction to "open the power automate and look into it").
//
// The original backend fired these directly from Postgres (`net.http_post`,
// the `pg_net` extension) inside trigger functions and RPCs. Azure Database
// for PostgreSQL has no equivalent extension, so every one of those calls
// moves up into this Node/Express layer instead — fired from the route
// handler right after the DB write that used to carry the trigger.
//
// There are 7 distinct Power Automate "manual trigger" HTTP endpoints. Their
// URLs (including the `sig=` query parameter, which functions as a bearer
// credential for that flow) are secrets — never hold this file's source, all
// 7 are read from environment variables (see .env.example) and are UNSET by
// default. `notify()` no-ops (logs once) when a URL isn't configured, so
// local/dev environments don't need real Power Automate flows wired up to
// run the rest of the app.
//
// Every call is fire-and-forget from the caller's point of view: a Power
// Automate outage must never fail the candidate/admin-facing request that
// triggered it. Errors are caught and logged here, never rethrown.
// ============================================================================

const EVENT_URL_ENV = {
  // rpc_submit_application → notify_power_automate_on_submit
  submit: 'POWER_AUTOMATE_URL_SUBMIT',
  // rpc_admin_update_status → notify_power_automate_on_status_change
  status_change: 'POWER_AUTOMATE_URL_STATUS_CHANGE',
  // rpc_admin_update_application (business_unit reassignment) →
  // notify_power_automate_on_bu_transfer
  bu_transfer: 'POWER_AUTOMATE_URL_BU_TRANSFER',
  // onboarding all-sections-confirmed → notify_power_automate_on_onboarding_complete
  onboarding_complete: 'POWER_AUTOMATE_URL_ONBOARDING_COMPLETE',
  // Shared by three call sites, each with a different `event_type` in the
  // payload: rpc_admin_set_offboarding ('fill_exit_interview'),
  // rpc_submit_my_exit_interview ('employee_signed'), and
  // notify_power_automate_on_exit_interview_signed ('hr_signed').
  exit_interview: 'POWER_AUTOMATE_URL_EXIT_INTERVIEW',
  // rpc_admin_invite_admin
  invite_admin: 'POWER_AUTOMATE_URL_INVITE_ADMIN',
  // Single Power Automate flow (one manual-trigger URL) fanning out on a
  // `event_type` field via a Switch action, covering FOUR call sites:
  // rpc_admin_grant_role ('grant_added'), rpc_admin_revoke_grant
  // ('grant_revoked'), and rpc_admin_set_admin_active ('deactivated' /
  // 'reactivated'). Confirmed against the actual Power Automate flow
  // definition (screenshot, 2026-09-14) — do not split this back into
  // separate env vars per event without re-checking the flow.
  admin_permission_change: 'POWER_AUTOMATE_URL_ADMIN_ACTIVE',
};

const warnedMissing = new Set();

/**
 * Fire a Power Automate webhook for `eventKey` with `payload` (a plain JS
 * object — will be JSON-stringified). Never throws; logs and resolves on any
 * failure (missing URL, network error, non-2xx response) so callers can
 * `await` it (for ordering) or leave it unawaited without a try/catch.
 */
async function notify(eventKey, payload) {
  const envVar = EVENT_URL_ENV[eventKey];
  if (!envVar) {
    // eslint-disable-next-line no-console
    console.error(`powerAutomate.notify: unknown eventKey "${eventKey}"`);
    return;
  }
  const url = process.env[envVar];
  if (!url) {
    if (!warnedMissing.has(eventKey)) {
      warnedMissing.add(eventKey);
      // eslint-disable-next-line no-console
      console.warn(`powerAutomate.notify: ${envVar} is not set — skipping "${eventKey}" notifications (this is expected in local/dev)`);
    }
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`powerAutomate.notify: "${eventKey}" webhook returned ${res.status}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`powerAutomate.notify: "${eventKey}" webhook call failed:`, err.message || err);
  }
}

// ----------------------------------------------------------------------------
// Payload data-minimization, mirroring the original `sanitize_notification_
// payload(p_row jsonb)` SQL function: given a full `applications` row, blank
// out every jsonb array/object column (regardless of content) before it goes
// out over a webhook, so nested PII (education history, referee contact
// details, emergency contacts, etc.) never leaves the building. Plain scalar
// columns pass through unchanged; `null` stays `null` isn't reproduced here —
// the original replaced any non-object/array value with '' when null, which
// callers already get for free since we spread real column values in.
// ----------------------------------------------------------------------------
const JSONB_OBJECT_COLUMNS = new Set(['referee1', 'referee2', 'tp3_data']);
const JSONB_ARRAY_COLUMNS = new Set([
  'language_ability', 'education', 'working_experience', 'attachments',
  'children_below_18', 'children_18_to_23', 'emergency_contacts',
]);

function sanitizeNotificationPayload(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (JSONB_OBJECT_COLUMNS.has(key)) {
      out[key] = {};
    } else if (JSONB_ARRAY_COLUMNS.has(key)) {
      out[key] = [];
    } else {
      out[key] = value === null || value === undefined ? '' : value;
    }
  }
  return out;
}

module.exports = { notify, sanitizeNotificationPayload };
