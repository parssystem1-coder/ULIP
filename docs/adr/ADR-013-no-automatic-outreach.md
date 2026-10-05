# ADR 013 no automatic outreach

## Title
No automatic outreach in Core

## Status
Accepted for the current architecture baseline. The implementation freeze was
superseded by **ADR-026** (Social Actions and Outreach as bounded modules with
a human confirmation gate); the *safety boundary* of this ADR (no bypass
mechanics, honest capabilities) remains binding inside ADR-026.

## Decision
Campaign grouping/export stops short of message automation.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
The initial product objective is lead intelligence, not autonomous outreach.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
A future outreach module can be separately bounded and permissioned.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
