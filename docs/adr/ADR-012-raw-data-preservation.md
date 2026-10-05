# ADR 012 raw data preservation

## Title
Raw data preservation

## Status
Accepted for the current architecture baseline.

## Decision
Keep source payloads long enough to support reprocessing and auditing.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Normalization and AI models evolve; source payloads are valuable for re-analysis.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Retention and privacy policy controls how long raw data remains.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
