# Changelog

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
