# Testing Strategy

## Test pyramid

### Unit
Pure domain rules and parsers.

### Integration
Database repositories, queue adapters, AI gateway adapters, connector contract adapters.

### Contract
Connector and API contract compliance.

### E2E
User-visible workflow from discovery to export.

## Critical unit suites

- taxonomy tree operations
- normalization
- identity matching
- score calculation
- threshold routing
- query parsing validation
- permission rules

## Critical integration suites

- raw entity persistence
- dedup constraints
- AI run tracking
- evidence persistence
- campaign bulk operations
- audit logging

## Determinism

Mock AI/provider responses in core tests. Use real provider tests as opt-in integration checks, not as the only basis for correctness.
