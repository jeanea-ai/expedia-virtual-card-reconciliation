"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMoney, reconcilePages: reconcileRawPages } = require("../scripts/extract_evc");

const TEST_CONTEXT = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "run-context.json"), "utf8"));

function completePage(page) {
  return {
    extractionVersion: "1.0.0",
    status: "complete",
    property: { id: "TEST-100", name: "Example Hotel" },
    pagination: { hasNext: false, range: null },
    expectedCount: null,
    warnings: [],
    ...page,
    records: (page.records || []).map((record) => ({ checkIn: "", status: "", ...record }))
  };
}

function reconcilePages(pages, options = {}) {
  return reconcileRawPages(pages.map(completePage), { context: TEST_CONTEXT, ...options });
}

test("parses currency with exact cents", () => {
  assert.deepEqual(parseMoney("USD 1,234.56"), { currency: "USD", amountCents: 123456 });
  assert.deepEqual(parseMoney("$25.50 USD"), { currency: "USD", amountCents: 2550 });
  assert.throws(() => parseMoney("$12.5"), /Invalid money/);
});

test("merges pages, validates totals, and preserves source pages", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "two-pages.json"), "utf8"));
  const result = reconcilePages(fixture);
  assert.equal(result.status, "complete");
  assert.equal(result.extractedCount, 3);
  assert.deepEqual(result.totals.USD, { readyToChargeCents: 133456, refundDueCents: 2550 });
  assert.deepEqual(result.records.map((record) => record.sourcePage), [1, 1, 2]);
});

test("fails closed on repeated pagination results", () => {
  const page = { pageNumber: 1, records: [{ queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "1.00" }] };
  assert.throws(() => reconcilePages([page, { ...page, pageNumber: 2 }]), /Repeated pagination/);
});

test("marks mismatched displayed totals incomplete", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 2, records: [{ queue: "refund_due", guest: "A", reservationId: "R1", amount: "1.00" }] }]);
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings[0], /Expected 2/);
});

test("fails closed when the displayed total is unavailable", () => {
  const result = reconcilePages([{ pageNumber: 1, records: [] }]);
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /Displayed result count is required/);
});

test("fails closed when the displayed total changes between pages", () => {
  const first = { pageNumber: 1, expectedCount: 2, records: [{ queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "1.00" }] };
  const second = { pageNumber: 2, expectedCount: 3, records: [{ queue: "ready_to_charge", guest: "B", reservationId: "R2", amount: "2.00" }] };
  const result = reconcilePages([first, second]);
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /changed during pagination/);
});

test("deduplicates identical records and reports the decision", () => {
  const row = { queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "USD 10.00" };
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 1, records: [row, row] }]);
  assert.equal(result.extractedCount, 1);
  assert.match(result.warnings[0], /Duplicate skipped/);
});

test("excludes and reports conflicting duplicates without double-counting", () => {
  const result = reconcilePages([{
    pageNumber: 1,
    expectedCount: 2,
    records: [
      { queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "USD 10.00" },
      { queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "USD 25.00" }
    ]
  }]);
  assert.equal(result.status, "incomplete");
  assert.equal(result.records.length, 1);
  assert.equal(result.totals.USD.readyToChargeCents, 1000);
  assert.deepEqual(result.conflicts, [{
    queue: "ready_to_charge",
    reservationId: "R1",
    firstPage: 1,
    conflictingPage: 1,
    fields: ["amountCents"]
  }]);
});

test("treats a status change as a conflict even when the amount is unchanged", () => {
  const result = reconcilePages([{
    pageNumber: 1,
    expectedCount: 2,
    records: [
      { queue: "ready_to_charge", guest: "A", reservationId: "R1", status: "Available", amount: "USD 10.00" },
      { queue: "ready_to_charge", guest: "A", reservationId: "R1", status: "Deactivated", amount: "USD 10.00" }
    ]
  }]);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.conflicts[0].fields, ["status"]);
});

test("accepts a validated empty page", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 0, records: [] }]);
  assert.equal(result.status, "complete");
  assert.equal(result.extractedCount, 0);
});

test("retains deactivated observations without treating them as chargeable money", () => {
  const result = reconcilePages([{
    pageNumber: 1,
    expectedCount: 1,
    records: [{ queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: null, status: "Deactivated" }]
  }]);
  assert.equal(result.status, "complete");
  assert.equal(result.extractedCount, 1);
  assert.deepEqual(result.currencies, []);
  assert.deepEqual(result.totals, {});
  assert.equal(result.records[0].actionable, false);
  assert.equal(result.records[0].amountCents, null);
});

test("detects repeated empty pages", () => {
  assert.throws(
    () => reconcilePages([
      { pageNumber: 1, expectedCount: 0, records: [] },
      { pageNumber: 2, expectedCount: 0, records: [] }
    ]),
    /Repeated pagination/
  );
});

test("rejects malformed records instead of guessing", () => {
  assert.throws(
    () => reconcilePages([{ pageNumber: 1, records: [{ queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "about ten dollars" }] }]),
    /Invalid money/
  );
});

test("propagates verified run and property metadata", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 0, records: [] }]);
  assert.equal(result.runId, TEST_CONTEXT.runId);
  assert.equal(result.generatedAt, TEST_CONTEXT.generatedAt);
  assert.equal(result.timezone, TEST_CONTEXT.timezone);
  assert.deepEqual(result.property, TEST_CONTEXT.expectedProperty);
});

test("fails closed when the observed property ID differs", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 0, property: { id: "WRONG", name: "Example Hotel" }, records: [] }]);
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /Property ID mismatch/);
});

test("keeps a matching property ID authoritative when the name formatting differs", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 0, property: { id: "TEST-100", name: "Example-Hotel" }, records: [] }]);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.warnings, []);
});

test("propagates an incomplete extracted page", () => {
  const result = reconcilePages([{ pageNumber: 1, status: "incomplete", expectedCount: 0, warnings: ["Required section not found"], records: [] }]);
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /Required section not found/);
});

test("rejects invalid run metadata", () => {
  const bad = { ...TEST_CONTEXT, timezone: "Not/A_Real_Zone" };
  assert.throws(() => reconcileRawPages([completePage({ pageNumber: 1, expectedCount: 0, records: [] })], { context: bad }), /valid IANA timezone/);
});
