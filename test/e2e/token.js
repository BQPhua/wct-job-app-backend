'use strict';
// Print a signed session token for the E2E run.
//   node test/e2e/token.js admin <email> <unit_scope> '<roles json>'
//   node test/e2e/token.js candidate <user id> <email>
process.env.E2E_DB = process.env.E2E_DB || 'wct_e2e';
require('../helpers/env');
const jwt = require('jsonwebtoken');
const [kind, a, b, c] = process.argv.slice(2);
if (kind === 'admin') {
  process.env.E2E_DB = process.env.E2E_DB || 'wct_e2e';
  require('../helpers/env');
  const db = require('../../src/db');
  db.query('SELECT id FROM admin_users WHERE email = $1', [a]).then(({ rows }) => {
    const payload = { admin_user_id: rows[0] ? rows[0].id : null, email: a, unit_scope: b };
    if (c) payload.roles = JSON.parse(c);
    process.stdout.write(jwt.sign(payload, process.env.ADMIN_JWT_SECRET, { expiresIn: '2h' }));
    return db.pool.end();
  });
} else {
  process.stdout.write(jwt.sign({ sub: a, email: b }, process.env.JWT_SECRET, { expiresIn: '2h' }));
}
