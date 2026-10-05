# ADR 002 postgresql

## Title
PostgreSQL

## Status
Accepted for the current architecture baseline.

## Decision
Use PostgreSQL as the source of truth for transactional domain data.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Strong relational integrity, JSONB, indexing, transactions and mature tooling match the domain.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
An external search index can be introduced later without replacing the transactional database.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
