"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMoney, reconcilePages } = require("../scripts/extract_evc");

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

test("deduplicates identical records and reports the decision", () => {
  const row = { queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "USD 10.00" };
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 1, records: [row, row] }]);
  assert.equal(result.extractedCount, 1);
  assert.match(result.warnings[0], /Duplicate skipped/);
});

test("accepts a validated empty page", () => {
  const result = reconcilePages([{ pageNumber: 1, expectedCount: 0, records: [] }]);
  assert.equal(result.status, "complete");
  assert.equal(result.extractedCount, 0);
});

test("rejects malformed records instead of guessing", () => {
  assert.throws(
    () => reconcilePages([{ pageNumber: 1, records: [{ queue: "ready_to_charge", guest: "A", reservationId: "R1", amount: "about ten dollars" }] }]),
    /Invalid money/
  );
});
