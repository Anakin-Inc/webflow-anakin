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
const { AnakinClient, redactSecrets } = require("./lib/anakin-client");
const { buildExtractionSchema, mapToFieldData } = require("./lib/extraction");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const WEBFLOW_CLIENT_ID = process.env.WEBFLOW_CLIENT_ID;
const WEBFLOW_CLIENT_SECRET = process.env.WEBFLOW_CLIENT_SECRET;
const WEBFLOW_REDIRECT_URI = process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback";

const ANAKIN_API_KEY = process.env.ANAKIN_API_KEY;
const ANAKIN_BASE_URL = process.env.ANAKIN_BASE_URL || "https://api.anakin.io/v1";

const INSTALLATION_COOKIE = "wf_anakin_installation";

// This app's own ceiling on POST /api/discover/crawl's maxPages, tighter
// than Anakin's own 1-500 range. Anakin's /crawl job is polled synchronously
// (this Express request stays open for the whole poll, up to pollTimeoutMs),
// and many hosts enforce a proxy/idle timeout well under that — see
// README's "Known limitations". A future version should return 202 + a
// poll endpoint instead of holding the connection open; until then, keep
// worst-case latency bounded.
const MAX_CRAWL_PAGES = 50;

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

/** Shared 500 guard for every route below that calls Anakin. Returns false (and has already responded) if misconfigured. */
function requireAnakinApiKey(res) {
  if (!ANAKIN_API_KEY) {
    res.status(500).json({ error: "server_misconfigured", message: "ANAKIN_API_KEY is not set" });
    return false;
  }
  return true;
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

// ─── Anakin capability passthrough routes ──────────────────────────────────
//
// Extends this app's API surface beyond scrape (POST /api/extract) to the
// rest of Anakin's REST API that plausibly serves a CMS-population use
// case: site-structure discovery (map/crawl), structured extraction from
// Anakin's pre-built site catalog (Wire read actions), AI-answer-engine
// content research (AI Visibility), and change tracking for already-
// imported source pages (monitors). Every route below is gated behind the
// same `requireInstallation` middleware as the Webflow-backed routes above
// — even though these specific calls only need `ANAKIN_API_KEY`, not the
// Webflow access token — so the auth boundary for this server stays a
// single, consistent pattern (an unauthenticated caller can't reach any
// /api/* route and spend this deployment's Anakin credits) rather than
// splitting into "routes that need a Webflow installation" vs "routes that
// don't." None of this touches lib/oauth-state.js or lib/token-store.js.
//
// Deliberately NOT added (see README for the full reasoning):
//   - wire_write_action, wire_login, wire_build — state-changing or
//     credential-establishing Wire operations; out of scope for an
//     unattended CMS-population pipeline.
//   - session_delete — destructive, and not needed to *read* CMS content.
//   - browser_task — open-ended agentic browser automation; no bounded
//     CMS-population shape.

/**
 * POST /api/discover/map — body { url, limit?, depth?, limitPerLevel?,
 * includeSubdomains?, includeExternalLinks?, useBrowser?, search? }.
 * Discovers a site's reachable URLs, so a site owner can see what a bulk
 * import would cover before spending Anakin credits and Webflow API calls
 * scraping every page individually.
 */
app.post("/api/discover/map", requireInstallation, async (req, res) => {
  const { url, limit, depth, limitPerLevel, includeSubdomains, includeExternalLinks, useBrowser, search } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "missing_url" });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const opts = {};
    if (limit !== undefined) opts.limit = limit;
    if (depth !== undefined) opts.depth = depth;
    if (limitPerLevel !== undefined) opts.limitPerLevel = limitPerLevel;
    if (includeSubdomains !== undefined) opts.includeSubdomains = includeSubdomains;
    if (includeExternalLinks !== undefined) opts.includeExternalLinks = includeExternalLinks;
    if (useBrowser !== undefined) opts.useBrowser = useBrowser;
    if (search !== undefined) opts.search = search;

    const result = await anakin.map(url, opts);
    res.json({
      url: result.url,
      links: result.links,
      totalLinks: result.totalLinks,
      externalLinks: result.externalLinks,
      totalExternalLinks: result.totalExternalLinks,
      durationMs: result.durationMs,
    });
  } catch (err) {
    logError("map failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * POST /api/discover/crawl — body { url, maxPages?, depth?, country?,
 * useBrowser?, includePatterns?, excludePatterns?, sessionId?,
 * sessionName? }. Bulk-fetches page markdown across a site — a preview
 * step ahead of turning pages into CMS items (each page can then be run
 * through POST /api/extract individually, so the AI-extracted fieldData
 * mapping keeps going through extraction.js's collection-schema allowlist
 * rather than being written unvalidated from crawl output).
 */
app.post("/api/discover/crawl", requireInstallation, async (req, res) => {
  const { url, maxPages, depth, country, useBrowser, includePatterns, excludePatterns, sessionId, sessionName } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "missing_url" });
    return;
  }
  if (maxPages !== undefined && (typeof maxPages !== "number" || maxPages > MAX_CRAWL_PAGES || maxPages < 1)) {
    res.status(400).json({
      error: "maxPages_out_of_range",
      message: `maxPages must be a number between 1 and ${MAX_CRAWL_PAGES} (this app's own ceiling, tighter than Anakin's, since the request is held open for the whole poll).`,
    });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const opts = { country: country || "us", useBrowser: !!useBrowser };
    if (maxPages !== undefined) opts.maxPages = maxPages;
    if (depth !== undefined) opts.depth = depth;
    if (includePatterns !== undefined) opts.includePatterns = includePatterns;
    if (excludePatterns !== undefined) opts.excludePatterns = excludePatterns;
    if (sessionId !== undefined) opts.sessionId = sessionId;
    if (sessionName !== undefined) opts.sessionName = sessionName;

    const result = await anakin.crawl(url, opts);
    res.json({
      url: result.url,
      totalPages: result.totalPages,
      completedPages: result.completedPages,
      pages: result.pages,
      durationMs: result.durationMs,
    });
  } catch (err) {
    logError("crawl failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * GET /api/wire/discover?q=&limit= — natural-language intent -> ranked
 * candidate Wire actions. First step before pulling structured data from
 * one of Anakin's pre-built site integrations into a CMS collection.
 */
app.get("/api/wire/discover", requireInstallation, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  if (!q) {
    res.status(400).json({ error: "missing_q" });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const result = await anakin.wireResolve(q, { limit });
    res.json(result);
  } catch (err) {
    logError("wire discover failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * GET /api/wire/catalog and GET /api/wire/catalog/:slug — browse Wire's
 * catalog of pre-built site integrations (no slug: every catalog + action
 * count; with slug: that site's full action list + param schemas).
 */
app.get("/api/wire/catalog", requireInstallation, async (_req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const result = await anakin.wireCatalog();
    res.json(result);
  } catch (err) {
    logError("wire catalog failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

app.get("/api/wire/catalog/:slug", requireInstallation, async (req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const result = await anakin.wireCatalog(req.params.slug);
    res.json(result);
  } catch (err) {
    logError("wire catalog failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * POST /api/wire/read-action — body { actionId, params? }. Runs a Wire
 * READ action only (extracts data; never changes state on the target
 * site) — see the file-header note on why wire_write_action is not
 * exposed here. `actionId` must be a "read"-type action per
 * GET /api/wire/discover or GET /api/wire/catalog/:slug's action list;
 * this route does not itself verify the type (that check lives in Wire's
 * catalog metadata, which the caller inspects before calling this).
 */
app.post("/api/wire/read-action", requireInstallation, async (req, res) => {
  const { actionId, params, credentialId, identityId } = req.body || {};
  if (!actionId || typeof actionId !== "string") {
    res.status(400).json({ error: "missing_actionId" });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const result = await anakin.wireRun(actionId, params || {}, { credentialId, identityId });
    res.json(result);
  } catch (err) {
    logError("wire read-action failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * GET /api/ai-visibility/sources — the roster of AI answer engines
 * available to POST /api/ai-visibility/search.
 */
app.get("/api/ai-visibility/sources", requireInstallation, async (_req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const result = await anakin.aiVisibilitySources();
    res.json(result);
  } catch (err) {
    logError("ai-visibility sources failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * POST /api/ai-visibility/search — body { query, sources?, country?,
 * includeFullContent? }. Asks multiple AI answer engines the same
 * question and compares their answers — useful for a marketing/SEO CMS
 * collection that publishes AI-visibility findings as content. Each
 * engine's raw `full_content` is large and stripped by default, matching
 * Anakin's own MCP tool; pass `includeFullContent: true` to keep it.
 */
app.post("/api/ai-visibility/search", requireInstallation, async (req, res) => {
  const { query, sources, country, includeFullContent } = req.body || {};
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "missing_query" });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const search = await anakin.aiVisibilitySearch(query, { sources, country });
    const results = (search.results || []).map((r) => {
      if (includeFullContent) return r;
      const { full_content: _dropped, ...rest } = r;
      return rest;
    });
    res.json({
      search_id: search.search_id,
      status: search.status,
      country: search.country,
      synthesis: search.synthesis,
      results,
    });
  } catch (err) {
    logError("ai-visibility search failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * GET /api/sessions?domain= — list saved browser sessions (encrypted
 * login states), whose ids are usable as `sessionId` on
 * POST /api/discover/crawl for login-protected source pages. Creating a
 * session is intentionally not exposed (it's an interactive dashboard
 * flow — see lib/anakin-client.js's header); this route only supports
 * discovery.
 */
app.get("/api/sessions", requireInstallation, async (req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const result = await anakin.sessionsList(domain);
    res.json(result);
  } catch (err) {
    logError("sessions list failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/**
 * POST /api/monitors — body { url, intervalMinutes, ... }. Creates a
 * scheduled watcher on a source page. Natural fit for keeping a CMS item
 * fresh after the initial POST /api/extract import, though this
 * integration does not (yet) wire a monitor's change alerts back into an
 * automatic Webflow item update — see README's "Not implemented" note.
 * The response is redacted (redactSecrets) before it ever reaches the
 * browser: monitors carry a one-time `alertWebhookSecret`.
 */
app.post("/api/monitors", requireInstallation, async (req, res) => {
  const { url, intervalMinutes, ...rest } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "missing_url" });
    return;
  }
  if (!intervalMinutes || typeof intervalMinutes !== "number" || intervalMinutes < 15) {
    res.status(400).json({ error: "invalid_intervalMinutes", message: "intervalMinutes must be a number >= 15" });
    return;
  }
  if (!requireAnakinApiKey(res)) return;

  try {
    const anakin = buildAnakinClient();
    const monitor = await anakin.monitorCreate(url, intervalMinutes, rest);
    res.status(201).json(redactSecrets(monitor));
  } catch (err) {
    logError("monitor create failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/** GET /api/monitors — list monitors. Redacted the same way as creation. */
app.get("/api/monitors", requireInstallation, async (_req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const result = await anakin.monitorList();
    res.json(redactSecrets(result));
  } catch (err) {
    logError("monitor list failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
  }
});

/** GET /api/monitors/:id/changes — detected changes for one monitor. */
app.get("/api/monitors/:id/changes", requireInstallation, async (req, res) => {
  if (!requireAnakinApiKey(res)) return;
  try {
    const anakin = buildAnakinClient();
    const result = await anakin.monitorChanges(req.params.id);
    res.json(redactSecrets(result));
  } catch (err) {
    logError("monitor changes failed:", err.message);
    res.status(502).json({ error: "anakin_api_error", message: err.message });
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
