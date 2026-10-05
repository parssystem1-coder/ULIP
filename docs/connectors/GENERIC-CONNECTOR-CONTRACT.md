# Generic Connector Contract

## SourceMetadata

```typescript
interface SourceMetadata {
  type: string;
  displayName: string;
  version: string;
  capabilities: string[];
}
```

## DiscoveryRequest

```typescript
interface DiscoveryRequest {
  query?: string;
  filters?: Record<string, string>;  // typed, mirrors blueprint/packages/connectors
  limit: number;
  cursor?: string;
}
```

## DiscoveryResult

```typescript
interface DiscoveryResult {
  items: RawEntity[];
  nextCursor?: string;
  partial: boolean;
  warnings: string[];
}
```

## RawEntity

```typescript
interface RawEntity {
  sourceType: string;
  externalId: string;
  entityType: string;
  payload: Record<string, unknown>;
  collectedAt: string;
}
```

## Capability negotiation

The application must call `capabilities()` before requesting optional functions. Unsupported operations should return a typed `CAPABILITY_NOT_SUPPORTED` outcome rather than silently doing something else.

## Contract mirror (ADR-023)

The TypeScript source of truth is `blueprint/packages/connectors/src/interfaces.ts`
(`DiscoveryRequest`, `DiscoveryResult`, `RawEntity`, `SourceMetadata`, `HealthStatus`,
`CapabilitySet`, `CapabilityNotSupportedError`). `RawEntity.payload` is intentionally
`Record<string, unknown>` **only** because it is untrusted input until normalization
types it — this is the single sanctioned boundary. Every declared capability
(`profile_search`, `profile_fetch`, `content_fetch`, `image_fetch`, `location`,
`engagement_metrics`) must be checked via `supports()` before use; unsupported
operations raise `CapabilityNotSupportedError` instead of returning empty data.
