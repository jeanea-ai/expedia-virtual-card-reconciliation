# Expedia Virtual Card Reconciliation — Kolo Skill

A read-only Kolo/OpenClaw skill that reconciles Expedia Partner Central virtual-card obligations into validated ready-to-charge and refund queues and produces a PDF report.

## Version 0.2.0

This release moves financial normalization and pagination validation out of prompt instructions and into deterministic, zero-dependency Node.js code. It also requires Kolo's approved credential storage instead of collecting Expedia passwords in chat.

## Security

- Expedia credentials are retrieved only through Kolo's approved credential storage.
- Passwords and MFA codes are never stored in chat, reports, or logs.
- Full card number, CVV, and expiration are never extracted or reported.
- The workflow is read-only and does not charge or refund cards.

## Test

Requires Node.js 18 or newer:

```bash
npm test
node scripts/extract_evc.js tests/fixtures/two-pages.json
```

The command emits normalized JSON with integer-cent amounts, currency-separated totals, record counts, warnings, and a complete/incomplete status.

## Install

```bash
git clone https://github.com/jeanea-ai/expedia-virtual-card-reconciliation.git ~/.openclaw/workspace-main/skills/expedia-virtual-card-reconciliation
```

Ask the agent to “check Expedia virtual cards,” run “VC reconciliation,” list “cards ready to charge,” or create a “virtual card refund report.”

## License

MIT
