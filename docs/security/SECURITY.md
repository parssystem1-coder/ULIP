# Security Architecture

## Authentication

Use a standard production authentication mechanism. The specific choice is implementation-level; it must support secure session/token handling, rotation/revocation and tenant context.

## Authorization

Permission checks are server-side. UI controls are not a security boundary.

## Tenant isolation

Tenant context is resolved server-side. All repository queries for tenant-scoped entities require tenant filtering.

## Secrets

Secrets are provided through a secret manager or environment injection. Never commit credentials.

## Input validation

Validate all external input, especially dynamic taxonomy IDs, filters, export fields and connector configuration.

## Output validation

Validate AI outputs before persistence.

## File/media security

Treat source media as untrusted. Validate type/size, avoid executing uploaded content, and store it in isolated object storage.

## Audit

Sensitive administrative and data-correction operations create audit records.
