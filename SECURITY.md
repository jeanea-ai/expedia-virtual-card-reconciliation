# Security Policy

Do not include Expedia passwords, MFA codes, full card numbers, CVVs, expiration dates, or live guest data in issues, fixtures, logs, screenshots, or reports.

Use only the one-use local webform for credential setup. Its store is workspace-local, outside the repository, owner-only on POSIX, locked, atomically replaced, and refuses symbolic links or corrupt content; it is not encrypted at rest. Never commit, copy, publish, or back up that file with the Skill. `scripts/login_local.js` is the only runtime code permitted to read stored credentials. It must send them only through a loopback CDP connection to an Expedia-owned login origin and return only redacted status.

Setup-state files may contain only credential references and configured booleans, never credential values. Credential checks may disclose presence and permission status, but not values or lengths. The local form must never accept MFA codes, recovery codes, cookies, or session tokens. Test contributions must use synthetic or irreversibly sanitized records. Report suspected credential or payment-data exposure privately to the repository owner rather than opening a public issue.
