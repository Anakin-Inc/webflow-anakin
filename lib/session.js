"use strict";

const crypto = require("node:crypto");
const cookie = require("cookie");

/**
 * Minimal opaque-session-id cookie handling.
 *
 * Deliberately NOT a JWT or signed cookie: the cookie value carries no
 * information the client could usefully forge (it's a random lookup key
 * into `pendingAuthorizations`/`installations`, both server-side stores),
 * so there's nothing gained by signing it — the security boundary is
 * `httpOnly` (JS on the page can never read it) + `sameSite=lax` (sent on
 * top-level GET navigations, which is what Webflow's redirect back to
 * `/oauth/callback` is, but not on cross-site subresource/XHR requests)
 * + `secure` in production (never sent over plaintext HTTP).
 *
 * `sameSite=lax` rather than `strict` is a deliberate, documented choice:
 * `strict` cookies are not sent on the top-level navigation Webflow uses to
 * redirect the browser back to `/oauth/callback`, which would break the
 * flow entirely in some browsers. `lax` still blocks the cookie on
 * cross-site POST/XHR/subresource requests, which is the CSRF-relevant
 * case — the `state` check in lib/oauth-state.js is the actual CSRF
 * defense; this cookie policy is defense in depth around it, not a
 * substitute for it.
 */

const COOKIE_NAME = "wf_anakin_session";
const COOKIE_MAX_AGE_S = 10 * 60; // matches oauth-state's STATE_TTL_MS

function generateSessionId() {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Reads the session id from the request's cookie header, if present.
 * @param {import('http').IncomingMessage} req
 */
function readSessionId(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed[COOKIE_NAME] || null;
}

/**
 * Ensures the response carries a session cookie, returning the session id
 * that is (or will be, once the response is sent) associated with this
 * browser. Idempotent: reuses an existing valid-looking cookie rather than
 * minting a new one on every request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{secure?: boolean}} [opts]
 */
function ensureSession(req, res, { secure = process.env.NODE_ENV === "production" } = {}) {
  let sessionId = readSessionId(req);
  if (!sessionId) {
    sessionId = generateSessionId();
    res.setHeader(
      "Set-Cookie",
      cookie.serialize(COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_MAX_AGE_S,
      })
    );
  }
  return sessionId;
}

module.exports = { COOKIE_NAME, generateSessionId, readSessionId, ensureSession };
