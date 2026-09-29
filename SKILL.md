---
name: "expedia-virtual-card-reconciliation"
description: "Reconcile Expedia virtual-card obligations into verified ready-to-charge and refund queues with a PDF guest-and-amount report. Use for: check Expedia VCs, VC reconciliation, cards ready to charge, or virtual card refund. Read-only; never charges or refunds a card."
tags: [hotel, expedia, virtual-cards, reconciliation, browser, accounting]
version: "0.2.5"
---

# Expedia Virtual Card Reconciliation

Read Expedia Partner Central's EVC Manage page, validate every extracted record, and produce ready-to-charge and refund queues. This skill is read-only: it never reveals card credentials and never charges or refunds a card.

## Safety invariants

- Prefer Kolo's approved credential storage. When it returns `feature_disabled`, the user may explicitly choose the local one-use webform fallback. Never ask the user to paste a credential into chat or pass it on a command line.
- Never print, log, persist in reports, or return passwords, MFA codes, full card numbers, CVVs, or expiration dates.
- If Expedia requests MFA, have the user enter it directly on Expedia. Never request, read, or persist it.
- Use the authenticated session only for the property selected for this run.
- Treat an incomplete or unfamiliar page as `incomplete`; do not issue a financial total as complete.
- Do not perform charges, refunds, reservation edits, or other financial actions.

## Required configuration

Each installer completes setup separately. Credential values are never part of the Skill, its configuration files, chat history, or marketplace package.

### First-run setup

Run this setup before the first reconciliation and whenever the user asks to set up, reconnect, change, or remove their Expedia account:

1. Resolve only the configured/not-configured status of the current user's `expedia.username` and `expedia.password` entries in Kolo's approved credential storage. Never retrieve either value for setup checks.
2. If either entry is missing, launch Kolo's secure credential-entry interface for that entry. Do not ask the user to type credentials into chat, a normal form, a report, or a command.
3. Save credentials with **user scope**. Never publish them with the Skill, copy them to another installer, or silently widen their scope to the team or workspace.
4. Collect and save the non-secret property configuration: Expedia property ID (`htid`), exact property name, and IANA timezone. Support multiple properties without duplicating an ID.
5. Build a sanitized `setup-state.json` containing only credential references, configured booleans, credential scope, and property configuration. It must never contain a username, password, MFA code, browser cookie, or session token.
6. Run `node scripts/check_setup.js setup-state.json`. Continue only when it returns `status: ready`. Exit code `3` means setup is incomplete; launch or resume setup rather than attempting Expedia authentication.
7. Report only that setup is complete and the configured property names. Never echo credential values or imply that one user's credentials will be available to another installer.

If the user cancels secure credential entry, stop with `setup_required`. Replacing or removing a vault credential must use Kolo's approved credential manager and the platform's required confirmation. Replacing a local fallback credential requires the explicit rotation command; removal requires its explicit confirmation option. After a removal, mark setup incomplete immediately.

The setup contract is defined by `schema/setup-state.schema.json`. Vault and interactive modes use `credentialScope: "user"`; the local file fallback uses `credentialScope: "workspace_local"`. The only permitted secret identifiers are `expedia.username` and `expedia.password` references. Setup state also records the non-secret `authenticationMode` (`vault`, `local_webform`, or `interactive_session`) and `vaultAvailability` (`available`, `feature_disabled`, or `unknown`) so readiness can be assessed for the workspace. Resolve the selected property's ID, name, and timezone from the saved non-secret configuration. If multiple properties are configured and the request is ambiguous, ask which property to use.

### One-use credential webform fallback (vault `feature_disabled` only)

Offer this fallback only after the vault reports `feature_disabled` and the user explicitly chooses local credential storage. Explain that it is workspace-local and protected by operating-system file permissions, but is not an encrypted replacement for Kolo's vault.

1. Run `npm run credentials:setup`. This starts an expiring HTTP listener bound only to `127.0.0.1`, creates a random one-use URL, and opens it in the visible shared browser. Never print, log, copy, or return the tokenized URL after opening it.
2. The user enters the Expedia username and two matching password entries in the webform. Do not request or accept these values in chat or command arguments.
3. The form accepts only username, password, confirmation, and its one-use token. It must never accept or store MFA codes, recovery codes, cookies, or session tokens.
4. Run `npm run credentials:check`. It may report only presence and permission status, never a credential value or its length.
5. Record `authenticationMode: "local_webform"`, `vaultAvailability: "feature_disabled"`, and `credentialScope: "workspace_local"` in the sanitized setup state. Continue only when both configured booleans are true and `check_setup.js` returns `ready`.
6. To rotate credentials, run `node scripts/credential_webform.js capture --replace`; this explicit option is required. To remove them, run `node scripts/credential_webform.js remove --confirm` only after the user confirms removal.

The fallback store is outside the skill and repository at `~/.openclaw/workspace-main/expedia-vc/.credentials.json`, unless `EXPEDIA_EVC_CONFIG_DIR` selects another private directory. The directory is mode `0700` and the file is mode `0600` on POSIX. Writes are locked and atomic; symbolic links and corrupt stores are refused. Credential values may be resolved only inside a trusted local authentication process by importing `readCredentials()` from `scripts/credential_webform.js`; never serialize its return value or expose it to the model, stdout, logs, exceptions, reports, or artifacts.

### Interactive login fallback (vault `feature_disabled` only)

The vault path above stays the preferred and default setup mode. The interactive fallback applies when and only when Kolo's credential vault is unavailable with HTTP 503 `feature_disabled`.

1. The agent opens Expedia Partner Central in the shared browser and pauses.
2. The user enters their username, password, and any MFA directly on Expedia.
3. The agent never requests, types, reads, captures, copies, logs, transmits, or persists any credential, MFA code, cookie, or session token — not in chat, files, artifacts, fixtures, reports, or memory.
4. After the user says login is complete, the agent verifies only that an authenticated session exists and the active property exactly matches the saved non-secret property configuration. Fail closed on login failure, expired session, ambiguous identity, or property mismatch.
5. Setup state records `authenticationMode: "interactive_session"` with only non-secret fields (never a credential, cookie, or session-token value).
6. When the session expires, the user must log in again.

**Interactive mode supports user-initiated runs but NOT unattended or scheduled runs.**

## Deterministic workflow

### 1. Preflight

- Require Node.js 18 or newer and confirm `scripts/check_setup.js`, `scripts/browser_extract_evc.js`, and `scripts/extract_evc.js` exist.
- Require a `ready` result from `scripts/check_setup.js` for the current user before creating a run directory or opening Expedia.
- Create a unique, permission-restricted run directory; never reuse fixed report filenames.
- Write `RUN_DIR/run-context.json` with a unique run ID, ISO 8601 start time, IANA property timezone, skill version, and configured property ID and name. Do not include credentials or browser-session data. Validate it against `schema/run-context.schema.json`.

Example shape:

```json
{
  "schemaVersion": "1.0.0",
  "runId": "unique-run-id",
  "generatedAt": "2026-09-16T09:30:00-07:00",
  "timezone": "America/Los_Angeles",
  "skillVersion": "0.2.5",
  "expectedProperty": { "id": "configured-htid", "name": "Configured property name" }
}
```

### 2. Authenticate

Reuse an authenticated Expedia Partner Central browser session when available. Otherwise open `https://www.expediapartnercentral.com` and populate its two-step login form using secrets from the configured backend. In vault mode, resolve them through Kolo credential storage. In `local_webform` mode, resolve them only within a trusted local authentication process; do not return them through a tool or model-visible result. Prefer semantic browser actions by accessible label. If Expedia requests MFA, let the user enter it directly in Expedia; never collect or store it. Stop after one credential retry and report only a redacted error.

In `interactive_session` mode the agent never populates the login form. Require a fresh `verifyInteractiveSession(document, expectedProperty)` pass on the live page (via `ExpediaEvcExtractor`) before proceeding: it must return `ok: true`. On session expiry, ask the user to log in again on Expedia and re-verify. Never auto-retry authentication with any stored data.

### 3. Select and verify the property

Navigate to:

```text
https://apps.expediapartnercentral.com/supply/reservations/evc-manage?tab=EVC_MANAGE&htid=<URL_ENCODED_HTID>
```

Verify that the visible property matches the configured property. Stop on a mismatch.

### 4. Extract every page

Load `scripts/browser_extract_evc.js` into the Expedia page and call `ExpediaEvcExtractor.extractDocument(document, PAGE_NUMBER)`. This browser-safe module has no Node.js, filesystem, or package dependencies. It maps rows by validated table-header names, never fixed column numbers. Each page must produce:

```json
{
  "pageNumber": 1,
  "expectedCount": 12,
  "records": [{
    "queue": "ready_to_charge",
    "guest": "Example Guest",
    "reservationId": "ABC123",
    "checkIn": "2026-09-14",
    "status": "Available",
    "amount": "USD 100.00",
    "originalPayout": "USD 125.00"
  }]
}
```

Valid queues are `ready_to_charge` and `refund_due`. Both sections must be present, including when empty. The extractor scopes tables to their section headings, reads original payout from nested detail rows, captures property identity and pagination state, and marks missing headers or counts incomplete. Never extract card number, CVV, or expiration fields.

When Expedia displays `Deactivated` in place of a remaining balance, retain the row as a non-actionable observation with a null amount. Count it for extraction completeness, exclude it from chargeable totals, and show it separately in the report. Any other non-money balance remains an unfamiliar structure and must fail closed.

An explicitly empty queue is recognized from the heading's bounded region even when Expedia provides no semantic wrapper, and the displayed range is read from the queue pagination controls or the text adjacent to them. Ambiguous or unfamiliar structures still fail closed.

For pagination, start at page 1, increment consecutively, and capture Expedia's displayed total. Stop when Next is disabled or the final displayed range is reached. Mark incomplete if a page repeats, page order changes, or 100 pages are reached. Save the collected contracts as `RUN_DIR/pages.json`.

### 5. Normalize and validate

```bash
node scripts/extract_evc.js RUN_DIR/pages.json RUN_DIR/run-context.json > RUN_DIR/reconciliation.json
```

The engine validates the run context and every extracted page with the dependency-free validators generated from `schema/`, then performs integer-cent parsing, exact-duplicate removal, conflicting-duplicate detection, repeated-page detection, property-ID verification, currency-separated totals, and displayed-count validation. It propagates only verified run and property metadata into the reconciliation result and validates that final result again. A missing count, a count that changes between pages, a property-ID mismatch, an incomplete page, or conflicting values for the same queue and reservation must produce `status: incomplete`. Conflicting records are excluded from totals. If the command exits nonzero or returns `status: incomplete`, do not label the result complete. Report only the redacted reason.

### 6. Build and verify the report

Generate the PDF from `reconciliation.json`, never directly from page text. Run `node scripts/build_report.js RUN_DIR/reconciliation.json RUN_DIR/expedia-vc-report.pdf CHROMIUM_PATH`. The generator enforces `schema/reconciliation-result.schema.json`, independently recomputes counts and currency totals, rejects sensitive fields, HTML-escapes every inserted string, and uses a unique restricted temporary directory. The report includes the verified property, Expedia property ID, timestamp and property timezone, both queues and currency-separated totals, completeness warnings, conflicts, extracted versus displayed counts, skill version, run ID, and a statement that it does not confirm a charge or refund was processed.

Before delivery, verify that the PDF opens and contains the same counts and totals as `reconciliation.json`. If rendering fails, deliver the validated structured summary instead.

### 7. Deliver and audit

Deliver the report in the requesting conversation. Log only run ID, property, timestamps, counts, currency-separated totals, completion status, and output filename. Never log credentials, MFA codes, or card credentials.

## Error handling

- **Missing or incomplete setup:** initiate the per-user approved Kolo credential setup; never request credentials in chat and never reuse another installer's credentials.
- **Vault `feature_disabled`:** offer the local one-use webform or interactive login fallback; explain their storage and session tradeoffs. The vault stays preferred once available again.
- **Interactive session expiry:** the user logs in again on Expedia and verification is repeated; the run stops otherwise.
- **MFA expired or rejected:** request one fresh code; never echo or persist it.
- **Property mismatch:** stop without extraction.
- **Validated empty section:** return a valid empty queue.
- **Missing or unfamiliar headers:** mark incomplete and retain only sanitized structural diagnostics.
- **Repeated page or count mismatch:** mark incomplete; do not present totals as final.
- **Invalid or mixed currency:** separate valid currencies or stop on a malformed record.
- **Session expired:** reauthenticate once, then stop with a redacted error.

## Release checks

Run `npm test` before publication. Releases require coverage for exact money parsing, multipage merging, repeated pages, duplicates, empty queues, malformed rows, and count mismatches. Run a secret/leak scan (structural grep for credential, MFA, cookie, session-token, and card-data markers) before publication. Tag GitHub releases with the same version published in Kolo.
