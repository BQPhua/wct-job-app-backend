// ============================================================================
// Microsoft (MSAL.js) + Google (Identity Services) sign-in helpers.
//
// These get an ID token from each provider on the CLIENT, then hand it to
// the backend for server-side verification — see:
//   POST /api/auth/oauth/microsoft   (candidate, backend/src/routes/auth.js)
//   POST /api/auth/oauth/google      (candidate, backend/src/routes/auth.js)
//   POST /api/admin/auth/microsoft   (admin,     backend/src/routes/admin.js)
// This file never talks to those endpoints itself — it only gets the ID
// token; callers (login.html, admin.html) POST it via api.js.
//
// Both reuse the SAME existing app registration / OAuth client the original
// Supabase-based app used (see backend/.env.example for the full story —
// same Azure app for both candidate + admin Microsoft sign-in, allowing
// "All Microsoft account users": multi-tenant + personal accounts).
// Requires <script src="https://alcdn.msauth.net/browser/3.24.0/js/msal-browser.min.js">
// and <script src="https://accounts.google.com/gsi/client"> loaded before
// this file (see login.html / admin.html <head>).
// ============================================================================

// Candidate pages (login.html) use this client ID by default. admin.html is
// signed in against a SEPARATE Azure app registration ("WCT Admin") and sets
// window.MS_CLIENT_ID to override this before oauth.js loads — see its
// <head>. The backend verifies each against the matching app (MS_CLIENT_ID
// vs ADMIN_MS_CLIENT_ID — see backend/src/lib/oauthVerify.js).
const MS_CLIENT_ID = window.MS_CLIENT_ID || '4e5c255b-7d3d-4fca-b61d-bd506e50e09d';
// Candidate pages (login.html) use the multi-tenant + personal-accounts
// endpoint, since any Microsoft account may apply. admin.html sets
// window.MS_AUTHORITY to its own organization's tenant-specific endpoint
// instead — the "WCT Admin" app registration is deliberately single-tenant
// (restricting admin sign-in to WCT's own Entra tenant), and single-tenant
// apps cannot use the /common endpoint at all (AADSTS50194).
const MS_AUTHORITY = window.MS_AUTHORITY || 'https://login.microsoftonline.com/common';
const GOOGLE_CLIENT_ID = '805014615991-elic4o6auhe7m8fr6qmu24lhkd9eqarj.apps.googleusercontent.com';

let msalInstancePromise = null;
function getMsalInstance() {
  if (!msalInstancePromise) {
    const instance = new msal.PublicClientApplication({
      auth: {
        clientId: MS_CLIENT_ID,
        authority: MS_AUTHORITY,
        // Same page handles the popup redirect — no separate callback page.
        redirectUri: window.location.origin + window.location.pathname,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    msalInstancePromise = instance.initialize().then(() => instance);
  }
  return msalInstancePromise;
}

/**
 * Opens a Microsoft sign-in popup and resolves with the raw ID token (a JWT
 * string) to POST to the backend. Throws if the user cancels or it fails.
 */
async function signInWithMicrosoft() {
  const instance = await getMsalInstance();
  const result = await instance.loginPopup({
    scopes: ['openid', 'profile', 'email'],
    prompt: 'select_account',
  });
  if (!result || !result.idToken) throw new Error('Microsoft sign-in did not return an ID token');
  return result.idToken;
}

let googleInitialized = false;
let pendingGoogleResolvers = [];
function ensureGoogleInitialized() {
  if (googleInitialized) return;
  googleInitialized = true;
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => {
      const resolvers = pendingGoogleResolvers;
      pendingGoogleResolvers = [];
      resolvers.forEach((resolve) => resolve(response.credential));
    },
  });
}

/**
 * Prompts Google One Tap / the account chooser and resolves with the raw ID
 * token (a JWT string) to POST to the backend. NOTE: One Tap can silently
 * fail to display (third-party cookies blocked, no prior Google session,
 * etc.) — pair this with `renderGoogleButton()` as a visible fallback in the
 * UI rather than relying on this alone.
 */
function signInWithGoogle() {
  ensureGoogleInitialized();
  return new Promise((resolve, reject) => {
    pendingGoogleResolvers.push(resolve);
    google.accounts.id.prompt();
    setTimeout(() => {
      const idx = pendingGoogleResolvers.indexOf(resolve);
      if (idx !== -1) {
        pendingGoogleResolvers.splice(idx, 1);
        reject(new Error('Google sign-in timed out or was dismissed'));
      }
    }, 60000);
  });
}

/**
 * Renders Google's own styled sign-in button into `el`, which is often more
 * reliable than the One Tap prompt (works even when One Tap is suppressed).
 * Resolves the SAME way as signInWithGoogle() — via the shared `callback`
 * set up in ensureGoogleInitialized().
 */
function renderGoogleButton(el, buttonOptions) {
  ensureGoogleInitialized();
  google.accounts.id.renderButton(
    el,
    Object.assign({ theme: 'outline', size: 'large', width: 320, text: 'continue_with' }, buttonOptions)
  );
}

/** Companion to renderGoogleButton(): resolves with the next ID token the button click produces. */
function waitForGoogleButtonSignIn() {
  ensureGoogleInitialized();
  return new Promise((resolve) => {
    pendingGoogleResolvers.push(resolve);
  });
}
