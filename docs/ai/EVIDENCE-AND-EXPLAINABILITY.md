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
