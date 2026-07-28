"use strict";

/**
 * Webflow OAuth 2.0 authorization-code flow.
 *
 * Endpoints and parameters confirmed live this session via WebFetch against
 * https://developers.webflow.com/data/reference/oauth-app and
 * https://developers.webflow.com/data/reference/rest-introduction/quick-start
 * (not recalled from training data — see README's "Real Webflow OAuth /
 * Data API structure confirmed" section for exact fetch results):
 *
 *  - Authorize: GET https://webflow.com/oauth/authorize
 *      ?response_type=code&client_id=...&redirect_uri=...&scope=...&state=...
 *    `response_type` must be the literal string "code". `scope` is a
 *    space-separated list of `resource:action` strings (e.g. "sites:read
 *    cms:read cms:write"); URLSearchParams handles the required encoding.
 *    `state` is documented as optional by Webflow, but this integration
 *    treats it as mandatory — see lib/oauth-state.js for why.
 *
 *  - Token exchange: POST https://api.webflow.com/oauth/access_token
 *    Body: { client_id, client_secret, code, redirect_uri, grant_type }.
 *    `redirect_uri` must exactly match the value sent in the authorize
 *    step, or Webflow returns invalid_grant (confirmed live via WebFetch).
 *    The authorization `code` is single-use and expires in 15 minutes per
 *    Webflow's docs.
 *
 *    `grant_type: "authorization_code"` is NOT documented on the
 *    docs.webflow.com pages reachable this session (WebFetch of both
 *    /data/reference/oauth-app and /data/reference/rest-introduction/
 *    quick-start omit it entirely from the listed body parameters) — but
 *    this integration's own smoke test (scripts/smoke-test.js) hit the
 *    REAL https://api.webflow.com/oauth/access_token endpoint with a body
 *    that omitted grant_type and got back a real, live HTTP 400
 *    `unsupported_grant_type` error. That is live-API ground truth
 *    overriding stale/incomplete docs: this client sends
 *    `grant_type: "authorization_code"` because the actual endpoint
 *    requires it, not because any fetched doc page said so. Documented
 *    here explicitly so a future maintainer doesn't "helpfully" remove it
 *    to match the docs.
 *
 *  - Scopes used by this integration: sites:read (list the user's sites),
 *    cms:read (list collections + read their field schema), cms:write
 *    (create the extracted-data item). These three are registered on the
 *    Webflow app itself (in the Developer Portal) and requested here as a
 *    subset — Webflow requires the requested scope set to be a subset of
 *    what's registered on the app, or installation fails.
 *
 * ── What's NOT confirmed (flagged, not assumed) ─────────────────────────
 * The exact JSON shape of a *successful* token-exchange response beyond the
 * `access_token` field, and Webflow's token expiry/revocation behavior,
 * were not pinned down by the docs pages reachable this session — see
 * README's "Token lifecycle" section. This client only depends on
 * `access_token` being present, and treats everything else as opaque.
 */

const AUTHORIZE_URL = "https://webflow.com/oauth/authorize";
const TOKEN_URL = "https://api.webflow.com/oauth/access_token";

const SCOPES = ["sites:read", "cms:read", "cms:write"];

/**
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri
 * @param {string} opts.state - REQUIRED. Callers must obtain this from
 *   lib/oauth-state.js's `createPendingAuthorization` — this function
 *   throws rather than silently building a CSRF-unprotected authorize URL.
 * @param {string[]} [opts.scopes]
 */
function buildAuthorizeUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
  if (!clientId) throw new Error("clientId is required");
  if (!redirectUri) throw new Error("redirectUri is required");
  if (!state) {
    throw new Error(
      "state is required — refusing to build a Webflow authorize URL without CSRF state. " +
        "See lib/oauth-state.js's createPendingAuthorization()."
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchanges a one-time authorization code for an access token.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} opts.code
 * @param {string} opts.redirectUri - must exactly match the authorize step's redirectUri.
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests.
 * @returns {Promise<{access_token: string, [key: string]: any}>}
 */
async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  if (!clientId) throw new Error("clientId is required");
  if (!clientSecret) throw new Error("clientSecret is required");
  if (!code) throw new Error("code is required");
  if (!redirectUri) throw new Error("redirectUri is required");

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    // Deliberately do not interpolate the full `body` into the error/log —
    // Webflow's documented error shape doesn't echo client_secret back, but
    // this guards against a future response-shape change doing so, and
    // matches this integration's "never log secrets" rule.
    const message = (body && (body.message || body.error)) || res.statusText || "unknown error";
    throw new Error(`Webflow token exchange failed: HTTP ${res.status} — ${message}`);
  }
  if (!body.access_token) {
    throw new Error("Webflow token exchange response did not include access_token");
  }
  return body;
}

module.exports = { AUTHORIZE_URL, TOKEN_URL, SCOPES, buildAuthorizeUrl, exchangeCodeForToken };
