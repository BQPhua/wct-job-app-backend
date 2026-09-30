'use strict';

// ============================================================================
// Offboarding case lifecycle: reference numbers, clearance sections, status
// recalculation, the activity timeline and loading a case "bundle".
//
// Functions that change state take a transaction client (`client`) so the
// caller controls atomicity — routes wrap each action in db.withTransaction
// and call lockCase() first, so two people signing at the same moment can't
// both miss (or both trigger) the "all six signed" transition.
// ============================================================================

const { yearMYT } = require('./dates');
const { TOTAL_SECTIONS } = require('./constants');

async function nextRefNo(client) {
  const { rows } = await client.query("SELECT nextval('offboarding_ref_seq') AS n");
  return `OFF-${yearMYT()}-${String(rows[0].n).padStart(4, '0')}`;
}

/** Row-lock and return the case (null if it doesn't exist). */
async function lockCase(client, caseId) {
  const { rows } = await client.query('SELECT * FROM offboarding_cases WHERE id = $1 FOR UPDATE', [caseId]);
  return rows[0] || null;
}

/**
 * Create the six department sections for a case, copying each department's
 * checklist template items. The Reporting Unit section is assigned to the
 * immediate superior's email when HR provided one.
 */
async function createSections(client, caseRow) {
  const superior = caseRow.immediate_superior_email ? String(caseRow.immediate_superior_email).toLowerCase() : null;
  const { rows: depts } = await client.query('SELECT id, is_reporting_unit FROM clearance_departments ORDER BY display_order');
  for (const d of depts) {
    const { rows } = await client.query(
      `INSERT INTO offboarding_clearance_sections (case_id, department_id, assignee_email)
       VALUES ($1, $2, $3)
       ON CONFLICT (case_id, department_id) DO NOTHING
       RETURNING id`,
      [caseRow.id, d.id, d.is_reporting_unit ? superior : null]
    );
    if (rows.length === 0) continue; // already existed
    await client.query(
      `INSERT INTO offboarding_clearance_items (section_id, template_item_id, item_text, is_other, display_order)
       SELECT $1, t.id, t.item_text, t.is_other, t.display_order
         FROM clearance_checklist_templates t
        WHERE t.department_id = $2
        ORDER BY t.display_order`,
      [rows[0].id, d.id]
    );
  }
}

/**
 * Move a case from clearance to pending_acknowledgement once every section
 * is complete. Returns the (possibly new) status and whether it changed.
 */
async function recalculate(client, caseId) {
  const { rows } = await client.query(
    `SELECT c.status,
            count(s.id) FILTER (WHERE s.status = 'complete')::int AS done,
            count(s.id)::int AS total
       FROM offboarding_cases c
       LEFT JOIN offboarding_clearance_sections s ON s.case_id = c.id
      WHERE c.id = $1
      GROUP BY c.status`,
    [caseId]
  );
  const r = rows[0];
  if (r.status === 'clearance_in_progress' && r.total === TOTAL_SECTIONS && r.done === TOTAL_SECTIONS) {
    await client.query("UPDATE offboarding_cases SET status = 'pending_acknowledgement' WHERE id = $1", [caseId]);
    return { status: 'pending_acknowledgement', changed: true };
  }
  return { status: r.status, changed: false };
}

/** Short role name recorded on timeline events. */
function actorRole(actor) {
  if (!actor) return 'system';
  if (actor.kind === 'employee') return 'employee';
  if (actor.unitScope === 'ALL') return 'super_admin';
  if (actor.unitScope === 'SUPERIOR') return 'superior';
  const r = actor.roles || {};
  if (r.bu_admin) return 'hr';
  if (r.payroll_pic) return 'payroll_pic';
  if (r.clearance_department_ids && r.clearance_department_ids.length) return 'clearance_pic';
  return 'staff';
}

async function logEvent(client, caseId, actor, eventType, detail = {}) {
  await client.query(
    `INSERT INTO offboarding_events (case_id, actor_email, actor_role, event_type, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [caseId, actor ? actor.email || null : null, actorRole(actor), eventType, JSON.stringify(detail)]
  );
}

/**
 * Everything about one case: the case row, exit interview, sections (with
 * department names and items, in form order) and the timeline.
 * `q` is anything with .query (the pool module or a transaction client).
 */
async function loadBundle(q, caseId) {
  const c = await q.query('SELECT * FROM offboarding_cases WHERE id = $1', [caseId]);
  if (c.rows.length === 0) return null;
  // Sequential on purpose: `q` may be a single transaction client, which
  // must not be given concurrent queries.
  const ei = await q.query('SELECT * FROM offboarding_exit_interviews WHERE case_id = $1', [caseId]);
  const secs = await q.query(
      `SELECT s.*, d.name AS department_name, d.is_reporting_unit, d.display_order
         FROM offboarding_clearance_sections s
         JOIN clearance_departments d ON d.id = s.department_id
        WHERE s.case_id = $1
        ORDER BY d.display_order`,
      [caseId]
    );
  const items = await q.query(
      `SELECT i.* FROM offboarding_clearance_items i
         JOIN offboarding_clearance_sections s ON s.id = i.section_id
        WHERE s.case_id = $1
        ORDER BY i.display_order`,
      [caseId]
    );
  const events = await q.query('SELECT * FROM offboarding_events WHERE case_id = $1 ORDER BY created_at, id', [caseId]);
  const sections = secs.rows.map((s) => ({ ...s, items: items.rows.filter((i) => i.section_id === s.id) }));
  return { case: c.rows[0], exitInterview: ei.rows[0] || null, sections, events: events.rows };
}

module.exports = { nextRefNo, lockCase, createSections, recalculate, logEvent, loadBundle, actorRole };
