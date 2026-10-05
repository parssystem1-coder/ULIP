# Coding Standards

## TypeScript

- strict mode
- no unbounded `any`
- DTO validation at boundaries
- explicit return types for public interfaces where useful
- domain types separated from transport DTOs

## Naming

Use domain language consistently: `Lead`, `Business`, `LeadIdentity`, `Evidence`, `Decision`, `Campaign`.

## Module boundaries

- Domain does not import infrastructure SDKs.
- Controllers do not call external providers directly.
- Queue processors call application services, not database primitives directly.
- Shared packages contain stable contracts, not dumping grounds for unrelated helpers.

## Error handling

Use typed application errors and a centralized mapping to HTTP error envelopes.

## Tests

Tests should express behavior, not implementation details. Use contract tests for provider/connector boundaries.

## Logging

Use structured logging. Redact secrets and high-risk payloads.

## Database

Queries must be tenant-aware where applicable. Schema changes use migrations.
