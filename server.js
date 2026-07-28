"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const cookie = require("cookie");

const { ensureSession, readSessionId, COOKIE_NAME: SESSION_COOKIE } = require("./lib/session");
const { createPendingAuthorization, verifyAndConsumeState } = require("./lib/oauth-state");
const { buildAuthorizeUrl, exchangeCodeForToken } = require("./lib/webflow-auth");
const { WebflowClient } = require("./lib/webflow-client");
const { TokenStore } = require("./lib/token-store");
const { AnakinClient } = require("./lib/anakin-client");
const { buildExtractionSchema, mapToFieldData } = require("./lib/extraction");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const WEBFLOW_CLIENT_ID = process.env.WEBFLOW_CLIENT_ID;
const WEBFLOW_CLIENT_SECRET = process.env.WEBFLOW_CLIENT_SECRET;
const WEBFLOW_REDIRECT_URI = process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback";

const ANAKIN_API_KEY = process.env.ANAKIN_API_KEY;
const ANAKIN_BASE_URL = process.env.ANAKIN_BASE_URL || "https://api.anakin.io/v1";

const INSTALLATION_COOKIE = "wf_anakin_installation";

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[webflow-anakin]", ...args);
}

function logError(...args) {
  // eslint-disable-next-line no-console
  console.error("[webflow-anakin]", ...args);
}

// ─── Server-side state (see README's "Known limitations": in-memory, ──────
// single-instance only — swap for Redis/a shared store before scaling out).
const pendingAuthorizations = new Map(); // sessionId -> {state, createdAt}
let tokenStore; // constructed lazily so a missing TOKEN_ENCRYPTION_KEY doesn't crash `require("./server")` in tests that don't need it.
function getTokenStore() {
  if (!tokenStore) tokenStore = new TokenStore();
  return tokenStore;
}

// Test-only instrumentation: counts how many times exchangeCodeForToken was
// invoked, so scripts/smoke-test.js can prove the CSRF state check gates
// the network call rather than merely returning a different HTTP status.
// Never mounted/incremented meaningfully outside NODE_ENV !== "production".
const counters = { tokenExchangeAttempts: 0 };

function buildAnakinClient() {
  return new AnakinClient({ apiKey: ANAKIN_API_KEY, baseUrl: ANAKIN_BASE_URL });
}

function readInstallationId(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed[INSTALLATION_COOKIE] || null;
}

function requireInstallation(req, res, next) {
  const installationId = readInstallationId(req);
  if (!installationId) {
    res.status(401).json({ error: "not_installed", message: "No Webflow installation linked to this browser session. Visit /install first." });
    return;
  }
  const accessToken = getTokenStore().get(installationId);
  if (!accessToken) {
    res.status(401).json({ error: "installation_not_found", message: "Installation not found or was disconnected. Visit /install again." });
    return;
  }
  req.webflowClient = new WebflowClient({ accessToken });
  req.installationId = installationId;
  next();
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Starts the OAuth flow. Mints a CSRF `state`, stores it server-side keyed
 * by a fresh (or existing) session cookie, and redirects to Webflow's
 * authorize screen. See lib/oauth-state.js for the threat model this
 * defends against.
 */
app.get("/install", (req, res) => {
  if (!WEBFLOW_CLIENT_ID) {
    res.status(500).json({ error: "server_misconfigured", message: "WEBFLOW_CLIENT_ID is not set" });
    return;
  }
  const sessionId = ensureSession(req, res);
  const state = createPendingAuthorization(pendingAuthorizations, sessionId);
  const url = buildAuthorizeUrl({
    clientId: WEBFLOW_CLIENT_ID,
    redirectUri: WEBFLOW_REDIRECT_URI,
    state,
  });
  log("redirecting to Webflow authorize screen");
  res.redirect(302, url);
});

/**
 * OAuth callback. Verifies `state` BEFORE ever calling exchangeCodeForToken
 * — this ordering is the actual security property under test in
 * test/oauth-state.test.js and scripts/smoke-test.js: a mismatched/missing
 * state must short-circuit before any network call to Webflow's token
 * endpoint, not merely before the response is trusted.
 */
app.get("/oauth/callback", async (req, res) => {
  const sessionId = readSessionId(req);
  const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query;

  if (oauthError) {
    // User declined consent, or Webflow rejected the request for a reason
    // unrelated to CSRF (e.g. invalid scope). Not a security event.
    log("Webflow returned an OAuth error:", oauthError);
    res.status(400).send(`Webflow authorization was not completed: ${oauthError}${oauthErrorDescription ? ` — ${oauthErrorDescription}` : ""}`);
    return;
  }

  const verification = verifyAndConsumeState(pendingAuthorizations, sessionId, typeof state === "string" ? state : undefined);
  if (!verification.ok) {
    // Deliberately do not log the raw `state`/session values (they're
    // capability-bearing while still pending) — only the non-secret reason
    // code and a boolean outcome.
    logError("OAuth callback rejected before token exchange — reason:", verification.reason);
    res.status(403).json({ error: "csrf_state_verification_failed", reason: verification.reason });
    return;
  }

  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "missing_code" });
    return;
  }

  if (!WEBFLOW_CLIENT_ID || !WEBFLOW_CLIENT_SECRET) {
    res.status(500).json({ error: "server_misconfigured", message: "WEBFLOW_CLIENT_ID/WEBFLOW_CLIENT_SECRET not set" });
    return;
  }

  counters.tokenExchangeAttempts += 1;
  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken({
      clientId: WEBFLOW_CLIENT_ID,
      clientSecret: WEBFLOW_CLIENT_SECRET,
      code,
      redirectUri: WEBFLOW_REDIRECT_URI,
    });
  } catch (err) {
    // Never log `err` if it might contain the code/secret — this client's
    // errors (lib/webflow-auth.js) are built from status + a short message
    // only, never the request body, so this is safe.
    logError("token exchange failed:", err.message);
    res.status(502).json({ error: "token_exchange_failed" });
    return;
  }

  const installationId = crypto.randomUUID();
  getTokenStore().put(installationId, tokenResponse.access_token, { installedAt: Date.now() });

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(INSTALLATION_COOKIE, installationId, {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    })
  );

  log("installation complete:", installationId);
  // The response intentionally never includes the access token or the
  // installationId in a form JS on the page could exfiltrate beyond this
  // httpOnly cookie — the page body below is static text.
  res.status(200).send("Webflow connected. You can close this tab and return to the app.");
});

app.get("/api/sites", requireInstallation, async (req, res) => {
  try {
    const sites = await req.webflowClient.listSites();
    res.json({ sites });
  } catch (err) {
    logError("listSites failed:", err.message);
    res.status(502).json({ error: "webflow_api_error", message: err.message });
  }
});

app.get("/api/sites/:siteId/collections", requireInstallation, async (req, res) => {
  try {
    const collections = await req.webflowClient.listCollections(req.params.siteId);
    res.json({ collections });
  } catch (err) {
    logError("listCollections failed:", err.message);
    res.status(502).json({ error: "webflow_api_error", message: err.message });
  }
});

app.get("/api/collections/:collectionId", requireInstallation, async (req, res) => {
  try {
    const collection = await req.webflowClient.getCollection(req.params.collectionId);
    res.json(collection);
  } catch (err) {
    logError("getCollection failed:", err.message);
    res.status(502).json({ error: "webflow_api_error", message: err.message });
  }
});

/**
 * The core feature: scrape `sourceUrl` with Anakin (generateJson targeted
 * at the destination collection's field schema), map the result onto that
 * collection's fieldData (allowlisted — see lib/extraction.js), and create
 * the item via Webflow's Data API.
 *
 * Body: { collectionId: string, sourceUrl: string, publish?: boolean }
 * `publish` defaults to false — created items are drafts unless the caller
 * explicitly opts in to publishing scraped content live (see
 * WebflowClient.createItem's isDraft default and rationale).
 */
app.post("/api/extract", requireInstallation, async (req, res) => {
  const { collectionId, sourceUrl, publish } = req.body || {};
  if (!collectionId || typeof collectionId !== "string") {
    res.status(400).json({ error: "missing_collectionId" });
    return;
  }
  if (!sourceUrl || typeof sourceUrl !== "string") {
    res.status(400).json({ error: "missing_sourceUrl" });
    return;
  }
  if (!ANAKIN_API_KEY) {
    res.status(500).json({ error: "server_misconfigured", message: "ANAKIN_API_KEY is not set" });
    return;
  }

  try {
    const collection = await req.webflowClient.getCollection(collectionId);
    const schema = buildExtractionSchema(collection);

    const anakin = buildAnakinClient();
    const doc = await anakin.scrapeUrl(sourceUrl, { generateJson: true, schema, formats: ["markdown"] });

    const fieldData = mapToFieldData(collection, doc.generatedJson, { sourceUrl });
    const item = await req.webflowClient.createItem(collectionId, fieldData, { isDraft: !publish });

    res.status(201).json({ item, isDraft: !publish });
  } catch (err) {
    logError("extract failed:", err.message);
    res.status(502).json({ error: "extraction_failed", message: err.message });
  }
});

// Test-only route: exposes the token-exchange attempt counter so
// scripts/smoke-test.js can assert the CSRF check gates the network call.
// Never mounted in production.
if (NODE_ENV !== "production" && process.env.EXPOSE_TEST_COUNTERS === "1") {
  app.get("/__test__/counters", (_req, res) => {
    res.json(counters);
  });
}

if (require.main === module) {
  app.listen(PORT, () => {
    log(`listening on :${PORT} (env=${NODE_ENV})`);
  });
}

module.exports = {
  app,
  pendingAuthorizations,
  counters,
  getTokenStore,
};
