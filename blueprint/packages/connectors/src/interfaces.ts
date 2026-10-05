/**
 * Connector package contracts — typed; capability negotiation preserved.
 * Connectors return raw, schema-less payloads on purpose (untrusted input);
 * everything else is strongly typed. No anti-bypass behavior belongs here.
 */

export type ConnectorCapability =
  | 'profile_search'
  | 'profile_fetch'
  | 'content_fetch'
  | 'image_fetch'
  | 'location'
  | 'engagement_metrics';

export interface SourceMetadata {
  type: string;
  displayName: string;
  version: string;
}

export interface HealthStatus {
  ok: boolean;
  reason?: string;
}

export interface DiscoveryRequest {
  query?: string;
  filters?: Record<string, string>;
  limit: number;
  cursor?: string;
}

/** Untrusted source payload until normalization types it. */
export interface RawEntity {
  sourceType: string;
  externalId: string;
  entityType: string;
  payload: Record<string, unknown>;
  collectedAt: string;
}

export interface DiscoveryResult {
  items: RawEntity[];
  nextCursor?: string;
  partial: boolean;
  warnings: string[];
}

/** Capability negotiation: check before calling optional operations. */
export class CapabilityNotSupportedError extends Error {
  readonly capability: ConnectorCapability;
  readonly sourceType: string;

  constructor(capability: ConnectorCapability, sourceType: string) {
    super(`capability "${capability}" is not supported by source "${sourceType}"`);
    this.name = 'CapabilityNotSupportedError';
    this.capability = capability;
    this.sourceType = sourceType;
  }
}

export interface LeadSourceConnector {
  metadata(): SourceMetadata;
  capabilities(): ReadonlySet<ConnectorCapability>;
  supports(capability: ConnectorCapability): boolean;
  search(request: DiscoveryRequest): Promise<DiscoveryResult>;
  fetch(identifier: string): Promise<RawEntity | null>;
  healthCheck(): Promise<HealthStatus>;
}
