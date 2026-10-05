# ADR 001 modular monolith

## Title
Modular Monolith

## Status
Accepted for the current architecture baseline.

## Decision
Keep the first production implementation as a modular monolith with strict module boundaries.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Microservices add network, deployment, observability and consistency overhead before the product has demonstrated the need.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Modules can later be extracted because they already depend on interfaces and explicit boundaries.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
