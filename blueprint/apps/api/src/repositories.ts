/**
 * Phase 14 repositories over the EXISTING schema (0001–0003). Tenant scoping
 * is mandatory: every query filters by tenant_id. The DB remains the source
 * of truth; jobs are persisted first, then enqueued.
 */

import type { Database } from '@ulip/runtime';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------- tenants

export interface TenantRow {
  id: string;
  name: string;
  status: string;
}

export class TenantRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(name: string, client?: Pool | PoolClient): Promise<TenantRow> {
    const exec = client ?? this.db.pool;
    const r = await exec.query<TenantRow>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, status',
      [name],
    );
    return r.rows[0] as TenantRow;
  }

  async findById(id: string): Promise<TenantRow | null> {
    const r = await this.db.query<TenantRow>('SELECT id, name, status FROM tenants WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }
}

// ---------------------------------------------------------------- users

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  api_key_hash: string | null;
}

export class UserRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: {
    tenantId: string;
    email: string;
    role?: string;
    apiKeyHash?: string;
  }): Promise<UserRow> {
    const r = await this.db.query<UserRow>(
      `INSERT INTO users (tenant_id, email, role, api_key_hash)
       VALUES ($1, $2, COALESCE($3, 'ANALYST'), $4)
       RETURNING id, tenant_id, email, role, api_key_hash`,
      [input.tenantId, input.email, input.role ?? null, input.apiKeyHash ?? null],
    );
    return r.rows[0] as UserRow;
  }

  async findByApiKeyHash(hash: string): Promise<UserRow | null> {
    const r = await this.db.query<UserRow>(
      'SELECT id, tenant_id, email, role, api_key_hash FROM users WHERE api_key_hash = $1 AND status = \'ACTIVE\' LIMIT 1',
      [hash],
    );
    return r.rows[0] ?? null;
  }
}

// ---------------------------------------------------------------- sources

export interface SourceRow {
  id: string;
  tenant_id: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
}

export class SourceRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(tenantId: string, input: { type: string; name: string; config?: Record<string, unknown> | undefined }): Promise<SourceRow> {
    const r = await this.db.query<SourceRow>(
      `INSERT INTO sources (tenant_id, type, name, config)
       VALUES ($1, $2, $3, COALESCE($4, '{}'::jsonb))
       RETURNING id, tenant_id, type, name, status, config`,
      [tenantId, input.type, input.name, input.config ? JSON.stringify(input.config) : null],
    );
    return r.rows[0] as SourceRow;
  }

  async list(tenantId: string): Promise<SourceRow[]> {
    const r = await this.db.query<SourceRow>(
      'SELECT id, tenant_id, type, name, status, config FROM sources WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return r.rows;
  }

  async findById(tenantId: string, id: string): Promise<SourceRow | null> {
    const r = await this.db.query<SourceRow>(
      'SELECT id, tenant_id, type, name, status, config FROM sources WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }
}

// ---------------------------------------------------------------- taxonomy

export interface TaxonomyNodeRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  node_kind: string;
  slug: string;
  name: string;
  status: string;
}

export class TaxonomyRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(tenantId: string, input: {
    parentId: string | null;
    nodeKind: string;
    name: string;
    slug: string;
  }): Promise<TaxonomyNodeRow> {
    const r = await this.db.query<TaxonomyNodeRow>(
      `INSERT INTO taxonomy_nodes (tenant_id, parent_id, node_kind, name, slug)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, parent_id, node_kind, slug, name, status`,
      [tenantId, input.parentId, input.nodeKind, input.name, input.slug],
    );
    return r.rows[0] as TaxonomyNodeRow;
  }

  async list(tenantId: string, nodeKind?: string): Promise<TaxonomyNodeRow[]> {
    if (nodeKind !== undefined) {
      const r = await this.db.query<TaxonomyNodeRow>(
        'SELECT id, tenant_id, parent_id, node_kind, slug, name, status FROM taxonomy_nodes WHERE tenant_id = $1 AND node_kind::text = $2 ORDER BY created_at',
        [tenantId, nodeKind],
      );
      return r.rows;
    }
    const r = await this.db.query<TaxonomyNodeRow>(
      'SELECT id, tenant_id, parent_id, node_kind, slug, name, status FROM taxonomy_nodes WHERE tenant_id = $1 ORDER BY created_at',
      [tenantId],
    );
    return r.rows;
  }
}

// ---------------------------------------------------------------- businesses + leads

export interface LeadRow {
  id: string;
  tenant_id: string;
  business_id: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

export class LeadRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Creates Business + Lead in one transaction. Status is the DB-enforced
   * lifecycle enum ('DISCOVERED' start).
   */
  async createWithBusiness(tenantId: string, input: {
    businessName: string;
    businessTypeId?: string | null;
    industryId?: string | null;
    sourceId: string;
    externalId: string;
    username?: string | null;
    profileUrl?: string | null;
  }): Promise<LeadRow> {
    return this.db.transaction(async (client) => {
      const biz = await client.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, canonical_name, business_type_node_id, industry_node_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, input.businessName, input.businessTypeId ?? null, input.industryId ?? null],
      );
      const businessId = biz.rows[0]!.id;
      const lead = await client.query<LeadRow>(
        `INSERT INTO leads (tenant_id, business_id, status) VALUES ($1, $2, 'DISCOVERED')
         RETURNING id, tenant_id, business_id, status, first_seen_at, last_seen_at`,
        [tenantId, businessId],
      );
      await client.query(
        `INSERT INTO lead_identities (lead_id, source_id, external_id, username, profile_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [lead.rows[0]!.id, input.sourceId, input.externalId, input.username ?? null, input.profileUrl ?? null],
      );
      return lead.rows[0] as LeadRow;
    });
  }

  async list(tenantId: string, opts: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Promise<LeadRow[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    if (opts.status !== undefined) {
      const r = await this.db.query<LeadRow>(
        `SELECT id, tenant_id, business_id, status, first_seen_at, last_seen_at
         FROM leads WHERE tenant_id = $1 AND status::text = $2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [tenantId, opts.status, limit, offset],
      );
      return r.rows;
    }
    const r = await this.db.query<LeadRow>(
      `SELECT id, tenant_id, business_id, status, first_seen_at, last_seen_at
       FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return r.rows;
  }

  async findById(tenantId: string, id: string): Promise<LeadRow | null> {
    const r = await this.db.query<LeadRow>(
      'SELECT id, tenant_id, business_id, status, first_seen_at, last_seen_at FROM leads WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }
}

// ---------------------------------------------------------------- campaigns

export interface CampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  filters: Record<string, unknown>;
}

export class CampaignRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(tenantId: string, input: { name: string; filters?: Record<string, unknown> | undefined }): Promise<CampaignRow> {
    const r = await this.db.query<CampaignRow>(
      `INSERT INTO campaigns (tenant_id, name, filters) VALUES ($1, $2, COALESCE($3, '{}'::jsonb))
       RETURNING id, tenant_id, name, status, filters`,
      [tenantId, input.name, input.filters ? JSON.stringify(input.filters) : null],
    );
    return r.rows[0] as CampaignRow;
  }

  async list(tenantId: string): Promise<CampaignRow[]> {
    const r = await this.db.query<CampaignRow>(
      'SELECT id, tenant_id, name, status, filters FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return r.rows;
  }

  async findById(tenantId: string, id: string): Promise<CampaignRow | null> {
    const r = await this.db.query<CampaignRow>(
      'SELECT id, tenant_id, name, status, filters FROM campaigns WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }
}

// ---------------------------------------------------------------- jobs (persistent source of truth)

export interface JobRow {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  priority: number;
  progress: number;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  correlation_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export type JobTypeValue =
  | 'DISCOVERY' | 'NORMALIZATION' | 'DEDUP' | 'ANALYSIS' | 'SCORING' | 'EXPORT' | 'REPROCESS' | 'OUTREACH';

export class JobRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(tenantId: string, input: {
    type: JobTypeValue;
    payload?: Record<string, unknown> | undefined;
    priority?: number | undefined;
    correlationId?: string | undefined;
  }): Promise<JobRow> {
    const r = await this.db.query<JobRow>(
      `INSERT INTO jobs (tenant_id, type, payload, priority, correlation_id)
       VALUES ($1, $2, COALESCE($3, '{}'::jsonb), COALESCE($4, 0), $5)
       RETURNING id, tenant_id, type, status, priority, progress, payload,
                 attempt_count, max_attempts, error_code, error_message,
                 correlation_id, created_at, completed_at`,
      [tenantId, input.type, input.payload ? JSON.stringify(input.payload) : null, input.priority ?? 0, input.correlationId ?? null],
    );
    return r.rows[0] as JobRow;
  }

  /** Marks RUNNING exactly once; returns false if another worker took it. */
  async claimForRun(jobId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE jobs SET status = 'RUNNING', started_at = now(),
              attempt_count = attempt_count + 1
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id`,
      [jobId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markSucceeded(jobId: string, progress = 100): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'SUCCEEDED', progress = $2, completed_at = now() WHERE id = $1`,
      [jobId, progress],
    );
  }

  async markFailed(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'FAILED', error_code = $2, error_message = $3, failed_at = now() WHERE id = $1`,
      [jobId, errorCode, errorMessage],
    );
  }

  async findById(tenantId: string, id: string): Promise<JobRow | null> {
    const r = await this.db.query<JobRow>(
      `SELECT id, tenant_id, type, status, priority, progress, payload,
              attempt_count, max_attempts, error_code, error_message,
              correlation_id, created_at, completed_at
       FROM jobs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return r.rows[0] ?? null;
  }

  async list(tenantId: string, opts: { status?: string | undefined; limit?: number | undefined } = {}): Promise<JobRow[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    if (opts.status !== undefined) {
      const r = await this.db.query<JobRow>(
        `SELECT id, tenant_id, type, status, priority, progress, payload,
                attempt_count, max_attempts, error_code, error_message,
                correlation_id, created_at, completed_at
         FROM jobs WHERE tenant_id = $1 AND status::text = $2 ORDER BY created_at DESC LIMIT $3`,
        [tenantId, opts.status, limit],
      );
      return r.rows;
    }
    const r = await this.db.query<JobRow>(
      `SELECT id, tenant_id, type, status, priority, progress, payload,
              attempt_count, max_attempts, error_code, error_message,
              correlation_id, created_at, completed_at
       FROM jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows;
  }

  async appendEvent(jobId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.db.query(
      'INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, $2, $3::jsonb)',
      [jobId, eventType, JSON.stringify(payload)],
    );
  }
}
