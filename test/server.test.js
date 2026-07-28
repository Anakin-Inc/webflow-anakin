"use strict";

/**
 * Integration tests for the Anakin-capability routes added to server.js
 * (POST /api/discover/map, POST /api/discover/crawl, GET/POST /api/wire/*,
 * GET/POST /api/ai-visibility/*, GET /api/sessions, and the /api/monitors
 * family). These drive the real Express app over a real HTTP socket (not
 * supertest — no such dependency here — plain node:http), with:
 *
 *  - a REAL installation seeded directly into the exported TokenStore
 *    (getTokenStore().put(...)), so `requireInstallation` runs its actual
 *    code path (cookie -> token store lookup), not a bypass;
 *  - a FAKE `global.fetch` swapped in only for the duration of each test,
 *    so AnakinClient's outbound calls hit an injected queue instead of the
 *    real network. server.js's own `require.main === module` guard means
 *    requiring it here never calls `app.listen` on its own — this file
 *    owns the listen/close lifecycle.
 *
 * Deliberately not exhaustive per-route (lib/anakin-client.test.js already
 * covers each Anakin call's request/response shape in isolation) — this
 * file's job is proving the routes are wired correctly: the auth gate
 * still applies, input validation returns 400s, and secrets are redacted
 * before they leave the process.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
process.env.ANAKIN_API_KEY = process.env.ANAKIN_API_KEY || "test-anakin-key-not-real";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { app, getTokenStore } = require("../server");

let server;
let baseCookie;

test.before(() => {
  server = app.listen(0);
  const installationId = crypto.randomUUID();
  getTokenStore().put(installationId, "fake-webflow-access-token", { installedAt: Date.now() });
  baseCookie = `wf_anakin_installation=${installationId}`;
});

test.after(() => {
  server.close();
});

function req(method, path, { cookie = baseCookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let json = null;
          try {
            json = chunks ? JSON.parse(chunks) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

/** Swaps in a fake global.fetch serving a fixed queue of responses for the duration of `fn`. */
async function withFetch(responses, fn) {
  const queue = [...responses];
  const original = global.fetch;
  global.fetch = async (url) => {
    const next = queue.shift();
    if (!next) throw new Error(`withFetch: no more queued responses (requested ${url})`);
    const { status = 200, body = {} } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(body),
    };
  };
  try {
    await fn();
  } finally {
    global.fetch = original;
  }
}

// ─── Auth gate still applies to every new route (spot-checked once) ──────

test("new Anakin routes are gated behind requireInstallation like the existing Webflow routes", async () => {
  const res = await req("GET", "/api/wire/catalog", { cookie: null });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, "not_installed");
});

// ─── POST /api/discover/map ───────────────────────────────────────────────

test("POST /api/discover/map validates a required url", async () => {
  const res = await req("POST", "/api/discover/map", { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "missing_url");
});

test("POST /api/discover/map returns the discovered links on success", async () => {
  await withFetch(
    [
      { body: { jobId: "map-1" } },
      {
        body: {
          status: "completed",
          url: "https://example.com",
          links: ["https://example.com/a", "https://example.com/b"],
          totalLinks: 2,
          externalLinks: [],
          totalExternalLinks: 0,
          durationMs: 12,
        },
      },
    ],
    async () => {
      const res = await req("POST", "/api/discover/map", { body: { url: "https://example.com", limit: 5 } });
      assert.equal(res.status, 200);
      assert.equal(res.json.totalLinks, 2);
      assert.deepEqual(res.json.links, ["https://example.com/a", "https://example.com/b"]);
    }
  );
});

// ─── POST /api/discover/crawl ─────────────────────────────────────────────

test("POST /api/discover/crawl rejects maxPages beyond this app's ceiling", async () => {
  const res = await req("POST", "/api/discover/crawl", { body: { url: "https://example.com", maxPages: 9999 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "maxPages_out_of_range");
});

test("POST /api/discover/crawl returns crawled pages on success", async () => {
  await withFetch(
    [
      { body: { jobId: "crawl-1" } },
      {
        body: {
          status: "completed",
          url: "https://example.com",
          totalPages: 1,
          completedPages: 1,
          pages: [{ url: "https://example.com", markdown: "# Home" }],
          durationMs: 30,
        },
      },
    ],
    async () => {
      const res = await req("POST", "/api/discover/crawl", { body: { url: "https://example.com", maxPages: 5 } });
      assert.equal(res.status, 200);
      assert.equal(res.json.totalPages, 1);
      assert.equal(res.json.pages[0].markdown, "# Home");
    }
  );
});

// ─── Wire ─────────────────────────────────────────────────────────────────

test("GET /api/wire/discover validates a required q", async () => {
  const res = await req("GET", "/api/wire/discover");
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "missing_q");
});

test("GET /api/wire/discover returns ranked candidate actions", async () => {
  await withFetch([{ body: { actions: [{ action_id: "walmart.search_products", type: "read" }] } }], async () => {
    const res = await req("GET", "/api/wire/discover?q=top+phones+on+walmart&limit=3");
    assert.equal(res.status, 200);
    assert.equal(res.json.actions[0].action_id, "walmart.search_products");
  });
});

test("GET /api/wire/catalog/:slug returns that site's action list", async () => {
  await withFetch([{ body: { slug: "walmart", actions: [] } }], async () => {
    const res = await req("GET", "/api/wire/catalog/walmart");
    assert.equal(res.status, 200);
    assert.equal(res.json.slug, "walmart");
  });
});

test("POST /api/wire/read-action validates a required actionId", async () => {
  const res = await req("POST", "/api/wire/read-action", { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "missing_actionId");
});

test("POST /api/wire/read-action runs the action and returns its result", async () => {
  await withFetch([{ body: { status: "completed", data: { price: 19.99 } } }], async () => {
    const res = await req("POST", "/api/wire/read-action", {
      body: { actionId: "walmart.get_product", params: { id: "123" } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { price: 19.99 });
  });
});

// ─── AI Visibility ─────────────────────────────────────────────────────────

test("GET /api/ai-visibility/sources returns the engine roster", async () => {
  await withFetch([{ body: { sources: [{ slug: "chatgpt", label: "ChatGPT" }] } }], async () => {
    const res = await req("GET", "/api/ai-visibility/sources");
    assert.equal(res.status, 200);
    assert.equal(res.json.sources[0].slug, "chatgpt");
  });
});

test("POST /api/ai-visibility/search validates a required query", async () => {
  const res = await req("POST", "/api/ai-visibility/search", { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "missing_query");
});

test("POST /api/ai-visibility/search strips full_content by default", async () => {
  await withFetch(
    [
      { body: { search_id: "sv-1", status: "running" } },
      {
        body: {
          search_id: "sv-1",
          status: "completed",
          synthesis: "Engines agree X is true.",
          results: [{ source: "chatgpt", summary: "X is true.", full_content: "very long raw answer..." }],
        },
      },
    ],
    async () => {
      const res = await req("POST", "/api/ai-visibility/search", { body: { query: "what is anakin.io" } });
      assert.equal(res.status, 200);
      assert.equal(res.json.results[0].summary, "X is true.");
      assert.equal("full_content" in res.json.results[0], false);
    }
  );
});

// ─── Sessions ───────────────────────────────────────────────────────────

test("GET /api/sessions returns the saved-session list", async () => {
  await withFetch([{ body: { sessions: [{ id: "sess-1", domain: "amazon.com" }] } }], async () => {
    const res = await req("GET", "/api/sessions?domain=amazon.com");
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions[0].id, "sess-1");
  });
});

// ─── Monitors ───────────────────────────────────────────────────────────

test("POST /api/monitors validates url and intervalMinutes (min 15)", async () => {
  const missingUrl = await req("POST", "/api/monitors", { body: { intervalMinutes: 30 } });
  assert.equal(missingUrl.status, 400);
  assert.equal(missingUrl.json.error, "missing_url");

  const tooFrequent = await req("POST", "/api/monitors", { body: { url: "https://example.com", intervalMinutes: 5 } });
  assert.equal(tooFrequent.status, 400);
  assert.equal(tooFrequent.json.error, "invalid_intervalMinutes");
});

test("POST /api/monitors creates a monitor and redacts alertWebhookSecret from the response", async () => {
  await withFetch(
    [
      {
        status: 201,
        body: {
          id: "mon-1",
          url: "https://example.com",
          intervalMinutes: 30,
          alertWebhookSecret: "whsec_realvaluethatmustneverleave",
        },
      },
    ],
    async () => {
      const res = await req("POST", "/api/monitors", { body: { url: "https://example.com", intervalMinutes: 30 } });
      assert.equal(res.status, 201);
      assert.equal(res.json.id, "mon-1");
      assert.notEqual(res.json.alertWebhookSecret, "whsec_realvaluethatmustneverleave");
      assert.match(res.json.alertWebhookSecret, /redacted/);
    }
  );
});

test("GET /api/monitors lists monitors with secrets redacted", async () => {
  await withFetch(
    [{ body: { monitors: [{ id: "mon-1", alertWebhookSecret: "whsec_should_not_leak" }] } }],
    async () => {
      const res = await req("GET", "/api/monitors");
      assert.equal(res.status, 200);
      assert.notEqual(res.json.monitors[0].alertWebhookSecret, "whsec_should_not_leak");
    }
  );
});

test("GET /api/monitors/:id/changes returns the change list", async () => {
  await withFetch([{ body: { changes: [{ detectedAt: "2026-01-01T00:00:00Z", summary: "price changed" }] } }], async () => {
    const res = await req("GET", "/api/monitors/mon-1/changes");
    assert.equal(res.status, 200);
    assert.equal(res.json.changes[0].summary, "price changed");
  });
});

// ─── Failure propagation (spot-check one route; others share the same try/catch shape) ──

test("a downstream Anakin API error is surfaced as 502 anakin_api_error, not a crash", async () => {
  await withFetch([{ status: 500, body: { message: "internal error" } }], async () => {
    const res = await req("GET", "/api/ai-visibility/sources");
    assert.equal(res.status, 502);
    assert.equal(res.json.error, "anakin_api_error");
  });
});
