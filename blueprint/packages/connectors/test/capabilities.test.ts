import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CapabilityNotSupportedError,
  type ConnectorCapability,
  type LeadSourceConnector,
  type DiscoveryRequest,
  type DiscoveryResult,
  type RawEntity,
  type HealthStatus,
  type SourceMetadata,
} from '../src/interfaces.ts';

/** Minimal connector fixture exercising the capability negotiation contract. */
class InstagramOnlyProfiles implements LeadSourceConnector {
  metadata(): SourceMetadata {
    return { type: 'instagram', displayName: 'Instagram', version: '1.0.0' };
  }
  capabilities(): ReadonlySet<ConnectorCapability> {
    return new Set<ConnectorCapability>(['profile_search', 'profile_fetch']);
  }
  supports(c: ConnectorCapability): boolean {
    return this.capabilities().has(c);
  }
  async search(_request: DiscoveryRequest): Promise<DiscoveryResult> {
    if (!this.supports('profile_search')) {
      throw new CapabilityNotSupportedError('profile_search', this.metadata().type);
    }
    const item: RawEntity = {
      sourceType: 'instagram',
      externalId: 'abc123',
      entityType: 'PROFILE',
      payload: { username: 'example' },
      collectedAt: new Date().toISOString(),
    };
    return { items: [item], partial: false, warnings: [] };
  }
  async fetch(_identifier: string): Promise<RawEntity | null> {
    return null;
  }
  async healthCheck(): Promise<HealthStatus> {
    return { ok: true };
  }
}

test('connector declares capabilities and reports support honestly', () => {
  const c = new InstagramOnlyProfiles();
  assert.equal(c.supports('profile_search'), true);
  assert.equal(c.supports('image_fetch'), false);
  assert.equal(c.supports('engagement_metrics'), false);
});

test('search works for a supported capability', async () => {
  const c = new InstagramOnlyProfiles();
  const result = await c.search({ limit: 10 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.externalId, 'abc123');
});

test('CapabilityNotSupportedError carries capability and source', () => {
  const err = new CapabilityNotSupportedError('image_fetch', 'instagram');
  assert.equal(err.name, 'CapabilityNotSupportedError');
  assert.equal(err.capability, 'image_fetch');
  assert.equal(err.sourceType, 'instagram');
});
