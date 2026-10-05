# Connector Framework

## Interface

```typescript
interface LeadSourceConnector {
  metadata(): SourceMetadata;
  search(request: DiscoveryRequest): Promise<DiscoveryResult>;
  fetch(identifier: string): Promise<RawEntity | null>;
  capabilities(): ConnectorCapabilities;
  healthCheck(): Promise<HealthStatus>;
}
```

## Contract rules

- Connector output must retain source identity.
- Connector must not invent missing fields.
- Connector must explicitly represent unavailable/partial data.
- Connector must expose source-specific errors in normalized error categories.
- Connector operations must be idempotent where possible.

## Registry

```text
ConnectorRegistry
  ├── Instagram
  ├── GoogleMaps
  ├── LinkedIn
  ├── YouTube
  ├── Facebook
  ├── Website
  └── CSV
```

## Test strategy

Every connector must have contract tests for:

- metadata
- capability reporting
- successful discovery
- empty result
- partial result
- transient error
- permanent error
- duplicate input
