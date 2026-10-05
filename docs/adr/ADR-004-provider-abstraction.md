# ADR 004 provider abstraction

## Title
Provider abstraction

## Status
Accepted for the current architecture baseline.

## Decision
Hide external AI/source SDKs behind interfaces.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Prevents vendor lock-in and keeps domain logic provider-neutral.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Adapters may be added without modifying domain models.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
