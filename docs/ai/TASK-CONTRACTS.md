# AI Task Contracts

> **Single source of truth:** the TypeScript contracts in `blueprint/packages/ai/src/interfaces.ts`.
> This document mirrors them in prose. No `unknown` in public contracts (ADR-023).
> Jev is an **optional** DecisionProvider behind a typed contract with explicit
> `DecisionRequest`/`DecisionResponse` types — see ADR-017.

## Structured profile extraction

Input:

```typescript
type ProfileExtractionInput = {
  profileText?: string;
  locationHints?: string[];
  contentSamples: ContentSample[];
  taxonomySnapshot: TaxonomyOption[];
  locale?: string;             // 'fa' | 'en' — Persian content is first-class
};
```

Output:

```typescript
type FieldPrediction = {
  value: string;              // taxonomy node id, or free text when none exists
  confidence: number;         // 0..1, finite
  evidenceIds: string[];      // must reference ids supplied in the request
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
};

type StructuredProfile = {
  businessType?: FieldPrediction;
  industry?: FieldPrediction;
  specialties: FieldPrediction[];
  brands?: FieldPrediction[];   // e.g. ['HP'] for printer-parts wholesalers
  city?: FieldPrediction & {
    provenance: 'EXPLICIT' | 'INFERRED' | 'UNKNOWN';
  };
};
```

**Implemented runtime (Phase 16, ADR-028).** `validateExtractionOutput` runs
before anything is persisted: confidence ranges, availability enum, evidence ids
that must exist in the request, provenance for a city value, no empty values.
`enforceEvidenceFirst` then demotes any claim whose evidence set is empty to
`UNAVAILABLE`/`UNKNOWN` — an unsupported inference never becomes a fact. All
validation errors are recorded as AI run outcomes (bounded repair/retry).

The HTTP adapter is configured by `AI_PROVIDER`/`AI_BASE_URL`/`AI_API_KEY`/
`AI_MODEL` (+ timeout/retry) and speaks OpenAI-compatible Chat Completions; no
vendor is hard-coded. `AI_PROVIDER=fake` selects the deterministic
`DeterministicFakeLlmProvider` (tests/local E2E only). With no credentials the
runtime reports `NOT_CONFIGURED` and never fabricates a result.

## Provider selection contract

```typescript
type AiRuntime =
  | { state: 'READY'; llm: LLMProvider; vision?: VisionProvider | null;
      embeddings?: EmbeddingProvider | null; decision?: DecisionProvider | null;
      meta: AiMetadata }
  | { state: 'NOT_CONFIGURED'; missing: string[]; reason: string };
```

Only these two states exist. `meta.provider` is persisted on every analysis and
`ai_runs`, so a `fake` run is always labelled `fake` — a fake is never presented
as a real provider (§11 of the Phase 16 spec).

## Natural-language query parsing

Input is user text. Output is a typed `LeadSearchQuery` containing only fields supported by the application.

The LLM must not generate SQL, arbitrary filter expressions or executable code.

## Visual analysis

Output must identify observations and confidence, not claim ownership/identity beyond available evidence.

## Decision provider

Input includes a finite option set. Output contains selected option, probabilities and provider metadata. Application code applies threshold/fallback logic.

## Validation

All outputs are schema validated. Validation errors are recorded as AI run outcomes and can trigger bounded repair/retry.
