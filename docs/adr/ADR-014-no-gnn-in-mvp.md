# ADR 014 no gnn in mvp

## Title
No GNN in MVP

## Status
Accepted for the current architecture baseline.

## Decision
Defer GNN until sufficient graph data and a validated problem justify it.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
GNN requires reliable interaction graph signals and adds substantial complexity.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Leave clean interfaces for future graph analytics without implementing them prematurely.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
