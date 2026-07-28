"use strict";

const crypto = require("node:crypto");

/**
 * OAuth `state`-parameter CSRF protection.
 *
 * Threat model: without a verified `state`, an attacker can start their own
 * OAuth authorization with Webflow, capture the resulting `code`, and trick
 * a victim's browser into hitting our `/oauth/callback?code=<attacker's
 * code>` (e.g. via an auto-submitting link) — commonly called "login/OAuth
 * CSRF" or authorization-code injection. If the callback accepted that code
 * unconditionally, the victim's browser session would get bound to an
 * installation the attacker controls, and any data the victim later
 * extracts and writes to "their" Webflow site actually flows to the
 * attacker's connected Webflow account. See RFC 6749 §10.12 and OWASP's
 * CSRF cheat sheet, both of which specify exactly this pattern: a
 * server-generated, unguessable, per-flow `state` value that is verified
 * server-side before the code is ever exchanged.
 *
 * This module implements the store-and-verify half of that:
 *   1. `createPendingAuthorization` mints 256 bits of randomness
 *      (crypto.randomBytes — CSPRNG, not Math.random) and stores it
 *      server-side, keyed by the caller's session id (never trust a value
 *      the client could set — the session id itself comes from an httpOnly
 *      cookie minted by lib/session.js).
 *   2. `verifyAndConsumeState` looks up that session's pending state and
 *      compares it against what the OAuth provider echoed back, using
 *      `crypto.timingSafeEqual` (constant-time — same rationale as this
 *      session's github-app-anakin webhook signature check: a length- or
 *      early-exit-based comparison leaks information an attacker could use
 *      to guess the value byte-by-byte). The entry is deleted on first
 *      lookup regardless of outcome, making state single-use — a captured
 *      callback URL (valid or not) cannot be replayed.
 *
 * The `store` parameter is an injected Map-like object (get/set/delete) so
 * this logic is unit-testable without Express or real cookies, and so
 * server.js can swap in a shared store (Redis, etc.) for multi-instance
 * deployments without touching this file — see README's "Known
 * limitations" for why the shipped default (an in-memory Map) is
 * single-instance-only.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes: generous enough to complete Webflow's consent screen, short enough to bound the CSRF window if a stale authorize link leaks (e.g. in a browser history or a proxy log).

function generateState() {
  // 32 bytes = 256 bits of entropy, base64url so it's safely embeddable in
  // a URL query parameter with no further encoding.
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Mints and stores a fresh CSRF state for this session, to be embedded in
 * the Webflow authorize URL's `state` param.
 *
 * @param {Map} store
 * @param {string} sessionId - opaque, server-issued session identifier.
 * @returns {string} the state value to send to Webflow.
 */
function createPendingAuthorization(store, sessionId) {
  if (!store) throw new Error("store is required");
  if (!sessionId) throw new Error("sessionId is required");

  const state = generateState();
  store.set(sessionId, { state, createdAt: Date.now(), used: false });
  return state;
}

/**
 * Verifies the `state` query param Webflow echoed back on `/oauth/callback`
 * against what was stored for this session, and consumes (deletes) the
 * pending entry so it cannot be reused.
 *
 * IMPORTANT: callers must treat any non-`{ok: true}` result as "reject the
 * callback and do not exchange the authorization code" — see server.js's
 * `/oauth/callback` handler, which returns before ever calling
 * `exchangeCodeForToken` on a non-ok result.
 *
 * @param {Map} store
 * @param {string|undefined} sessionId
 * @param {string|undefined} providedState - the `state` query param from Webflow's redirect.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyAndConsumeState(store, sessionId, providedState) {
  if (!store) throw new Error("store is required");
  if (!sessionId) return { ok: false, reason: "missing_session" };
  if (!providedState || typeof providedState !== "string") {
    return { ok: false, reason: "missing_state_param" };
  }

  const entry = store.get(sessionId);
  if (!entry) {
    // Either no authorization was ever started for this session, it was
    // already consumed by a prior callback, or it was evicted by a
    // process restart (in-memory store — see README). All three collapse
    // to the same safe outcome: reject.
    return { ok: false, reason: "no_pending_authorization" };
  }

  // Single-use: delete immediately, before evaluating match/expiry, so a
  // replay of this exact callback URL (valid or not) always lands in the
  // "no_pending_authorization" branch above on its second attempt.
  store.delete(sessionId);

  if (Date.now() - entry.createdAt > STATE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }

  const expected = Buffer.from(entry.state, "utf8");
  const actual = Buffer.from(providedState, "utf8");

  // timingSafeEqual throws on length mismatch, so check that explicitly
  // first. This leaks only length, never digest/content — the same
  // accepted tradeoff used in lib/verify-signature.js in github-app-anakin
  // and endorsed by GitHub's own webhook-verification docs.
  if (expected.length !== actual.length) {
    return { ok: false, reason: "state_mismatch" };
  }
  if (!crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "state_mismatch" };
  }

  return { ok: true };
}

module.exports = {
  STATE_TTL_MS,
  generateState,
  createPendingAuthorization,
  verifyAndConsumeState,
};
