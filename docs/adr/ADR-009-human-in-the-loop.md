# ADR 009 human in the loop

## Title
Human in the loop

## Status
Accepted for the current architecture baseline.

## Decision
Uncertain or policy-sensitive predictions can be reviewed by humans.

## Context
ULIP needs an architecture that remains easy to evolve while keeping the first implementation operationally simple.

## Rationale
Human correction is a high-value source of evaluation data.

## Consequences
The chosen design adds explicit interfaces and contracts. This introduces some up-front structure but reduces coupling between sources, AI providers and domain code.

## Future evolution
Review does not mean AI is removed; it creates a controlled feedback loop.

## Review trigger
Revisit this ADR only when measured requirements, production incidents, or a new source/provider capability make the current decision materially restrictive.
