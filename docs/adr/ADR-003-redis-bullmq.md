# ADR 003 redis bullmq

## Title
Redis and BullMQ

## Status
Accepted for the current architecture baseline.

## Decision
Use Redis/BullMQ for asynchronous work.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Discovery, AI, vision and exports can be long-running and retryable.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Queue contracts must remain independent of HTTP request lifetimes.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
