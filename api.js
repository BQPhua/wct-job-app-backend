// ============================================================================
// API client for the migrated Node/Express + Azure backend.
// Replaces `supabaseClient` (config.js, @supabase/supabase-js) everywhere in
// this app. Two independent token stores, matching the backend's two
// separate JWT secrets (see backend/src/middleware/auth.js):
//   - candidate token -> localStorage 'wct_token'   (Authorization header on
//     every /api/applications, /api/onboarding, /api/exit-interviews,
//     /api/uploads call)
//   - admin token      -> localStorage 'wct_admin_token' (Authorization
//     header on every /api/admin/* call)
// ============================================================================

// Point this at the deployed backend. Defaults to localhost for local dev;
// override by setting `window.API_BASE_URL` in a small inline <script> BEFORE
// this file loads (e.g. in production HTML: <script>window.API_BASE_URL =
// 'https://wct-job-app-api.azurewebsites.net/api';</script>).
const API_BASE_URL = window.API_BASE_URL || 'http://localhost:3000/api';

const TOKEN_KEY = 'wct_token';
const ADMIN_TOKEN_KEY = 'wct_admin_token';
const USER_KEY = 'wct_user'; // {id, email, name} — the login/register/oauth
// response's `user` object, cached here since the JWT itself only carries
// {sub, email} (see backend/src/routes/auth.js issueToken()), not the
// display name.

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }
function getAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; }
function setAdminToken(t) { t ? localStorage.setItem(ADMIN_TOKEN_KEY, t) : localStorage.removeItem(ADMIN_TOKEN_KEY); }
function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}
function setUser(u) { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); }
function clearSession() { setToken(null); setUser(null); }

/**
 * Core request helper. `opts.admin` picks which token to attach;
 * `opts.formData` sends a FormData body (file upload) instead of JSON.
 * Throws on any non-2xx response, with `.status` and `.data` (the parsed
 * error body, if any) attached — callers match the old
 * `const { data, error } = await supabaseClient.rpc(...)` shape by wrapping
 * calls in try/catch (see apiTry below) rather than every call site having
 * its own try/catch.
 */
async function apiRequest(path, { method = 'GET', body, admin = false, formData = false } = {}) {
  const token = admin ? getAdminToken() : getToken();
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined && !formData) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API_BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : (formData ? body : JSON.stringify(body)),
    });
  } catch (networkErr) {
    const err = new Error('Network error — could not reach the server. Please check your connection and try again.');
    err.status = 0;
    err.cause = networkErr;
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }

  if (!res.ok) {
    const message = (data && typeof data === 'object' && data.error) || res.statusText || 'Request failed';
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Supabase-style wrapper: returns { data, error } instead of throwing, so
 * call sites originally written as
 *   const { data, error } = await supabaseClient.rpc('rpc_x', {...});
 *   if (error) { ...handle... }
 * can become
 *   const { data, error } = await apiTry(() => api.get('/x'));
 *   if (error) { ...handle... }
 * with the smallest possible diff at each call site.
 */
async function apiTry(fn) {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err };
  }
}

// Decodes a JWT's payload WITHOUT verifying its signature — only ever safe
// to use for reading display-only claims (name, email) out of a token this
// same browser just received directly from the provider/backend a moment
// ago. Never use this as an authorization check; the backend is what
// actually verifies tokens.
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

const api = {
  get: (path, opts) => apiRequest(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => apiRequest(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => apiRequest(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => apiRequest(path, { ...opts, method: 'DELETE' }),
  upload: (path, file, opts) => {
    const form = new FormData();
    form.append('file', file);
    return apiRequest(path, { ...opts, method: 'POST', body: form, formData: true });
  },
  getToken, setToken, getAdminToken, setAdminToken, getUser, setUser, clearSession,
};
