# Evidence and Explainability

## 1. Evidence purpose

Evidence exists so a human can understand why a classification or score was produced.

## 2. Evidence categories

- BIO_TEXT
- CAPTION_TEXT
- IMAGE_OBSERVATION
- CONTENT_METADATA
- LOCATION_SIGNAL
- PROFILE_METADATA
- ENGAGEMENT_SIGNAL
- MODEL_INFERENCE
- HUMAN_CORRECTION

## 3. Evidence record

At minimum:

- lead id
- evidence type
- source type
- source reference
- content/snippet or object pointer
- timestamp
- confidence
- metadata

## 4. Grounding rule

An AI response is not an evidence record by itself. The system should distinguish between the model's statement and the input fact supporting it.

## 5. Explainability UI

The user should be able to navigate:

```text
Score → contributing signals → evidence → source
```

and:

```text
Classification → confidence → evidence → model/version
```

## Write order and transaction boundaries (remediation §19)

Evidence is written **before** anything may reference it:

```text
Analysis Run (ai_runs row, status=RUNNING)
    → Structured Extraction (validated against schema)
    → Evidence rows INSERT (provenance: source, external_id, retrieved_at, content_hash)
    → Evidence IDs attached to the analysis row
    → Evidence validation
    → Decision
```

- The extraction→evidence→attach sequence runs in **one database transaction**
  per lead-analysis step; on failure the transaction rolls back and the
  orchestrator retries per the job retry policy (ADR-016).
- No `evidenceIds` reference may point to a row that does not exist in the same
  transaction. Broken references are a build/test failure, not a runtime state.
- Orphan evidence (analysis rolled back) is impossible by transaction design;
  orphan analyses cannot exist because evidence attach precedes analysis commit.
- Reprocessing creates **new** analysis/evidence versions; old versions stay
  auditable per the current-version semantics (ADR-024).

## Implemented runtime (Phase 16, ADR-028)

`@ulip/analysis` `buildEvidenceDrafts()` (`blueprint/packages/analysis/src/evidence.ts`)
observes the loaded lead context and emits one record per observed fact — name,
bio, categories, city/address, website/contact presence, source metadata,
sampled captions, engagement. Rules:

- deterministic ids derived from (job, lead, type, source reference, content
  hash) ⇒ a retry rebuilds byte-identical evidence instead of duplicating it;
- never derived from a field that was not actually present (missing ⇒ no
  evidence row, not an invented one);
- contact values are never copied into evidence content (PII minimization),
  only their presence is recorded;
- every content sample exposes its evidence id, so each AI claim can cite it.

Evidence is inserted in the same transaction as the analysis row, before the
row becomes current (§ write order above). `enforceEvidenceFirst()` in
`@ulip/ai` demotes any prediction whose evidence set is empty to
`UNAVAILABLE`/`UNKNOWN`, and `@ulip/analysis` stores per-field
`availability` + `reasons[]` + `uncertainFields[]` in the analysis output, so
`GET /leads/{leadId}/evidence` and `GET /leads/{leadId}/analysis` answer
"why" with structured reasons and evidence references — never hidden
chain-of-thought.
