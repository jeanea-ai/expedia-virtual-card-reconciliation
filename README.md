# Expedia Virtual Card Reconciliation — Kolo Skill

A read-only Kolo/OpenClaw skill that reconciles Expedia Partner Central virtual-card obligations into validated ready-to-charge and refund queues and produces a PDF report.

## Version 0.2.0

This release moves financial normalization and pagination validation out of prompt instructions and into deterministic, zero-dependency Node.js code. It also requires Kolo's approved credential storage instead of collecting Expedia passwords in chat.

Browser extraction is isolated in `scripts/browser_extract_evc.js`. It runs directly in the Expedia page without Node.js dependencies and extracts both ready-to-charge and refund queues by validated column names.

PDF generation is isolated in `scripts/build_report.js`. It independently verifies counts and totals, rejects sensitive fields, escapes all untrusted text, and renders through an explicitly supplied Chromium executable.

## Security

- Expedia credentials are retrieved only through Kolo's approved credential storage.
- Passwords and MFA codes are never stored in chat, reports, or logs.
- Full card number, CVV, and expiration are never extracted or reported.
- The workflow is read-only and does not charge or refund cards.

## Test

Requires Node.js 18 or newer:

```bash
pnpm install --frozen-lockfile
npm test
node scripts/extract_evc.js tests/fixtures/two-pages.json
```

`linkedom` is a development-only dependency used to exercise the browser DOM adapter against sanitized HTML. The runtime skill remains dependency-free.

The command emits normalized JSON with integer-cent amounts, currency-separated totals, record counts, warnings, conflicting-record details, and a complete/incomplete status. Missing or changing displayed counts and conflicting duplicates fail closed.

## Install

```bash
git clone https://github.com/jeanea-ai/expedia-virtual-card-reconciliation.git ~/.openclaw/workspace-main/skills/expedia-virtual-card-reconciliation
```

Ask the agent to “check Expedia virtual cards,” run “VC reconciliation,” list “cards ready to charge,” or create a “virtual card refund report.”

## License

MIT
