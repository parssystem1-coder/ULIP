/**
 * Raw snapshot persistence (Phase 15) against raw_entities/raw_entity_currents.
 *
 * Raw data is NEVER rewritten: each distinct (source_id, external_id,
 * content_hash) triple is one immutable row (DB-enforced). Re-ingesting an
 * identical payload is a no-op (unchanged); a changed payload appends a NEW
 * revision and moves the current pointer. Provenance = source_id + collected_at
 * + payload, preserved verbatim.
 */

import { createHash } from 'node:crypto';
import { Database } from '@ulip/runtime';
import type { RawEntityStore, RawSnapshot, SourceRecord } from './contracts.ts';

export interface RawEntityRow {
  id: string;
  source_id: string;
  external_id: string;
  entity_type: string;
  payload_json: Record<string, unknown>;
  content_hash: string;
  revision: number;
  ingest_status: string;
  collected_at: string;
}

export class DbRawEntityStore implements RawEntityStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async persist(
    source: SourceRecord,
    entity: {
      sourceType: string;
      externalId: string;
      entityType: string;
      payload: Record<string, unknown>;
      collectedAt: string;
    },
  ): Promise<RawSnapshot> {
    const contentHash = createHash('sha256')
      .update(JSON.stringify(entity.payload))
      .digest('hex');

    // Immutable append; a repeat of the exact same payload is ignored by the
    // unique constraint (source_id, external_id, content_hash).
    const inserted = await this.db.query<RawEntityRow>(
      `INSERT INTO raw_entities
         (source_id, external_id, entity_type, payload_json, content_hash, ingest_status, collected_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'PROCESSED', $6)
       ON CONFLICT (source_id, external_id, content_hash) DO NOTHING
       RETURNING id, revision`,
      [source.id, entity.externalId, entity.entityType, JSON.stringify(entity.payload), contentHash, entity.collectedAt],
    );

    if ((inserted.rowCount ?? 0) > 0 && inserted.rows[0] !== undefined) {
      const row = inserted.rows[0];
      await this.db.query(
        `INSERT INTO raw_entity_currents (source_id, external_id, raw_entity_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_id, external_id)
         DO UPDATE SET raw_entity_id = EXCLUDED.raw_entity_id, updated_at = now()`,
        [source.id, entity.externalId, row.id],
      );
      return { id: row.id, isNewRevision: true };
    }

    // Identical snapshot already stored — resolve its id for provenance.
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM raw_entities WHERE source_id = $1 AND external_id = $2 AND content_hash = $3`,
      [source.id, entity.externalId, contentHash],
    );
    return { id: existing.rows[0]!.id, isNewRevision: false };
  }

  async countForSource(tenantId: string, sourceId: string): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM raw_entities re
       JOIN sources s ON s.id = re.source_id
       WHERE s.tenant_id = $1 AND re.source_id = $2`,
      [tenantId, sourceId],
    );
    return Number(r.rows[0]?.n ?? '0');
  }
}
