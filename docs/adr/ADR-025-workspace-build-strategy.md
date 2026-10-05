# ADR 025 — Workspace and Build Strategy

## Status
Accepted (remediation 2026-10-04)

## Context
The blueprint shipped `package.json` + `tsconfig.base.json` but no workspace
file and no child manifests: the "typecheck" gate declared in every phase
prompt could not actually run, and documentation would have been untruthful.

## Decision
1. `blueprint/` is a real pnpm workspace (`pnpm-workspace.yaml`,
   `packages/*`), containing typed contract packages: domain, ai, connectors,
   scoring, orchestration.
2. The minimum validation gate is: `pnpm install` → `pnpm typecheck` →
   `pnpm lint` → `pnpm test` → `pnpm build` (root `build` = typecheck + tests).
   Node ≥ 20; tests use the Node built-in runner
   (`node --experimental-strip-types --test`) so no test framework lock-in.
3. Database constraint tests run against PostgreSQL via Docker
   (`database/tests/db-constraints.test.ts`); when Docker/Postgres is absent
   they SKIP loudly with instructions — CI must run them on a capable runner.
   Documentation never claims a passing check that did not run.
4. App scaffolding (NestJS API, Next.js web) remains per Phase 1 of the
   implementation plan; the contracts packages above are the seed of that
   workspace and move into `apps/api`'s import path unchanged.

## Consequences
- The blueprint's own gate is executable today (see remediation report).
- Phase 1 inherits a green baseline instead of scaffolding from zero.
