"use strict";

const crypto = require("node:crypto");

/**
 * Token storage: design + reference implementation.
 *
 * ── What's real vs a placeholder ────────────────────────────────────────
 * The ENCRYPTION is real and tested (see test/token-store.test.js): access
 * tokens are AES-256-GCM-encrypted before they ever reach `_backend.set`,
 * with a key that must come from the environment (`TOKEN_ENCRYPTION_KEY`) —
 * there is no code path that stores a plaintext token.
 *
 * The BACKEND is a placeholder: `_backend` defaults to an in-memory `Map`,
 * which is not durable (lost on restart) and not safe across multiple
 * server instances. Swap it for a real store (Postgres, DynamoDB, etc. —
 * anything with per-row storage) before shipping to production; the
 * constructor accepts any object exposing `get(key)`/`set(key, value)`/
 * `delete(key)`, so a real backend is a drop-in `backend:` option, not a
 * rewrite of this file. This split — real crypto boundary, swappable
 * storage boundary — is the security-relevant design decision; getting the
 * boundary in the wrong place (e.g. encrypting inside a specific DB
 * driver's code, so a future backend swap could accidentally reintroduce
 * plaintext storage) is the mistake this structure is meant to prevent.
 *
 * ── Security properties this design guarantees ──────────────────────────
 *  - Access tokens are encrypted at rest with AES-256-GCM. The backend
 *    (whatever it ends up being) only ever sees ciphertext + a random IV +
 *    an auth tag, never the raw token.
 *  - The encryption key is 32 bytes from `TOKEN_ENCRYPTION_KEY` (env / a
 *    secrets manager in production) — never hardcoded, never derived from
 *    a guessable value, never logged (see `loadKey` below — it reads the
 *    env var and nothing else touches it).
 *  - GCM's authentication tag means a corrupted or tampered ciphertext
 *    (e.g. a bit-flipped DB row, or an attempt to splice a different
 *    ciphertext's ivar) fails `decrypt` loudly (throws) instead of
 *    silently returning garbage bytes that get sent to Webflow as a
 *    "valid" bearer token.
 *  - Decrypted tokens are only ever returned from `TokenStore.get()`,
 *    called exclusively from server-side request handlers in server.js
 *    that build a `WebflowClient` — no HTTP route returns a token value to
 *    the browser. The browser only ever holds an opaque `installationId`
 *    (a random UUID, itself meaningless without server-side access to this
 *    store) in an httpOnly cookie (see lib/session.js's cookie policy,
 *    which applies the same way to the installation-id cookie in
 *    server.js).
 *  - Tokens are never written to logs: server.js's logging helper
 *    (`log`/`logError`) is only ever called with installationId, event
 *    names, and error `.message` strings built from those — never with a
 *    token or a raw `state`/session id.
 *
 * ── Not covered by this design (flagged, not silently skipped) ─────────
 *  - Key rotation. Rotating `TOKEN_ENCRYPTION_KEY` as shipped here would
 *    make every previously-stored token undecryptable. A production
 *    version needs either envelope encryption (a KMS-managed key that
 *    wraps per-token data keys, so the root key can rotate without
 *    re-encrypting every row) or an explicit re-encryption migration path.
 *  - Revocation/expiry bookkeeping beyond what Webflow itself enforces —
 *    see README's "Token lifecycle" section for what's confirmed vs not
 *    about Webflow token expiry.
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — the size GCM is defined/recommended for.
const AUTH_TAG_LENGTH = 16;

function loadKey(rawFromEnv = process.env.TOKEN_ENCRYPTION_KEY) {
  if (!rawFromEnv) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  const key = Buffer.from(rawFromEnv, "base64");
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}).`);
  }
  return key;
}

/**
 * @param {string} plaintext
 * @param {Buffer} key - 32 bytes.
 * @returns {string} base64(iv || authTag || ciphertext)
 */
function encryptToken(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * @param {string} blob - output of encryptToken.
 * @param {Buffer} key - 32 bytes.
 * @returns {string} plaintext
 * @throws if the key is wrong or the blob was tampered with (GCM auth tag check fails).
 */
function decryptToken(blob, key) {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Malformed token ciphertext (too short)");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

class TokenStore {
  /**
   * @param {object} [opts]
   * @param {Buffer} [opts.key] - defaults to loadKey() (reads TOKEN_ENCRYPTION_KEY).
   * @param {{get: Function, set: Function, delete: Function}} [opts.backend] - defaults to an in-memory Map (see file header — swap for a real DB before production).
   */
  constructor({ key, backend } = {}) {
    this._key = key || loadKey();
    this._backend = backend || new Map();
  }

  /**
   * @param {string} installationId - opaque random id, never the token itself.
   * @param {string} accessToken
   * @param {object} [metadata] - non-secret fields (e.g. installedAt) stored alongside the ciphertext.
   */
  put(installationId, accessToken, metadata = {}) {
    if (!installationId) throw new Error("installationId is required");
    if (!accessToken) throw new Error("accessToken is required");
    const encrypted = encryptToken(accessToken, this._key);
    this._backend.set(installationId, { encrypted, ...metadata, storedAt: Date.now() });
  }

  /**
   * @param {string} installationId
   * @returns {string|null} the decrypted access token, or null if not found.
   */
  get(installationId) {
    const row = this._backend.get(installationId);
    if (!row) return null;
    return decryptToken(row.encrypted, this._key);
  }

  delete(installationId) {
    this._backend.delete(installationId);
  }
}

module.exports = { TokenStore, encryptToken, decryptToken, loadKey, ALGO, IV_LENGTH, AUTH_TAG_LENGTH };
