# Data Protection

## 1. Purpose and scope

ULIP processes data about businesses and, unavoidably, about the people behind
them. This document is the normative data-protection model (remediation §34).
`PII-DATA-MODEL.md` enumerates fields; `RETENTION-POLICY.md` sets clocks.

## 2. Data categories

| Category | Examples | Protection class |
|---|---|---|
| Business data | canonical name, website, business address, business phone | Standard |
| Sole-trader personal data | a person's name when the business IS the person | Personal — handle as PII |
| Contact personal data | personal mobile, WhatsApp, personal email | Personal — sensitive contact |
| Content | posts, captions, images collected via permitted access | Personal-adjacent; provenance required |
| Inference data | classifications, scores, audience-quality estimates | Personal-adjacent; explainability required |
| System data | jobs, AI runs, audit logs | Standard + audit integrity |

Rule: **business data about legal entities is not PII; the same field attached
to a sole trader or a named professional is.** The `businesses` vs
`business_contacts.is_sensitive` split exists to enforce this at the storage layer.

## 3. Lawful/permitted collection boundary

- Connectors use only authorized/permitted access (see ACCESS-AND-COMPLIANCE.md).
- No CAPTCHA/anti-bot/rate-limit bypass — ever (ADR-005 boundary preserved).
- Public-by-design business contact channels (business phone, website) may be
  collected; personal channels (private mobile, personal email) are collected
  only when the source exposes them as business contact data, and are flagged
  `is_sensitive = true` with restricted exposure and no default export.
- Data minimization: fields without a product purpose are not stored (§34 "do
  not over-collect"). Profile media is stored by reference and hash, not
  re-hosted, unless a documented purpose exists.

## 4. Rights-style duties (platform obligations)

Even where a jurisdiction-specific GDPR regime does not directly apply, the
platform implements the same duties because tenants are multi-jurisdictional:

1. **Access/export** — a tenant can export all stored data for one lead
   (identity, content references, analyses, evidence) as JSON.
2. **Deletion** — deleting a lead removes/anonymizes its personal fields;
   `audit_logs` retains a tombstone (entity id, action, time) without payloads.
3. **Rectification** — human review corrections are the rectification channel;
   history is preserved, never overwritten silently.
4. **Objection** — a lead can be marked REJECTED/ARCHIVED; reprocessing must
   not resurrect rejected leads without an explicit user action.

## 5. Access control

- Tenant isolation is server-side and mandatory; tenant id comes from the
  authenticated session, never from user input (THREAT-MODEL T2).
- Sensitive contacts require an explicit permission beyond `leads.read`
  (`contacts.sensitive.read` — defined in ROLES-AND-PERMISSIONS).
- Raw payloads (`raw_entities.payload_json`) are internal-only; they are never
  exposed via the public API.

## 6. Audit and integrity

All access to sensitive contact data and all exports are audit-logged
(actor, scope, time, count). Audit logs are append-only at the application
layer; no API deletes audit records.

## 7. AI-specific protections

- Source content is untrusted input (prompt-injection boundary, THREAT-MODEL T3);
  it is never executed as instruction.
- Inferences about people (not businesses) are minimized; audience-quality is
  always probabilistic with evidence, never a definitive claim about individuals.
- AI runs store hashes + metadata, not raw personal payloads.
