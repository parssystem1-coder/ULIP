# Secrets and Configuration

## Environment groups

```text
APP_
DATABASE_
REDIS_
STORAGE_
AUTH_
AI_
SOURCE_
OBSERVABILITY_
```

## Rules

- Commit `.env.example`, never real `.env` secrets.
- Never print credentials in logs.
- Redact Authorization headers and provider keys from traces.
- Configuration loading fails fast for required production secrets.
- Tenant-specific secrets require encrypted-at-rest storage if persisted.
- Rotate credentials without code changes.
