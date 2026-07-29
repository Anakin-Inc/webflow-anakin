"use strict";

/**
 * Minimal Anakin API client covering the endpoints this integration uses
 * (plus `search`/`agentic-search`, included for completeness/parity with
 * the other Anakin directory submissions built this session).
 *
 * Ground truth for `scrapeUrl`/`search`/`agenticSearch` read directly from
 * the real SDK, not guessed:
 *   /Users/arun/Anakin/anakin-py/src/anakin/client.py
 *   /Users/arun/Anakin/anakin-py/src/anakin/models.py
 *
 * Ground truth for `map`/`crawl`/`wire*`/`aiVisibility*`/`sessionsList`/
 * `monitor*` (added when this integration's API surface was extended past
 * its original 3-capability scrape/search/agentic-search baseline) read
 * directly from Anakin's own MCP server source, not guessed:
 *   /Users/arun/Anakin/anakin-mcp/src/client.ts
 *   /Users/arun/Anakin/anakin-mcp/src/tools/{map,crawl,wire,ai-visibility,sessions,monitor}.ts
 *
 * - Base URL: https://api.anakin.io/v1
 * - Auth: `X-API-Key: <key>` header (not Bearer, not OAuth — this is
 *   Anakin's own API key, unrelated to the Webflow OAuth token this
 *   integration also handles; the two must never be confused or stored
 *   together).
 * - POST /url-scraper       -> submits { url, country, formats, useBrowser,
 *                               generateJson, forceFresh, sessionId?,
 *                               sessionName? } -> { jobId }
 * - GET  /url-scraper/:id   -> poll; body.status in {pending, processing,
 *                               completed, failed}; on completed, body has
 *                               `generatedJson` (present when
 *                               generateJson:true was requested) plus
 *                               `markdown`/`html`/etc. per requested
 *                               `formats`.
 * - POST /search            -> synchronous { prompt, limit } ->
 *                               { id, results: [{url, title, snippet,
 *                               date, lastUpdated}] }
 * - POST /agentic-search     -> submits { prompt, useBrowser, schema? } ->
 *                               { jobId }
 * - GET  /agentic-search/:id -> poll; on completed, body.generatedJson =
 *                               { summary, structuredData, dataSchema }
 * - POST /map               -> submits { url, limit, depth, limitPerLevel,
 *                               includeSubdomains, includeExternalLinks,
 *                               useBrowser, search? } -> { jobId }
 * - GET  /map/:jobId        -> poll; on completed, { links, totalLinks,
 *                               externalLinks, totalExternalLinks }
 * - POST /crawl             -> submits { url, maxPages, depth, country,
 *                               useBrowser, includePatterns?,
 *                               excludePatterns?, sessionId?,
 *                               sessionName? } -> { jobId }
 * - GET  /crawl/:jobId      -> poll; on completed, { pages, totalPages,
 *                               completedPages }
 * - GET  /wire/resolve      -> synchronous ?q=&limit= -> ranked candidate
 *                               Wire actions
 * - GET  /wire/catalog[/:slug] -> synchronous; no slug lists every catalog,
 *                               a slug returns that site's full action list
 * - POST /wire/task         -> { action_id, params? } -> either terminal
 *                               data inline (sync actions) or { job_id }
 * - GET  /wire/jobs/:jobId  -> poll a submitted Wire task to completion
 * - GET  /ai-visibility/sources -> synchronous roster of engine slugs
 * - POST /ai-visibility/search  -> { query, sources?, country? } ->
 *                               { search_id, status, ... }
 * - GET  /ai-visibility/search/:id -> poll; status leaves "running" on
 *                               completion (success) or failure — both are
 *                               returned to the caller, not thrown, since a
 *                               partially-failed run still carries useful
 *                               per-source results.
 * - GET  /sessions           -> synchronous ?domain= -> saved browser
 *                               sessions
 * - POST /monitors           -> { url, intervalMinutes, ... } -> the
 *                               created monitor (includes a one-time
 *                               `alertWebhookSecret` — see `redactSecrets`)
 * - GET  /monitors           -> synchronous list
 * - GET  /monitors/:id/changes -> synchronous list of detected changes
 */

const DEFAULT_BASE_URL = "https://api.anakin.io/v1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(body, fallback) {
  if (!body || typeof body !== "object") return fallback;
  const err = body.error;
  if (err && typeof err === "object") return err.message || fallback;
  if (typeof err === "string") return body.message || fallback;
  return body.message || fallback;
}

function isTerminal(status) {
  return status === "completed" || status === "failed";
}

class AnakinClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests.
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error("ANAKIN_API_KEY is not set");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this._fetch = fetchImpl;
  }

  _headers(extra = {}) {
    return {
      "X-API-Key": this.apiKey,
      "User-Agent": "webflow-anakin/1.0.0",
      Accept: "application/json",
      ...extra,
    };
  }

  async _requestJson(res, context) {
    let body = {};
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    if (!res.ok) {
      const message = extractErrorMessage(body, res.statusText || "Unknown error");
      throw new Error(`${context} failed: HTTP ${res.status} — ${message}`);
    }
    return body;
  }

  async _pollJob(path, { pollIntervalMs, pollMaxIntervalMs, pollTimeoutMs, context }) {
    const deadline = Date.now() + pollTimeoutMs;
    let wait = pollIntervalMs;
    let attempts = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts += 1;
      const res = await this._fetch(`${this.baseUrl}${path}`, { headers: this._headers() });
      const job = await this._requestJson(res, `${context} poll`);

      if (isTerminal(job.status)) {
        if (job.status === "failed") {
          throw new Error(`${context} job at ${path} failed: ${job.error || "unknown error"}`);
        }
        return job;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`${context} job at ${path} did not complete within ${pollTimeoutMs}ms (${attempts} polls)`);
      }
      await sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 1.5, pollMaxIntervalMs);
    }
  }

  /**
   * POST /url-scraper (submit) + GET /url-scraper/:jobId (poll).
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {string[]} [opts.formats] - default ["markdown"].
   * @param {boolean} [opts.generateJson] - default true for this integration's use case (structured extraction for CMS field mapping).
   * @param {object} [opts.schema] - JSON-schema hint for generateJson; see lib/extraction.js's buildExtractionSchema.
   * @param {string} [opts.country]
   * @param {boolean} [opts.useBrowser]
   * @param {boolean} [opts.forceFresh]
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.pollMaxIntervalMs]
   * @param {number} [opts.pollTimeoutMs]
   */
  async scrapeUrl(
    url,
    {
      formats = ["markdown"],
      generateJson = true,
      schema,
      country = "us",
      useBrowser = false,
      forceFresh = false,
      pollIntervalMs = 3000,
      pollMaxIntervalMs = 10000,
      pollTimeoutMs = 180000,
    } = {}
  ) {
    if (!url) throw new Error("url is required");
    const body = {
      url,
      country,
      formats,
      useBrowser,
      generateJson,
      forceFresh,
    };
    if (schema) body.schema = schema;

    const submitRes = await this._fetch(`${this.baseUrl}/url-scraper`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /url-scraper submit");

    const jobId = submitted.jobId || submitted.job_id || submitted.id;
    if (!jobId) {
      throw new Error(`Anakin /url-scraper submit response did not include a jobId: ${JSON.stringify(submitted)}`);
    }

    return this._pollJob(`/url-scraper/${jobId}`, {
      pollIntervalMs,
      pollMaxIntervalMs,
      pollTimeoutMs,
      context: "Anakin /url-scraper",
    });
  }

  /**
   * POST /search — synchronous, no polling. Costs 3 credits per call (per client.py's docstring).
   * @param {string} prompt
   * @param {number} [limit]
   */
  async search(prompt, { limit = 5 } = {}) {
    const res = await this._fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prompt, limit }),
    });
    return this._requestJson(res, "Anakin /search");
  }

  /**
   * POST /agentic-search (submit) + GET /agentic-search/:jobId (poll).
   * Costs 10 credits (per client.py's docstring).
   * @param {string} prompt
   * @param {object} [opts]
   */
  async agenticSearch(
    prompt,
    {
      useBrowser = true,
      schema,
      pollIntervalMs = 3000,
      pollMaxIntervalMs = 10000,
      pollTimeoutMs = 240000,
    } = {}
  ) {
    if (!prompt) throw new Error("prompt is required");
    const body = { prompt, useBrowser };
    if (schema) body.schema = schema;

    const submitRes = await this._fetch(`${this.baseUrl}/agentic-search`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /agentic-search submit");

    const jobId = submitted.jobId || submitted.job_id || submitted.id;
    if (!jobId) {
      throw new Error(`Anakin /agentic-search submit response did not include a jobId: ${JSON.stringify(submitted)}`);
    }

    return this._pollJob(`/agentic-search/${jobId}`, {
      pollIntervalMs,
      pollMaxIntervalMs,
      pollTimeoutMs,
      context: "Anakin /agentic-search",
    });
  }

  /**
   * POST /map (submit) + GET /map/:jobId (poll). Discovers a site's
   * reachable URLs — used to plan a bulk CMS import before spending Anakin
   * credits/Webflow API calls on every page (see server.js's
   * POST /api/discover/map).
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.limit] - default 100 (Anakin's own default).
   * @param {number} [opts.depth] - default 2.
   * @param {number} [opts.limitPerLevel]
   * @param {boolean} [opts.includeSubdomains]
   * @param {boolean} [opts.includeExternalLinks]
   * @param {boolean} [opts.useBrowser]
   * @param {string} [opts.search] - keyword filter.
   */
  async map(
    url,
    {
      limit = 100,
      depth = 2,
      limitPerLevel = 100,
      includeSubdomains = false,
      includeExternalLinks = false,
      useBrowser = false,
      search,
      pollIntervalMs = 3000,
      pollMaxIntervalMs = 10000,
      pollTimeoutMs = 180000,
    } = {}
  ) {
    if (!url) throw new Error("url is required");
    const body = { url, limit, depth, limitPerLevel, includeSubdomains, includeExternalLinks, useBrowser };
    if (search) body.search = search;

    const submitRes = await this._fetch(`${this.baseUrl}/map`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /map submit");

    const jobId = submitted.jobId || submitted.job_id || submitted.id;
    if (!jobId) {
      throw new Error(`Anakin /map submit response did not include a jobId: ${JSON.stringify(submitted)}`);
    }

    return this._pollJob(`/map/${jobId}`, { pollIntervalMs, pollMaxIntervalMs, pollTimeoutMs, context: "Anakin /map" });
  }

  /**
   * POST /crawl (submit) + GET /crawl/:jobId (poll). Bulk-fetches markdown
   * across a site — the ingestion side of bulk CMS population (see
   * server.js's POST /api/discover/crawl, which additionally clamps
   * `maxPages` beyond what Anakin itself enforces, since this route holds
   * the HTTP request open for the whole poll).
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.maxPages] - default 10 (Anakin's own default).
   * @param {number} [opts.depth] - default 1.
   * @param {string} [opts.country]
   * @param {boolean} [opts.useBrowser]
   * @param {string[]} [opts.includePatterns]
   * @param {string[]} [opts.excludePatterns]
   * @param {string} [opts.sessionId]
   * @param {string} [opts.sessionName]
   */
  async crawl(
    url,
    {
      maxPages = 10,
      depth = 1,
      country = "us",
      useBrowser = false,
      includePatterns,
      excludePatterns,
      sessionId,
      sessionName,
      pollIntervalMs = 3000,
      pollMaxIntervalMs = 10000,
      pollTimeoutMs = 180000,
    } = {}
  ) {
    if (!url) throw new Error("url is required");
    const body = { url, maxPages, depth, country, useBrowser };
    if (includePatterns) body.includePatterns = includePatterns;
    if (excludePatterns) body.excludePatterns = excludePatterns;
    if (sessionId) body.sessionId = sessionId;
    if (sessionName) body.sessionName = sessionName;

    const submitRes = await this._fetch(`${this.baseUrl}/crawl`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /crawl submit");

    const jobId = submitted.jobId || submitted.job_id || submitted.id;
    if (!jobId) {
      throw new Error(`Anakin /crawl submit response did not include a jobId: ${JSON.stringify(submitted)}`);
    }

    return this._pollJob(`/crawl/${jobId}`, { pollIntervalMs, pollMaxIntervalMs, pollTimeoutMs, context: "Anakin /crawl" });
  }

  /**
   * GET /wire/resolve — synchronous. Natural-language intent -> ranked
   * candidate Wire actions.
   * @param {string} q
   * @param {number} [limit]
   */
  async wireResolve(q, { limit } = {}) {
    if (!q) throw new Error("q is required");
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await this._fetch(`${this.baseUrl}/wire/resolve?${params.toString()}`, { headers: this._headers() });
    return this._requestJson(res, "Anakin /wire/resolve");
  }

  /**
   * GET /wire/catalog or /wire/catalog/:slug — synchronous. No slug lists
   * every catalog; a slug returns that site's full action list + param
   * schemas.
   * @param {string} [slug]
   */
  async wireCatalog(slug) {
    const path = slug ? `/wire/catalog/${encodeURIComponent(slug)}` : "/wire/catalog";
    const res = await this._fetch(`${this.baseUrl}${path}`, { headers: this._headers() });
    return this._requestJson(res, "Anakin /wire/catalog");
  }

  /**
   * POST /wire/task (submit) + GET /wire/jobs/:jobId (poll if async).
   * Only intended for READ (data-extraction) Wire actions — this
   * integration deliberately does not expose Wire WRITE actions (see
   * server.js / README: an unattended CMS-population pipeline should never
   * perform state-changing interactions on a third-party site).
   *
   * @param {string} actionId
   * @param {object} [params]
   * @param {object} [opts]
   * @param {string} [opts.credentialId]
   * @param {string} [opts.identityId]
   */
  async wireRun(
    actionId,
    params = {},
    { credentialId, identityId, pollIntervalMs = 3000, pollMaxIntervalMs = 10000, pollTimeoutMs = 180000 } = {}
  ) {
    if (!actionId) throw new Error("actionId is required");
    const body = { action_id: actionId };
    if (params && Object.keys(params).length > 0) body.params = params;
    if (credentialId) body.credential_id = credentialId;
    if (identityId) body.identity_id = identityId;

    const res = await this._fetch(`${this.baseUrl}/wire/task`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const accepted = await this._requestJson(res, "Anakin /wire/task submit");

    const jobId = accepted.job_id || accepted.jobId;
    if (!jobId) return accepted; // sync action — terminal data came back inline.

    return this._pollWireJob(jobId, { pollIntervalMs, pollMaxIntervalMs, pollTimeoutMs });
  }

  async _pollWireJob(jobId, { pollIntervalMs, pollMaxIntervalMs, pollTimeoutMs }) {
    const deadline = Date.now() + pollTimeoutMs;
    let wait = pollIntervalMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this._fetch(`${this.baseUrl}/wire/jobs/${encodeURIComponent(jobId)}`, { headers: this._headers() });
      const job = await this._requestJson(res, "Anakin /wire/jobs poll");

      if (job.status === "completed") return job;
      if (job.status === "failed") {
        const reason = (job.error && (job.error.message || job.error.code)) || "unknown error";
        throw new Error(`Anakin Wire job ${jobId} failed: ${reason}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Anakin Wire job ${jobId} did not complete within ${pollTimeoutMs}ms`);
      }
      await sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 1.5, pollMaxIntervalMs);
    }
  }

  /** GET /ai-visibility/sources — synchronous roster of engine slugs. */
  async aiVisibilitySources() {
    const res = await this._fetch(`${this.baseUrl}/ai-visibility/sources`, { headers: this._headers() });
    return this._requestJson(res, "Anakin /ai-visibility/sources");
  }

  /**
   * POST /ai-visibility/search (submit) + GET /ai-visibility/search/:id
   * (poll). A "failed" terminal status is returned, not thrown — a
   * partially-failed run still carries per-source results/errors the
   * caller needs either way (same behavior as Anakin's own MCP client).
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string[]} [opts.sources]
   * @param {string} [opts.country]
   */
  async aiVisibilitySearch(
    query,
    { sources, country, pollIntervalMs = 3000, pollMaxIntervalMs = 10000, pollTimeoutMs = 180000 } = {}
  ) {
    if (!query) throw new Error("query is required");
    const body = { query };
    if (sources) body.sources = sources;
    if (country) body.country = country;

    const submitRes = await this._fetch(`${this.baseUrl}/ai-visibility/search`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const submitted = await this._requestJson(submitRes, "Anakin /ai-visibility/search submit");

    const searchId = submitted.search_id || submitted.searchId;
    if (!searchId) {
      throw new Error(`Anakin /ai-visibility/search submit response did not include a search_id: ${JSON.stringify(submitted)}`);
    }

    const deadline = Date.now() + pollTimeoutMs;
    let wait = pollIntervalMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this._fetch(`${this.baseUrl}/ai-visibility/search/${encodeURIComponent(searchId)}`, {
        headers: this._headers(),
      });
      const search = await this._requestJson(res, "Anakin /ai-visibility/search poll");
      if (search.status !== "running") return search;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Anakin AI visibility search ${searchId} did not complete within ${pollTimeoutMs}ms`);
      }
      await sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 1.5, pollMaxIntervalMs);
    }
  }

  /** GET /sessions — synchronous, optional ?domain= filter. */
  async sessionsList(domain) {
    const params = new URLSearchParams();
    if (domain) params.set("domain", domain);
    const qs = params.toString();
    const res = await this._fetch(`${this.baseUrl}/sessions${qs ? `?${qs}` : ""}`, { headers: this._headers() });
    return this._requestJson(res, "Anakin /sessions");
  }

  /**
   * POST /monitors — synchronous. Creates a scheduled watcher on a URL.
   * `opts` fields are passed through as-is (only fields the caller sets
   * are sent — the API applies its own defaults), mirroring Anakin's MCP
   * `monitorCreate`.
   * @param {string} url
   * @param {number} intervalMinutes - minimum 15.
   * @param {object} [opts]
   */
  async monitorCreate(url, intervalMinutes, opts = {}) {
    if (!url) throw new Error("url is required");
    if (!intervalMinutes) throw new Error("intervalMinutes is required");
    const body = { url, intervalMinutes };
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined) body[k] = v;
    }
    const res = await this._fetch(`${this.baseUrl}/monitors`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this._requestJson(res, "Anakin POST /monitors");
  }

  /** GET /monitors — synchronous list. */
  async monitorList() {
    const res = await this._fetch(`${this.baseUrl}/monitors`, { headers: this._headers() });
    return this._requestJson(res, "Anakin GET /monitors");
  }

  /** GET /monitors/:id/changes — synchronous list of detected changes. */
  async monitorChanges(id) {
    if (!id) throw new Error("id is required");
    const res = await this._fetch(`${this.baseUrl}/monitors/${encodeURIComponent(id)}/changes`, { headers: this._headers() });
    return this._requestJson(res, "Anakin GET /monitors/:id/changes");
  }
}

/**
 * The `/monitors` API returns each monitor's `alertWebhookSecret` (an HMAC
 * signing secret for verifying alert-webhook deliveries). A secret that
 * enters a server log or an HTTP response consumed by a browser-side
 * script is compromised by definition, so every route that returns monitor
 * data passes it through this first — same redaction rule Anakin's own MCP
 * server applies (see anakin-mcp/src/tools/monitor.ts). The real value
 * remains retrievable from the Anakin dashboard.
 *
 * @param {*} value
 * @returns {*} a deep copy with any secret-bearing keys replaced.
 */
const MONITOR_SECRET_KEYS = new Set(["alertWebhookSecret"]);
const REDACTED_PLACEHOLDER = "[redacted — view in the Anakin dashboard]";

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = MONITOR_SECRET_KEYS.has(key) && v ? REDACTED_PLACEHOLDER : redactSecrets(v);
    }
    return out;
  }
  return value;
}

module.exports = { AnakinClient, DEFAULT_BASE_URL, redactSecrets };
