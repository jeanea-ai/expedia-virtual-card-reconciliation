"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReportHtml, verifyReconciliation } = require("../scripts/build_report");

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "report-complete.json"), "utf8"));
}

test("builds an escaped report with verified counts and totals", () => {
  const html = buildReportHtml(fixture());
  assert.match(html, /Example &amp; Harbor &lt;Hotel&gt;/);
  assert.match(html, /Alex &lt;Example&gt;/);
  assert.match(html, /Sam &amp; Example/);
  assert.match(html, /\$165\.25/);
  assert.match(html, /\$20\.00/);
  assert.doesNotMatch(html, /Example & Harbor <Hotel>/);
});

test("rejects totals that do not match the records", () => {
  const data = fixture();
  data.totals.USD.readyToChargeCents = 1;
  assert.throws(() => verifyReconciliation(data), /totals do not match/);
});

test("rejects complete reports whose displayed count does not match", () => {
  const data = fixture();
  data.expectedCount = 4;
  assert.throws(() => verifyReconciliation(data), /displayed count/);
});

test("rejects sensitive fields anywhere in the input", () => {
  const data = fixture();
  data.records[0].cvv = "999";
  assert.throws(() => verifyReconciliation(data), /Sensitive fields are forbidden/);
});

test("renders an explicit provisional warning for incomplete reports", () => {
  const data = fixture();
  data.status = "incomplete";
  data.expectedCount = 4;
  data.warnings = ["Expected 4 records but retained 3 validated records"];
  const html = buildReportHtml(data);
  assert.match(html, /INCOMPLETE - REVIEW REQUIRED/);
  assert.match(html, /Totals are provisional/);
});
