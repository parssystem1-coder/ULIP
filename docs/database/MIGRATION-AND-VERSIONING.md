# Migration and Versioning Policy

## Rules

- Every schema change is represented by a migration.
- Migrations are deterministic and reviewable.
- Production migrations must be backward-compatible where rolling deploys are used.
- Destructive changes use expand → migrate → contract where necessary.
- Seed data and schema migrations are kept separate.

## Versioned analytical artifacts

The following version identifiers are persisted with results:

- analysis version
- model/provider version
- taxonomy version
- scoring version
- prompt/schema version when relevant

## Reprocessing

A new model does not overwrite the historical result. It creates a new analysis/result version linked to the same Lead and underlying evidence.
