'use strict';
// Local end-to-end server: the real API on :3000 against the `wct_e2e`
// database, plus a Power Automate stand-in on :3099 that records every
// email payload (GET http://127.0.0.1:3099/calls to inspect, DELETE to clear).
// Usage: node test/e2e/server.js   (run test/e2e/seed.js first)
process.env.E2E_DB = process.env.E2E_DB || 'wct_e2e';
require('../helpers/env');
const http = require('http');

const calls = [];
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(calls.map((c) => ({ ...c, attachments: (c.attachments || []).map((a) => ({ name: a.name, bytes: a.content_base64.length })) }))));
  }
  if (req.method === 'DELETE' && req.url === '/calls') { calls.length = 0; res.writeHead(204); return res.end(); }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    try { calls.push(JSON.parse(body)); } catch (e) { calls.push({ raw: body }); }
    res.writeHead(202); res.end();
  });
}).listen(3099, '127.0.0.1');

process.env.POWER_AUTOMATE_URL_OFFBOARDING_EMAIL = 'http://127.0.0.1:3099/hook?sig=e2e';
process.env.FRONTEND_BASE_URL = 'http://localhost:8080';
const app = require('../../src/app');
app.listen(3000, () => console.log('E2E API on :3000 (db wct_e2e), PA stub on :3099'));
