"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAuthorizeUrl, exchangeCodeForToken, SCOPES, AUTHORIZE_URL, TOKEN_URL } = require("../lib/webflow-auth");

test("buildAuthorizeUrl targets the real Webflow authorize host/path", () => {
  const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://example.com/cb", state: "s1" }));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, AUTHORIZE_URL);
});

test("buildAuthorizeUrl includes response_type=code, client_id, redirect_uri, scope, and state", () => {
  const url = new URL(buildAuthorizeUrl({ clientId: "my-client-id", redirectUri: "https://example.com/cb", state: "my-state-value" }));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "my-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/cb");
  assert.equal(url.searchParams.get("state"), "my-state-value");
  assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
});

test("requested scopes are exactly sites:read, cms:read, cms:write (this integration's minimum, per README)", () => {
  assert.deepEqual(SCOPES, ["sites:read", "cms:read", "cms:write"]);
});

test("buildAuthorizeUrl refuses to build a link without state (CSRF-protection-by-construction)", () => {
  assert.throws(
    () => buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://example.com/cb", state: undefined }),
    /state is required/
  );
});

test("buildAuthorizeUrl requires clientId and redirectUri", () => {
  assert.throws(() => buildAuthorizeUrl({ redirectUri: "https://example.com/cb", state: "s" }), /clientId/);
  assert.throws(() => buildAuthorizeUrl({ clientId: "cid", state: "s" }), /redirectUri/);
});

// ─── Token exchange (fetch is injected — no real network call in unit tests) ──

test("exchangeCodeForToken POSTs to the real Webflow token endpoint with the documented body shape", async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: "wf_token_123" }),
    };
  };

  const result = await exchangeCodeForToken({
    clientId: "cid",
    clientSecret: "secret",
    code: "auth-code",
    redirectUri: "https://example.com/cb",
    fetchImpl: fakeFetch,
  });

  assert.equal(captured.url, TOKEN_URL);
  assert.equal(captured.init.method, "POST");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, {
    client_id: "cid",
    client_secret: "secret",
    code: "auth-code",
    redirect_uri: "https://example.com/cb",
    grant_type: "authorization_code",
  });
  assert.equal(result.access_token, "wf_token_123");
});

test("exchangeCodeForToken throws on a non-ok HTTP response", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => JSON.stringify({ message: "invalid_grant" }),
  });

  await assert.rejects(
    () =>
      exchangeCodeForToken({
        clientId: "cid",
        clientSecret: "secret",
        code: "bad-code",
        redirectUri: "https://example.com/cb",
        fetchImpl: fakeFetch,
      }),
    /invalid_grant/
  );
});

test("exchangeCodeForToken throws if the response is ok but has no access_token", async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({}) });
  await assert.rejects(
    () =>
      exchangeCodeForToken({
        clientId: "cid",
        clientSecret: "secret",
        code: "code",
        redirectUri: "https://example.com/cb",
        fetchImpl: fakeFetch,
      }),
    /did not include access_token/
  );
});

test("exchangeCodeForToken requires all four parameters", async () => {
  await assert.rejects(() => exchangeCodeForToken({ clientSecret: "s", code: "c", redirectUri: "r" }), /clientId/);
  await assert.rejects(() => exchangeCodeForToken({ clientId: "c", code: "c", redirectUri: "r" }), /clientSecret/);
  await assert.rejects(() => exchangeCodeForToken({ clientId: "c", clientSecret: "s", redirectUri: "r" }), /code/);
  await assert.rejects(() => exchangeCodeForToken({ clientId: "c", clientSecret: "s", code: "c" }), /redirectUri/);
});
