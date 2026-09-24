"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const { verifyInteractiveSession } = require("../scripts/browser_extract_evc");

const EXPECTED_PROPERTY = { id: "TEST-100", name: "Example Hotel" };

function verifyFixture(name, expectedProperty = EXPECTED_PROPERTY) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "html", name), "utf8");
  const { document } = parseHTML(html);
  return verifyInteractiveSession(document, expectedProperty);
}

test("verifies an authenticated page with an exact property match", () => {
  const result = verifyFixture("interactive-authenticated.html");
  assert.equal(result.verificationVersion, "1.0.0");
  assert.equal(result.ok, true);
  assert.equal(result.reason, "");
  assert.equal(result.authenticated, true);
  assert.equal(result.propertyMatch, true);
  assert.deepEqual(result.property, { id: "TEST-100", name: "Example Hotel" });
});

test("fails closed with login_required on a sign-in page", () => {
  const result = verifyFixture("interactive-login.html");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "login_required");
  assert.equal(result.authenticated, false);
  assert.equal(result.propertyMatch, null);
  assert.equal(result.property, null);
});

test("models the pause/resume sequence: login page first, then the completed login", () => {
  const beforeLogin = verifyFixture("interactive-login.html");
  assert.equal(beforeLogin.authenticated, false);
  assert.equal(beforeLogin.ok, false);

  const afterLogin = verifyFixture("interactive-authenticated.html");
  assert.equal(afterLogin.authenticated, true);
  assert.equal(afterLogin.ok, true);
  assert.equal(afterLogin.reason, "");
  assert.equal(afterLogin.propertyMatch, true);
});

test("fails closed with property_mismatch on a different property", () => {
  const result = verifyFixture("interactive-mismatch.html");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "property_mismatch");
  assert.equal(result.authenticated, true);
  assert.equal(result.propertyMatch, false);
  assert.deepEqual(result.property, { id: "TEST-200", name: "Other Hotel" });
});

test("fails closed with property_ambiguous when identity is not determinable", () => {
  const result = verifyFixture("interactive-ambiguous.html");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "property_ambiguous");
  assert.equal(result.authenticated, true);
  assert.equal(result.property, null);
  assert.equal(result.propertyMatch, null);
});

test("leakage guard: verification results expose no secret or card-shaped values", () => {
  const results = [
    verifyFixture("interactive-authenticated.html"),
    verifyFixture("interactive-login.html"),
    { before: verifyFixture("interactive-login.html"), after: verifyFixture("interactive-authenticated.html") },
    verifyFixture("interactive-mismatch.html"),
    verifyFixture("interactive-ambiguous.html")
  ];
  const serialized = JSON.stringify(results);
  for (const forbidden of ["password", "mfa", "cookie", "token", "CVV"]) {
    assert.equal(serialized.includes(forbidden), false, `verification output exposed forbidden marker: ${forbidden}`);
  }
  assert.equal(/\d{13,16}/.test(serialized), false, "verification output exposed a card-number-shaped digit sequence");
});
