'use strict';

// ============================================================================
// Live screen updates (Server-Sent Events).
//
// Signed-in admin screens keep one open GET /api/admin/events. Whenever any
// request successfully CHANGES something (POST/PUT/PATCH/DELETE answered with
// a 2xx/3xx), every open screen gets a tiny signal:
//
//   data: {"area":"offboarding","case_id":"<uuid or null>","client":"<tab id or null>","at":169...}
//
// The signal carries no data at all, only which area changed, so business-unit
// privacy is unaffected: each screen re-fetches through the normal API, which
// applies the viewer's own permissions. `client` echoes the X-Client-Id header
// of the browser tab that made the change, so that tab can ignore its own echo.
//
// One Node process = one in-memory list of streams (that is how this app runs).
// ============================================================================

const MAX_CLIENTS = 500;
const PING_MS = 25000; // keeps proxies (nginx, Azure) from closing an idle stream
const clients = new Set();

// Which part of the system a changed URL belongs to. Anything not listed
// (sign-in, password reset, AI questions, raw uploads, file links) is ignored.
const AREAS = [
  [/^\/api\/(admin\/)?offboarding(\/|$)/, 'offboarding'],
  [/^\/api\/admin\/(applications|companies|entity-categories)(\/|$)/, 'applications'],
  [/^\/api\/(applications|onboarding)(\/|$)/, 'applications'],
  [/^\/api\/admin\/(admins|grants|permission-matrix|settings)(\/|$)/, 'access'],
];
const CASE_ID = /\/(?:cases|mine)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function areaFor(path) {
  const hit = AREAS.find(([re]) => re.test(path));
  return hit ? hit[1] : null;
}

function publish(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch (e) { clients.delete(res); }
  }
}

/** Express middleware: after a successful change, tell every open screen. */
function trackChanges(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const path = req.originalUrl.split('?')[0];
  const area = areaFor(path);
  if (!area) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || clients.size === 0) return;
    const m = CASE_ID.exec(path);
    const client = String(req.get('x-client-id') || '').slice(0, 64) || null;
    publish({ area, case_id: m ? m[1].toLowerCase() : null, client, at: Date.now() });
  });
  return next();
}

/** GET /api/admin/events: the open stream itself (after requireAdminAuth). */
function stream(req, res) {
  if (clients.size >= MAX_CLIENTS) return res.status(503).json({ error: 'Too many live connections' });
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // nginx: pass each event straight through
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 5000\n: connected\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, PING_MS);
  const done = () => { clearInterval(ping); clients.delete(res); };
  // 'close' on the response fires when the browser tab goes away (the
  // request's own 'close' can fire as soon as its empty body is read).
  res.on('close', done);
  res.on('error', done);
  return undefined;
}

module.exports = { trackChanges, stream, publish, areaFor, clientCount: () => clients.size };
