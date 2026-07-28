# webflow-anakin

A Webflow **Data Client** (OAuth app) that uses [Anakin](https://anakin.io) to
turn any URL into a new CMS collection item: a site owner picks a
destination collection and a source URL, Anakin scrapes and extracts
structured data from that URL (targeted at the collection's own field
schema), and the result is written into Webflow as a draft CMS item via the
Data API v2. Beyond that core scrape-to-CMS-item flow, it also exposes
Anakin's site-discovery (map/crawl), Wire read-action, AI Visibility,
sessions, and monitors APIs — see "Extended Anakin API coverage" below.

## What it does

1. `GET /install` — starts the Webflow OAuth authorization-code flow: mints
   a CSRF `state`, stores it server-side, and redirects to Webflow's
   authorize screen.
2. `GET /oauth/callback` — verifies `state` **before** any token exchange,
   swaps the authorization `code` for an access token, encrypts and stores
   it, and sets an opaque `installationId` cookie on the browser.
3. `GET /api/sites`, `GET /api/sites/:siteId/collections`,
   `GET /api/collections/:collectionId` — list the installed token's sites
   and collections, and read a collection's field schema (used to build the
   extraction schema hint and the write-time allowlist).
4. `POST /api/extract` — the core feature. Body
   `{ collectionId, sourceUrl, publish? }`:
   - Reads the destination collection's field schema.
   - Calls Anakin's `url-scraper` (`generateJson: true`, schema hint built
     from the collection's editable fields) to scrape `sourceUrl` and
     extract structured data.
   - Maps the extracted JSON onto the collection's `fieldData`, **allowlisted
     by the collection's actual editable field slugs** — arbitrary keys a
     scraped page's content (or an adversarially crafted page) might produce
     are dropped, not defaulted or coerced.
   - Creates the item via Webflow's Data API. Defaults to `isDraft: true`
     (AI-extracted content from an arbitrary URL is not safe to publish live
     without human review) — callers opt in to `publish: true` explicitly.
5. Anakin capability passthrough routes — `POST /api/discover/map`,
   `POST /api/discover/crawl`, `GET /api/wire/discover`,
   `GET /api/wire/catalog[/:slug]`, `POST /api/wire/read-action`,
   `GET /api/ai-visibility/sources`, `POST /api/ai-visibility/search`,
   `GET /api/sessions`, `POST /api/monitors`, `GET /api/monitors`,
   `GET /api/monitors/:id/changes`. See "Extended Anakin API coverage".

## Architecture

```
server.js               Express server: OAuth routes, installation auth, /api/extract, /api/discover/*, /api/wire/*, /api/ai-visibility/*, /api/sessions, /api/monitors*
lib/
  webflow-auth.js          Authorize-URL builder + token exchange (Webflow OAuth)
  oauth-state.js            CSRF state: mint / verify-and-consume (store-agnostic)
  session.js                 Opaque session-id cookie (httpOnly, sameSite=lax)
  token-store.js              AES-256-GCM token encryption + swappable backend
  webflow-client.js            Webflow Data API v2 client (sites, collections, items)
  anakin-client.js              Anakin API client (url-scraper, search, agentic-search, map, crawl, wire*, aiVisibility*, sessionsList, monitor*)
  extraction.js                  generatedJson -> Webflow fieldData mapping + allowlist
test/                    Unit tests (node:test) — one file per lib/ module, plus server.test.js for route wiring
scripts/smoke-test.js    Starts the real server, drives the real OAuth HTTP flow
```

## Extended Anakin API coverage

This app originally covered 3 of Anakin's REST capabilities (`scrape` via
`POST /api/extract`, plus `search`/`agentic-search` implemented in
`lib/anakin-client.js` but not yet wired to a route). This pass extends the
API surface to the rest of Anakin's capabilities that plausibly serve a
**CMS-population use case** — discovering and importing content into
Webflow, and keeping it fresh — without touching `lib/oauth-state.js` or
`lib/token-store.js`'s logic. Ground truth for every endpoint added here was
read directly from Anakin's own MCP server source
(`anakin-mcp/src/client.ts` and `anakin-mcp/src/tools/*.ts`), not guessed.

**Added** (all gated behind the existing `requireInstallation` middleware —
same cookie-derived installation lookup as `/api/sites` etc. — even though
these calls only need `ANAKIN_API_KEY`, not the Webflow token, so the whole
`/api/*` surface keeps one consistent auth boundary rather than splitting
into "needs Webflow auth" vs "doesn't"):

| Route | Anakin capability | Why it fits CMS population |
| --- | --- | --- |
| `POST /api/discover/map` | `map` | Discover a site's URL structure before committing to a bulk import — see how many pages/what shape before spending credits or Webflow API calls. |
| `POST /api/discover/crawl` | `crawl` | Bulk-fetch page content across a site as a preview step; each page can then be run through the existing `POST /api/extract` so AI-extracted fields still go through `extraction.js`'s collection-schema allowlist rather than being written unvalidated. |
| `GET /api/wire/discover` | `wire_discover` | Find a pre-built Wire action (e.g. a product-listing extractor) for a specific known site before running it. |
| `GET /api/wire/catalog`, `GET /api/wire/catalog/:slug` | `wire_catalog` | Browse/inspect a Wire site's action list and param schema before calling it. |
| `POST /api/wire/read-action` | `wire_read_action` | Pull structured data (product specs, listings, profiles) from one of Anakin's hundreds of pre-built site integrations into a CMS collection — an alternative ingestion path to raw scrape+extract for sites Wire already understands well. |
| `GET /api/ai-visibility/sources` | `ai_visibility_sources` | Roster of engines available to the search below. |
| `POST /api/ai-visibility/search` | `ai_visibility_search` | Compare AI-answer-engine responses about a brand/topic — content a marketing/SEO CMS collection can publish directly. |
| `GET /api/sessions` | `session_list` | Discover saved login sessions usable as `sessionId` on `POST /api/discover/crawl` for login-protected source pages. Session *creation* stays out of scope — it's an interactive dashboard flow (2FA/captchas), not something an API route can do. |
| `POST /api/monitors` | `monitor_create` | Watch a source page on a schedule after it's been imported, so drift from the original `/api/extract` snapshot is detectable. |
| `GET /api/monitors` | `monitor_list` | List/inspect existing monitors. |
| `GET /api/monitors/:id/changes` | `monitor_changes` | Read what changed on a watched page. |

**Not added** (per the task's own scoping and this integration's threat
model):

- `wire_write_action`, `wire_login`, `wire_build` — state-changing or
  credential-establishing Wire operations. An unattended CMS-population
  pipeline reading third-party pages should never submit forms, sign in
  as a user, or spend credits building new scrapers on their behalf.
- `session_delete` — destructive and irreversible, and not needed to *read*
  CMS content; a site owner who wants a session gone can do it from the
  Anakin dashboard.
- `browser_task` — open-ended natural-language browser automation with no
  bounded, CMS-population-shaped output; doesn't fit this app's "structured
  data in, CMS item out" model.

**Deliberately partial**: `POST /api/monitors` creates a monitor, but this
pass does **not** wire a monitor's change alerts back into an automatic
Webflow item update (that needs a webhook receiver, HMAC verification of
`alertWebhookSecret` deliveries, and a decision about which collection item
a given monitored URL maps back to — a distinct feature, not a thin
passthrough route). Flagged here rather than silently left unbuilt; see
"Known limitations."

**Secret handling**: `/monitors` responses include a one-time
`alertWebhookSecret` (an HMAC signing secret for verifying alert-webhook
deliveries). Every route that returns monitor data passes the response
through `lib/anakin-client.js`'s `redactSecrets()` first — the same
redaction rule Anakin's own MCP server applies — so that secret never
reaches a browser-side script or a server log. This is the same
"secrets that entered the process must not leak back out" instinct behind
`token-store.js` never returning a token to the browser.

## OAuth / CSRF design (why this row wasn't rushed)

An OAuth app has two security-sensitive surfaces — the `state`-parameter CSRF
defense and how access tokens are stored — so both got a real design and a
real test, not a stub.

### CSRF `state` verification

**Threat model** (`lib/oauth-state.js`'s header comment, RFC 6749 §10.12 /
OWASP's CSRF cheat sheet): without a verified `state`, an attacker can start
their own Webflow OAuth flow, capture the resulting `code`, and trick a
victim's browser into hitting `/oauth/callback?code=<attacker's code>`. If
accepted, the victim's browser gets bound to an installation the attacker
controls — data the victim later extracts and "writes to their site" would
actually flow to the attacker's connected Webflow account.

**Defense**: `createPendingAuthorization` mints 256 bits of CSPRNG randomness
(`crypto.randomBytes`, not `Math.random`) keyed server-side by the session
id from an httpOnly cookie. `verifyAndConsumeState` compares the callback's
`state` against the stored value with `crypto.timingSafeEqual`
(constant-time — a length/early-exit comparison leaks the value byte-by-byte
to an attacker probing the callback), deletes the entry on first lookup
regardless of outcome (single-use — no replay of a captured callback URL),
and enforces a 10-minute TTL. `server.js`'s `/oauth/callback` handler calls
`verifyAndConsumeState` and returns 403 **before** `exchangeCodeForToken` is
ever invoked on any non-`ok` result — the state check gates the network call
itself, not just the HTTP response.

**Independently re-verified this session** (not taken on a prior run's
word):

- `test/oauth-state.test.js` — 15 unit tests: valid state accepted; a
  single-character-tampered state rejected (`state_mismatch`); a
  well-formed but unrelated attacker-supplied state rejected; a state valid
  for a *different* session rejected (cross-session replay); missing
  session/missing state param rejected; replay of an already-consumed valid
  state rejected (`no_pending_authorization`); a *failed* attempt also
  consumes the pending entry (no retry oracle); expiry at/just-inside the
  TTL boundary; `generateState` entropy (1000 draws, no collisions, correct
  length/charset); fails closed (throws) on a missing store/sessionId.
- `scripts/smoke-test.js` drives the **real** `/install` -> `/oauth/callback`
  HTTP flow against the real running server, with real cookies, and proves
  the property that actually matters: a `GET /__test__/counters`
  (test-only route, gated behind `NODE_ENV !== "production"` **and**
  `EXPOSE_TEST_COUNTERS=1`) confirms `tokenExchangeAttempts` is incremented
  for the valid-state case and **not** incremented for the tampered-state,
  replayed-state, cross-session-state, or missing-cookie cases — i.e. the
  check rejects before the network call, not merely before the response.

### Token storage

`lib/token-store.js` splits the design into a real, tested crypto boundary
and an explicitly-flagged swappable storage boundary:

- **Real and tested**: access tokens are AES-256-GCM-encrypted
  (`TOKEN_ENCRYPTION_KEY`, 32 bytes from the environment) before they ever
  reach the backend — there is no code path that stores a plaintext token.
  GCM's auth tag means a tampered/corrupted ciphertext throws on decrypt
  instead of silently returning garbage bytes that get sent to Webflow as a
  bearer token. Verified by `test/token-store.test.js` (14 tests):
  round-trip, ciphertext never contains the plaintext as a substring, wrong
  key throws, tampered ciphertext throws, fresh IV per encryption (identical
  plaintexts -> different ciphertexts), key-length/format validation, and a
  `TokenStore` built with one key cannot decrypt another's rows.
- **Explicitly a placeholder**: the storage backend defaults to an in-memory
  `Map` — not durable, not multi-instance-safe. The constructor accepts any
  `{get, set, delete}`-shaped object, so swapping in Postgres/DynamoDB/etc.
  is a drop-in `backend:` option, not a rewrite. Flagged in the file header
  as the one piece that must change before real production traffic.
- Decrypted tokens are returned only from `TokenStore.get()`, called only by
  server-side request handlers that build a `WebflowClient` — no route ever
  returns a token to the browser. The browser holds only an opaque
  `installationId` (random UUID) in an httpOnly, `sameSite=lax` cookie
  (`secure` in production).
- Not covered (flagged, not silently skipped): key rotation — rotating
  `TOKEN_ENCRYPTION_KEY` as shipped would make existing stored tokens
  undecryptable; a production version needs envelope encryption (KMS-wrapped
  per-token data keys) or an explicit re-encryption migration.

## Real Webflow OAuth / Data API structure confirmed

Read from the real SDK/docs, not guessed — and independently re-confirmed
via live `WebFetch` of `developers.webflow.com` during this verification
pass:

- **Authorize**: `GET https://webflow.com/oauth/authorize` with
  `response_type=code`, `client_id`, `redirect_uri`, `scope` (space-separated
  `resource:action` strings, e.g. `sites:read cms:read cms:write`), `state`.
  Webflow's own docs mark `state` as *optional* but explicitly recommend it
  ("Ensure this value matches the original to protect against CSRF
  attacks.") — this integration treats it as mandatory:
  `buildAuthorizeUrl` throws rather than emitting a state-less authorize
  URL.
- **Token exchange**: `POST https://api.webflow.com/oauth/access_token`,
  body `{ client_id, client_secret, code, redirect_uri, grant_type }`.
  `redirect_uri` must exactly match the authorize step's value or Webflow
  returns `invalid_grant`. The authorization code is single-use, 15-minute
  expiry.
  - **`grant_type` is not documented** on either
    `developers.webflow.com/data/reference/oauth-app` or
    `.../data/reference/rest-introduction/quick-start` (confirmed by
    `WebFetch` of both pages) — but the **real, live endpoint requires it**.
    This was proven empirically, not assumed: `scripts/smoke-test.js` hits
    the real `https://api.webflow.com/oauth/access_token` with the fake
    smoke-test credentials. Before `grant_type: "authorization_code"` was
    added to the request body, the live endpoint returned `HTTP 400
    unsupported_grant_type`; after adding it, re-running the smoke test
    against the same live endpoint returns `HTTP 400 invalid_client` —
    proving `grant_type` is now accepted and the *only* remaining failure is
    the (deliberately) fake client credentials. That live 400
    `invalid_client` response is reproduced verbatim below in "Independently
    re-verified this session." This is live-API ground truth overriding
    incomplete docs, and is documented in `lib/webflow-auth.js`'s header
    comment so a future maintainer doesn't "helpfully" remove it to match
    the docs.
- **Bearer auth on Data API calls**: `Authorization: Bearer <access_token>`
  — confirmed via `WebFetch` of
  `developers.webflow.com/data/reference/authentication` ("Include your
  bearer token in the Authorization header"; applies to Site, Workspace, and
  OAuth tokens alike).
- **Data API v2 endpoints used**:
  - `GET /v2/sites` -> `{ sites: [...] }` (scope `sites:read`)
  - `GET /v2/sites/{site_id}/collections` -> `{ collections: [...] }` (scope
    `cms:read`)
  - `GET /v2/collections/{collection_id}` -> `{ id, displayName, fields: [...] }`
    (scope `cms:read`)
  - `POST /v2/collections/{collection_id}/items` -> creates an item, body
    `{ fieldData, isDraft, isArchived }` (scope `cms:write`)
- **App registration**: Data Clients are registered per-Workspace in the
  Webflow Dashboard (Workspace Settings -> Apps & Integrations -> App
  Development -> Create an App; Workspace-admin only), where the redirect
  URI and requested scopes are configured. New apps are private to that
  Workspace until published to the App Marketplace — external users can't
  install an unpublished app. Confirmed via `WebFetch` of
  `developers.webflow.com/data/docs/register-an-app`.
- **Not confirmed** (flagged, not assumed): the exact JSON shape of a
  successful token-exchange response beyond `access_token`, and Webflow's
  token expiry/revocation behavior — not pinned down by the docs pages
  reachable this session. This client depends only on `access_token` being
  present and treats the rest of the response as opaque.

## Anakin API usage

Ground truth for `scrapeUrl`/`search`/`agenticSearch` read directly from the
real SDK: `anakin-py/src/anakin/client.py`, `models.py`. Ground truth for
`map`/`crawl`/`wire*`/`aiVisibility*`/`sessionsList`/`monitor*` read
directly from Anakin's own MCP server source: `anakin-mcp/src/client.ts` and
`anakin-mcp/src/tools/*.ts`.

- Base URL: `https://api.anakin.io/v1`
- Auth: `X-API-Key: <key>` header — Anakin's own API key, unrelated to (and
  never stored alongside) the Webflow OAuth token.
- `POST /url-scraper` (submit) + `GET /url-scraper/:jobId` (poll) — the
  endpoint this integration's `/api/extract` uses, with `generateJson: true`
  and a schema hint built from the destination collection's editable fields.
- `POST /search`, `POST /agentic-search` + `GET /agentic-search/:jobId` —
  implemented in `lib/anakin-client.js` for completeness/parity with this
  session's other Anakin integrations; not called by any route in this app.
- `POST /map` (submit) + `GET /map/:jobId` (poll) — `POST /api/discover/map`.
- `POST /crawl` (submit) + `GET /crawl/:jobId` (poll) — `POST /api/discover/crawl`.
- `GET /wire/resolve`, `GET /wire/catalog[/:slug]` — synchronous, no polling
  — `GET /api/wire/discover`, `GET /api/wire/catalog[/:slug]`.
- `POST /wire/task` (+ `GET /wire/jobs/:jobId` poll when the response
  carries a `job_id`; some Wire actions answer synchronously inline) —
  `POST /api/wire/read-action`, restricted to read-type actions (see
  "Extended Anakin API coverage").
- `GET /ai-visibility/sources` — synchronous — `GET /api/ai-visibility/sources`.
- `POST /ai-visibility/search` (submit) + `GET /ai-visibility/search/:id`
  (poll until `status` leaves `"running"`; a terminal `"failed"` is
  returned, not thrown, since a partially-failed run still carries useful
  per-source results) — `POST /api/ai-visibility/search`.
- `GET /sessions` — synchronous, optional `?domain=` filter —
  `GET /api/sessions`.
- `POST /monitors`, `GET /monitors`, `GET /monitors/:id/changes` —
  synchronous — the `/api/monitors*` routes. Responses are redacted
  (`redactSecrets`) before leaving the process — see above.

## Setup

```sh
npm install
cp .env.example .env
# Fill in WEBFLOW_CLIENT_ID / WEBFLOW_CLIENT_SECRET (from the Webflow
# Dashboard's App Development page), TOKEN_ENCRYPTION_KEY (generate with
# the command in .env.example), and ANAKIN_API_KEY (anakin.io/dashboard).
npm start
```

## Test

```sh
npm test    # unit tests (node:test) — 87 tests across 6 files
npm run smoke   # starts the real server, drives the real OAuth HTTP flow
```

## Independently re-verified this session

Re-run from scratch against this checkout, not taken on a prior session's
report:

```
$ npm test
...
ℹ tests 87
ℹ pass 87
ℹ fail 0
```

87/87 unit tests pass: `test/oauth-state.test.js` (15 — CSRF state
verification, see above), `test/token-store.test.js` (14 — encryption),
`test/webflow-auth.test.js` (10 — authorize URL + token exchange against an
injected fetch), `test/extraction.test.js` (10 — schema-driven, allowlisted
field mapping) — all four unmodified by this pass — plus two new files added
alongside the extended API surface: `test/anakin-client.test.js` (24 — the
new `map`/`crawl`/`wire*`/`aiVisibility*`/`sessionsList`/`monitor*` client
methods' request shaping and polling behavior against an injected fetch, and
`redactSecrets`) and `test/server.test.js` (19 — the new routes' wiring:
the `requireInstallation` auth gate still applies, input validation, secret
redaction reaching the HTTP response, and downstream-error propagation, all
against a real Express app over a real socket with only `global.fetch`
swapped for a fake).

```
$ npm run smoke
server is up, running OAuth CSRF-state exercises...

--- results ---
PASS  GET /install redirects to webflow.com/oauth/authorize with a state param + session cookie
PASS  valid state -> passes CSRF check, reaches real Webflow token exchange (502 = real rejection, not a CSRF 403)
PASS  valid-state attempt incremented tokenExchangeAttempts by exactly 1
PASS  replaying the already-used valid state is rejected (403, no_pending_authorization)
PASS  tampered state is rejected with 403 state_mismatch
PASS  tampered-state attempt did NOT increment tokenExchangeAttempts (rejected BEFORE the network call)
PASS  a state valid for a different session is rejected (403 state_mismatch) — cross-session CSRF blocked
PASS  missing session cookie entirely is rejected (403 missing_session)
PASS  total tokenExchangeAttempts across the whole run is exactly 1 (only the single valid attempt)

--- server stderr ---
[webflow-anakin] token exchange failed: Webflow token exchange failed: HTTP 400 — invalid_client
[webflow-anakin] OAuth callback rejected before token exchange — reason: no_pending_authorization
[webflow-anakin] OAuth callback rejected before token exchange — reason: state_mismatch
[webflow-anakin] OAuth callback rejected before token exchange — reason: state_mismatch
[webflow-anakin] OAuth callback rejected before token exchange — reason: missing_session
```

9/9 smoke-test assertions pass. The `invalid_client` in stderr (not
`unsupported_grant_type`) is the real, live `https://api.webflow.com` server
responding to this smoke test's real network call — it's the specific proof
that `grant_type` is now accepted by the live endpoint and the only
remaining failure is the smoke test's deliberately fake
`WEBFLOW_CLIENT_ID`/`WEBFLOW_CLIENT_SECRET`.

## Not verified

- **Never run against a real Webflow account.** No real Data Client was
  registered in a Webflow Dashboard, no human ever clicked through the
  authorize/consent screen, and the OAuth callback's *success* path
  (`getTokenStore().put(...)`, the `wf_anakin_installation` cookie, and
  every route behind `requireInstallation` — `/api/sites`,
  `/api/sites/:id/collections`, `/api/collections/:id`, `/api/extract`) has
  only been unit-tested against injected fakes, never exercised end-to-end
  against Webflow's real API with a real access token.
- **`/api/extract`'s Anakin call was never made with a real
  `ANAKIN_API_KEY`.** `lib/anakin-client.js`'s request/response shapes are
  transcribed from `anakin-py`'s real source, not guessed, but never
  confirmed against a live `200` from `api.anakin.io`.
- **Same caveat for every capability added in this pass**
  (`map`/`crawl`/`wire*`/`aiVisibility*`/`sessionsList`/`monitor*`, and the
  11 routes built on them): request/response shapes are transcribed from
  Anakin's own MCP server source (`anakin-mcp/src/client.ts`,
  `src/tools/*.ts`), not guessed, and covered by unit tests against an
  injected fetch (`test/anakin-client.test.js`) and route-wiring tests
  against a real Express app with a faked `global.fetch`
  (`test/server.test.js`) — but never exercised against the real
  `api.anakin.io` with a real key, and never exercised through a real
  installed Webflow token end-to-end.
- The successful-token-exchange response shape (beyond `access_token`) and
  Webflow's token expiry/revocation semantics remain unconfirmed — see
  "Real Webflow OAuth / Data API structure confirmed" above.

## Known limitations

- `pendingAuthorizations` (CSRF state) and the `TokenStore`'s default
  backend are in-memory `Map`s — single-instance only, lost on restart.
  Both are constructed behind an injectable interface specifically so a
  shared store (Redis for state; Postgres/DynamoDB for tokens) is a drop-in
  swap before running more than one instance.
- No key-rotation story for `TOKEN_ENCRYPTION_KEY` (see "Token storage"
  above).
- No webhook/event handling for token revocation initiated from Webflow's
  side (e.g. a user uninstalling the app from their Workspace) — a stale
  `installationId` would fail on next use (`WebflowClient` call returns a
  401/403 from Webflow) rather than being proactively cleaned up.
- `POST /api/discover/crawl` and `POST /api/ai-visibility/search` hold the
  HTTP request open for the whole Anakin poll (up to 180s) rather than
  returning a job id the caller polls separately — simple, but a bad fit
  for hosts with short proxy/idle timeouts, and it ties up a Node worker
  for the duration. `POST /api/discover/crawl` additionally clamps
  `maxPages` to `MAX_CRAWL_PAGES` (50) as a stopgap; a production version
  should return `202 { jobId }` and a `GET .../:jobId` poll route instead,
  the same shape Anakin's own API already uses under the hood.
- `POST /api/monitors` creates a monitor but does not wire its change
  alerts back into an automatic Webflow item update — see "Extended Anakin
  API coverage" above. A production version needs a webhook receiver that
  verifies `alertWebhookSecret` HMAC signatures and maps a monitored URL
  back to the Webflow item it originally populated.
- The new `/api/discover/*`, `/api/wire/*`, `/api/ai-visibility/*`,
  `/api/sessions`, and `/api/monitors*` routes are thin passthroughs to
  Anakin — they do not themselves write anything to Webflow. Turning their
  output into CMS items (beyond the existing `/api/extract`) is left to the
  caller, deliberately: piping arbitrary Wire/crawl output straight into
  `fieldData` without going through `extraction.js`'s collection-schema
  allowlist would reintroduce the exact unvalidated-write risk that
  allowlist exists to prevent.
