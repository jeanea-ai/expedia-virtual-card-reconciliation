"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessSetup } = require("../scripts/check_setup");
const { writeCredentials } = require("../scripts/credential_webform");

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "setup-ready.json"), "utf8"));
}

test("accepts local credential references and property configuration", () => {
  const result = assessSetup(fixture());
  assert.equal(result.status, "ready");
  assert.equal(result.credentialScope, "workspace_local");
  assert.equal(result.authenticationMode, "local_webform");
  assert.deepEqual(result.credentialRefs, ["expedia.username", "expedia.password"]);
  assert.equal(result.propertyCount, 1);
});

test("requires the local credential file to contain both fields", () => {
  const result = assessSetup(fixture(), { localCredentials: {
    usernameConfigured: false, passwordConfigured: false, permissionsOk: false
  } });
  assert.equal(result.status, "setup_required");
  assert.deepEqual(result.missing, ["expedia.username", "expedia.password"]);
});

test("rejects unsafe local credential permissions", () => {
  const result = assessSetup(fixture(), { localCredentials: {
    usernameConfigured: true, passwordConfigured: true, permissionsOk: false
  } });
  assert.equal(result.status, "setup_required");
  assert.deepEqual(result.missing, ["private local credential permissions"]);
});

test("readiness command checks the actual local credential store", (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "expedia-readiness-test-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const script = path.join(__dirname, "..", "scripts", "check_setup.js");
  const statePath = path.join(__dirname, "fixtures", "setup-ready.json");
  const env = { ...process.env, EXPEDIA_EVC_CONFIG_DIR: storeDir };
  const before = spawnSync(process.execPath, [script, statePath], { env, encoding: "utf8" });
  assert.equal(before.status, 3);
  assert.equal(JSON.parse(before.stdout).status, "setup_required");

  writeCredentials({ username: "synthetic-user@example.invalid", password: "synthetic-password", storeDir });
  const after = spawnSync(process.execPath, [script, statePath], { env, encoding: "utf8" });
  assert.equal(after.status, 0);
  assert.equal(JSON.parse(after.stdout).status, "ready");
});

test("requires at least one property configuration", () => {
  const state = fixture();
  state.properties = [];
  const result = assessSetup(state);
  assert.equal(result.status, "setup_required");
  assert.deepEqual(result.missing, ["property configuration"]);
});

test("rejects other authentication modes, shared scope, and legacy vault fields", () => {
  for (const mode of ["vault", "interactive_session"]) {
    const state = fixture();
    state.authenticationMode = mode;
    assert.throws(() => assessSetup(state), /schema validation.*authenticationMode/i);
  }
  const shared = fixture();
  shared.credentialScope = "user";
  assert.throws(() => assessSetup(shared), /schema validation.*credentialScope/i);

  const legacy = fixture();
  legacy.vaultAvailability = "feature_disabled";
  assert.throws(() => assessSetup(legacy), /schema validation.*additional properties/i);
});

test("rejects duplicate properties and invalid timezones", () => {
  const duplicate = fixture();
  duplicate.properties.push({ ...duplicate.properties[0] });
  assert.throws(() => assessSetup(duplicate), /Duplicate property ID/);

  const invalidTimezone = fixture();
  invalidTimezone.properties[0].timezone = "America/Not_A_Zone";
  assert.throws(() => assessSetup(invalidTimezone), /valid IANA timezone/);
});

test("rejects setup state carrying secret-shaped keys", () => {
  const secretKeys = ["password", "mfaCode", "sessionToken", "cookie"];
  for (const key of secretKeys) {
    const topLevel = fixture();
    topLevel[key] = "must-not-be-accepted";
    assert.throws(() => assessSetup(topLevel), /schema validation/i);

    const inCredentials = fixture();
    inCredentials.credentials[key] = "must-not-be-accepted";
    assert.throws(() => assessSetup(inCredentials), /schema validation/i);
  }
});
