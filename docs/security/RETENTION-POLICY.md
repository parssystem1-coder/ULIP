# Retention Policy

All clocks are configuration (retention policy category, §23 configuration
architecture), with the defaults below. Enforcement is a scheduled
maintenance job; every enforcement run is audit-logged.

## Clocks by data class

| Data | Default retention | Trigger | Rationale |
|---|---|---|---|
| `raw_entities` (raw snapshots) | 90 days per snapshot | from `collected_at` | Reprocessing/debug window; identity + current pointer persist |
| `raw_entity_currents` | Until lead deletion | — | Pointer, not payload |
| `lead_contents` | Life of lead + 12 months after ARCHIVED/REJECTED | from terminal transition | Analysis context |
| `lead_analyses` (superseded) | 24 months | from `superseded_at` | Model comparison window |
| `lead_analyses` (current) | Life of lead | — | Active product data |
| `lead_scores` (superseded) | 24 months | from `superseded_at` | Policy-comparison window |
| `ai_runs` | 24 months | from `created_at` | Cost/accuracy analytics |
| `job_events` / `job_attempts` | 6 months | from `occurred_at`/`finished_at` | Ops window; `jobs` rows persist as compact records |
| `idempotency_keys` | 24 hours | from `expires_at` | §8 idempotency semantics |
| `exports` files (object storage) | 7 days | from creation | Signed URLs expire; tenant re-exports as needed |
| `audit_logs` | 7 years minimum (configurable) | from `created_at` | Integrity duty; tombstones only after deletion |
| Evidence (`evidence`) | Life of lead; content hashes persist | — | Explainability duty |

## Deletion vs anonymization

- Raw payloads and content text are **deleted** (not anonymized) at clock end:
  reprocessing value decays and hashed storage is cheaper than legal risk.
- Superseded analyses/scores older than the clock become **count-only**
  tombstones (lead_id, version, date) when they participate in an audited
  decision (e.g. a campaign export), otherwise deleted.
- Lead deletion (PII-DATA-MODEL) always runs immediately, overriding all clocks.

## Reprocessing interplay

Reprocessing after raw-snapshot expiry re-fetches from the source via the
connector when permitted; it never fabricates payloads from partial history
(provenance rule §33).

## Enforcement

1. A maintenance job enumerates retention categories from configuration.
2. Deletion runs in bounded batches (backpressure rule, SCALING-AND-CAPACITY).
3. Every batch run writes an audit record (category, rows affected, window).
4. Object-storage orphans (files without DB rows) are swept weekly.
