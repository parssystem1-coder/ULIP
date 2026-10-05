# ADR 010 scoring separation

## Title
Scoring separation

## Status
Accepted for the current architecture baseline.

## Decision
Keep relevance, audience quality, activity and confidence separate.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
One number cannot represent all business dimensions.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Priority can be derived from configurable weighting.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
