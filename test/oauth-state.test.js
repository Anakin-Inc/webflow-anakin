"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPendingAuthorization,
  verifyAndConsumeState,
  generateState,
  STATE_TTL_MS,
} = require("../lib/oauth-state");

// ─── The core property: valid state accepted, tampered/mismatched rejected ──

test("accepts a correctly matching state for the session that issued it", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");
  const result = verifyAndConsumeState(store, "session-A", state);
  assert.deepEqual(result, { ok: true });
});

test("rejects a tampered state (single character flipped)", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");
  const tampered = state.slice(0, -1) + (state.at(-1) === "a" ? "b" : "a");
  const result = verifyAndConsumeState(store, "session-A", tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_mismatch");
});

test("rejects a completely different (attacker-supplied) state value", () => {
  const store = new Map();
  createPendingAuthorization(store, "session-A");
  const attackerState = generateState(); // a real-looking, but unrelated, state
  const result = verifyAndConsumeState(store, "session-A", attackerState);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_mismatch");
});

test("rejects a state that is valid for a DIFFERENT session (cross-session replay)", () => {
  const store = new Map();
  const stateForB = createPendingAuthorization(store, "session-B");
  // Attacker starts their own flow (session-B), captures the resulting
  // state/code, then tries to complete session-A's callback with it.
  createPendingAuthorization(store, "session-A");
  const result = verifyAndConsumeState(store, "session-A", stateForB);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_mismatch");
});

// ─── Missing / malformed inputs ──────────────────────────────────────────

test("rejects when no session id is present at all (no cookie)", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");
  const result = verifyAndConsumeState(store, undefined, state);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_session");
});

test("rejects when the state query param is missing", () => {
  const store = new Map();
  createPendingAuthorization(store, "session-A");
  const result = verifyAndConsumeState(store, "session-A", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_state_param");
});

test("rejects a session with no pending authorization ever created", () => {
  const store = new Map();
  const result = verifyAndConsumeState(store, "never-started-session", "some-state");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_pending_authorization");
});

// ─── Single-use / replay protection ──────────────────────────────────────

test("rejects reuse of an already-consumed (valid) state — replay protection", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");

  const first = verifyAndConsumeState(store, "session-A", state);
  assert.equal(first.ok, true);

  const second = verifyAndConsumeState(store, "session-A", state);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "no_pending_authorization");
});

test("a rejected (mismatched) attempt also consumes the pending entry — no retry oracle", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");

  const wrongAttempt = verifyAndConsumeState(store, "session-A", "totally-wrong-value");
  assert.equal(wrongAttempt.ok, false);

  // Even the CORRECT state now fails, because the single pending slot was
  // consumed by the first (failed) attempt. This prevents an attacker from
  // brute-forcing guesses against a still-live pending authorization.
  const correctAttemptAfter = verifyAndConsumeState(store, "session-A", state);
  assert.equal(correctAttemptAfter.ok, false);
  assert.equal(correctAttemptAfter.reason, "no_pending_authorization");
});

// ─── Expiry ───────────────────────────────────────────────────────────────

test("rejects an expired state (created beyond STATE_TTL_MS)", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");
  // Backdate the entry past the TTL rather than sleeping in a test.
  const entry = store.get("session-A");
  entry.createdAt = Date.now() - (STATE_TTL_MS + 1000);
  store.set("session-A", entry);

  const result = verifyAndConsumeState(store, "session-A", state);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired");
});

test("accepts a state right up to (but not past) the TTL boundary", () => {
  const store = new Map();
  const state = createPendingAuthorization(store, "session-A");
  const entry = store.get("session-A");
  entry.createdAt = Date.now() - (STATE_TTL_MS - 1000); // 1s inside the window
  store.set("session-A", entry);

  const result = verifyAndConsumeState(store, "session-A", state);
  assert.equal(result.ok, true);
});

// ─── Randomness sanity ────────────────────────────────────────────────────

test("generateState produces high-entropy, non-repeating values", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const s = generateState();
    assert.equal(seen.has(s), false, "state value repeated — insufficient entropy or broken RNG");
    seen.add(s);
    // 32 bytes base64url-encoded -> 43 chars, no padding.
    assert.equal(s.length, 43);
    assert.match(s, /^[A-Za-z0-9_-]+$/);
  }
});

test("createPendingAuthorization throws without a store or sessionId (fails closed, not open)", () => {
  assert.throws(() => createPendingAuthorization(null, "session-A"));
  assert.throws(() => createPendingAuthorization(new Map(), undefined));
});
