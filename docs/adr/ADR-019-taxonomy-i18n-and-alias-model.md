# ADR 019 — Taxonomy Internationalization and Persian-First Normalization

## Status
Accepted (remediation 2026-10-04)

## Context
The product's flagship use cases are Persian, but Persian handling existed only
as prose. Alias normalization is a deterministic concern, not AI guesswork.

## Decision
1. Taxonomy gains `taxonomy_node_translations` (display names per locale) and
   `taxonomy_node_aliases` (resolution aliases) with a pre-normalized
   `alias_norm` key column.
2. A pure, deterministic normalization layer
   (`@ulip/domain/persian-normalize`) defines the canonical key derivation:
   Arabic→Persian letter unification, Arabic-Indic digit mapping, ZWNJ
   preservation in words / collapse in alias keys, tashkeel removal, casefold.
3. `normalization_rules` and `location_aliases` tables hold data-driven
   spelling/variant mappings — aliases are data, never code branches.
4. Persian is a first-class locale in API (`locale=fa` default), NL search and
   AI extraction inputs.

## Consequences
- Alias lookups are O(1) indexed queries on `alias_norm`.
- Any change to normalization is a versioned, testable code change plus data
  backfill — never a silent behavior change.
