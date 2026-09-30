"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSnapshot, extractDocument } = require("../scripts/browser_extract_evc");
const { reconcilePages } = require("../scripts/extract_evc");
const { parseHTML } = require("linkedom");
const RUN_CONTEXT = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "run-context.json"), "utf8"));

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

function htmlFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", "html", name), "utf8");
}

function extractHtml(html, pageNumber = 1) {
  const { document } = parseHTML(html);
  return extractDocument(document, pageNumber);
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
  const reconciled = reconcilePages([extracted], { context: RUN_CONTEXT });
  assert.equal(reconciled.status, "complete");
  assert.deepEqual(reconciled.totals.USD, {
    readyToChargeCents: 16525,
    refundDueCents: 2000
  });
  assert.equal(reconciled.records[0].originalPayoutCents, 15000);
});

test("extracts per-queue pagination and help-text money headers from the live page shape", () => {
  const result = extractHtml(htmlFixture("per-queue-pagination.html"));
  assert.equal(result.status, "complete");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.expectedCount, 3);
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].queue, "refund_due");
  assert.equal(result.records[0].guest, "Example Guest");
  assert.equal(result.records[0].reservationId, "R100");
  assert.equal(result.records[0].amount, "USD 100.00");
  assert.equal(result.records[1].queue, "ready_to_charge");
  assert.equal(result.records[1].amount, null);
  assert.equal(result.records[1].status, "Deactivated");
  assert.equal(result.records[2].queue, "ready_to_charge");
  assert.equal(result.records[2].amount, null);
  assert.equal(result.records[2].status, "Deactivated");
  assert.equal(result.pagination.hasNext, false);
  assert.equal(result.pagination.range, "refund_due 1-1 of 1; ready_to_charge 1-2 of 2");
});

test("flags remaining pages when any queue range shows more records to come", () => {
  const html = htmlFixture("per-queue-pagination.html").replace(">1-2 of 2<", ">1-2 of 4<");
  const result = extractHtml(html);
  assert.equal(result.status, "complete");
  assert.equal(result.expectedCount, 5);
  assert.equal(result.pagination.hasNext, true);
  assert.equal(result.pagination.range, "refund_due 1-1 of 1; ready_to_charge 1-2 of 4");
});

test("fails closed on an ambiguous per-queue pagination range", () => {
  const result = extractHtml(htmlFixture("per-queue-ambiguous-range.html"));
  assert.equal(result.status, "incomplete");
  assert.equal(result.expectedCount, null);
  assert.match(result.warnings.join("\n"), /Ambiguous pagination range in refund_due section/);
});

test("fails closed when a queued table has no displayed count and no global range", () => {
  const result = extractHtml(htmlFixture("per-queue-missing-range.html"));
  assert.equal(result.status, "incomplete");
  assert.equal(result.expectedCount, null);
  assert.match(result.warnings.join("\n"), /Displayed count not found for refund_due section/);
});

test("prefix fallback picks the help-text money header and never Card details or Reason for refund", () => {
  // Known alias semantics stay unchanged: the refundAmount alias list includes the bare
  // alias "amount", so a header like "Amount authorized" prefix-matches it. This test
  // documents that behavior; the aliases themselves are not changed.
  const helpText = "Refund duerefund amounts are calculated using your updated payout and any charges you have already made to the virtual card";
  const result = extractSnapshot({
    property: { id: "TEST-100", name: "Example Hotel" },
    expectedCounts: { ready_to_charge: 2, refund_due: 1 },
    pagination: { hasNext: false, range: "refund_due 1-1 of 1; ready_to_charge 1-2 of 2" },
    tables: [
      {
        sectionLabel: "Virtual cards to refund",
        headers: ["", "Card details", "Guest", "Reservation", "Reason for refund", helpText],
        rows: [{ cells: ["", "Virtual card", "Example Guest", "R100", "Duplicate charge", "USD 100.00"], detailRows: [] }]
      },
      {
        sectionLabel: "Virtual cards ready to charge",
        headers: ["", "Guest", "Reservation", "Check-in date", "Card details", "Charge before", "Remaining balance"],
        rows: [{ cells: ["", "Sky Example", "R101", "2026-09-30", "Virtual card", "2026-10-01", "Deactivated"], detailRows: [] }]
      }
    ]
  });
  assert.equal(result.status, "complete");
  assert.equal(result.records[0].amount, "USD 100.00");
  assert.equal(result.records[1].amount, null);
  assert.equal(result.records[1].status, "Deactivated");

  const authorized = extractSnapshot({
    property: { id: "TEST-100", name: "Example Hotel" },
    expectedCounts: { total: 1 },
    pagination: { hasNext: false, range: "1-1 of 1" },
    tables: [
      {
        sectionLabel: "Virtual cards ready to charge",
        headers: ["Guest", "Reservation", "Remaining balance"],
        rows: []
      },
      {
        sectionLabel: "Virtual cards to refund",
        headers: ["Guest", "Reservation", "Amount authorized"],
        rows: [{ cells: ["Example Guest", "R103", "USD 50.00"], detailRows: [] }]
      }
    ]
  });
  assert.equal(authorized.status, "complete");
  assert.equal(authorized.records[0].amount, "USD 50.00");

  const cardOnly = extractSnapshot({
    property: { id: "TEST-100", name: "Example Hotel" },
    expectedCounts: { total: 0 },
    pagination: { hasNext: false, range: "1-1 of 1" },
    tables: [
      {
        sectionLabel: "Virtual cards ready to charge",
        headers: ["Guest", "Reservation", "Card details"],
        rows: []
      }
    ]
  });
  assert.equal(cardOnly.status, "incomplete");
  assert.match(cardOnly.warnings.join("\n"), /missing required headers: remainingBalance/);
});
