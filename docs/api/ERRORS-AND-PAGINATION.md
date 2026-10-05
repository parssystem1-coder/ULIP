# API Errors and Pagination

## Error envelope

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Human-readable safe message",
    "details": {}
  },
  "requestId": "req_123"
}
```

## Error categories

- `AUTHENTICATION_REQUIRED`
- `FORBIDDEN`
- `NOT_FOUND`
- `INVALID_REQUEST`
- `CONFLICT`
- `SOURCE_UNAVAILABLE`
- `SOURCE_DATA_UNAVAILABLE`
- `AI_PROVIDER_ERROR`
- `AI_SCHEMA_VALIDATION_FAILED`
- `JOB_NOT_FOUND`
- `JOB_CANCELED`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

Do not expose provider credentials, stack traces or sensitive source payloads in API error messages.

## Pagination

Initial page/limit format:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1250,
    "totalPages": 25
  }
}
```

For large datasets, add cursor pagination without breaking response semantics by versioning the endpoint if necessary.
