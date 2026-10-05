# ADR 008 evidence first

## Title
Evidence first

## Status
Accepted for the current architecture baseline.

## Decision
Persist supporting evidence for important AI predictions.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Users need explainability and the system needs debugging/evaluation support.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Unsupported predictions can still exist but should show reduced confidence and provenance.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
