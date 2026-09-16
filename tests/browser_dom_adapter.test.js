"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const { extractDocument } = require("../scripts/browser_extract_evc");

function extractFixture(name, pageNumber = 1) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "html", name), "utf8");
  const { document } = parseHTML(html);
  return extractDocument(document, pageNumber);
}

function assertNoCardCredentials(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["4111 1111 1111 1111", "CVV 999", "12/99", "cardNumber", "mfaCode", "password"]) {
    assert.equal(serialized.includes(forbidden), false, `output exposed forbidden value: ${forbidden}`);
  }
}

test("reads both queues, nested payout, property, count, and disabled pagination from HTML", () => {
  const result = extractFixture("both-queues.html");
  assert.equal(result.status, "complete");
  assert.deepEqual(result.property, { id: "TEST-100", name: "Example Hotel" });
  assert.equal(result.expectedCount, 3);
  assert.equal(result.pagination.hasNext, false);
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].originalPayout, "USD 150.00");
  assert.equal(result.records[2].queue, "refund_due");
  assertNoCardCredentials(result);
});

test("maps reordered HTML columns and enabled pagination", () => {
  const result = extractFixture("reordered-columns.html", 2);
  assert.equal(result.status, "complete");
  assert.equal(result.pageNumber, 2);
  assert.equal(result.pagination.hasNext, true);
  assert.equal(result.records[0].reservationId, "R-200");
  assert.equal(result.records[0].amount, "USD 75.50");
  assert.equal(result.records[1].guest, "Casey Example");
});

test("accepts explicitly empty HTML sections", () => {
  const result = extractFixture("empty-queues.html");
  assert.equal(result.status, "complete");
  assert.equal(result.expectedCount, 0);
  assert.deepEqual(result.records, []);
});

test("fails closed on a missing HTML header", () => {
  const result = extractFixture("missing-header.html");
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /missing required headers: reservationId/);
});

test("fails closed when HTML does not identify the property", () => {
  const result = extractFixture("missing-property.html");
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /Property identity was not verified/);
});
