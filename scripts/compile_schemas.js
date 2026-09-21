#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020").default;
const standaloneCode = require("ajv/dist/standalone").default;

const root = path.resolve(__dirname, "..");
const schemaNames = ["reconciliation-record", "setup-state", "run-context", "extracted-page", "reconciliation-result"];
const schemas = schemaNames.map((name) => JSON.parse(fs.readFileSync(path.join(root, "schema", `${name}.schema.json`), "utf8")));
const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true } });
for (const schema of schemas) ajv.addSchema(schema);
const moduleCode = standaloneCode(ajv, {
  validateSetupState: "setup-state",
  validateRunContext: "run-context",
  validateExtractedPage: "extracted-page",
  validateReconciliationResult: "reconciliation-result"
});
const outputDir = path.join(root, "scripts", "generated");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "validators.js"), moduleCode, "utf8");
process.stdout.write("Generated standalone schema validators\n");
