# API Module Boundary Blueprint

Each module should normally have:

```text
application/
domain/
infrastructure/
presentation/
```

Use only the subfolders that are justified by the implementation stage. Do not create empty abstraction layers solely for aesthetics.

Suggested module contents:

- application: use cases, commands/queries, orchestration
- domain: entities/value objects/domain services/ports
- infrastructure: repositories/adapters/providers
- presentation: controllers/DTOs/OpenAPI metadata
