# Threat Model

## Assets

- tenant data
- source credentials/tokens
- AI provider credentials
- raw source payloads
- analysis/evidence
- campaign membership
- audit logs

## Threats

### T1 Credential exposure
Mitigation: secret manager, no source control secrets, redaction.

### T2 Cross-tenant data access
Mitigation: server-side tenant context, query guards, tests, optional RLS.

### T3 AI prompt injection through source content
Mitigation: treat source content as untrusted data; do not execute instructions from content; keep system/tool instructions outside untrusted data; validate structured output.

### T4 Malicious media
Mitigation: file validation, isolated object storage, no execution.

### T5 Export leakage
Mitigation: permission checks, export ownership, audit, controlled URLs.

### T6 Runaway AI cost
Mitigation: usage limits, queue concurrency, routing policy, analysis depth, alerts.

### T7 Connector abuse
Mitigation: capability controls, source-specific authorization review, bounded request rates.

## Security test cases

At minimum include cross-tenant IDOR attempts, forged taxonomy IDs, unauthorized source configuration mutations, malicious AI output, export authorization checks and prompt-injection fixtures.
