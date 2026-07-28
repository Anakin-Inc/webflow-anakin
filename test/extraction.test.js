"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { slugify, buildExtractionSchema, mapToFieldData } = require("../lib/extraction");

test("slugify lowercases, hyphenates, and trims", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  leading and trailing  "), "leading-and-trailing");
});

test("slugify falls back to a non-empty value for empty/garbage input", () => {
  assert.match(slugify(""), /^item-\d+$/);
  assert.match(slugify("!!!"), /^item-\d+$/);
});

const COLLECTION = {
  fields: [
    { slug: "name", isEditable: true },
    { slug: "slug", isEditable: true },
    { slug: "summary", isEditable: true, displayName: "Summary" },
    { slug: "price", isEditable: true, displayName: "Price" },
    { slug: "internal-notes", isEditable: false, displayName: "Internal Notes" },
  ],
};

test("mapToFieldData allowlists only editable fields present on the destination collection", () => {
  const generatedJson = {
    name: "Widget Pro",
    summary: "A great widget",
    price: "19.99",
    "not-a-real-field": "should be dropped",
    "internal-notes": "should also be dropped (not editable)",
  };
  const fieldData = mapToFieldData(COLLECTION, generatedJson, { sourceUrl: "https://example.com/widget" });

  assert.equal(fieldData.name, "Widget Pro");
  assert.equal(fieldData.summary, "A great widget");
  assert.equal(fieldData.price, "19.99");
  assert.equal("not-a-real-field" in fieldData, false);
  assert.equal("internal-notes" in fieldData, false);
});

test("mapToFieldData always produces name and slug", () => {
  const fieldData = mapToFieldData(COLLECTION, {}, { sourceUrl: "https://example.com/page" });
  assert.equal(typeof fieldData.name, "string");
  assert.ok(fieldData.name.length > 0);
  assert.equal(typeof fieldData.slug, "string");
  assert.ok(fieldData.slug.length > 0);
});

test("mapToFieldData falls back to sourceUrl for name when extraction produced none", () => {
  const fieldData = mapToFieldData(COLLECTION, {}, { sourceUrl: "https://example.com/no-title-page" });
  assert.equal(fieldData.name, "https://example.com/no-title-page");
});

test("mapToFieldData prefers an explicit `title` over falling back to sourceUrl", () => {
  const fieldData = mapToFieldData(COLLECTION, { title: "A Real Title" }, { sourceUrl: "https://example.com/x" });
  assert.equal(fieldData.name, "A Real Title");
});

test("mapToFieldData tolerates the agentic-search-style { structuredData } wrapper shape", () => {
  const fieldData = mapToFieldData(
    COLLECTION,
    { summary: "top-level, ignored if structuredData present", structuredData: { name: "Nested Name", summary: "Nested summary" } },
    { sourceUrl: "https://example.com/x" }
  );
  assert.equal(fieldData.name, "Nested Name");
  assert.equal(fieldData.summary, "Nested summary");
});

test("buildExtractionSchema includes only editable, non-name/slug fields", () => {
  const schema = buildExtractionSchema(COLLECTION);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["price", "summary"]);
});

test("buildExtractionSchema handles a collection with no fields", () => {
  const schema = buildExtractionSchema({ fields: [] });
  assert.deepEqual(schema.properties, {});
});
