# ADR 011 dynamic taxonomy

## Title
Dynamic taxonomy

## Status
Accepted for the current architecture baseline.

## Decision
Store the profession/specialty hierarchy in the database.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Categories evolve by market and user workflow.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Taxonomy versions are recorded with classifications.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
