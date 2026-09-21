"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessSetup } = require("../scripts/check_setup");

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "setup-ready.json"), "utf8"));
}

test("accepts per-user credential references and property configuration", () => {
  const result = assessSetup(fixture());
  assert.equal(result.status, "ready");
  assert.equal(result.credentialScope, "user");
  assert.deepEqual(result.credentialRefs, ["expedia.username", "expedia.password"]);
  assert.equal(result.propertyCount, 1);
});

test("requires first-run setup when the current user has no credentials", () => {
  const state = fixture();
  state.credentials.usernameConfigured = false;
  state.credentials.passwordConfigured = false;
  const result = assessSetup(state);
  assert.equal(result.status, "setup_required");
  assert.deepEqual(result.missing, ["expedia.username", "expedia.password"]);
});

test("requires at least one property configuration", () => {
  const state = fixture();
  state.properties = [];
  const result = assessSetup(state);
  assert.equal(result.status, "setup_required");
  assert.deepEqual(result.missing, ["property configuration"]);
});

test("rejects credential values and workspace-wide credential scope", () => {
  const withPassword = fixture();
  withPassword.credentials.password = "must-not-be-accepted";
  assert.throws(() => assessSetup(withPassword), /schema validation.*additional properties/i);

  const shared = fixture();
  shared.credentialScope = "workspace";
  assert.throws(() => assessSetup(shared), /credentialScope.*constant/i);
});

test("rejects duplicate properties and invalid timezones", () => {
  const duplicate = fixture();
  duplicate.properties.push({ ...duplicate.properties[0] });
  assert.throws(() => assessSetup(duplicate), /Duplicate property ID/);

  const invalidTimezone = fixture();
  invalidTimezone.properties[0].timezone = "America/Not_A_Zone";
  assert.throws(() => assessSetup(invalidTimezone), /valid IANA timezone/);
});
