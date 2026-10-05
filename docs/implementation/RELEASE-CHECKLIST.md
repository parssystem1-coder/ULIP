# Release Checklist

## Product

- [ ] Core user flow works end-to-end.
- [ ] Taxonomy is tenant-safe and versioned.
- [ ] Review workflow works.
- [ ] Campaign/export workflow works.

## Data

- [ ] Migrations tested.
- [ ] Tenant isolation tested.
- [ ] Indexes reviewed.
- [ ] Retention policy documented.

## AI

- [ ] Provider configuration is secret-safe.
- [ ] AI outputs are schema validated.
- [ ] Evidence is persisted.
- [ ] Model versions are recorded.
- [ ] Usage tracking works.

## Source access

- [ ] Connector uses authorized/permitted access.
- [ ] No bypass mechanisms exist.
- [ ] Capability reporting works.
- [ ] Partial/unavailable fields are explicit.

## Operations

- [ ] Health/readiness checks.
- [ ] Queue monitoring.
- [ ] Logs/metrics/traces.
- [ ] Backup/restore procedure.
- [ ] Runbook reviewed.

## Security

- [ ] Secrets absent from repository.
- [ ] Authz tests pass.
- [ ] Export permissions tested.
- [ ] Prompt injection fixtures pass.
