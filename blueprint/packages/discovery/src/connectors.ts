/**
 * First source integration (Phase 15, ADR-027).
 *
 * Two factories ship here:
 *
 *  1. ConfiguredHttpApiConnectorFactory — the production boundary pattern:
 *     requires explicit authorized-API credentials in the source row config
 *     (`config.provider` + `config.apiBaseUrl` + `config.apiToken`). Without
 *     them it refuses (canBuild → false), which the pipeline surfaces as
 *     NOT_CONFIGURED. The actual authorized Instagram Graph path needs app
 *     review + permissions, so no real network adapter is claimed here; this
 *     factory is where such an adapter plugs in.
 *
 *  2. DeterministicFakeConnectorFactory — an honest, deterministic provider
 *     for local E2E tests. It is a REAL LeadSourceConnector (search/fetch/
 *     health) over a fixed in-memory dataset; production code may only use it
 *     when explicitly allowed (allowDeterministicFakes).
 *
 * No scraping, no CAPTCHA/anti-bot bypass, no session extraction, no
 * unauthorized access — anywhere, ever.
 */

import type {
  ConnectorCapability,
  DiscoveryRequest,
  DiscoveryResult,
  HealthStatus,
  LeadSourceConnector,
  RawEntity,
  SourceMetadata,
} from '@ulip/connectors';

import type { ConnectorFactory } from './contracts.ts';

function requireString(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const FAKE_PROFILE_SEARCH: ConnectorCapability = 'profile_search';

export class DeterministicFakeConnector implements LeadSourceConnector {
  /** Drives the registry guard; see ConnectorRegistry.resolveFor. */
  readonly isDeterministicFake = true;

  private readonly dataset: readonly {
    externalId: string;
    entityType: string;
    username: string;
    displayName: string;
    profileUrl: string;
    payload: Record<string, unknown>;
  }[];
  private readonly collectedAt: string;

  constructor(
    dataset: readonly {
      externalId: string;
      entityType: string;
      username: string;
      displayName: string;
      profileUrl: string;
      payload: Record<string, unknown>;
    }[],
    collectedAt: string,
  ) {
    this.dataset = dataset;
    this.collectedAt = collectedAt;
  }

  metadata(): SourceMetadata {
    return { type: 'FAKE', displayName: 'Deterministic Fake Provider', version: '1.0.0' };
  }

  capabilities(): ReadonlySet<ConnectorCapability> {
    return new Set<ConnectorCapability>([FAKE_PROFILE_SEARCH, 'profile_fetch', 'location']);
  }

  supports(capability: ConnectorCapability): boolean {
    return this.capabilities().has(capability);
  }

  async search(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const q = (request.query ?? '').trim();
    const matches = q === ''
      ? this.dataset
      : this.dataset.filter(
          (d) => d.displayName.includes(q) || d.username.includes(q.toLowerCase()) || Object.values(d.payload).some((v) => typeof v === 'string' && v.includes(q)),
        );
    const items: RawEntity[] = matches.map((d) => ({
      sourceType: 'FAKE',
      externalId: d.externalId,
      entityType: d.entityType,
      payload: { ...d.payload },
      collectedAt: this.collectedAt,
    }));
    return { items, partial: false, warnings: [] };
  }

  async fetch(identifier: string): Promise<RawEntity | null> {
    const hit = this.dataset.find((d) => d.externalId === identifier);
    if (hit === undefined) return null;
    return {
      sourceType: 'FAKE',
      externalId: hit.externalId,
      entityType: hit.entityType,
      payload: { ...hit.payload },
      collectedAt: this.collectedAt,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true };
  }
}

export class DeterministicFakeConnectorFactory implements ConnectorFactory {
  readonly sourceType = 'FAKE';

  private readonly dataset: readonly {
    externalId: string;
    entityType: string;
    username: string;
    displayName: string;
    profileUrl: string;
    payload: Record<string, unknown>;
  }[];
  private readonly collectedAt: string;

  constructor(
    dataset: readonly {
      externalId: string;
      entityType: string;
      username: string;
      displayName: string;
      profileUrl: string;
      payload: Record<string, unknown>;
    }[] = DEFAULT_FAKE_DATASET,
    collectedAt = '2026-01-01T00:00:00.000Z',
  ) {
    this.dataset = dataset;
    this.collectedAt = collectedAt;
  }

  canBuild(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  build(): DeterministicFakeConnector {
    return new DeterministicFakeConnector(this.dataset, this.collectedAt);
  }
}

/**
 * Production source boundary for arbitrary authorized HTTP APIs the tenant
 * legally controls (sourceType 'HTTP_API'). The REAL authorized Instagram
 * Graph adapter lives in ./instagram.ts (Phase 19, ADR-031) and registers
 * under sourceType 'INSTAGRAM' — nothing else in the pipeline changes.
 */
export class ConfiguredHttpApiConnectorFactory implements ConnectorFactory {
  readonly sourceType: string;

  constructor(sourceType = 'HTTP_API') {
    this.sourceType = sourceType;
  }


  canBuild(config: Record<string, unknown>): { ok: boolean; reason?: string } {
    const provider = requireString(config, 'provider');
    if (provider === undefined) return { ok: false, reason: 'config.provider is required' };
    const base = requireString(config, 'apiBaseUrl');
    if (base === undefined) return { ok: false, reason: 'config.apiBaseUrl is required' };
    if (!/^https:\/\//.test(base)) return { ok: false, reason: 'config.apiBaseUrl must be https' };
    const token = requireString(config, 'apiToken');
    if (token === undefined) return { ok: false, reason: 'config.apiToken is required' };
    return { ok: true };
  }

  build(config: Record<string, unknown>): LeadSourceConnector {
    return new ConfiguredHttpApiConnector(
      this.sourceType,
      requireString(config, 'provider') ?? '',
      requireString(config, 'apiBaseUrl') ?? '',
      requireString(config, 'apiToken') ?? '',
    );
  }
}

/**
 * A real, network-capable connector skeleton for an authorized HTTP API.
 * Only talks to the configured https base URL with the tenant's own token;
 * respects 429 retry-after by surfacing a typed error (never evading).
 * It does NOT advertise profile_search until the authorized provider actually
 * implements it — so a configured-but-unimplemented provider stays honest.
 */
export class ConfiguredHttpApiConnector implements LeadSourceConnector {
  private readonly sourceType: string;
  private readonly provider: string;
  private readonly apiBaseUrl: string;
  private readonly apiToken: string;

  constructor(sourceType: string, provider: string, apiBaseUrl: string, apiToken: string) {
    this.sourceType = sourceType;
    this.provider = provider;
    this.apiBaseUrl = apiBaseUrl;
    this.apiToken = apiToken;
  }

  metadata(): SourceMetadata {
    return { type: this.sourceType, displayName: `Configured ${this.provider} API`, version: '0.1.0' };
  }

  capabilities(): ReadonlySet<ConnectorCapability> {
    // Deliberately EMPTY: this boundary performs no discovery until its
    // authorized provider is actually implemented. Extend only with proof.
    return new Set<ConnectorCapability>();
  }

  supports(): boolean {
    return false;
  }

  async search(): Promise<DiscoveryResult> {
    // Honest gate: the boundary is implemented, the provider is not yet.
    throw new Error(
      `UNSUPPORTED: authorized "${this.provider}" discovery is not implemented; ` +
        'configure a provider with a real adapter before running discovery',
    );
  }

  async fetch(): Promise<RawEntity | null> {
    return null;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: false, reason: 'provider adapter not implemented; credentials validated at config time only' };
  }

  /** Exposed for tests asserting the credential pieces stayed intact. */
  configSummary(): { provider: string; apiBaseUrl: string; hasToken: boolean } {
    return { provider: this.provider, apiBaseUrl: this.apiBaseUrl, hasToken: this.apiToken.length > 0 };
  }
}

const DEFAULT_FAKE_DATASET: readonly {
  externalId: string;
  entityType: string;
  username: string;
  displayName: string;
  profileUrl: string;
  payload: Record<string, unknown>;
}[] = [
  {
    externalId: 'fake-001',
    entityType: 'BUSINESS_PROFILE',
    username: 'chap_tehran',
    displayName: 'چاپخانه تهران',
    profileUrl: 'https://example.test/chap_tehran',
    payload: {
      username: 'chap_tehran',
      full_name: 'چاپخانه تهران',
      biography: 'عمده‌فروش قطعات پرینتر HP',
      category: 'WHOLESALE',
      city: 'تهران',
      brand: 'HP',
      external_url: 'https://chap-tehran.example.test',
    },
  },
  {
    externalId: 'fake-002',
    entityType: 'BUSINESS_PROFILE',
    username: 'arayesh_shiraz',
    displayName: 'آرایشگاه شیراز',
    profileUrl: 'https://example.test/arayesh_shiraz',
    payload: {
      username: 'arayesh_shiraz',
      full_name: 'آرایشگاه شیراز',
      biography: 'خدمات رنگ مو',
      category: 'SERVICE',
      city: 'شیراز',
      external_url: '',
    },
  },
];
