"use strict";

/**
 * Minimal Anakin API client covering the endpoints this integration uses
 * (plus `search`/`agentic-search`, included for completeness/parity with
 * the other Anakin directory submissions built this session).
 *
 * Ground truth read directly from the real SDK, not guessed:
 *   /Users/arun/Anakin/anakin-py/src/anakin/client.py
 *   /Users/arun/Anakin/anakin-py/src/anakin/models.py
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
}

module.exports = { AnakinClient, DEFAULT_BASE_URL };
