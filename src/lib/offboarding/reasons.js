'use strict';

// ============================================================================
// Exit Interview reasons (migration 013): the list HR manages in the Admin
// Dashboard. Falls back to the original 12 if the table isn't there yet
// (before migration 013 is run), so nothing breaks in between.
// ============================================================================

const db = require('../../db');
const { EXIT_REASONS } = require('./constants');

let warned = false;

/** [{ id, label, display_order }] in the order shown on the form. */
async function list(q = db) {
  try {
    const { rows } = await q.query('SELECT id, label, display_order FROM offboarding_exit_reasons ORDER BY display_order, id');
    return rows;
  } catch (err) {
    if (err.code !== '42P01') throw err;
    if (!warned) { warned = true; console.warn('offboarding_exit_reasons is missing: run migration 013. Using the built-in reasons.'); } // eslint-disable-line no-console
    return EXIT_REASONS.map((label, i) => ({ id: null, label, display_order: i + 1 }));
  }
}

/** Just the labels, in order. */
async function labels(q = db) {
  return (await list(q)).map((r) => r.label);
}

module.exports = { list, labels };
