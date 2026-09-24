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

test("vault mode is preferred and ready when the vault is available", () => {
  const result = assessSetup(fixture());
  assert.equal(result.status, "ready");
  assert.equal(result.authenticationMode, "vault");
  assert.equal(result.vaultAvailability, "available");
});

test("vault mode with a feature_disabled vault reports interactive setup as available", () => {
  const state = fixture();
  state.vaultAvailability = "feature_disabled";
  const result = assessSetup(state);
  assert.equal(result.status, "setup_required");
  assert.ok(result.missing.includes("vault credential storage (feature_disabled; interactive setup available)"));
});

test("interactive mode is ready with a verified session, one property, and no vault credentials", () => {
  const state = fixture();
  state.authenticationMode = "interactive_session";
  state.vaultAvailability = "feature_disabled";
  state.credentials.usernameConfigured = false;
  state.credentials.passwordConfigured = false;
  state.interactiveSessionVerified = true;
  const result = assessSetup(state);
  assert.equal(result.status, "ready");
  assert.equal(result.authenticationMode, "interactive_session");
  assert.deepEqual(result.missing, []);
});

test("interactive mode is rejected when the vault is available (pairing violation)", () => {
  const state = fixture();
  state.authenticationMode = "interactive_session";
  state.vaultAvailability = "available";
  state.interactiveSessionVerified = true;
  assert.throws(() => assessSetup(state), /interactive_session setup is only supported as a fallback for vault feature_disabled/);

  const unknown = fixture();
  unknown.authenticationMode = "interactive_session";
  unknown.vaultAvailability = "unknown";
  unknown.interactiveSessionVerified = true;
  assert.throws(() => assessSetup(unknown), /interactive_session setup is only supported as a fallback for vault feature_disabled/);
});

test("interactive mode requires interactive session verification", () => {
  const state = fixture();
  state.authenticationMode = "interactive_session";
  state.vaultAvailability = "feature_disabled";
  state.interactiveSessionVerified = false;
  const result = assessSetup(state);
  assert.equal(result.status, "setup_required");
  assert.ok(result.missing.includes("interactive session verification"));
});

test("rejects setup state carrying secret-shaped keys at the top level or inside credentials", () => {
  const secretKeys = ["password", "mfaCode", "sessionToken", "cookie"];
  for (const key of secretKeys) {
    const topLevel = fixture();
    topLevel[key] = "must-not-be-accepted";
    assert.throws(() => assessSetup(topLevel), /schema validation/i, `top-level ${key} must be rejected`);

    const inCredentials = fixture();
    inCredentials.credentials[key] = "must-not-be-accepted";
    assert.throws(() => assessSetup(inCredentials), /schema validation/i, `credentials.${key} must be rejected`);
  }
});
