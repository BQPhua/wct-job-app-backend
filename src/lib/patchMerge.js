'use strict';

// ============================================================================
// Generic partial-update ("patch/coalesce") helper.
//
// See spec §6.2 ("the currentPatch() trick") for the full rationale. Summary
// of the CONTRACT this function assumes about its `patchObject` input:
//
//   1. The caller (client) is expected to have already stripped every key
//      whose value is the empty string '' from the patch before it ever
//      reaches this function — exactly like the reference app's own
//      `currentPatch()` helper does client-side:
//        Object.keys(p).forEach(k => { if (p[k] === '') delete p[k]; });
//      This module re-strips '' values defensively anyway (see
//      `stripEmptyStrings`, applied by every route before calling
//      `buildPatchUpdate`), but the *load-bearing* rule downstream is #2.
//
//   2. A key that is ENTIRELY ABSENT from patchObject means "leave this
//      column's current value untouched" — it is simply omitted from the
//      generated SQL SET clause. This is the critical distinction from a
//      naive `jsonb_populate_record` / `COALESCE(patch->>'col', col)` merge:
//      COALESCE only falls back to the existing value when the JSON value is
//      SQL NULL, not when the key is missing and not when the value is '' —
//      neither of which is safe here, because:
//        (a) a blank scalar field sent as '' would silently overwrite good
//            previously-saved data with blank, and
//        (b) some columns are constrained enums with CHECK constraints
//            (e.g. `language_choice IN ('BM','EN')`) that reject '' outright
//            and would abort the entire save transaction.
//      By building the SET clause purely from *present* keys, both problems
//      disappear: an absent key never appears in the query at all.
//
//   3. jsonb array/object fields (e.g. `education`, `language_ability`,
//      `attachments`, `reasons`, `children_below_18`, ...) are the one
//      documented exception to "only send what's on the currently-visible
//      form step" — per spec §6.2 note 5, callers always send these in full
//      from current in-memory state. That's a caller-side convention; this
//      function treats them like any other present key (whole-value
//      replacement), which is exactly what "always send in full" requires.
//
// This ONE function is reused by every save/patch endpoint (application
// save, onboarding save, exit-interview save) instead of three copy-pasted
// variants — see spec §6.2 note 6.
// ============================================================================

/**
 * Remove every key whose value is exactly the empty string ''. Mutates
 * nothing — returns a new object. Route handlers should call this on the
 * raw `req.body.patch` (or equivalent) BEFORE calling `buildPatchUpdate`,
 * matching the client's own `currentPatch()` convention (see module header).
 *
 * Only top-level string values are stripped, matching the reference
 * client's own shallow behavior — nested jsonb object/array fields are left
 * untouched (they're replaced wholesale per the module contract above, not
 * deep-merged).
 *
 * @param {object} patchObject
 * @returns {object}
 */
function stripEmptyStrings(patchObject) {
  const out = {};
  for (const [key, value] of Object.entries(patchObject || {})) {
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build a parameterized `UPDATE <table> SET col1 = $1, ... WHERE <idColumn> =
 * $N RETURNING *` query from a partial patch object, restricted to an
 * allowlist of columns.
 *
 * @param {string} tableName - table to update (must be a trusted, hardcoded
 *   string from calling code — never derived from user input — since it's
 *   interpolated directly; column identifiers are similarly restricted to
 *   `allowedColumns`, never taken verbatim from `patchObject`'s own keys
 *   without allowlist-checking, which is the whole point of this parameter).
 * @param {string} idColumn - the WHERE-clause column identifying the row
 *   (e.g. 'id', 'application_id').
 * @param {string|number} idValue - the value to match idColumn against.
 * @param {object} patchObject - partial object of column -> new value. Keys
 *   not present in `allowedColumns` are silently ignored (defense in depth
 *   against arbitrary column injection from a client-supplied patch body).
 * @param {string[]} allowedColumns - allowlist of column names this table
 *   permits patching for this caller/endpoint.
 * @param {object} [opts]
 * @param {object} [opts.extraWhere] - additional column=value equality
 *   conditions ANDed into the WHERE clause (e.g. { user_id: req.user.id } to
 *   enforce ownership in the same query, avoiding a separate round trip).
 * @returns {{ text: string, values: any[] } | null} the query to run, or
 *   `null` if patchObject contains no allowed keys (nothing to update —
 *   callers should treat this as a no-op, not an error, and may want to just
 *   re-fetch the row instead of issuing a no-op UPDATE).
 */
function buildPatchUpdate(tableName, idColumn, idValue, patchObject, allowedColumns, opts = {}) {
  const allowedSet = new Set(allowedColumns);
  const entries = Object.entries(patchObject || {}).filter(([key]) => allowedSet.has(key));

  if (entries.length === 0) {
    return null;
  }

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of entries) {
    setClauses.push(`${quoteIdent(key)} = $${paramIndex}`);
    values.push(jsonbColumnsCoerce(value));
    paramIndex += 1;
  }

  const whereClauses = [`${quoteIdent(idColumn)} = $${paramIndex}`];
  values.push(idValue);
  paramIndex += 1;

  const extraWhere = opts.extraWhere || {};
  for (const [key, value] of Object.entries(extraWhere)) {
    whereClauses.push(`${quoteIdent(key)} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  }

  const text = `UPDATE ${quoteIdent(tableName)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`;

  return { text, values };
}

// Arrays/plain objects destined for a jsonb column need to be passed to `pg`
// as JSON text (or `pg` will try to send them as a Postgres array literal /
// fail). We can't know the target column's type here, but jsonb-shaped JS
// values (arrays, plain objects that aren't Date) are unambiguous — scalars
// pass through untouched.
function jsonbColumnsCoerce(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

// Minimal identifier quoting for the fixed, hardcoded column/table names this
// module is invoked with (never raw end-user text) — guards against typos
// more than injection, since callers only ever pass literal identifiers.
function quoteIdent(ident) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`);
  }
  return `"${ident}"`;
}

module.exports = { buildPatchUpdate, stripEmptyStrings };
