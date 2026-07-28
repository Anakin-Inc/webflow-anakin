"use strict";

/**
 * Minimal Webflow Data API v2 client — just the endpoints this integration
 * uses. Shapes confirmed live this session via WebFetch (see README):
 *
 *  - GET  /v2/sites                              -> { sites: [{id, displayName, ...}] }   (scope: sites:read)
 *  - GET  /v2/sites/{site_id}/collections         -> { collections: [{id, displayName, slug, ...}] }  (scope: cms:read)
 *  - GET  /v2/collections/{collection_id}         -> { id, displayName, fields: [{id, slug, type, displayName, isRequired, isEditable, ...}] }  (scope: cms:read)
 *  - POST /v2/collections/{collection_id}/items   -> creates an item; body { fieldData, isDraft, isArchived }, fieldData requires `name` + `slug`  (scope: cms:write)
 *
 * Auth: `Authorization: Bearer <access_token>` header (confirmed via
 * WebFetch of developers.webflow.com/data/reference/authentication).
 */

const BASE_URL = "https://api.webflow.com/v2";

class WebflowClient {
  /**
   * @param {object} opts
   * @param {string} opts.accessToken - decrypted token from TokenStore.get() — never a raw client-supplied value.
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {string} [opts.baseUrl]
   */
  constructor({ accessToken, fetchImpl = fetch, baseUrl = BASE_URL } = {}) {
    if (!accessToken) throw new Error("accessToken is required");
    this.accessToken = accessToken;
    this._fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
      ...extra,
    };
  }

  async _json(res, context) {
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const message = (body && body.message) || res.statusText || "unknown error";
      throw new Error(`${context} failed: HTTP ${res.status} — ${message}`);
    }
    return body;
  }

  /** GET /v2/sites — list sites the installed token can access. */
  async listSites() {
    const res = await this._fetch(`${this.baseUrl}/sites`, { headers: this._headers() });
    const body = await this._json(res, "Webflow GET /sites");
    return body.sites || [];
  }

  /** GET /v2/sites/{site_id}/collections */
  async listCollections(siteId) {
    if (!siteId) throw new Error("siteId is required");
    const res = await this._fetch(`${this.baseUrl}/sites/${encodeURIComponent(siteId)}/collections`, {
      headers: this._headers(),
    });
    const body = await this._json(res, "Webflow GET /sites/:id/collections");
    return body.collections || [];
  }

  /** GET /v2/collections/{collection_id} — includes the `fields` schema. */
  async getCollection(collectionId) {
    if (!collectionId) throw new Error("collectionId is required");
    const res = await this._fetch(`${this.baseUrl}/collections/${encodeURIComponent(collectionId)}`, {
      headers: this._headers(),
    });
    return this._json(res, "Webflow GET /collections/:id");
  }

  /**
   * POST /v2/collections/{collection_id}/items
   *
   * Defaults `isDraft: true` — this integration writes AI-extracted content
   * from an arbitrary URL the site owner supplied; publishing it live
   * without a human reviewing it first is not a safe default. Callers that
   * want it live immediately must pass `isDraft: false` explicitly (see
   * server.js's POST /api/extract, which only does so on an explicit
   * request-body opt-in).
   */
  async createItem(collectionId, fieldData, { isDraft = true, isArchived = false } = {}) {
    if (!collectionId) throw new Error("collectionId is required");
    if (!fieldData || typeof fieldData !== "object") throw new Error("fieldData is required");
    const res = await this._fetch(`${this.baseUrl}/collections/${encodeURIComponent(collectionId)}/items`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fieldData, isDraft, isArchived }),
    });
    return this._json(res, "Webflow POST /collections/:id/items");
  }
}

module.exports = { WebflowClient, BASE_URL };
