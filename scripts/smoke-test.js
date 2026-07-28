"use strict";

/**
 * Starts the real server as a child process and drives the real
 * /install -> /oauth/callback HTTP flow with real cookies, proving the
 * CSRF `state` check actually gates access — not just that a mismatched
 * request happens to get a different status code, but that it never even
 * reaches the Webflow token-exchange network call.
 *
 * This deliberately uses FAKE Webflow credentials
 * (WEBFLOW_CLIENT_ID/WEBFLOW_CLIENT_SECRET). For the *valid*-state case,
 * that means the state check passes and the server goes on to make a real
 * HTTPS call to https://api.webflow.com/oauth/access_token, which Webflow
 * will reject (real 400, since the client_id/secret/code are fake) — this
 * script asserts on that real rejection (502 from our server, wrapping
 * Webflow's real error) specifically to prove the token-exchange code path
 * executes for real when state verification passes, mirroring the same
 * "exercise the real path, don't bypass it" standard used by
 * github-app-anakin's smoke test for webhook signatures.
 *
 * For the *invalid*-state cases, the key assertion is NOT the HTTP status
 * alone — it's `GET /__test__/counters` (a test-only route mounted only
 * when EXPOSE_TEST_COUNTERS=1) confirming `tokenExchangeAttempts` never
 * incremented. That is the actual security property: state verification
 * must run and reject *before* the code is ever exchanged, not just
 * before the response is returned to the browser.
 *
 * Run: node scripts/smoke-test.js
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const PORT = 3918;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`${name}=([^;]+)`));
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

function waitForHealth(deadlineMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() - start < deadlineMs) {
        try {
          const res = await fetch(`${BASE_URL}/healthz`);
          if (res.ok) return resolve();
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error("server did not become healthy in time"));
    })();
  });
}

async function getCounters() {
  const res = await fetch(`${BASE_URL}/__test__/counters`);
  return res.json();
}

/** Drives /install and returns { sessionCookie, state, location }. */
async function startInstall() {
  const res = await fetch(`${BASE_URL}/install`, { redirect: "manual" });
  const sessionCookie = extractCookie(res.headers.get("set-cookie"), "wf_anakin_session");
  const location = res.headers.get("location");
  const state = location ? new URL(location).searchParams.get("state") : null;
  return { status: res.status, sessionCookie, location, state };
}

async function callback({ sessionCookie, code, state }) {
  const params = new URLSearchParams();
  if (code !== undefined) params.set("code", code);
  if (state !== undefined) params.set("state", state);
  const res = await fetch(`${BASE_URL}/oauth/callback?${params.toString()}`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "development",
      EXPOSE_TEST_COUNTERS: "1",
      // Deliberately fake — see file header. Real enough shape to reach
      // Webflow's real token endpoint and get a real rejection.
      WEBFLOW_CLIENT_ID: "smoke-test-fake-client-id",
      WEBFLOW_CLIENT_SECRET: "smoke-test-fake-client-secret",
      WEBFLOW_REDIRECT_URI: `${BASE_URL}/oauth/callback`,
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ANAKIN_API_KEY: "fake-smoke-test-key-not-real",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const results = [];
  let exitCode = 0;

  try {
    await waitForHealth(5000);
    console.log("server is up, running OAuth CSRF-state exercises...\n");

    // ── 0. Baseline: /install redirects to the real Webflow authorize host,
    //    with a state param present, and sets a session cookie. ──────────
    const install1 = await startInstall();
    results.push([
      "GET /install redirects to webflow.com/oauth/authorize with a state param + session cookie",
      install1.status === 302 &&
        !!install1.sessionCookie &&
        !!install1.state &&
        install1.location.startsWith("https://webflow.com/oauth/authorize"),
      install1,
    ]);

    const countersBefore = await getCounters();

    // ── 1. VALID state -> must pass the CSRF check and reach the real
    //    Webflow token-exchange call (which then fails for real, since the
    //    client credentials are fake — 502 from our server wrapping that
    //    real rejection). Confirms the accept path is real, not stubbed. ──
    const validAttempt = await callback({
      sessionCookie: install1.sessionCookie,
      code: "smoke-test-fake-auth-code",
      state: install1.state,
    });
    results.push([
      "valid state -> passes CSRF check, reaches real Webflow token exchange (502 = real rejection, not a CSRF 403)",
      validAttempt.status === 502 && validAttempt.body && validAttempt.body.error === "token_exchange_failed",
      validAttempt,
    ]);

    const countersAfterValid = await getCounters();
    results.push([
      "valid-state attempt incremented tokenExchangeAttempts by exactly 1",
      countersAfterValid.tokenExchangeAttempts === countersBefore.tokenExchangeAttempts + 1,
      countersAfterValid,
    ]);

    // ── 2. REPLAY of the same (now-consumed) valid state -> must be
    //    rejected, and must NOT attempt a second token exchange. ─────────
    const replayAttempt = await callback({
      sessionCookie: install1.sessionCookie,
      code: "smoke-test-fake-auth-code",
      state: install1.state,
    });
    results.push([
      "replaying the already-used valid state is rejected (403, no_pending_authorization)",
      replayAttempt.status === 403 && replayAttempt.body && replayAttempt.body.reason === "no_pending_authorization",
      replayAttempt,
    ]);

    // ── 3. TAMPERED state (fresh session, so it's not a replay case) ─────
    const install2 = await startInstall();
    const tamperedState = install2.state.slice(0, -4) + "XXXX"; // corrupt the trailing chars
    const tamperedAttempt = await callback({
      sessionCookie: install2.sessionCookie,
      code: "smoke-test-fake-auth-code",
      state: tamperedState,
    });
    results.push([
      "tampered state is rejected with 403 state_mismatch",
      tamperedAttempt.status === 403 && tamperedAttempt.body && tamperedAttempt.body.reason === "state_mismatch",
      tamperedAttempt,
    ]);

    const countersAfterTampered = await getCounters();
    results.push([
      "tampered-state attempt did NOT increment tokenExchangeAttempts (rejected BEFORE the network call)",
      countersAfterTampered.tokenExchangeAttempts === countersAfterValid.tokenExchangeAttempts,
      countersAfterTampered,
    ]);

    // ── 4. Attacker-controlled state from a DIFFERENT session (cross-
    //    session CSRF: attacker starts their own flow, tries to bind it to
    //    the victim's session). ───────────────────────────────────────────
    const install3 = await startInstall();
    const install4 = await startInstall(); // a second, unrelated pending authorization
    const crossSessionAttempt = await callback({
      sessionCookie: install3.sessionCookie,
      code: "smoke-test-fake-auth-code",
      state: install4.state, // valid state, but for install4's session, not install3's
    });
    results.push([
      "a state valid for a different session is rejected (403 state_mismatch) — cross-session CSRF blocked",
      crossSessionAttempt.status === 403 && crossSessionAttempt.body && crossSessionAttempt.body.reason === "state_mismatch",
      crossSessionAttempt,
    ]);

    // ── 5. No session cookie at all (e.g. attacker crafts a bare callback
    //    link and gets a victim to click it directly, with no prior
    //    /install on that browser). ──────────────────────────────────────
    const noCookieAttempt = await callback({ sessionCookie: null, code: "x", state: "y" });
    results.push([
      "missing session cookie entirely is rejected (403 missing_session)",
      noCookieAttempt.status === 403 && noCookieAttempt.body && noCookieAttempt.body.reason === "missing_session",
      noCookieAttempt,
    ]);

    const countersFinal = await getCounters();
    results.push([
      "total tokenExchangeAttempts across the whole run is exactly 1 (only the single valid attempt)",
      countersFinal.tokenExchangeAttempts === 1,
      countersFinal,
    ]);
  } catch (err) {
    console.error("smoke test crashed:", err);
    exitCode = 1;
  } finally {
    child.kill();
  }

  console.log("--- results ---");
  for (const [label, pass, detail] of results) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) {
      console.log("       detail:", JSON.stringify(detail));
      exitCode = 1;
    }
  }

  console.log("\n--- server stdout ---\n" + stdout.trim());
  console.log("\n--- server stderr ---\n" + stderr.trim());

  process.exit(exitCode);
}

main();
