/**
 * Controllers (Phase 14). Thin: validate input, delegate to repositories /
 * job persistence, map to the OpenAPI contract shapes. NO domain logic.
 *
 * Job flow: a POST that starts work persists the Job row FIRST (source of
 * truth) and returns 202 + Job; the worker is notified through BullMQ and
 * claims the row via `claimForRun` (DB stays authoritative).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from './composer.ts';
import { errorReply, jsonReply, readJsonBody, type RequestContext } from './http.ts';
import type { AuthenticatedContext } from './middleware.ts';

// ------------------------------------------------------------- health/ready

export function healthHandler(app: AppContext) {
  return (ctx: RequestContext): void => {
    jsonReply(ctx, 200, { status: 'UP' });
  };
}

export function readyHandler(app: AppContext) {
  return async (ctx: RequestContext): Promise<void> => {
    const checks: Record<string, boolean> = {};
    let ok = true;
    try {
      await app.db.query('SELECT 1');
      checks.postgres = true;
    } catch {
      checks.postgres = false;
      ok = false;
    }
    if (ok) jsonReply(ctx, 200, { status: 'UP', checks });
    else jsonReply(ctx, 503, { status: 'DOWN', checks });
  };
}

// ------------------------------------------------------------- validation schemas

const CreateSourceSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const CreateTaxonomySchema = z.object({
  nodeKind: z.enum(['BUSINESS_TYPE', 'INDUSTRY', 'SPECIALTY', 'SUB_SPECIALTY']),
  name: z.string().min(1),
  slug: z.string().min(1),
  parentId: z.string().uuid().nullable().optional(),
});

const CreateLeadSchema = z.object({
  businessName: z.string().min(1),
  sourceId: z.string().uuid(),
  externalId: z.string().min(1),
  businessTypeId: z.string().uuid().nullable().optional(),
  industryId: z.string().uuid().nullable().optional(),
  username: z.string().nullable().optional(),
  profileUrl: z.string().nullable().optional(),
});

const CreateCampaignSchema = z.object({
  name: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).optional(),
});

const CreateJobSchema = z.object({
  type: z.enum(['DISCOVERY', 'NORMALIZATION', 'DEDUP', 'ANALYSIS', 'SCORING', 'EXPORT', 'REPROCESS', 'OUTREACH']),
  payload: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

/**
 * DiscoveryRequest per OPENAPI.yaml: sourceId + query + filters + maxCandidates.
 * Business-model fields (businessType/industry/specialty/subSpecialty/brand/
 * location) ride in `filters` as strings — the universal model is preserved.
 */
const DiscoverySearchSchema = z.object({
  sourceId: z.string().uuid(),
  query: z.string().max(500).optional(),
  filters: z.record(z.string(), z.string()).optional(),
  maxCandidates: z.number().int().min(1).max(10000).optional(),
  cursor: z.string().max(500).optional(),
  /** Local E2E only: explicitly allow the deterministic fake provider. */
  allowFake: z.boolean().optional(),
});

/**
 * Bootstrap (dev/smoke only): creates a tenant + user with an API key.
 * Guarded by the shared BOOTSTRAP_API_KEY, not by a user key.
 */
const BootstrapSchema = z.object({
  tenantName: z.string().min(1),
  userEmail: z.string().email(),
  apiKey: z.string().min(16),
});

export function bootstrapHandler(app: AppContext) {
  return async (ctx: RequestContext): Promise<void> => {
    const provided = ctx.headers.authorization;
    if (provided !== `Bearer ${app.env.BOOTSTRAP_API_KEY}`) {
      return errorReply(ctx, 401, 'UNAUTHORIZED', 'bootstrap requires the bootstrap key');
    }
    const parsed = BootstrapSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    const hash = createHash('sha256').update(parsed.data.apiKey, 'utf8').digest('hex');
    const tenant = await app.tenants.create(parsed.data.tenantName);
    const user = await app.users.create({ tenantId: tenant.id, email: parsed.data.userEmail, apiKeyHash: hash });
    jsonReply(ctx, 201, { tenantId: tenant.id, userId: user.id, apiKey: parsed.data.apiKey });
  };
}

function validationError(ctx: RequestContext, err: z.ZodError): void {
  errorReply(ctx, 400, 'VALIDATION_FAILED', 'request validation failed', {
    fields: err.issues.map((i) => ({ field: i.path.join('.') || '(root)', issue: i.message })),
  });
}

// ------------------------------------------------------------- sources

export function listSources(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const rows = await app.sources.list(ctx.principal.tenantId);
    jsonReply(ctx, 200, { data: rows });
  };
}

export function createSource(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const parsed = CreateSourceSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    const row = await app.sources.create(ctx.principal.tenantId, {
      type: parsed.data.type,
      name: parsed.data.name,
      config: parsed.data.config,
    });
    jsonReply(ctx, 201, row);
  };
}

// ------------------------------------------------------------- taxonomy

export function listTaxonomy(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const kind = ctx.query.get('nodeKind') ?? undefined;
    const rows = await app.taxonomy.list(ctx.principal.tenantId, kind);
    jsonReply(ctx, 200, { data: rows });
  };
}

export function createTaxonomy(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const parsed = CreateTaxonomySchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    try {
      const row = await app.taxonomy.create(ctx.principal.tenantId, {
        parentId: parsed.data.parentId ?? null,
        nodeKind: parsed.data.nodeKind,
        name: parsed.data.name,
        slug: parsed.data.slug,
      });
      jsonReply(ctx, 201, row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('taxonomy parent kind mismatch') || msg.includes('uniq_taxonomy')) {
        return errorReply(ctx, 409, 'CONFLICT', msg);
      }
      throw err;
    }
  };
}

// ------------------------------------------------------------- leads

export function listLeads(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const status = ctx.query.get('status') ?? undefined;
    const limit = Number(ctx.query.get('limit') ?? '50');
    const offset = Number(ctx.query.get('offset') ?? '0');
    const rows = await app.leads.list(ctx.principal.tenantId, {
      status,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    jsonReply(ctx, 200, { data: rows, pagination: { limit, offset } });
  };
}

export function createLead(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const parsed = CreateLeadSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    const source = await app.sources.findById(ctx.principal.tenantId, parsed.data.sourceId);
    if (source === null) return errorReply(ctx, 404, 'NOT_FOUND', 'source not found in tenant');
    const row = await app.leads.createWithBusiness(ctx.principal.tenantId, {
      businessName: parsed.data.businessName,
      businessTypeId: parsed.data.businessTypeId ?? null,
      industryId: parsed.data.industryId ?? null,
      sourceId: parsed.data.sourceId,
      externalId: parsed.data.externalId,
      username: parsed.data.username ?? null,
      profileUrl: parsed.data.profileUrl ?? null,
    });
    jsonReply(ctx, 201, row);
  };
}

// ------------------------------------------------------------- campaigns

export function listCampaigns(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const rows = await app.campaigns.list(ctx.principal.tenantId);
    jsonReply(ctx, 200, { data: rows });
  };
}

export function createCampaign(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const parsed = CreateCampaignSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    const row = await app.campaigns.create(ctx.principal.tenantId, {
      name: parsed.data.name,
      filters: parsed.data.filters,
    });
    jsonReply(ctx, 201, row);
  };
}

// ------------------------------------------------------------- jobs

export function listJobs(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const status = ctx.query.get('status') ?? undefined;
    const limit = Number(ctx.query.get('limit') ?? '50');
    const rows = await app.jobs.list(ctx.principal.tenantId, {
      status,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    jsonReply(ctx, 200, { data: rows });
  };
}

export function getJob(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const id = (ctx as unknown as { params: Record<string, string> }).params['jobId'] ?? '';
    const row = await app.jobs.findById(ctx.principal.tenantId, id);
    if (row === null) return errorReply(ctx, 404, 'NOT_FOUND', 'job not found in tenant');
    jsonReply(ctx, 200, row);
  };
}

export function createJob(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const parsed = CreateJobSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);
    // Persist FIRST (DB = source of truth, ADR-016); worker runs it via BullMQ.
    const row = await app.jobs.create(ctx.principal.tenantId, {
      type: parsed.data.type,
      payload: parsed.data.payload,
      priority: parsed.data.priority,
    });
    await app.jobs.appendEvent(row.id, 'STATUS', { status: 'PENDING' });
    // DB is the source of truth; enqueue only AFTER the row is durable.
    // If Redis is down the row stays PENDING and is re-driven on recovery.
    let transport: { enqueued: boolean; bullJobId?: string | undefined } = { enqueued: false };
    try {
      const bull = await app.queue.add({ jobId: row.id, ...({ priority: parsed.data.priority } as const) });
      transport = { enqueued: true, bullJobId: bull.id };
    } catch (err) {
      app.log.warn('job persisted but not enqueued (redis unavailable?)', {
        jobId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    jsonReply(ctx, 202, { ...row, transport });
  };
}

// ------------------------------------------------------------- discovery (Phase 15)

/**
 * Idempotent discovery submission per OPENAPI.yaml POST /discovery/search:
 * requires an Idempotency-Key header; same (tenant, scope, key, requestHash)
 * returns the ORIGINAL job instead of creating a duplicate.
 */
export function createDiscovery(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const idemKey = (ctx.headers['idempotency-key'] as string | undefined) ?? '';
    if (idemKey === '') {
      return errorReply(ctx, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const parsed = DiscoverySearchSchema.safeParse(ctx.body);
    if (!parsed.success) return validationError(ctx, parsed.error);

    const tenantId = ctx.principal.tenantId;
    const scope = 'discovery.search';
    const requestHash = createHash('sha256')
      .update(JSON.stringify(parsed.data))
      .digest('hex');

    // Replay path: same tenant+scope+key returns the original job.
    const existing = await app.db.query<{ response_snapshot: { jobId?: string } | null; status: string }>(
      `SELECT response_snapshot, status FROM idempotency_keys
       WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [tenantId, scope, idemKey],
    );
    if ((existing.rowCount ?? 0) > 0 && existing.rows[0] !== undefined) {
      const snapshotJobId = existing.rows[0].response_snapshot?.['jobId'];
      if (existing.rows[0].status === 'COMPLETED' && typeof snapshotJobId === 'string') {
        const job = await app.jobs.findById(tenantId, snapshotJobId);
        if (job !== null) return jsonReply(ctx, 202, { ...job, replayed: true });
      }
      if (existing.rows[0].status === 'IN_FLIGHT') {
        return errorReply(ctx, 409, 'IDEMPOTENCY_IN_FLIGHT', 'an identical discovery request is still in flight');
      }
      // FAILED: fall through and allow a fresh submission with the same key.
      await app.db.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`, [
        tenantId,
        scope,
        idemKey,
      ]);
    }

    // Source must exist in THIS tenant (capability/permission boundary).
    const source = await app.sources.findById(tenantId, parsed.data.sourceId);
    if (source === null) {
      return errorReply(ctx, 404, 'NOT_FOUND', 'source not found in tenant');
    }
    if (source.status !== 'ACTIVE') {
      return errorReply(ctx, 409, 'SOURCE_NOT_ACTIVE', `source status is ${source.status}; discovery requires ACTIVE`);
    }

    const { allowFake: _allowFake, ...request } = parsed.data;
    const payload: Record<string, unknown> = { ...request };
    if (parsed.data.allowFake === true) payload['allowFake'] = true;

    // Reserve the idempotency key IN_FLIGHT first (unique constraint arbitrates).
    try {
      await app.db.query(
        `INSERT INTO idempotency_keys (tenant_id, scope, idempotency_key, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, 'IN_FLIGHT', now() + interval '24 hours')`,
        [tenantId, scope, idemKey, requestHash],
      );
    } catch {
      return errorReply(ctx, 409, 'IDEMPOTENCY_IN_FLIGHT', 'an identical discovery request is still in flight');
    }

    const job = await app.jobs.create(tenantId, {
      type: 'DISCOVERY',
      payload,
      correlationId: ctx.requestId,
    });
    await app.jobs.appendEvent(job.id, 'STATUS', { status: 'PENDING' });
    await app.db.query(
      `UPDATE idempotency_keys SET status = 'COMPLETED', response_snapshot = $4::jsonb
       WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [tenantId, scope, idemKey, JSON.stringify({ jobId: job.id })],
    );

    let transport: { enqueued: boolean; bullJobId?: string | undefined } = { enqueued: false };
    try {
      const bull = await app.queue.add({ jobId: job.id });
      transport = { enqueued: true, bullJobId: bull.id };
    } catch (err) {
      app.log.warn('discovery job persisted but not enqueued (redis unavailable?)', {
        jobId: job.id,
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    app.log.info('discovery job created', {
      requestId: ctx.requestId,
      tenantId,
      jobId: job.id,
      sourceId: parsed.data.sourceId,
    });
    jsonReply(ctx, 202, { ...job, transport });
  };
}

export function getDiscoveryJob(app: AppContext) {
  return async (ctx: AuthenticatedContext): Promise<void> => {
    const id = (ctx as unknown as { params: Record<string, string> }).params['jobId'] ?? '';
    const row = await app.jobs.findById(ctx.principal.tenantId, id);
    if (row === null || row.type !== 'DISCOVERY') {
      return errorReply(ctx, 404, 'NOT_FOUND', 'discovery job not found in tenant');
    }
    jsonReply(ctx, 200, row);
  };
}
