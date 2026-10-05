# ADR 015 parse later

## Title
PARSE-style optimization later

## Status
Accepted for the current architecture baseline.

## Decision
Start with strong schemas, validation and grounding; add schema-optimization/reflection later.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
A complex schema optimization subsystem is not necessary before real failure data exists.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Feedback datasets can later inform automated schema/prompt refinement.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
