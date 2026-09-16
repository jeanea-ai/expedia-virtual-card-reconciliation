#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { validateRunContext, validateExtractedPage, validateReconciliationResult } = require("./generated/validators");

const QUEUES = new Set(["ready_to_charge", "refund_due"]);
const MONEY_RE = /^\s*(?:([A-Z]{3})\s*)?\$?\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\.([0-9]{2})\s*(?:([A-Z]{3}))?\s*$/;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function schemaError(label, validator) {
  const details = (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  return new Error(`${label} failed schema validation: ${details}`);
}

function validateContext(context) {
  if (!validateRunContext(context)) throw schemaError("Run context", validateRunContext);
  if (Number.isNaN(Date.parse(context.generatedAt))) throw new Error("Run context generatedAt is not a valid timestamp");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: context.timezone }).format(new Date(context.generatedAt));
  } catch {
    throw new Error(`Run context timezone is not a valid IANA timezone: ${context.timezone}`);
  }
}

function normalizedName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function identityKey(record) {
  return [record.queue, record.reservationId].join("|");
}

function conflictingFields(first, next) {
  return ["guest", "checkIn", "status", "currency", "amountCents", "originalPayoutCents"]
    .filter((field) => first[field] !== next[field]);
}

function reconcilePages(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("At least one page is required");
  const context = options.context;
  validateContext(context);
  const maxPages = options.maxPages || 100;
  if (pages.length > maxPages) throw new Error(`Page limit exceeded (${maxPages})`);

  const records = [];
  const recordsByIdentity = new Map();
  const seenSignatures = new Set();
  const warnings = [];
  const conflicts = [];
  const integrityFailures = [];
  let expectedCount = null;

  pages.forEach((page, index) => {
    if (!validateExtractedPage(page)) throw schemaError(`Extracted page ${index + 1}`, validateExtractedPage);
    const pageNumber = Number(page.pageNumber || index + 1);
    if (pageNumber !== index + 1) throw new Error(`Unexpected page order at page ${index + 1}`);
    if (!Array.isArray(page.records)) throw new Error(`Page ${pageNumber} has no records array`);
    const signature = page.records.map((r) => `${clean(r.queue)}:${clean(r.reservationId || r.reservation)}`).join("|");
    if (seenSignatures.has(signature)) throw new Error(`Repeated pagination result at page ${pageNumber}`);
    seenSignatures.add(signature);

    if (page.status === "incomplete") {
      const message = `Extracted page ${pageNumber} was incomplete`;
      warnings.push(message, ...page.warnings.map((warning) => `Page ${pageNumber}: ${warning}`));
      integrityFailures.push(message);
    }
    if (!clean(page.property.id) || page.property.id !== context.expectedProperty.id) {
      const message = `Property ID mismatch on page ${pageNumber}`;
      warnings.push(message);
      integrityFailures.push(message);
    } else if (normalizedName(page.property.name) !== normalizedName(context.expectedProperty.name)) {
      warnings.push(`Property name differs on page ${pageNumber}; property ID matched`);
    }

    if (Number.isInteger(page.expectedCount)) {
      if (expectedCount === null) {
        expectedCount = page.expectedCount;
      } else if (expectedCount !== page.expectedCount) {
        const message = `Displayed result count changed during pagination: ${expectedCount} to ${page.expectedCount}`;
        warnings.push(message);
        integrityFailures.push(message);
      }
    }

    for (const raw of page.records) {
      const record = normalizeRecord(raw, pageNumber);
      const identity = identityKey(record);
      const existing = recordsByIdentity.get(identity);
      if (existing) {
        const fields = conflictingFields(existing, record);
        if (fields.length === 0) {
          warnings.push(`Duplicate skipped: ${record.queue}/${record.reservationId}`);
          continue;
        }
        const conflict = {
          queue: record.queue,
          reservationId: record.reservationId,
          firstPage: existing.sourcePage,
          conflictingPage: record.sourcePage,
          fields
        };
        conflicts.push(conflict);
        const message = `Conflicting duplicate excluded: ${record.queue}/${record.reservationId} (${fields.join(", ")})`;
        warnings.push(message);
        integrityFailures.push(message);
        continue;
      }
      recordsByIdentity.set(identity, record);
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
  if (expectedCount === null) {
    const message = "Displayed result count is required but was not captured";
    warnings.push(message);
    integrityFailures.push(message);
  } else if (expectedCount !== records.length) {
    const message = `Expected ${expectedCount} records but retained ${records.length} validated records`;
    warnings.push(message);
    integrityFailures.push(message);
  }
  const complete = integrityFailures.length === 0;

  const result = {
    schemaVersion: "1.0.0",
    runId: context.runId,
    generatedAt: context.generatedAt,
    timezone: context.timezone,
    skillVersion: context.skillVersion,
    property: { id: context.expectedProperty.id, name: context.expectedProperty.name },
    status: complete ? "complete" : "incomplete",
    pageCount: pages.length,
    expectedCount,
    extractedCount: records.length,
    currencies,
    totals,
    warnings,
    conflicts,
    records
  };
  if (!validateReconciliationResult(result)) throw schemaError("Reconciliation result", validateReconciliationResult);
  return result;
}

module.exports = { clean, normalizeRecord, parseMoney, reconcilePages };

if (require.main === module) {
  const [inputPath, contextPath] = process.argv.slice(2);
  if (!inputPath || !contextPath) {
    process.stderr.write("Usage: node scripts/extract_evc.js <pages.json> <run-context.json>\n");
    process.exit(2);
  }
  try {
    const pages = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    process.stdout.write(`${JSON.stringify(reconcilePages(pages, { context }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Extraction validation failed: ${error.message}\n`);
    process.exit(1);
  }
}
