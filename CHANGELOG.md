# Changelog

## 0.2.4

- Formally support an interactive-login fallback when the credential vault returns `feature_disabled`; the vault remains the preferred setup mode.
- In interactive mode the agent never handles authentication secrets: the user logs in directly on Expedia while the agent pauses.
- After login, verify only that an authenticated session exists and the active property exactly matches the saved non-secret property configuration.
- Interactive mode is user-initiated only; it is not for unattended or scheduled runs, and an expired session requires the user to log in again.
- Add sanitized fixtures and regression tests for setup pairing, session verification, and fail-closed secret rejection.

## 0.2.3

- Recognize an explicitly empty refund queue from the heading's bounded region without a semantic wrapper.
- Parse the displayed range from text adjacent to the Previous/Next controls without a pagination-labeled wrapper.
- Preserve fail-closed behavior for ambiguous or unknown structures.
- Add sanitized regression fixtures and tests.

## 0.2.2

- Treat a `Deactivated` remaining-balance badge as a non-actionable observation with no monetary amount.
- Accept an explicitly empty refund queue even when Expedia renders no table.
- Recognize the `Check-in date` column header.
- Scope pagination range extraction and reject impossible ranges.

## 0.2.1

- Add a required first-run setup flow for every installer.
- Keep Expedia credentials user-scoped in Kolo's approved credential storage.
- Add a deterministic setup-state schema and readiness validator that reject credential values.
- Require property ID, property name, and IANA timezone before reconciliation.

## 0.2.0

- Preserve the Expedia Virtual Card Reconciliation name and consumer triggers.
- Require Kolo-approved credential storage instead of chat-based password collection.
- Add deterministic normalization, exact money parsing, deduplication, pagination checks, and completeness reporting.
- Add a strict reconciliation-record schema and sanitized test fixtures.
- Keep the workflow read-only and prevent card credentials from entering reports or logs.

## 0.1.1

- Initial prompt-driven release.
