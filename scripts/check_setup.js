#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { validateSetupState } = require("./generated/validators");

function schemaError(validator) {
  const details = (validator.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  return new Error(`Setup state failed schema validation: ${details}`);
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function assessSetup(state) {
  if (!validateSetupState(state)) throw schemaError(validateSetupState);

  const { authenticationMode, vaultAvailability } = state;
  if (authenticationMode === "interactive_session" && vaultAvailability !== "feature_disabled") {
    throw new Error(
      `interactive_session setup is only supported as a fallback for vault feature_disabled (got vaultAvailability: ${vaultAvailability}); the vault remains preferred whenever it is available`
    );
  }

  const missing = [];
  if (authenticationMode === "vault") {
    if (vaultAvailability === "feature_disabled") {
      missing.push("vault credential storage (feature_disabled; interactive setup available)");
    } else {
      if (!state.credentials.usernameConfigured) missing.push("expedia.username");
      if (!state.credentials.passwordConfigured) missing.push("expedia.password");
      if (vaultAvailability === "unknown") missing.push("vault availability unknown");
    }
  } else if (state.interactiveSessionVerified !== true) {
    missing.push("interactive session verification");
  }
  if (state.properties.length === 0) missing.push("property configuration");

  const seenPropertyIds = new Set();
  for (const property of state.properties) {
    if (!validTimezone(property.timezone)) {
      throw new Error(`Property ${property.id} does not have a valid IANA timezone`);
    }
    if (seenPropertyIds.has(property.id)) throw new Error(`Duplicate property ID: ${property.id}`);
    seenPropertyIds.add(property.id);
  }

  return {
    schemaVersion: "1.0.0",
    skillVersion: state.skillVersion,
    status: missing.length ? "setup_required" : "ready",
    credentialScope: state.credentialScope,
    credentialRefs: [state.credentials.usernameRef, state.credentials.passwordRef],
    missing,
    propertyCount: state.properties.length,
    properties: state.properties,
    authenticationMode: state.authenticationMode,
    vaultAvailability: state.vaultAvailability
  };
}

module.exports = { assessSetup, validTimezone };

if (require.main === module) {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath) {
    process.stderr.write("Usage: node scripts/check_setup.js <setup-state.json>\n");
    process.exit(2);
  }
  try {
    const state = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const result = assessSetup(state);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "ready") process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`Setup validation failed: ${error.message}\n`);
    process.exit(1);
  }
}
