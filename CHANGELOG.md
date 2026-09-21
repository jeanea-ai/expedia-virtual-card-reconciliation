# Changelog

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
