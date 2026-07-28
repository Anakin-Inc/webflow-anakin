# Webflow App Marketplace — submission instructions

Real, but — like `github-app-anakin` — a standing-service submission, not a
PR-to-a-registry one: a Data Client needs a deployed host and an OAuth
Workspace registration *before* a Marketplace listing is even possible, and
the listing itself is a reviewed process on top of that. Nothing here was
registered or submitted — that needs the account owner's real Webflow
identity, a deployed host, and a Workspace they administer.

## What's here

```
server.js               Express server: OAuth routes, /api/*, /api/extract, /api/discover/*, /api/wire/*, /api/ai-visibility/*, /api/sessions, /api/monitors*
lib/webflow-auth.js        Authorize-URL builder + token exchange (Webflow OAuth)
lib/oauth-state.js          CSRF state: mint / verify-and-consume
lib/session.js                Opaque session cookie
lib/token-store.js             AES-256-GCM token encryption + swappable backend
lib/webflow-client.js           Webflow Data API v2 client
lib/anakin-client.js              Anakin API client (scrape, search, agentic-search, map, crawl, wire*, aiVisibility*, sessionsList, monitor*)
lib/extraction.js                  generatedJson -> Webflow fieldData mapping
test/*.test.js           node:test unit tests (87 total, 6 files)
scripts/smoke-test.js     Starts the real server, drives the real OAuth HTTP flow
package.json, .env.example, .gitignore
```

## API surface: from 3 capabilities to 14 of 21

This row started covering 3 of Anakin's 21 REST capabilities (`scrape` via
`POST /api/extract`; `search`/`agentic-search` implemented in
`lib/anakin-client.js` but not wired to a route). This pass extends the
surface to 11 more — `map`, `crawl`, `wire_discover`, `wire_catalog`,
`wire_read_action`, `ai_visibility_sources`, `ai_visibility_search`,
`session_list`, `monitor_create`, `monitor_list`, `monitor_changes` — chosen
because each plausibly serves this app's CMS-population use case: site
discovery before a bulk import, structured extraction from Anakin's
pre-built site catalog, AI-visibility content for a marketing collection,
and change tracking for already-imported pages. Every new route reuses the
existing `requireInstallation` auth gate (same cookie -> `TokenStore`
lookup) without any change to `lib/oauth-state.js` or `lib/token-store.js`.

Deliberately excluded: `wire_write_action`/`wire_login`/`wire_build` (state-
changing or credential-establishing — wrong shape for an unattended read
pipeline), `session_delete` (destructive, not needed to read CMS content),
`browser_task` (open-ended, no bounded CMS-population output). Full
reasoning and the per-route table are in README's "Extended Anakin API
coverage."

## Real Webflow OAuth / Data Client structure — confirmed live, not guessed

All of the following was read directly from `developers.webflow.com` via
`WebFetch` during this verification pass (re-confirmed independently, not
carried over from a prior session's notes):

- **Registering a Data Client** —
  `developers.webflow.com/data/docs/register-an-app`: registered per-Workspace
  in the Webflow Dashboard, under Workspace Settings -> Apps & Integrations
  -> App Development -> "Create an App"; Workspace-admin only. Requires app
  name, description (max 140 chars), icon, homepage URL, a valid HTTPS
  redirect URI, and the specific scopes requested. New apps are private to
  the registering Workspace — "External users can't install your app until
  it's approved and published in the Webflow Marketplace." After
  publishing, adding new scopes requires resubmitting for approval as an
  "App Update."
- **Authorize endpoint** —
  `developers.webflow.com/data/reference/oauth-app`:
  `GET https://webflow.com/oauth/authorize` with `response_type=code`,
  `client_id`, `redirect_uri`, `scope` (`resource:action`, space-separated),
  `state`. Webflow's docs mark `state` as optional-but-recommended
  ("Ensure this value matches the original to protect against CSRF
  attacks.") — `lib/webflow-auth.js`'s `buildAuthorizeUrl` makes it
  mandatory instead, throwing rather than emitting a state-less URL.
- **Token exchange** — same page:
  `POST https://api.webflow.com/oauth/access_token`, body
  `{client_id, client_secret, code, redirect_uri, grant_type}`. `grant_type`
  is undocumented on that page and on
  `.../data/reference/rest-introduction/quick-start` (confirmed via
  `WebFetch` of both), but the real endpoint requires it — proven live by
  `scripts/smoke-test.js` (see README's "Real Webflow OAuth / Data API
  structure confirmed" for the exact before/after error strings:
  `unsupported_grant_type` without it, `invalid_client` with it, against the
  real `api.webflow.com` host).
- **Bearer auth** —
  `developers.webflow.com/data/reference/authentication`: `Authorization:
  Bearer <token>`, same scheme for Site, Workspace, and OAuth tokens.
- **Data API v2 shapes** used by `lib/webflow-client.js` — `GET /v2/sites`,
  `GET /v2/sites/{id}/collections`, `GET /v2/collections/{id}` (returns
  `fields[]`), `POST /v2/collections/{id}/items` (body
  `{fieldData, isDraft, isArchived}`) — matches the endpoints this
  integration exercises against `sites:read`/`cms:read`/`cms:write` scopes.
- **Marketplace submission requirements** (via `WebSearch`, since
  `developers.webflow.com/data/docs/submitting-your-app` 404'd on direct
  `WebFetch` — same "docs URL 404s, resolve via search" situation the
  `github-app-anakin` submission hit for GitHub Marketplace): technical
  requirements include two-factor authentication enabled on an admin
  account of the submitting Workspace, the app being "thoroughly tested and
  fully functional," clear documentation and error handling, and adherence
  to Webflow's security/privacy guidelines. Submission is via a Webflow App
  submission form plus the app's source code; review targets a decision
  within 10-15 business days, communicated to the account's email. If the
  app has account-based features, reviewers need either an active demo
  account, a fully-featured demo mode, or granted access to the necessary
  resources so they can exercise it directly. Webflow's Marketplace
  Guidelines additionally require that the app not compromise user/project
  security and only use content the developer has rights to.

## What's real and verified vs what needs the account owner

**Built and independently re-verified in this sandbox** (re-run from
scratch this pass, not taken on a prior run's word):

- `npm install` — succeeds (`express`, `cookie`, `dotenv` from the npm
  registry).
- `npm test` — **87/87 unit tests pass**, `node:test`:
  - `test/oauth-state.test.js` (15) — CSRF `state` verification: valid
    accepted; tampered (single char flipped) rejected; unrelated
    attacker-supplied state rejected; state valid for a *different* session
    rejected (cross-session CSRF); missing session / missing state param
    rejected; replay of a consumed state rejected; a failed attempt also
    consumes the slot (no retry oracle); TTL expiry at/inside the boundary;
    `generateState` entropy (1000 draws, no collisions); fails closed on
    missing store/sessionId.
  - `test/token-store.test.js` (14) — AES-256-GCM round-trip, ciphertext
    never contains plaintext, wrong key throws, tampered ciphertext throws
    (GCM auth tag), fresh IV per call, key validation, cross-instance
    isolation.
  - `test/webflow-auth.test.js` (10) — authorize URL targets the real
    `webflow.com/oauth/authorize` host/path with the documented params;
    refuses to build a state-less URL; token exchange POSTs the documented
    body shape to the real `api.webflow.com` token URL (fetch injected, no
    live call in this file); error/missing-`access_token` handling.
  - `test/extraction.test.js` (10) — allowlisted field mapping, schema
    building, name/slug fallback logic.
  - `test/anakin-client.test.js` (24, new this pass) — the 11 newly added
    Anakin client methods' request shaping and job-polling behavior against
    an injected fetch (map/crawl submit+poll, Wire sync GET + async
    submit/poll, AI Visibility poll-until-not-running incl. returning a
    terminal "failed" rather than throwing, sessions, monitors), plus
    `redactSecrets`.
  - `test/server.test.js` (19, new this pass) — the 11 new routes' wiring
    against a real Express app on a real socket (fake `global.fetch` only):
    the `requireInstallation` 401 gate still applies to the new routes,
    input validation (missing required fields, `maxPages` ceiling,
    `intervalMinutes` minimum), `alertWebhookSecret` redaction reaching the
    actual HTTP response body, and downstream Anakin errors surfacing as
    502 instead of crashing the process.
  - **The four pre-existing test files are byte-for-byte unmodified by this
    pass** — same 44 tests, same assertions, confirming the CSRF/token-
    security work wasn't touched while extending the API surface.
- **The CSRF `state` check was actually exercised end-to-end against the
  real Webflow token endpoint, not bypassed**: `npm run smoke` starts the
  real `server.js` as a child process and drives the real
  `/install` -> `/oauth/callback` HTTP flow with real cookies, using
  deliberately fake `WEBFLOW_CLIENT_ID`/`WEBFLOW_CLIENT_SECRET`. All 9
  assertions passed on this run, including the two that matter most for the
  "not rushed" call on this row:
  - the valid-state case reaches the real
    `https://api.webflow.com/oauth/access_token` and gets a real `HTTP 400
    invalid_client` back (proving the accept path runs the real network
    call, not a stub, and that `grant_type` is now accepted by the live
    endpoint);
  - the tampered/replayed/cross-session/no-cookie cases are all rejected via
    `GET /__test__/counters` showing `tokenExchangeAttempts` was **not**
    incremented — i.e. state verification gates the network call itself,
    confirmed by instrumentation, not inferred from the HTTP status alone.
- Token encryption is real (see `test/token-store.test.js` above); the
  storage *backend* is an explicitly-flagged in-memory placeholder (see
  README's "Token storage" section) — swappable, not silently left as a
  production gap.

**Not done — needs a real Webflow Workspace/account and a real Anakin key:**

- **No Data Client was ever registered in a real Webflow Dashboard.**
  Registration needs a Workspace admin, a real HTTPS redirect URI (a
  deployed host, or a tunnel during dev), and confirming creation in
  Webflow's UI — none of which exist in this sandbox.
- **No human ever completed the real OAuth consent screen.** Every OAuth
  exercise above is this server driving its own `/install` redirect and
  then hitting `/oauth/callback` with either a real (but not human-clicked)
  redirect chain or synthetic query params — not a live authorization
  granted by an actual Webflow user through Webflow's real consent UI.
- **The success path was never completed against a real token.** Because
  the smoke test's client credentials are deliberately fake, the flow always
  terminates at Webflow's real `invalid_client` rejection — `TokenStore.put`,
  the `wf_anakin_installation` cookie, and every route behind
  `requireInstallation` (`/api/sites`, `/api/sites/:id/collections`,
  `/api/collections/:id`, `/api/extract`) have only been exercised against
  unit-test fakes, never against a real Webflow access token or a real
  site/collection.
- **No real Anakin API key was used.** `lib/anakin-client.js`'s
  request/response shapes are transcribed from `anakin-py`'s real
  `client.py`/`models.py` source (same standard as this session's other
  Anakin integrations), but never confirmed against a live `200` from
  `api.anakin.io`. Same caveat for the 11 capabilities added in this pass
  (`map`/`crawl`/`wire*`/`aiVisibility*`/`sessionsList`/`monitor*`) — their
  shapes are transcribed from Anakin's own MCP server source
  (`anakin-mcp/src/client.ts`, `src/tools/*.ts`) and covered by injected-
  fetch unit tests, but never hit against the live API either.
- **No Marketplace listing was drafted or submitted.** That needs: the app
  registered under a real Workspace, 2FA enabled on the submitting admin
  account, a deployed and publicly reachable host, a demo account or demo
  mode for reviewers, and completion of Webflow's app submission form with
  the source code attached — none of which are engineering tasks this
  session can do on the account owner's behalf.

## Steps (needs the account owner)

1. Deploy `server.js` somewhere with a stable public HTTPS URL (or a tunnel
   for testing) and set real env vars from `.env.example`, including a
   freshly generated `TOKEN_ENCRYPTION_KEY`.
2. In the Webflow Dashboard: Workspace Settings -> Apps & Integrations ->
   App Development -> Create an App. Set the redirect URI to
   `https://<your-host>/oauth/callback` (must exactly match
   `WEBFLOW_REDIRECT_URI`), and request scopes `sites:read`, `cms:read`,
   `cms:write`. Save the issued Client ID / Client Secret into the deployed
   server's env.
3. As a Workspace member, visit `https://<your-host>/install`, complete the
   real Webflow consent screen, and confirm the browser lands on "Webflow
   connected" with a real `wf_anakin_installation` cookie set.
4. Exercise `/api/sites` -> `/api/sites/:id/collections` ->
   `/api/collections/:id` -> `POST /api/extract` against a real test site
   and collection with a real `ANAKIN_API_KEY`; confirm a real draft CMS
   item is created and its `fieldData` matches the collection's schema.
5. Swap `TokenStore`'s backend from the default in-memory `Map` to a durable
   store (Postgres/DynamoDB/etc.) and `pendingAuthorizations` to a shared
   store (Redis) before running more than one instance.
6. For the Marketplace: enable 2FA on the submitting Workspace admin
   account, prepare a demo account or demo mode for reviewers, and submit
   via Webflow's app submission form with the source code attached. Expect
   a decision in roughly 10-15 business days per Webflow's stated review
   timeline.
