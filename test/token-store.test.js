"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { TokenStore, encryptToken, decryptToken, loadKey } = require("../lib/token-store");

function randomKey() {
  return crypto.randomBytes(32);
}

test("round-trips a token through encrypt/decrypt", () => {
  const key = randomKey();
  const token = "wf_secret_access_token_abc123";
  const blob = encryptToken(token, key);
  assert.notEqual(blob, token); // never stores plaintext
  assert.equal(decryptToken(blob, key), token);
});

test("the encrypted blob does not contain the plaintext token as a substring", () => {
  const key = randomKey();
  const token = "wf_secret_access_token_abc123";
  const blob = encryptToken(token, key);
  assert.equal(blob.includes(token), false);
  assert.equal(Buffer.from(blob, "base64").toString("latin1").includes(token), false);
});

test("decrypting with the wrong key throws instead of returning garbage", () => {
  const key = randomKey();
  const wrongKey = randomKey();
  const blob = encryptToken("wf_secret_access_token_abc123", key);
  assert.throws(() => decryptToken(blob, wrongKey));
});

test("a tampered ciphertext fails the GCM auth tag check (throws, doesn't silently decrypt)", () => {
  const key = randomKey();
  const blob = encryptToken("wf_secret_access_token_abc123", key);
  const buf = Buffer.from(blob, "base64");
  // Flip a bit inside the ciphertext region (after the 12-byte IV + 16-byte auth tag).
  buf[buf.length - 1] ^= 0xff;
  const tampered = buf.toString("base64");
  assert.throws(() => decryptToken(tampered, key));
});

test("each encryption uses a fresh IV, so identical plaintexts produce different ciphertexts", () => {
  const key = randomKey();
  const a = encryptToken("same-token-value", key);
  const b = encryptToken("same-token-value", key);
  assert.notEqual(a, b);
});

test("loadKey rejects a missing env var", () => {
  assert.throws(() => loadKey(undefined), /TOKEN_ENCRYPTION_KEY is not set/);
});

test("loadKey rejects a key that doesn't decode to exactly 32 bytes", () => {
  const shortKey = Buffer.from("too-short").toString("base64");
  assert.throws(() => loadKey(shortKey), /32 bytes/);
});

test("loadKey accepts a well-formed 32-byte base64 key", () => {
  const key = randomKey().toString("base64");
  assert.doesNotThrow(() => loadKey(key));
});

// ─── TokenStore integration (backend is an injected Map — see file header) ──

test("TokenStore.put/get round-trips via an injected in-memory backend", () => {
  const store = new TokenStore({ key: randomKey(), backend: new Map() });
  store.put("install-1", "wf_real_token_value");
  assert.equal(store.get("install-1"), "wf_real_token_value");
});

test("TokenStore's backend never holds the plaintext token", () => {
  const backend = new Map();
  const store = new TokenStore({ key: randomKey(), backend });
  store.put("install-1", "wf_real_token_value");
  const row = backend.get("install-1");
  assert.equal(row.encrypted.includes("wf_real_token_value"), false);
  assert.equal(typeof row.encrypted, "string");
});

test("TokenStore.get returns null for an unknown installationId", () => {
  const store = new TokenStore({ key: randomKey() });
  assert.equal(store.get("does-not-exist"), null);
});

test("TokenStore.delete removes the row", () => {
  const store = new TokenStore({ key: randomKey() });
  store.put("install-1", "wf_real_token_value");
  store.delete("install-1");
  assert.equal(store.get("install-1"), null);
});

test("a TokenStore built with a different key cannot decrypt another instance's rows", () => {
  const backend = new Map();
  const storeA = new TokenStore({ key: randomKey(), backend });
  storeA.put("install-1", "wf_real_token_value");

  const storeB = new TokenStore({ key: randomKey(), backend });
  assert.throws(() => storeB.get("install-1"));
});
