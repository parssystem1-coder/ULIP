/**
 * Persistent hashtag budget (Phase 21).
 *
 * Meta's official Hashtag Search quota: 30 UNIQUE hashtags per querying
 * professional account per ROLLING 7-day window. Re-querying a tag that was
 * already queried inside the window does NOT consume quota (documented).
 *
 * The budget is enforced IN THE DATABASE: the consuming INSERT transaction
 * counts ledger rows inside the rolling window and refuses the spend when the
 * cap is reached. Two concurrent jobs therefore can never both spend past the
 * cap — the DB is the arbiter, not process memory (the worker may restart;
 * memory may not). The connector's in-process RollingWindowQuota stays as a
 * second defensive layer.
 *
 * Tenant isolation is unconditional: every query carries tenant_id and
 * source_id; all values travel as bound parameters.
 */

import type { Database } from '@ulip/runtime';

/** Default official quota: 30 unique hashtags / rolling 7 days (Meta docs). */
export const DEFAULT_HASHTAG_BUDGET_PER_7D = 30;

const WINDOW_DAYS = 7;

/**
 * Normalizes a hashtag for budget identity: ZWNJ/space variants collapse,
 * leading '##' prefixes are stripped (after trimming, so they are truly
 * leading), repeats collapse to one tag. This MUST stay consistent with the
 * connector's in-process quota identity and with candidate generation.
 */
export function normalizeHashtag(raw: string): string {
  return raw
    .trim()
    .replace(/[\u200c\u0640\s]+/g, '_') // ZWNJ, kashida, whitespace → underscore
    .replace(/^#+/, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Read-only budget snapshot for DiscoveryPlan reporting (Phase 21). */
export interface HashtagBudgetSnapshot {
  used: number;
  budget: number;
  remaining: number;
}

export interface HashtagSpendResult {
  /** true = the tag was admitted under the cap (or reused within the window). */
  admitted: boolean;
  /** true when this query reused a tag already queried inside the window (no quota consumed). */
  reused: boolean;
  /** Unique tags consumed by this tenant+source inside the window AFTER the call. */
  usedInWindow: number;
  budget: number;
  /** Machine-readable refusal reason when admitted === false. */
  reason?: 'HASHTAG_BUDGET_EXHAUSTED' | undefined;
}

export interface HashtagBudgetStore {
  /** Attemps to spend one hashtag query for (tenant, source). */
  spend(input: { tenantId: string; sourceId: string; hashtag: string; jobId?: string | undefined; budget?: number | undefined }): Promise<HashtagSpendResult>;
  /** Read-only snapshot for DiscoveryPlan budget reporting. */
  usage(tenantId: string, sourceId: string, budget?: number | undefined): Promise<{ used: number; budget: number; remaining: number }>;
}

export class DbHashtagBudgetStore implements HashtagBudgetStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async spend(input: {
    tenantId: string;
    sourceId: string;
    hashtag: string;
    jobId?: string | undefined;
    budget?: number | undefined;
  }): Promise<HashtagSpendResult> {
    const budget = input.budget ?? DEFAULT_HASHTAG_BUDGET_PER_7D;
    const tag = normalizeHashtag(input.hashtag);
    if (tag === '') {
      return { admitted: false, reused: false, usedInWindow: 0, budget, reason: 'HASHTAG_BUDGET_EXHAUSTED' };
    }

    // One transaction decides: reuse → free; window count < cap → insert new row.
    // A transaction-scoped advisory lock on (tenant, source) serializes
    // concurrent spenders for the same professional account, so two jobs can
    // never both pass the cap check (the count + insert pair is atomic under
    // the lock). Reuse of an already-queried tag is free (documented behavior).
    const result = await this.db.transaction(async (tx) => {
      // Hash (tenantId, sourceId) into a single bigint key for the advisory lock.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`,
        [input.tenantId, input.sourceId],
      );
      const reuse = await tx.query<{ queried_at: string | Date }>(
        `SELECT queried_at FROM hashtag_budget_ledger
         WHERE tenant_id = $1 AND source_id = $2 AND hashtag = $3
           AND queried_at >= now() - interval '${WINDOW_DAYS} days'
         ORDER BY queried_at DESC LIMIT 1`,
        [input.tenantId, input.sourceId, tag],
      );
      if (reuse.rows.length > 0) {
        const used = await this.countWindow(tx, input.tenantId, input.sourceId);
        return { admitted: true, reused: true, usedInWindow: used, budget } satisfies HashtagSpendResult;
      }

      const used = await this.countWindow(tx, input.tenantId, input.sourceId);
      if (used >= budget) {
        return { admitted: false, reused: false, usedInWindow: used, budget, reason: 'HASHTAG_BUDGET_EXHAUSTED' } satisfies HashtagSpendResult;
      }

      await tx.query(
        `INSERT INTO hashtag_budget_ledger (tenant_id, source_id, hashtag, job_id)
         VALUES ($1, $2, $3, $4)`,
        [input.tenantId, input.sourceId, tag, input.jobId ?? null],
      );
      return { admitted: true, reused: false, usedInWindow: used + 1, budget } satisfies HashtagSpendResult;
    });
    return result;
  }

  async usage(tenantId: string, sourceId: string, budget?: number | undefined): Promise<HashtagBudgetSnapshot> {
    const b = budget ?? DEFAULT_HASHTAG_BUDGET_PER_7D;
    const used = await this.db.transaction(async (tx) => this.countWindow(tx, tenantId, sourceId));
    return { used, budget: b, remaining: Math.max(0, b - used) };
  }

  private async countWindow(
    tx: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
    tenantId: string,
    sourceId: string,
  ): Promise<number> {
    const r = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT hashtag)::int AS n FROM hashtag_budget_ledger
       WHERE tenant_id = $1 AND source_id = $2
         AND queried_at >= now() - interval '${WINDOW_DAYS} days'`,
      [tenantId, sourceId],
    );
    return r.rows[0]?.n ?? 0;
  }
}
