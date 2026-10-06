/**
 * Content ingestion (Phase 18, ADR-030 §2): connector payloads become
 * first-class lead_contents rows.
 *
 * Posts/captions/media arrive inside the untrusted connector payload. The
 * parser below is deterministic and defensive: it recognizes the common
 * shapes (`posts` / `media` / `contents` arrays) and NEVER invents data —
 * an absent field stays null, an unparseable date stays null, and an
 * unrecognized type falls back to POST (the widest Instagram-style modality).
 *
 * Idempotency: ids are deterministic per (leadId, sourceContentId, hash) and
 * the DB UNIQUE (lead_id, source_content_id, content_hash) keeps historical
 * content immutable — a changed caption appends a NEW version row, a repeat
 * inserts nothing.
 */

import { createHash } from 'node:crypto';
import type { Database } from '@ulip/runtime';
import type { SourceRecord } from './contracts.ts';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic UUID (v5-shaped, same scheme as @ulip/analysis ids.ts). */
export function deterministicUuid(namespace: string, ...parts: string[]): string {
  const h = createHash('sha1').update([namespace, ...parts].join('|'), 'utf8').digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ALLOWED_CONTENT_TYPES = new Set([
  'TEXT', 'IMAGE', 'VIDEO', 'LINK', 'METADATA', 'POST', 'REEL', 'CAROUSEL',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (s === undefined) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Maps connector-side type words onto the widened lead_contents CHECK set. */
export function canonicalContentType(raw: unknown): string {
  const key = (str(raw) ?? '').toUpperCase();
  if (ALLOWED_CONTENT_TYPES.has(key)) return key;
  switch (key) {
    case 'CAPTION':
      return 'TEXT';
    case 'REELS': // Instagram media_product_type
    case 'IG_REEL':
      return 'REEL';
    case 'CAROUSEL_ALBUM':
      return 'CAROUSEL';
    case 'GRAPH_IMAGE':
      return 'IMAGE';
    case 'GRAPH_VIDEO':
      return 'VIDEO';
    default:
      return 'POST';
  }
}

export interface ExtractedContent {
  sourceContentId: string;
  contentType: string;
  text: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
  metadata: Record<string, string | number | boolean | null>;
  /** sha256 over the canonical fields — the content version fingerprint. */
  contentHash: string;
}

function contentHashOf(c: {
  contentType: string;
  text: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
}): string {
  return sha256Hex([c.contentType, c.text ?? '', c.mediaUrl ?? '', c.publishedAt ?? ''].join('|'));
}

/** Hard cap per payload so one huge profile cannot flood the table. */
export const MAX_CONTENT_ITEMS_PER_PAYLOAD = 100;

/**
 * Parses `posts` / `media` / `contents` arrays from a raw connector payload.
 * Order follows the payload order; duplicates by sourceContentId collapse to
 * the first occurrence (repeats carry no new information).
 */
export function extractContentItems(payload: Record<string, unknown>): ExtractedContent[] {
  const out: ExtractedContent[] = [];
  const seen = new Set<string>();
  for (const key of ['posts', 'media', 'contents']) {
    const arr = payload[key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length && out.length < MAX_CONTENT_ITEMS_PER_PAYLOAD; i++) {
      const entry = arr[i];
      let item: ExtractedContent;
      if (typeof entry === 'string' && entry.trim() !== '') {
        // Bare string post = caption-only text item.
        item = {
          sourceContentId: `${key}-${i}`,
          contentType: 'TEXT',
          text: entry.trim(),
          mediaUrl: null,
          publishedAt: null,
          metadata: { payloadKey: key },
          contentHash: '',
        };
      } else {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const p = entry as Record<string, unknown>;
        const sourceContentId =
          str(p['id']) ?? str(p['source_content_id']) ?? str(p['post_id']) ?? `${key}-${i}`;
        const mediaUrl =
          str(p['media_url']) ?? str(p['image_url']) ?? str(p['thumbnail_url']) ?? null;
        const metadata: Record<string, string | number | boolean | null> = { payloadKey: key };
        const likes = num(p['likes']);
        const comments = num(p['comments']);
        const views = num(p['views']);
        if (likes !== null) metadata['likes'] = likes;
        if (comments !== null) metadata['comments'] = comments;
        if (views !== null) metadata['views'] = views;
        const permalink = str(p['permalink']);
        if (permalink !== undefined) metadata['permalink'] = permalink;
        item = {
          sourceContentId,
          contentType: canonicalContentType(
            p['type'] ?? p['media_type'] ?? p['content_type'] ?? p['media_product_type'],
          ),
          text: str(p['text']) ?? str(p['caption']) ?? str(p['message']) ?? null,
          mediaUrl,
          publishedAt:
            isoDate(p['published_at']) ?? isoDate(p['timestamp']) ?? isoDate(p['taken_at']),
          metadata,
          contentHash: '',
        };
      }
      if (seen.has(item.sourceContentId)) continue;
      seen.add(item.sourceContentId);
      item.contentHash = contentHashOf(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Content ingestion for one lead. Satisfied by DbContentIngestor; unit
 * tests use in-memory fakes (async, batched — called once per item).
 */
export interface ContentIngestor {
  ingestForLead(input: {
    source: SourceRecord;
    leadId: string;
    externalId: string;
    payload: Record<string, unknown>;
    collectedAt: string;
  }): Promise<number>;
}

/**
 * PostgreSQL implementation of the Phase 18 content ingestor contract.
 * Historical content is never overwritten: every version is its own row.
 */
export class DbContentIngestor {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Persists payload-derived content for one lead. Returns the number of NEW
   * rows inserted (repeats insert nothing — idempotent reprocessing).
   */
  async ingestForLead(input: {
    source: SourceRecord;
    leadId: string;
    externalId: string;
    payload: Record<string, unknown>;
    collectedAt: string;
  }): Promise<number> {
    const items = extractContentItems(input.payload);
    let inserted = 0;
    for (const item of items) {
      const id = deterministicUuid(
        'lead-content',
        input.leadId,
        item.sourceContentId,
        item.contentHash,
      );
      const r = await this.db.query(
        `INSERT INTO lead_contents
           (id, lead_id, source_id, source_content_id, content_type, text, media_url,
            published_at, content_hash, retrieved_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11::jsonb)
         ON CONFLICT (lead_id, source_content_id, content_hash) DO NOTHING`,
        [
          id, input.leadId, input.source.id, item.sourceContentId, item.contentType,
          item.text, item.mediaUrl, item.publishedAt, item.contentHash,
          input.collectedAt, JSON.stringify(item.metadata),
        ],
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }
}
