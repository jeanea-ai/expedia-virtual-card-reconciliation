---
name: "expedia-virtual-card-reconciliation"
description: "Reconcile Expedia virtual-card obligations into verified ready-to-charge and refund queues with a PDF guest-and-amount report. Use for: check Expedia VCs, VC reconciliation, cards ready to charge, or virtual card refund. Read-only; never charges or refunds a card."
tags: [hotel, expedia, virtual-cards, reconciliation, browser, accounting]
version: "0.2.7"
---

# Expedia Virtual Card Reconciliation

Read Expedia Partner Central's EVC Manage page, validate every extracted record, and produce ready-to-charge and refund queues. This skill is read-only: it never reveals card credentials and never charges or refunds a card.

## Safety invariants

- Use only the workspace-local, one-use credential webform for Expedia username and password setup. Never use Kolo credential storage or request credentials in chat or command arguments.
- Never print, log, persist in reports, or return passwords, MFA codes, full card numbers, CVVs, or expiration dates.
- The local store is protected by operating-system permissions but is not encrypted at rest. Keep it outside the Skill and repository.
- If Expedia requests MFA, have the user enter it directly on Expedia. Never request, read, or persist the code.
- Use the authenticated session only for the property selected for this run.
- Treat an incomplete or unfamiliar page as `incomplete`; do not issue a financial total as complete.
- Do not perform charges, refunds, reservation edits, or other financial actions.

## Required configuration

Each installer configures their own local credentials and property list. Credential values are never part of the Skill, setup state, chat history, or marketplace package.

### First-run setup

1. Explain that credentials will be stored in a workspace-local file protected by owner-only permissions and **not encrypted at rest**.
2. Run `npm run credentials:check`. If credentials are absent, run `npm run credentials:setup`. It opens the one-use form in the visible shared browser. Have the user enter their username and matching password entries there, never in chat.
3. Collect the non-secret Expedia property ID (`htid`), exact property name, and IANA timezone. Support multiple properties without duplicating an ID.
4. Write a sanitized `setup-state.json` matching `schema/setup-state.schema.json`: `authenticationMode: "local_webform"`, `credentialScope: "workspace_local"`, `expedia.username` and `expedia.password` references with configured booleans, and property configuration. Do not put credential values, MFA codes, cookies, or session tokens in it. For an existing v0.2.5 local setup, remove `vaultAvailability` and set `skillVersion: "0.2.7"`.
5. Run `node scripts/check_setup.js setup-state.json`. It independently checks the local credential file and its permissions. Continue only on `status: ready`. Exit code `3` means setup is incomplete.
6. Report only that setup is complete and the configured property names.

**Readiness command:** `node scripts/check_setup.js setup-state.json`. It returns `ready` only when the local file exists, both credentials are configured, permissions are private, and at least one valid property is configured.

If the user cancels the form, stop with `setup_required`. Rotate credentials only with `node scripts/credential_webform.js capture --replace`; remove them only with `node scripts/credential_webform.js remove --confirm` after the user requests removal. Update setup state immediately after removal.

### One-use credential webform

`npm run credentials:setup` starts an expiring HTTP listener bound to `127.0.0.1`, creates a random one-use URL, and opens it in the visible shared browser. Never print, log, copy, or return the tokenized URL after opening it. The form accepts only username, password, confirmation, and its one-use token. It must never accept MFA codes, recovery codes, cookies, or session tokens.

The store is outside the Skill and repository at `~/.openclaw/workspace-main/expedia-vc/.credentials.json`, unless `EXPEDIA_EVC_CONFIG_DIR` selects another private directory. The directory is mode `0700` and the file is mode `0600` on POSIX. Writes are locked and atomic; symbolic links and corrupt stores are refused. Credential values may be resolved only inside `scripts/login_local.js` by importing `readCredentials()` from `scripts/credential_webform.js`; never serialize them or expose them to the model, stdout, logs, exceptions, reports, or artifacts.

### Local automatic sign-in

With a ready local store, run `npm run login:local` to open Expedia Partner Central in the visible shared browser and fill its username and password fields through the local CDP connection. The command accepts no credential arguments, requires a loopback CDP endpoint, allows only Expedia-owned login origins, and prints only a status and browser target ID. It does not return credentials. If it returns `mfa_required`, ask the user to complete MFA directly on Expedia. If it returns `session_check_required`, verify the authenticated session and selected property on the live page before extraction. Any unexpected origin, ambiguous form, login failure, or unverified session stops the run with a redacted error. Do not invent a different credential path or pass secrets through agent-visible browser actions.

## Deterministic workflow

### 1. Preflight

- Require Node.js 18 or newer, installed runtime dependencies (`pnpm install --prod --frozen-lockfile`), and the setup, login, browser extraction, and reconciliation scripts.
- Require a `ready` result from `scripts/check_setup.js` for the current workspace before creating a run directory or opening Expedia.
- Create a unique, permission-restricted run directory; never reuse fixed report filenames.
- Write `RUN_DIR/run-context.json` with a unique run ID, ISO 8601 start time, IANA property timezone, skill version, and configured property ID and name. Do not include credentials or browser-session data. Validate it against `schema/run-context.schema.json`.

Example shape:

```json
{
  "schemaVersion": "1.0.0",
  "runId": "unique-run-id",
  "generatedAt": "2026-09-16T09:30:00-07:00",
  "timezone": "America/Los_Angeles",
  "skillVersion": "0.2.7",
  "expectedProperty": { "id": "configured-htid", "name": "Configured property name" }
}
```

### 2. Authenticate

Reuse an existing Expedia Partner Central browser session only after the property verification in step 3. Otherwise run `npm run login:local`. This trusted local process reads the private credential file and enters the username and password without exposing them to the agent. If the result is `mfa_required`, have the user enter MFA directly on Expedia. Then continue to step 3. Stop on login failure or an unexpected origin. Do not retry with a different credential path.

### 3. Select and verify the property

Navigate to:

```text
https://apps.expediapartnercentral.com/supply/reservations/evc-manage?tab=EVC_MANAGE&htid=<URL_ENCODED_HTID>
```

On this live page, run `ExpediaEvcExtractor.verifyInteractiveSession(document, expectedProperty)` and require `ok: true`. Verify that the visible property matches the configured property. Stop on login failure, expired session, ambiguous identity, or property mismatch.

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

- **Missing or incomplete setup:** run the one-use local credential form; never request credentials in chat and never reuse another installer's credentials.
- **Session expiry:** run `npm run login:local` once and repeat live session and property verification; stop otherwise.
- **MFA expired or rejected:** ask the user to retry directly on Expedia; never request, echo, or persist the code.
- **Property mismatch:** stop without extraction.
- **Validated empty section:** return a valid empty queue.
- **Missing or unfamiliar headers:** mark incomplete and retain only sanitized structural diagnostics.
- **Repeated page or count mismatch:** mark incomplete; do not present totals as final.
- **Invalid or mixed currency:** separate valid currencies or stop on a malformed record.
- **Session expired:** reauthenticate once, then stop with a redacted error.

## Release checks

Run `npm test` before publication. Releases require coverage for exact money parsing, multipage merging, repeated pages, duplicates, empty queues, malformed rows, and count mismatches. Run a secret/leak scan (structural grep for credential, MFA, cookie, session-token, and card-data markers) before publication. Tag GitHub releases with the same version published in Kolo.
