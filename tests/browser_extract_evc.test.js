"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSnapshot } = require("../scripts/browser_extract_evc");
const { reconcilePages } = require("../scripts/extract_evc");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

test("extracts charge and refund queues by header names regardless of column order", () => {
  const result = extractSnapshot(fixture("browser-both-queues.json"));
  assert.equal(result.status, "complete");
  assert.equal(result.expectedCount, 3);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records[0], {
    queue: "ready_to_charge",
    guest: "Alex Example",
    reservationId: "R-100",
    amount: "USD 120.00",
    checkIn: "2026-09-10",
    status: "Available",
    originalPayout: "USD 150.00"
  });
  assert.equal(result.records[2].queue, "refund_due");
  assert.equal(result.records[2].amount, "USD 20.00");
});

test("accepts validated empty charge and refund sections", () => {
  const result = extractSnapshot(fixture("browser-empty.json"));
  assert.equal(result.status, "complete");
  assert.equal(result.expectedCount, 0);
  assert.deepEqual(result.records, []);
});

test("fails closed when a required header is missing", () => {
  const result = extractSnapshot(fixture("browser-missing-header.json"));
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /missing required headers: reservationId/);
});

test("fails closed when property identity or displayed totals are unavailable", () => {
  const result = extractSnapshot({ tables: [] });
  assert.equal(result.status, "incomplete");
  assert.match(result.warnings.join("\n"), /Property identity was not verified/);
  assert.match(result.warnings.join("\n"), /Displayed result count was not found/);
});

test("feeds extracted queues into deterministic reconciliation", () => {
  const extracted = extractSnapshot(fixture("browser-both-queues.json"));
  const reconciled = reconcilePages([extracted]);
  assert.equal(reconciled.status, "complete");
  assert.deepEqual(reconciled.totals.USD, {
    readyToChargeCents: 16525,
    refundDueCents: 2000
  });
  assert.equal(reconciled.records[0].originalPayoutCents, 15000);
});
