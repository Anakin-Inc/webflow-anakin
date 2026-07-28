"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AnakinClient, redactSecrets } = require("../lib/anakin-client");

/** Builds a fetchImpl that serves a fixed queue of responses in order, and records every call. */
function queuedFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`queuedFetch: no more queued responses (call #${calls.length} to ${url})`);
    const { status = 200, body = {} } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(body),
    };
  };
  fn.calls = calls;
  return fn;
}

function client(fetchImpl) {
  return new AnakinClient({ apiKey: "test-key", fetchImpl });
}

// ─── map ─────────────────────────────────────────────────────────────────

test("map submits POST /map then polls GET /map/:jobId to completion", async () => {
  const fetchImpl = queuedFetch([
    { body: { jobId: "map-1" } },
    { body: { status: "processing" } },
    {
      body: {
        status: "completed",
        url: "https://example.com",
        links: ["https://example.com/a"],
        totalLinks: 1,
        externalLinks: [],
        totalExternalLinks: 0,
        durationMs: 42,
      },
    },
  ]);
  const c = client(fetchImpl);
  const result = await c.map("https://example.com", { limit: 10, depth: 1, pollIntervalMs: 1, pollMaxIntervalMs: 1 });

  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/map");
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.url, "https://example.com");
  assert.equal(body.limit, 10);
  assert.equal(body.depth, 1);

  assert.equal(fetchImpl.calls[1].url, "https://api.anakin.io/v1/map/map-1");
  assert.equal(fetchImpl.calls[2].url, "https://api.anakin.io/v1/map/map-1");
  assert.equal(result.totalLinks, 1);
});

test("map throws when the submit response has no jobId", async () => {
  const fetchImpl = queuedFetch([{ body: {} }]);
  await assert.rejects(() => client(fetchImpl).map("https://example.com"), /did not include a jobId/);
});

test("map requires a url", async () => {
  await assert.rejects(() => client(queuedFetch([])).map(), /url is required/);
});

// ─── crawl ───────────────────────────────────────────────────────────────

test("crawl submits POST /crawl then polls GET /crawl/:jobId to completion", async () => {
  const fetchImpl = queuedFetch([
    { body: { jobId: "crawl-1" } },
    {
      body: {
        status: "completed",
        url: "https://example.com",
        totalPages: 2,
        completedPages: 2,
        pages: [{ url: "https://example.com/a", markdown: "# A" }],
        durationMs: 100,
      },
    },
  ]);
  const c = client(fetchImpl);
  const result = await c.crawl("https://example.com", { maxPages: 5, pollIntervalMs: 1 });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.maxPages, 5);
  assert.equal(result.totalPages, 2);
  assert.equal(result.pages.length, 1);
});

test("crawl job failure throws", async () => {
  const fetchImpl = queuedFetch([{ body: { jobId: "crawl-2" } }, { body: { status: "failed", error: "boom" } }]);
  await assert.rejects(() => client(fetchImpl).crawl("https://example.com", { pollIntervalMs: 1 }), /boom/);
});

// ─── wire ────────────────────────────────────────────────────────────────

test("wireResolve GETs /wire/resolve with q and limit as query params", async () => {
  const fetchImpl = queuedFetch([{ body: { actions: [] } }]);
  await client(fetchImpl).wireResolve("top phones on walmart", { limit: 3 });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, "/v1/wire/resolve");
  assert.equal(url.searchParams.get("q"), "top phones on walmart");
  assert.equal(url.searchParams.get("limit"), "3");
});

test("wireCatalog with no slug hits /wire/catalog; with a slug hits /wire/catalog/:slug", async () => {
  const fetchImpl = queuedFetch([{ body: { catalogs: [] } }, { body: { slug: "walmart" } }]);
  const c = client(fetchImpl);
  await c.wireCatalog();
  await c.wireCatalog("walmart");
  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/wire/catalog");
  assert.equal(fetchImpl.calls[1].url, "https://api.anakin.io/v1/wire/catalog/walmart");
});

test("wireRun returns terminal data inline when the response has no job_id (sync action)", async () => {
  const fetchImpl = queuedFetch([{ body: { status: "completed", data: { price: 9.99 } } }]);
  const result = await client(fetchImpl).wireRun("walmart.get_product", { id: "123" });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(result.data, { price: 9.99 });
});

test("wireRun polls /wire/jobs/:id when the submit response has a job_id", async () => {
  const fetchImpl = queuedFetch([
    { body: { job_id: "job-1" } },
    { body: { status: "running" } },
    { body: { status: "completed", data: { price: 9.99 } } },
  ]);
  const result = await client(fetchImpl).wireRun("walmart.get_product", {}, { pollIntervalMs: 1, pollMaxIntervalMs: 1 });
  assert.equal(fetchImpl.calls[1].url, "https://api.anakin.io/v1/wire/jobs/job-1");
  assert.deepEqual(result.data, { price: 9.99 });
});

test("wireRun throws with the failure reason when a polled job fails", async () => {
  const fetchImpl = queuedFetch([
    { body: { job_id: "job-2" } },
    { body: { status: "failed", error: { code: "NOT_FOUND", message: "product missing" } } },
  ]);
  await assert.rejects(
    () => client(fetchImpl).wireRun("walmart.get_product", {}, { pollIntervalMs: 1 }),
    /product missing/
  );
});

test("wireRun requires an actionId", async () => {
  await assert.rejects(() => client(queuedFetch([])).wireRun(), /actionId is required/);
});

// ─── AI Visibility ──────────────────────────────────────────────────────

test("aiVisibilitySources GETs /ai-visibility/sources", async () => {
  const fetchImpl = queuedFetch([{ body: { sources: [{ slug: "chatgpt", label: "ChatGPT" }] } }]);
  const result = await client(fetchImpl).aiVisibilitySources();
  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/ai-visibility/sources");
  assert.equal(result.sources[0].slug, "chatgpt");
});

test("aiVisibilitySearch submits then polls until status leaves 'running'", async () => {
  const fetchImpl = queuedFetch([
    { body: { search_id: "sv-1", status: "running" } },
    { body: { search_id: "sv-1", status: "running" } },
    { body: { search_id: "sv-1", status: "completed", results: [{ source: "chatgpt", full_content: "long..." }] } },
  ]);
  const result = await client(fetchImpl).aiVisibilitySearch("what is anakin.io", { pollIntervalMs: 1 });
  assert.equal(result.status, "completed");
  assert.equal(fetchImpl.calls.length, 3);
});

test("aiVisibilitySearch returns (does not throw on) a terminal 'failed' status — caller needs the per-source detail", async () => {
  const fetchImpl = queuedFetch([
    { body: { search_id: "sv-2", status: "running" } },
    { body: { search_id: "sv-2", status: "failed", results: [] } },
  ]);
  const result = await client(fetchImpl).aiVisibilitySearch("q");
  assert.equal(result.status, "failed");
});

test("aiVisibilitySearch requires a query", async () => {
  await assert.rejects(() => client(queuedFetch([])).aiVisibilitySearch(), /query is required/);
});

// ─── sessions ───────────────────────────────────────────────────────────

test("sessionsList GETs /sessions, optionally with ?domain=", async () => {
  const fetchImpl = queuedFetch([{ body: { sessions: [] } }, { body: { sessions: [] } }]);
  const c = client(fetchImpl);
  await c.sessionsList();
  await c.sessionsList("amazon.com");
  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/sessions");
  assert.equal(fetchImpl.calls[1].url, "https://api.anakin.io/v1/sessions?domain=amazon.com");
});

// ─── monitors ───────────────────────────────────────────────────────────

test("monitorCreate POSTs url + intervalMinutes + passthrough opts", async () => {
  const fetchImpl = queuedFetch([{ status: 201, body: { id: "mon-1", url: "https://example.com", intervalMinutes: 30 } }]);
  const result = await client(fetchImpl).monitorCreate("https://example.com", 30, { aiMode: true, scope: undefined });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.url, "https://example.com");
  assert.equal(body.intervalMinutes, 30);
  assert.equal(body.aiMode, true);
  assert.equal("scope" in body, false); // undefined opts are dropped, not sent as null
  assert.equal(result.id, "mon-1");
});

test("monitorCreate requires url and intervalMinutes", async () => {
  await assert.rejects(() => client(queuedFetch([])).monitorCreate(), /url is required/);
  await assert.rejects(() => client(queuedFetch([])).monitorCreate("https://example.com"), /intervalMinutes is required/);
});

test("monitorList GETs /monitors", async () => {
  const fetchImpl = queuedFetch([{ body: { monitors: [] } }]);
  await client(fetchImpl).monitorList();
  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/monitors");
});

test("monitorChanges GETs /monitors/:id/changes", async () => {
  const fetchImpl = queuedFetch([{ body: { changes: [] } }]);
  await client(fetchImpl).monitorChanges("mon-1");
  assert.equal(fetchImpl.calls[0].url, "https://api.anakin.io/v1/monitors/mon-1/changes");
});

test("monitorChanges requires an id", async () => {
  await assert.rejects(() => client(queuedFetch([])).monitorChanges(), /id is required/);
});

// ─── redactSecrets ──────────────────────────────────────────────────────

test("redactSecrets replaces alertWebhookSecret but leaves everything else untouched", () => {
  const monitor = { id: "mon-1", url: "https://example.com", alertWebhookSecret: "whsec_realvalue" };
  const redacted = redactSecrets(monitor);
  assert.equal(redacted.id, "mon-1");
  assert.equal(redacted.url, "https://example.com");
  assert.notEqual(redacted.alertWebhookSecret, "whsec_realvalue");
  assert.match(redacted.alertWebhookSecret, /redacted/);
  // original object is untouched (deep copy, not mutation)
  assert.equal(monitor.alertWebhookSecret, "whsec_realvalue");
});

test("redactSecrets recurses into arrays and nested objects (e.g. monitor_list's response)", () => {
  const list = { monitors: [{ id: "a", alertWebhookSecret: "s1" }, { id: "b", alertWebhookSecret: "s2" }] };
  const redacted = redactSecrets(list);
  assert.match(redacted.monitors[0].alertWebhookSecret, /redacted/);
  assert.match(redacted.monitors[1].alertWebhookSecret, /redacted/);
  assert.equal(redacted.monitors[0].id, "a");
});

test("redactSecrets leaves a falsy secret value alone (nothing to redact)", () => {
  assert.equal(redactSecrets({ alertWebhookSecret: null }).alertWebhookSecret, null);
  assert.equal(redactSecrets({ alertWebhookSecret: "" }).alertWebhookSecret, "");
});
