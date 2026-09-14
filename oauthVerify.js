'use strict';

// ============================================================================
// Server-side verification of Google and Microsoft (Entra) OAuth ID tokens.
//
// Design (per product owner instruction, 2026-09-11, to reuse the existing,
// already-configured OAuth apps rather than provision new ones):
//   - Frontend uses each provider's own SDK (Google Identity Services / MSAL.js)
//     to get the user to sign in and obtain a signed ID token directly from
//     the provider — this backend NEVER sees the user's Google/Microsoft
//     password, only the resulting ID token.
//   - That ID token is POSTed here and verified SERVER-SIDE against the
//     provider's own public keys before any email/name claim inside it is
//     trusted. This is deliberate: an unverified "trust whatever the client
//     sends" step would let anyone claim to be any email address.
//   - Both existing app registrations are reused as-is:
//       Google Cloud OAuth 2.0 Web client "WCT Job Application"
//         (project digitalize-job-application) — GOOGLE_CLIENT_ID.
//       Azure Entra App Registration "WCT Job Application"
//         (Supported account types: All Microsoft account users, i.e.
//         multi-tenant + personal accounts) — MS_CLIENT_ID.
//     Google is used for candidate sign-in only. Microsoft is used for both
//     candidate sign-in (src/routes/auth.js) and admin sign-in
//     (src/routes/admin.js) — but as of 2026-09-14 these are TWO SEPARATE
//     Azure app registrations ("WCT Job Application" for candidates,
//     "WCT Admin" for the admin dashboard), each with its own client ID and
//     its own SPA redirect URI (login.html / admin.html respectively). A
//     Microsoft ID token's `aud` claim is always the client ID of whichever
//     app registration the frontend signed in against, so
//     verifyMicrosoftIdToken() below takes the expected audience as an
//     explicit parameter rather than reading one fixed env var — callers
//     pass MS_CLIENT_ID (candidate) or ADMIN_MS_CLIENT_ID (admin).
// ============================================================================

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { OAuth2Client } = require('google-auth-library');

// ---- Google ----

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token (from Google Identity Services on the frontend).
 * Validates signature, audience (our client id), issuer, and expiry via the
 * google-auth-library, which fetches/caches Google's public keys itself.
 * Returns { email, emailVerified, name, subject }.
 */
async function verifyGoogleIdToken(idToken) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is not configured');
  }
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing id_token');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error('Google ID token did not contain an email claim');
  }
  if (payload.email_verified === false) {
    // Google sets this explicitly false only when it knows the address isn't
    // verified — reject rather than silently trusting an unverified address.
    throw new Error('Google account email is not verified');
  }

  return {
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified !== false,
    name: payload.name || '',
    subject: payload.sub,
  };
}

// ---- Microsoft (Entra) ----
// The app registration allows "All Microsoft account users" (work/school AND
// personal Microsoft accounts), so tokens can be issued from any tenant, or
// from the personal-account "consumers" endpoint. Microsoft's `common`
// discovery/JWKS endpoint serves the signing keys for all of them, so
// verification only needs one JWKS client — but the issuer must still be
// checked against the multi-tenant v2.0 issuer *pattern*
// (`https://login.microsoftonline.com/{tenantid}/v2.0`) since there's no
// single fixed issuer string to compare against, per Microsoft's own
// multi-tenant validation guidance.
const msJwks = jwksClient({
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  cache: true,
  rateLimit: true,
});

const MS_ISSUER_PATTERN = /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/;

function getMicrosoftSigningKey(header, callback) {
  msJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Verify a Microsoft (Entra) ID token (from MSAL.js on the frontend).
 * Validates signature (via Microsoft's JWKS), audience, and the multi-tenant
 * issuer pattern. `expectedAudience` must be the client ID of whichever
 * Azure app registration the frontend signed in against (MS_CLIENT_ID for
 * candidate sign-in, ADMIN_MS_CLIENT_ID for admin sign-in — see the file
 * header comment). Returns { email, name, subject }.
 */
function verifyMicrosoftIdToken(idToken, expectedAudience) {
  return new Promise((resolve, reject) => {
    if (!expectedAudience) {
      return reject(new Error('Expected Microsoft app client ID is not configured'));
    }
    if (!idToken || typeof idToken !== 'string') {
      return reject(new Error('Missing id_token'));
    }

    jwt.verify(
      idToken,
      getMicrosoftSigningKey,
      { audience: expectedAudience, algorithms: ['RS256'] },
      (err, decoded) => {
        if (err) return reject(err);
        if (!decoded.iss || !MS_ISSUER_PATTERN.test(decoded.iss)) {
          return reject(new Error(`Unexpected token issuer: ${decoded.iss}`));
        }

        // Personal Microsoft accounts often only populate `email` when the
        // `email` scope was requested (which the frontend must request); fall
        // back to `preferred_username`, which Entra always sets to a usable
        // address for both work/school and personal accounts.
        const email = decoded.email || decoded.preferred_username;
        if (!email) {
          return reject(new Error('Microsoft ID token did not contain a usable email claim'));
        }

        resolve({
          email: String(email).toLowerCase(),
          name: decoded.name || '',
          subject: decoded.oid || decoded.sub,
        });
      }
    );
  });
}

module.exports = { verifyGoogleIdToken, verifyMicrosoftIdToken };
