# Expedia Virtual Card Reconciliation — Kolo Skill

An [OpenClaw](https://github.com/openclaw/openclaw) / Kolo skill that pulls virtual-card (EVC) data from Expedia Partner Central and produces a styled PDF report: which cards are ready to charge, which need refunds, and for what amounts.

## What it does

1. **Logs in** to Expedia Partner Central via browser automation (2-step login flow, with MFA/SMS support)
2. **Extracts** virtual-card data from the EVC Manage page — "ready to charge" and "to refund" tables, including pagination handling
3. **Generates** a styled PDF report (guest, reservation, check-in, status, amounts, totals)
4. **Delivers** the report to the user in chat

## Prerequisites

- Expedia Partner Central credentials (username + password); the property may have MFA/2FA enabled
- The hotel's Expedia property ID (`htid`)
- A Chromium-based browser (headless mode used for PDF rendering)

## Install

Copy or clone this repo into your OpenClaw skills directory:

```bash
git clone https://github.com/jeanea-ai/expedia-virtual-card-reconciliation.git ~/.openclaw/workspace-main/skills/expedia-virtual-card-reconciliation
```

Or with GitHub CLI:

```bash
gh repo clone jeanea-ai/expedia-virtual-card-reconciliation ~/.openclaw/workspace-main/skills/expedia-virtual-card-reconciliation
```

## Usage

Ask your agent: *"check Expedia virtual cards"*, *"VC reconciliation"*, *"which cards are ready to charge"*, or *"virtual card refund report"*.

## Security notes

- The report intentionally surfaces **amounts only** — full card numbers, CVV, and expiration are never included in the output.
- This skill drives the logged-in browser session; it does not store credentials itself.
- The default property ID has been genericized — configure your own `htid` per hotel.

## License

MIT
