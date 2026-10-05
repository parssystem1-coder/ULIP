# ADR 006 ai gateway

## Title
AI Gateway

## Status
Accepted for the current architecture baseline.

## Decision
Route AI tasks through a centralized gateway/registry.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Centralizes routing, usage tracking, cost policy and provider selection.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Provider implementations remain replaceable.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
