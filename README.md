# Expedia Virtual Card Reconciliation — Kolo Skill

A read-only Kolo/OpenClaw skill that reconciles Expedia Partner Central virtual-card obligations into ready-to-charge and refund queues and produces a PDF report.

## Version 0.2.6: local credentials only

This version uses a one-use, loopback webform as its only Expedia credential setup path. It does not use Kolo's credential vault. Each installer enters their own credentials in the visible shared browser. They are stored outside the repository in a workspace-local file with owner-only POSIX permissions. **The file is not encrypted at rest.**

`npm run login:local` reads those credentials in a local Node.js process and fills the Expedia login form through the loopback Chrome DevTools connection. The command never accepts or prints credentials. MFA remains user-entered directly on Expedia. The skill verifies the authenticated session and selected property before extraction. The login helper fails closed if Expedia changes the login form or redirects to an unrecognized origin; live Expedia compatibility still needs to be checked in the target Kolo workspace.

Browser extraction is isolated in `scripts/browser_extract_evc.js`. PDF generation is isolated in `scripts/build_report.js`. The workflow never charges or refunds a card and never extracts card numbers, CVVs, or expiration dates.

## Install and test

Runtime requires Node.js 18 or newer, pnpm, and a visible shared browser with a loopback CDP endpoint (default `http://127.0.0.1:9222`; override with `KOLO_BROWSER_CDP_URL`). The development test dependency `linkedom` requires Node.js 20.19 or newer.

```bash
pnpm install --prod --frozen-lockfile
```

For development tests on Node.js 20.19 or newer:

```bash
pnpm install --frozen-lockfile
npm test
```

Then run `npm run credentials:check` to inspect setup status.

Ajv is a runtime dependency of the generated validators, and `ws` is a runtime dependency of the local login helper. `ajv-formats` and `linkedom` are development dependencies for schema compilation and browser-adapter tests.

For first-run setup, run `npm run credentials:setup`, then create a sanitized `setup-state.json` with your Expedia property ID, exact property name, and IANA timezone. Use `tests/fixtures/setup-ready.json` as a **synthetic shape example only**. Run `node scripts/check_setup.js setup-state.json`; it checks the real local credential file and its permissions before returning `ready`. Existing v0.2.5 local setup state can be migrated by removing `vaultAvailability` and setting `skillVersion` to `0.2.6`.

The credential store defaults to `~/.openclaw/workspace-main/expedia-vc/.credentials.json`; `EXPEDIA_EVC_CONFIG_DIR` selects another private directory. To rotate, run `node scripts/credential_webform.js capture --replace`. To remove, run `node scripts/credential_webform.js remove --confirm` after the user requests removal.

The reconciliation command emits normalized JSON with integer-cent amounts, currency-separated totals, counts, warnings, and complete/incomplete status. Conflicting reservations are excluded from totals. Reports are provisional when extraction is incomplete.

## Security

- Never enter credentials in chat, command arguments, setup state, fixtures, reports, or logs.
- The local form accepts username and password only, with password confirmation. It does not accept MFA, recovery codes, cookies, or session tokens.
- The login helper sends credentials only to an Expedia-owned login origin through the local browser connection. An unexpected origin or ambiguous form stops login.
- Credential files are outside the Skill package and must not be copied with it.
- The skill is read-only and does not charge or refund cards.

## License

MIT
