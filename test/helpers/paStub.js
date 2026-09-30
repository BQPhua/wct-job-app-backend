'use strict';
// Local stand-in for a Power Automate HTTP trigger: records every POST body
// and answers 202, or 500 for the next `failNext(n)` calls.
const http = require('http');

async function start(envVars = ['POWER_AUTOMATE_URL_OFFBOARDING_EMAIL']) {
  const calls = [];
  let failures = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
      calls.push({ url: req.url, body: parsed });
      if (failures > 0) { failures -= 1; res.writeHead(500); return res.end('fail'); }
      res.writeHead(202); return res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  envVars.forEach((v) => { process.env[v] = `${url}?sig=test&v=${v}`; });
  return {
    url, calls,
    failNext(n = 1) { failures = n; },
    reset() { calls.length = 0; failures = 0; },
    byEvent(type) { return calls.filter((c) => c.body && c.body.event_type === type); },
    stop: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { start };
