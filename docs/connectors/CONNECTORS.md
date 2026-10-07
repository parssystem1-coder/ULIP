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
  ├── Instagram        ✅ IMPLEMENTED (Phase 19, ADR-031) — authorized Instagram Graph API
  ├── HTTP_API         ✅ generic authorized-HTTP boundary (advertises nothing until a real adapter backs it)
  ├── FAKE             ✅ deterministic E2E-only provider (never in production)
  ├── GoogleMaps       ⬜ future — same factory + registration pattern
  ├── LinkedIn         ⬜ future
  ├── YouTube          ⬜ future
  ├── Facebook         ⬜ future
  ├── Website          ⬜ future
  └── CSV              ⬜ future
```

See `docs/connectors/INSTAGRAM-CONNECTOR.md` and
`docs/adr/ADR-031-instagram-authorized-connector.md` for the implemented
Instagram adapter (capabilities, config, quotas, error mapping, payload
shape).

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
