# ADR 005 connector architecture

## Title
Connector architecture

## Status
Accepted for the current architecture baseline.

## Decision
Use source-specific connectors that return universal/raw contracts.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Different platforms expose different fields and capabilities.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Core logic consumes normalized data, not source-specific objects.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
