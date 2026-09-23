# Expedia Virtual Card Reconciliation — Kolo Skill

A read-only Kolo/OpenClaw skill that reconciles Expedia Partner Central virtual-card obligations into validated ready-to-charge and refund queues and produces a PDF report.

## Version 0.2.3

This release fixes two live-DOM regressions: explicitly empty refund queues are now recognized from the heading's bounded region without a semantic wrapper, and the displayed result range is parsed from the text adjacent to the Previous/Next pagination controls without a pagination-labeled wrapper.

Each installer stores their own Expedia username and password through Kolo's approved credential interface and configures their own Expedia properties. Credential values are never bundled with or shared through the Skill.

Browser extraction is isolated in `scripts/browser_extract_evc.js`. It runs directly in the Expedia page without Node.js dependencies and extracts both ready-to-charge and refund queues by validated column names.

PDF generation is isolated in `scripts/build_report.js`. It independently verifies the runtime schema, counts, and totals; rejects sensitive fields; escapes all untrusted text; and renders through an explicitly supplied Chromium executable.

Every run carries a separate, non-secret context containing the run ID, timestamp, timezone, skill version, and expected property identity. JSON Schemas in `schema/` are compiled into dependency-free standalone validators in `scripts/generated/validators.js`; production execution does not require Ajv.

## Security

- Expedia credentials are retrieved only through Kolo's approved credential storage.
- Credential entries are user-scoped; installing the Skill never grants access to another user's credentials.
- Passwords and MFA codes are never stored in chat, reports, or logs.
- Full card number, CVV, and expiration are never extracted or reported.
- The workflow is read-only and does not charge or refund cards.

## Test

Requires Node.js 18 or newer:

```bash
pnpm install --frozen-lockfile
npm test
node scripts/check_setup.js tests/fixtures/setup-ready.json
node scripts/extract_evc.js tests/fixtures/two-pages.json tests/fixtures/run-context.json
```

`linkedom`, `ajv`, and `ajv-formats` are development-only dependencies used to test the browser adapter and compile the runtime contracts. `npm test` regenerates the standalone validators before running the tests. The runtime skill remains dependency-free.

The setup command emits only sanitized readiness information and credential references; it never accepts credential values. The reconciliation command emits normalized JSON with integer-cent amounts, currency-separated totals, record counts, warnings, conflicting-record details, and a complete/incomplete status. Missing or changing displayed counts and conflicting duplicates fail closed.

## Install

```bash
git clone https://github.com/jeanea-ai/expedia-virtual-card-reconciliation.git ~/.openclaw/workspace-main/skills/expedia-virtual-card-reconciliation
```

Ask the agent to “check Expedia virtual cards,” run “VC reconciliation,” list “cards ready to charge,” or create a “virtual card refund report.”

## License

MIT
