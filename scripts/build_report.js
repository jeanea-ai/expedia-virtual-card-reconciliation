#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const FORBIDDEN_KEY = /^(?:cardnumber|fullcardnumber|cvv|cvc|expiration|expiry|password|mfacode|verificationcode)$/i;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function findForbiddenKeys(value, prefix = "") {
  const found = [];
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const location = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEY.test(key.replaceAll(/[^a-z]/gi, ""))) found.push(location);
    found.push(...findForbiddenKeys(child, location));
  }
  return found;
}

function verifyReconciliation(data) {
  if (!data || typeof data !== "object") throw new Error("Reconciliation input must be an object");
  if (!["complete", "incomplete"].includes(data.status)) throw new Error("Invalid reconciliation status");
  if (!Array.isArray(data.records)) throw new Error("Reconciliation records must be an array");
  if (!data.property?.id || !data.property?.name) throw new Error("Verified property identity is required");
  if (!data.generatedAt || !data.timezone || !data.runId) throw new Error("generatedAt, timezone, and runId are required");
  const forbidden = findForbiddenKeys(data);
  if (forbidden.length) throw new Error(`Sensitive fields are forbidden: ${forbidden.join(", ")}`);
  if (data.extractedCount !== data.records.length) throw new Error("Extracted count does not match record count");
  if (data.status === "complete" && data.expectedCount !== data.records.length) {
    throw new Error("Complete report count does not match Expedia's displayed count");
  }

  const computed = {};
  for (const record of data.records) {
    if (!["ready_to_charge", "refund_due"].includes(record.queue)) throw new Error(`Unknown queue: ${record.queue}`);
    if (!record.reservationId || !record.guest) throw new Error("Record is missing guest or reservation ID");
    if (!/^[A-Z]{3}$/.test(record.currency || "")) throw new Error("Record has an invalid currency");
    if (!Number.isSafeInteger(record.amountCents) || record.amountCents < 0) throw new Error("Record has an invalid amountCents");
    computed[record.currency] ||= { readyToChargeCents: 0, refundDueCents: 0 };
    const field = record.queue === "ready_to_charge" ? "readyToChargeCents" : "refundDueCents";
    computed[record.currency][field] += record.amountCents;
    if (!Number.isSafeInteger(computed[record.currency][field])) throw new Error("Currency total exceeds safe integer range");
  }
  if (JSON.stringify(computed) !== JSON.stringify(data.totals || {})) throw new Error("Reported totals do not match record amounts");
  return computed;
}

function formatMoney(cents, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function recordRows(records) {
  if (!records.length) return '<tr><td colspan="6" class="empty">No records in this queue</td></tr>';
  return records.map((record) => `<tr>
    <td>${escapeHtml(record.guest)}</td>
    <td>${escapeHtml(record.reservationId)}</td>
    <td>${escapeHtml(record.checkIn || "-")}</td>
    <td>${escapeHtml(record.status || "-")}</td>
    <td>${escapeHtml(record.currency)}</td>
    <td class="amount">${escapeHtml(formatMoney(record.amountCents, record.currency))}</td>
  </tr>`).join("\n");
}

function totalsRows(totals, field) {
  const entries = Object.entries(totals);
  if (!entries.length) return '<tr><td>No currency totals</td><td class="amount">-</td></tr>';
  return entries.map(([currency, values]) => `<tr><td>${escapeHtml(currency)}</td><td class="amount">${escapeHtml(formatMoney(values[field], currency))}</td></tr>`).join("\n");
}

function listItems(values, emptyText) {
  if (!values?.length) return `<li class="muted">${escapeHtml(emptyText)}</li>`;
  return values.map((value) => `<li>${escapeHtml(value)}</li>`).join("\n");
}

function buildReportHtml(data) {
  verifyReconciliation(data);
  const charge = data.records.filter((record) => record.queue === "ready_to_charge");
  const refunds = data.records.filter((record) => record.queue === "refund_due");
  const conflicts = (data.conflicts || []).map((conflict) => `${conflict.queue}/${conflict.reservationId}: ${conflict.fields.join(", ")}`);
  const statusLabel = data.status === "complete" ? "COMPLETE" : "INCOMPLETE - REVIEW REQUIRED";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Expedia Virtual Card Reconciliation</title><style>
@page { size: Letter; margin: 0.55in; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; color: #172033; font-size: 10px; margin: 0; }
.header { border-bottom: 3px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px; }
h1 { margin: 0 0 4px; font-size: 21px; color: #10204a; }
h2 { margin: 22px 0 7px; font-size: 14px; color: #1d4ed8; break-after: avoid; }
.meta { color: #526176; line-height: 1.5; }
.status { display: inline-block; margin-top: 8px; padding: 5px 9px; border-radius: 12px; font-weight: bold; color: white; background: ${data.status === "complete" ? "#15803d" : "#b91c1c"}; }
.warning { margin: 12px 0; padding: 10px; border-left: 4px solid #b91c1c; background: #fef2f2; color: #7f1d1d; }
.summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0; }
.card { padding: 10px; background: #f1f5f9; border-radius: 6px; }
.card strong { display: block; font-size: 17px; color: #10204a; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #dbeafe; color: #1e3a8a; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
th, td { padding: 6px 7px; border-bottom: 1px solid #dbe3ee; vertical-align: top; }
.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.totals { width: 45%; margin-left: auto; }
.totals td { font-weight: bold; }
.empty, .muted { color: #64748b; font-style: italic; }
ul { margin: 5px 0 0; padding-left: 18px; }
.footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 8px; }
</style></head><body>
<div class="header"><h1>Expedia Virtual Card Reconciliation</h1>
<div class="meta"><strong>${escapeHtml(data.property.name)}</strong> (Expedia property ${escapeHtml(data.property.id)})<br>
Generated ${escapeHtml(data.generatedAt)} (${escapeHtml(data.timezone)}) | Run ${escapeHtml(data.runId)} | Skill v${escapeHtml(data.skillVersion || "0.2.0")}</div>
<span class="status">${escapeHtml(statusLabel)}</span></div>
${data.status === "incomplete" ? '<div class="warning"><strong>This report is incomplete.</strong> Totals are provisional and require human review.</div>' : ""}
<div class="summary"><div class="card"><strong>${charge.length}</strong>Ready to charge</div><div class="card"><strong>${refunds.length}</strong>Refund due</div><div class="card"><strong>${data.extractedCount}</strong>Validated records</div></div>
<h2>Ready to Charge</h2><table><thead><tr><th>Guest</th><th>Reservation</th><th>Check-in</th><th>Status</th><th>Currency</th><th class="amount">Amount</th></tr></thead><tbody>${recordRows(charge)}</tbody></table>
<table class="totals"><tbody>${totalsRows(data.totals, "readyToChargeCents")}</tbody></table>
<h2>Refund Due</h2><table><thead><tr><th>Guest</th><th>Reservation</th><th>Check-in</th><th>Status</th><th>Currency</th><th class="amount">Amount</th></tr></thead><tbody>${recordRows(refunds)}</tbody></table>
<table class="totals"><tbody>${totalsRows(data.totals, "refundDueCents")}</tbody></table>
<h2>Validation Notes</h2><ul>${listItems(data.warnings, "No validation warnings")}</ul>
<h2>Conflicts</h2><ul>${listItems(conflicts, "No conflicting records")}</ul>
<div class="footer">Read-only report. It identifies Expedia virtual-card obligations and does not confirm that any charge or refund was processed. No card number, CVV, expiration, password, or MFA value is included.</div>
</body></html>`;
}

function renderPdf(data, outputPath, chromiumPath) {
  const html = buildReportHtml(data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "expedia-vc-report-"));
  const htmlPath = path.join(tempDir, "report.html");
  fs.writeFileSync(htmlPath, html, { encoding: "utf8", mode: 0o600 });
  try {
    const result = spawnSync(chromiumPath, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions",
      "--no-pdf-header-footer", `--print-to-pdf=${path.resolve(outputPath)}`, pathToFileURL(htmlPath).href
    ], { encoding: "utf8", timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Chromium PDF rendering failed: ${result.stderr || result.stdout}`);
    const size = fs.statSync(outputPath).size;
    if (size < 1000) throw new Error(`Rendered PDF is unexpectedly small (${size} bytes)`);
    return { outputPath, size };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { buildReportHtml, escapeHtml, findForbiddenKeys, renderPdf, verifyReconciliation };

if (require.main === module) {
  const [inputPath, outputPath, chromiumPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || !chromiumPath) {
    process.stderr.write("Usage: node scripts/build_report.js <reconciliation.json> <output.pdf> <chromium-path>\n");
    process.exit(2);
  }
  try {
    const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const result = renderPdf(data, outputPath, chromiumPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Report generation failed: ${error.message}\n`);
    process.exit(1);
  }
}
