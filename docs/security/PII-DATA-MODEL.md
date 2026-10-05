# PII Data Model

## Field inventory and protection classes

The canonical schema (`database/schema/schema.sql`) is the storage source of
truth; this document classifies its personal-data fields.

| Storage field | Content | Class | Exposure rule |
|---|---|---|---|
| `businesses.canonical_name` | Business name; person name when sole trader | Personal when sole trader | Standard tenant visibility |
| `business_contacts.value` (PHONE/MOBILE/WHATSAPP/EMAIL) | Contact channel | Personal (sensitive when personal channel) | `is_sensitive=true` rows require `contacts.sensitive.read`; excluded from default exports |
| `business_contacts.value` (WEBSITE/SOCIAL) | Public business channels | Business data | Standard |
| `lead_identities.username` / `profile_url` | Public source handle | Public-by-design | Standard |
| `lead_contents.text` | Bio/captions from permitted access | Personal-adjacent | Standard; never re-published outside tenant |
| `lead_contents.media_url` | Reference to source media | Reference only | Store by reference + hash; no re-hosting without purpose |
| `human_reviews.reviewer_id` | Who corrected what | Personal (internal) | Visible within tenant; included in audit |
| `users.email` | Account identity | Personal (internal) | Never exported in lead exports |
| `raw_entities.payload_json` | Unfiltered source payloads | Mixed — treat as containing PII | Internal-only; retention-capped (RETENTION-POLICY); never exposed via API |
| `audit_logs.*` | Who did what | Personal (internal, integrity-relevant) | Append-only; tombstone-only after entity deletion |

## Non-PII by design

- `taxonomy_*`, `location_aliases`, `normalization_rules` — reference data.
- `scoring_policies` / `decision_policies` — configuration.
- Aggregate `usage_counters` — no personal fields.

## Derived/inference data

`lead_classifications`, `lead_analyses`, `lead_scores`, `audience_quality`,
`decisions` are inferences. Rules:

1. Every inference carries provenance (model version, policy version, evidence).
2. Inferences about audience quality stay probabilistic and risk-oriented.
3. Inference rows are deleted with the lead (cascade) or tombstoned per
   RETENTION-POLICY when deletion is requested.

## Deletion mechanics

- `leads` deletion cascades to identities, contents, analyses, evidence,
  scores, decisions, reviews (schema-level ON DELETE CASCADE).
- `raw_entities` rows referencing the deleted identity are deleted by the
  deletion job; `raw_entity_currents` pointer is removed with them.
- `businesses` merged via entity resolution keep merge events
  (`entity_merge_events`) as tombstone-level history without payloads.
