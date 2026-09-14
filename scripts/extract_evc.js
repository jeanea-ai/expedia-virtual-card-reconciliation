#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const QUEUES = new Set(["ready_to_charge", "refund_due"]);
const MONEY_RE = /^\s*(?:([A-Z]{3})\s*)?\$?\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\.([0-9]{2})\s*(?:([A-Z]{3}))?\s*$/;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseMoney(value, defaultCurrency = "USD") {
  const text = clean(value);
  const match = MONEY_RE.exec(text);
  if (!match) throw new Error(`Invalid money value: ${JSON.stringify(text)}`);
  const currency = (match[1] || match[4] || defaultCurrency).toUpperCase();
  if (match[1] && match[4] && match[1] !== match[4]) {
    throw new Error(`Conflicting currencies: ${match[1]} and ${match[4]}`);
  }
  const dollars = Number(match[2].replaceAll(",", ""));
  return { currency, amountCents: dollars * 100 + Number(match[3]) };
}

function normalizeRecord(raw, sourcePage) {
  const queue = clean(raw.queue);
  if (!QUEUES.has(queue)) throw new Error(`Unknown queue: ${JSON.stringify(queue)}`);
  const guest = clean(raw.guest);
  const reservationId = clean(raw.reservationId || raw.reservation);
  if (!guest || !reservationId) throw new Error("Record is missing guest or reservation ID");
  const money = parseMoney(raw.amount || raw.remainingBalance, raw.currency || "USD");
  let originalPayoutCents = null;
  if (clean(raw.originalPayout)) {
    const original = parseMoney(raw.originalPayout, money.currency);
    if (original.currency !== money.currency) throw new Error("Record contains mixed currencies");
    originalPayoutCents = original.amountCents;
  }
  return {
    queue,
    guest,
    reservationId,
    checkIn: clean(raw.checkIn) || null,
    status: clean(raw.status) || null,
    currency: money.currency,
    amountCents: money.amountCents,
    originalPayoutCents,
    sourcePage
  };
}

function recordKey(record) {
  return [record.queue, record.reservationId, record.currency, record.amountCents].join("|");
}

function reconcilePages(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("At least one page is required");
  const maxPages = options.maxPages || 100;
  if (pages.length > maxPages) throw new Error(`Page limit exceeded (${maxPages})`);

  const records = [];
  const seenRecords = new Set();
  const seenSignatures = new Set();
  const warnings = [];
  let expectedCount = null;

  pages.forEach((page, index) => {
    const pageNumber = Number(page.pageNumber || index + 1);
    if (pageNumber !== index + 1) throw new Error(`Unexpected page order at page ${index + 1}`);
    if (!Array.isArray(page.records)) throw new Error(`Page ${pageNumber} has no records array`);
    const signature = page.records.map((r) => `${clean(r.queue)}:${clean(r.reservationId || r.reservation)}`).join("|");
    if (seenSignatures.has(signature) && signature) throw new Error(`Repeated pagination result at page ${pageNumber}`);
    seenSignatures.add(signature);

    if (Number.isInteger(page.expectedCount)) {
      if (expectedCount !== null && expectedCount !== page.expectedCount) warnings.push("Displayed result count changed during pagination");
      expectedCount = page.expectedCount;
    }

    for (const raw of page.records) {
      const record = normalizeRecord(raw, pageNumber);
      const key = recordKey(record);
      if (seenRecords.has(key)) {
        warnings.push(`Duplicate skipped: ${record.queue}/${record.reservationId}`);
        continue;
      }
      seenRecords.add(key);
      records.push(record);
    }
  });

  const currencies = [...new Set(records.map((r) => r.currency))];
  const totals = {};
  for (const record of records) {
    totals[record.currency] ||= { readyToChargeCents: 0, refundDueCents: 0 };
    const field = record.queue === "ready_to_charge" ? "readyToChargeCents" : "refundDueCents";
    totals[record.currency][field] += record.amountCents;
  }
  const complete = expectedCount === null || expectedCount === records.length;
  if (!complete) warnings.push(`Expected ${expectedCount} records but extracted ${records.length}`);

  return {
    schemaVersion: "1.0.0",
    status: complete ? "complete" : "incomplete",
    pageCount: pages.length,
    expectedCount,
    extractedCount: records.length,
    currencies,
    totals,
    warnings,
    records
  };
}

function extractPage(document, pageNumber = 1) {
  const canonical = (value) => clean(value).toLowerCase();
  const tables = [...document.querySelectorAll("table")];
  const records = [];
  for (const table of tables) {
    const headers = [...(table.rows[0]?.cells || [])].map((cell) => canonical(cell.textContent));
    const remainingIndex = headers.findIndex((h) => h.includes("remaining balance"));
    const guestIndex = headers.findIndex((h) => h.includes("guest"));
    const reservationIndex = headers.findIndex((h) => h.includes("reservation"));
    if (remainingIndex < 0 || guestIndex < 0 || reservationIndex < 0) continue;
    const checkInIndex = headers.findIndex((h) => h.includes("check-in") || h.includes("check in"));
    const statusIndex = headers.findIndex((h) => h === "status" || h.includes("card status"));
    for (const row of [...table.rows].slice(1)) {
      if (row.querySelector("table")) continue;
      const cells = [...row.cells];
      if (cells.length <= Math.max(remainingIndex, guestIndex, reservationIndex)) continue;
      records.push({
        queue: "ready_to_charge",
        guest: clean(cells[guestIndex]?.textContent),
        reservationId: clean(cells[reservationIndex]?.textContent),
        checkIn: checkInIndex >= 0 ? clean(cells[checkInIndex]?.textContent) : "",
        status: statusIndex >= 0 ? clean(cells[statusIndex]?.textContent) : "",
        amount: clean(cells[remainingIndex]?.textContent)
      });
    }
  }
  const countMatch = clean(document.body?.textContent).match(/(?:of|total)\s+([0-9,]+)\s+(?:results?|records?)/i);
  return { pageNumber, expectedCount: countMatch ? Number(countMatch[1].replaceAll(",", "")) : null, records };
}

module.exports = { clean, extractPage, normalizeRecord, parseMoney, reconcilePages };

if (require.main === module) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("Usage: node scripts/extract_evc.js <pages.json>\n");
    process.exit(2);
  }
  try {
    const pages = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    process.stdout.write(`${JSON.stringify(reconcilePages(pages), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Extraction validation failed: ${error.message}\n`);
    process.exit(1);
  }
}
