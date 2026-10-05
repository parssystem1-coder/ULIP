# ADR 007 llm jev separation

## Title
LLM / Jev separation

## Status
Accepted for the current architecture baseline.

## Decision
Use LLM for understanding and Jev for bounded decisions where appropriate.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Different tasks have different optimal interfaces and failure modes.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Benchmark alternatives on a labeled dataset rather than assuming Jev always improves accuracy.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
