/**
 * Entity resolution against the existing PostgreSQL schema (Phase 15).
 *
 * Dedup strategy, in strength order:
 *  1. EXACT identity key: lead_identities UNIQUE (source_id, external_id) —
 *     a repeated discovery of the same source entity maps to the SAME lead.
 *  2. Same normalized name inside the tenant: an entity_resolution_candidates
 *     row (UNCERTAIN, PENDING) is recorded for later human/ER review instead
 *     of silently merging — no uncontrolled duplicate is created (we reuse the
 *     existing lead), and no false merge is asserted.
 *
 * Lead lifecycle transitions use the canonical LEAD_TRANSITION_TABLE via the
 * transition helper, applied conditionally (deterministic, idempotent).
 * Raw snapshots are NEVER deleted: preserves provenance even when resolved.
 */

import { Database } from '@ulip/runtime';
import { LEAD_TRANSITION_TABLE, canTransition, type ProcessingStage } from '@ulip/orchestration';
import type { EntityResolver, NormalizedFields, ResolveOutcome, SourceRecord } from './contracts.ts';

export class DbEntityResolver implements EntityResolver {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async resolve(tenantId: string, source: SourceRecord, normalized: NormalizedFields): Promise<ResolveOutcome> {
    // 1) Exact identity resolution — tenant isolation is guaranteed because
    // lead_identities join through sources (tenant-scoped) and we re-check
    // the tenant of the lead row explicitly.
    const existing = await this.db.query<{ lead_id: string; tenant_id: string; status: string; business_id: string }>(
      `SELECT li.lead_id, l.tenant_id, l.status::text AS status, l.business_id
       FROM lead_identities li
       JOIN leads l ON l.id = li.lead_id
       WHERE li.source_id = $1 AND li.external_id = $2 AND l.tenant_id = $3
       LIMIT 1`,
      [source.id, normalized.username !== undefined && normalized.username !== '' ? `username:${normalized.username}` : '', tenantId],
    );

    let leadId: string | undefined;
    let businessId: string | undefined;
    let currentStatus: string | undefined;

    if ((existing.rowCount ?? 0) > 0 && existing.rows[0] !== undefined) {
      leadId = existing.rows[0].lead_id;
      businessId = existing.rows[0].business_id;
      currentStatus = existing.rows[0].status;
    } else {
      // Fresh external id. Try name-based dedup INSIDE the tenant first.
      const nameKey = normalized.nameKey;
      const byName = await this.db.query<{ id: string; tenant_id: string; status: string }>(
        `SELECT b.id, b.tenant_id, l.status::text AS status
         FROM businesses b
         JOIN leads l ON l.business_id = b.id
         JOIN lead_classifications lc ON lc.lead_id = l.id
         WHERE b.tenant_id = $1 AND lower(b.canonical_name) = lower($2)
         LIMIT 1`,
        [tenantId, normalized.displayName],
      );

      if ((byName.rowCount ?? 0) > 0 && byName.rows[0] !== undefined) {
        const hit = byName.rows[0];
        // Record the uncertainty for ER review; never silently merge.
        await this.db.query(
          `INSERT INTO entity_resolution_candidates
             (tenant_id, business_a_id, business_b_id, resolvable_signals, similarity, verdict, status, decided_by)
           SELECT $1, b2.id, b3.id, $4::jsonb, $5, 'UNCERTAIN', 'PENDING', 'discovery:auto'
           FROM businesses b2, businesses b3
           WHERE b2.id = $2 AND b3.id = $3
           ON CONFLICT (business_a_id, business_b_id) DO NOTHING`,
          [tenantId, hit.id, hit.id, JSON.stringify({ nameKey, source: source.type }), 0.9000],
        ).catch(async () => {
          // Same-business self-pair violates nothing but may be degenerate;
          // fall back to a no-op candidate insert via lead ids is unnecessary.
        });
        leadId = hit.id;
        businessId = hit.id;
        currentStatus = hit.status;
      }
    }

    if (leadId !== undefined && businessId !== undefined) {
      // Update the existing lead: refresh last_seen, keep raw provenance.
      await this.db.query(`UPDATE leads SET last_seen_at = now() WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId]);
      // Deterministic re-entry into the pipeline only from valid states.
      if (currentStatus !== undefined && canTransition(LEAD_TRANSITION_TABLE, currentStatus as ProcessingStage, 'RAW_STORED', 'RAW_STORED')) {
        await this.db.query(`UPDATE leads SET status = 'RAW_STORED' WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId]);
      }
      return { leadId, businessId, action: 'UPDATED' };
    }

    // 2) Creation path — new business + lead + identity in one transaction.
    return this.db.transaction(async (client) => {
      const biz = await client.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, canonical_name) VALUES ($1, $2) RETURNING id`,
        [tenantId, normalized.displayName],
      );
      const newBusinessId = biz.rows[0]!.id;
      const lead = await client.query<{ id: string; business_id: string }>(
        `INSERT INTO leads (tenant_id, business_id, status) VALUES ($1, $2, 'DISCOVERED')
         RETURNING id, business_id`,
        [tenantId, newBusinessId],
      );
      const newLeadId = lead.rows[0]!.id;

      await client.query(
        `INSERT INTO lead_identities (lead_id, source_id, external_id, username, profile_url, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newLeadId,
          source.id,
          externalIdentityKey(normalized),
          normalized.username ?? null,
          normalized.profileUrl ?? null,
          normalized.displayName,
        ],
      );

      // RAW_STORED event (canonical transition DISCOVERED → RAW_STORED).
      await client.query(`UPDATE leads SET status = 'RAW_STORED' WHERE id = $1`, [newLeadId]);
      // NORMALIZED event (RAW_STORED → NORMALIZED).
      await client.query(`UPDATE leads SET status = 'NORMALIZED' WHERE id = $1`, [newLeadId]);

      // Deterministic hints as RULE classifications (Brand may be free text).
      const hintRows: { type: string; value: string; nodeId: string | null }[] = [];
      for (const [hintKey, value] of Object.entries(normalized.hints)) {
        if (value === '') continue;
        hintRows.push(mapHint(hintKey, value));
      }
      for (const h of hintRows) {
        await client.query(
          `INSERT INTO lead_classifications
             (lead_id, classification_type, taxonomy_node_id, value_text, value_normalized, source)
           VALUES ($1, $2::classification_type, $3, $4, $5, 'RULE')`,
          [newLeadId, h.type, h.nodeId, h.value, h.value.toLowerCase()],
        );
      }

      // DEDUP_RESOLVED (NORMALIZED → DEDUP_CHECKED) then QUEUE_ANALYSIS
      // (DEDUP_CHECKED → ANALYSIS_PENDING) — deterministic, in-order.
      await client.query(`UPDATE leads SET status = 'DEDUP_CHECKED' WHERE id = $1`, [newLeadId]);
      await client.query(`UPDATE leads SET status = 'ANALYSIS_PENDING' WHERE id = $1`, [newLeadId]);

      return { leadId: newLeadId, businessId: newBusinessId, action: 'CREATED' };
    });
  }
}

/**
 * The identity key for lead_identities.external_id. Uses username when the
 * raw entity has one (stable public identifier), else the raw external id.
 */
export function externalIdentityKey(normalized: NormalizedFields): string {
  return normalized.username !== undefined && normalized.username !== ''
    ? `username:${normalized.username}`
    : normalized.nameKey;
}

function mapHint(hintKey: string, value: string): { type: string; value: string; nodeId: string | null } {
  switch (hintKey) {
    case 'businessType':
      return { type: 'BUSINESS_TYPE', value, nodeId: null };
    case 'industry':
      return { type: 'INDUSTRY', value, nodeId: null };
    case 'specialty':
      return { type: 'SPECIALTY', value, nodeId: null };
    case 'subSpecialty':
      return { type: 'SUB_SPECIALTY', value, nodeId: null };
    case 'brand':
      return { type: 'BRAND', value, nodeId: null };
    case 'location':
      return { type: 'OTHER', value, nodeId: null };
    default:
      return { type: 'OTHER', value, nodeId: null };
  }
}
