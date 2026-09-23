---
name: "expedia-virtual-card-reconciliation"
description: "Reconcile Expedia virtual-card obligations into verified ready-to-charge and refund queues with a PDF guest-and-amount report. Use for: check Expedia VCs, VC reconciliation, cards ready to charge, or virtual card refund. Read-only; never charges or refunds a card."
tags: [hotel, expedia, virtual-cards, reconciliation, browser, accounting]
version: "0.2.3"
---

# Expedia Virtual Card Reconciliation

Read Expedia Partner Central's EVC Manage page, validate every extracted record, and produce ready-to-charge and refund queues. This skill is read-only: it never reveals card credentials and never charges or refunds a card.

## Safety invariants

- Retrieve the Expedia username and password only through Kolo's approved credential storage. Never ask the user to paste a password into chat.
- Never print, log, persist in reports, or return passwords, MFA codes, full card numbers, CVVs, or expiration dates.
- Ask for an MFA code only when Expedia requests it, use it once, and do not persist it.
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

If the user cancels secure credential entry, stop with `setup_required`. Replacing or removing a stored credential must use Kolo's approved credential manager and the platform's required confirmation. After a removal, mark setup incomplete immediately.

The setup contract is defined by `schema/setup-state.schema.json`. `credentialScope` must be `user`, and the only permitted secret identifiers are `expedia.username` and `expedia.password` references. Resolve the selected property's ID, name, and timezone from the saved non-secret configuration. If multiple properties are configured and the request is ambiguous, ask which property to use.

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
  "skillVersion": "0.2.3",
  "expectedProperty": { "id": "configured-htid", "name": "Configured property name" }
}
```

### 2. Authenticate

Reuse an authenticated Expedia Partner Central browser session when available. Otherwise open `https://www.expediapartnercentral.com` and populate its two-step login form using secrets from Kolo credential storage. Prefer semantic browser actions by accessible label. If Expedia requests MFA, ask the user for the current code and submit it once. Stop after one credential retry and report only a redacted error.

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
- **MFA expired or rejected:** request one fresh code; never echo or persist it.
- **Property mismatch:** stop without extraction.
- **Validated empty section:** return a valid empty queue.
- **Missing or unfamiliar headers:** mark incomplete and retain only sanitized structural diagnostics.
- **Repeated page or count mismatch:** mark incomplete; do not present totals as final.
- **Invalid or mixed currency:** separate valid currencies or stop on a malformed record.
- **Session expired:** reauthenticate once, then stop with a redacted error.

## Release checks

Run `npm test` before publication. Releases require coverage for exact money parsing, multipage merging, repeated pages, duplicates, empty queues, malformed rows, and count mismatches. Tag GitHub releases with the same version published in Kolo.
