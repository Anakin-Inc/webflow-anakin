"use strict";

/**
 * Maps Anakin's `generatedJson` output (from `scrapeUrl` with
 * `generateJson: true`) onto a Webflow CMS collection's `fieldData` shape.
 *
 * Security note: `mapToFieldData` allowlists by the target collection's
 * actual editable field slugs (from `WebflowClient.getCollection`) rather
 * than spreading Anakin's output into the item body directly. Without this,
 * whatever a scraped third-party page's content happened to produce (or an
 * adversarially crafted page designed to confuse the extraction model)
 * could set arbitrary keys on the Webflow item. Only keys that already
 * exist as an editable field on the destination collection are copied
 * over; everything else is silently dropped, not defaulted or coerced.
 */

/**
 * @param {string} input
 * @returns {string} a Webflow-slug-safe string (lowercase, hyphenated, non-empty).
 */
function slugify(input) {
  const slug = String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 256);
  return slug || `item-${Date.now()}`;
}

/**
 * Builds a `generateJson` schema hint from a Webflow collection's field
 * list, so Anakin's extraction targets field names the destination
 * collection actually has. Best-effort only — Webflow's `getCollection`
 * schema, and the allowlist in `mapToFieldData`, are the actual source of
 * truth for what gets written, not this hint.
 *
 * @param {{fields?: Array<{slug: string, displayName?: string, isEditable?: boolean}>}} collection
 */
function buildExtractionSchema(collection) {
  const properties = {};
  for (const field of (collection && collection.fields) || []) {
    if (!field.isEditable) continue;
    if (field.slug === "name" || field.slug === "slug") continue;
    properties[field.slug] = { type: "string", description: field.displayName || field.slug };
  }
  return { type: "object", properties };
}

/**
 * @param {{fields?: Array<{slug: string, isEditable?: boolean}>}} collection
 * @param {object} generatedJson - Anakin's Document.generatedJson (or an agentic-search-style { structuredData } wrapper — both shapes are tolerated).
 * @param {object} [opts]
 * @param {string} [opts.sourceUrl] - used as a name/slug fallback if extraction produced neither.
 * @returns {{name: string, slug: string, [key: string]: any}}
 */
function mapToFieldData(collection, generatedJson, { sourceUrl } = {}) {
  const editableSlugs = new Set(
    ((collection && collection.fields) || []).filter((f) => f.isEditable).map((f) => f.slug)
  );

  const data = (generatedJson && generatedJson.structuredData) || generatedJson || {};

  const name =
    (typeof data.name === "string" && data.name.trim()) ||
    (typeof data.title === "string" && data.title.trim()) ||
    sourceUrl ||
    `Untitled item ${new Date().toISOString()}`;

  const fieldData = {
    name,
    slug: slugify(data.slug || name),
  };

  for (const [key, value] of Object.entries(data)) {
    if (key === "name" || key === "slug") continue;
    if (!editableSlugs.has(key)) continue; // allowlist — see file header
    fieldData[key] = value;
  }

  return fieldData;
}

module.exports = { slugify, buildExtractionSchema, mapToFieldData };
