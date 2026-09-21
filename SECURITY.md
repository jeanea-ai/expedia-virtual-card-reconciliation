# Security Policy

Do not include Expedia passwords, MFA codes, full card numbers, CVVs, expiration dates, or live guest data in issues, fixtures, logs, screenshots, or reports.

Use Kolo's approved credential storage for Expedia credentials. Store credentials with user scope so installing or publishing the Skill never shares one user's credentials with another installer. Setup-state files may contain only credential references and configured booleans, never credential values. Test contributions must use synthetic or irreversibly sanitized records. Report suspected credential or payment-data exposure privately to the repository owner rather than opening a public issue.
