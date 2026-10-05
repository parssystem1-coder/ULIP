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
  contentSamples?: ContentSample[];
  taxonomySnapshot: TaxonomyOption[];
};
```

Output:

```typescript
type StructuredProfile = {
  businessType?: {
    value: string;              // taxonomy node id or slug
    confidence: number;
    evidenceIds: string[];
  };
  industry?: {
    value: string;
    confidence: number;
    evidenceIds: string[];
  };
  specialties: Array<{
    value: string;
    confidence: number;
    evidenceIds: string[];
  }>;
  brands?: string[];            // e.g. ['HP'] for printer-parts wholesalers
  city?: {
    value: string;
    confidence: number;
    evidenceIds: string[];
    provenance: 'EXPLICIT' | 'INFERRED' | 'UNKNOWN';
  };
};
```

## Natural-language query parsing

Input is user text. Output is a typed `LeadSearchQuery` containing only fields supported by the application.

The LLM must not generate SQL, arbitrary filter expressions or executable code.

## Visual analysis

Output must identify observations and confidence, not claim ownership/identity beyond available evidence.

## Decision provider

Input includes a finite option set. Output contains selected option, probabilities and provider metadata. Application code applies threshold/fallback logic.

## Validation

All outputs are schema validated. Validation errors are recorded as AI run outcomes and can trigger bounded repair/retry.
