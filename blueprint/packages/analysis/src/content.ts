/**
 * Content preprocessing (Phase 18, ADR-030).
 *
 * Deterministic normalization of connector-supplied content metadata into the
 * analysis-side content view. No network, no AI: hashtags/topics are parsed
 * with fixed rules over the text the connector already provided, and Persian
 * variants are canonicalized through @ulip/domain's aliasKey (ADR-019).
 *
 * Content types follow the widened lead_contents CHECK constraint:
 *   TEXT | IMAGE | VIDEO | LINK | METADATA | POST | REEL | CAROUSEL
 *
 * Honesty rules:
 *  - A modality is "available" only when the connector actually supplied the
 *    data for it (caption text, a media reference). Absence is recorded, not
 *    invented: nothing downstream may claim image/video understanding when
 *    only metadata exists.
 *  - Repeated normalization of the same content row yields the same view
 *    (ids and hashes are deterministic → idempotent reprocessing).
 */

import { aliasKey } from '@ulip/domain';
import type { LeadContentContext } from './contracts.ts';
import { sha256Hex } from './ids.ts';

export const CONTENT_TYPES = [
  'TEXT', 'IMAGE', 'VIDEO', 'LINK', 'METADATA', 'POST', 'REEL', 'CAROUSEL',
] as const;
export type AnalysisContentType = (typeof CONTENT_TYPES)[number];

/** Canonical content-type: POST keeps its identity; aliases normalize to it. */
function canonicalContentType(raw: string): AnalysisContentType {
  const key = raw.trim().toUpperCase();
  switch (key) {
    case 'TEXT':
    case 'CAPTION':
      return 'TEXT';
    case 'IMAGE':
      return 'IMAGE';
    case 'VIDEO':
    case 'REEL':
      return 'VIDEO';
    case 'CAROUSEL':
      return 'CAROUSEL';
    case 'LINK':
      return 'LINK';
    case 'METADATA':
      return 'METADATA';
    default:
      return 'POST';
  }
}

export interface ContentModalityAvailability {
  text: boolean;
  image: boolean;
  video: boolean;
}

export interface NormalizedContent {
  /** lead_contents.id — the stable source content reference. */
  contentId: string;
  /** Canonical content type (POST/TEXT/IMAGE/VIDEO/CAROUSEL/LINK/METADATA). */
  contentType: AnalysisContentType;
  /** Original connector-side type string (provenance, never rewritten). */
  rawContentType: string;
  text: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  /** Hashtags parsed from the caption text, normalized (no duplicates), in first-seen order. */
  hashtags: string[];
  /** Simple topic keys: normalized unigram/bigram tokens above a length floor. */
  topics: string[];
  engagement: {
    likes: number | null;
    comments: number | null;
    views: number | null;
  };
  metadata: Record<string, unknown>;
  /** sha256 of the canonical fields — content version fingerprint. */
  contentHash: string;
  availability: ContentModalityAvailability;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Persian/ZWNJ-aware hashtag extraction: #tag tokens, deduplicated, ordered. */
export function extractHashtags(text: string | null): string[] {
  if (text === null || text.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /#([\p{L}\p{N}_]{2,60})/gu;
  for (const match of text.matchAll(re)) {
    const tag = aliasKey(match[1] ?? '');
    if (tag === '' || tag.length < 2) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Deterministic topic keys for repeated-topic detection: normalized unigrams
 * (≥4 chars, Latin or Persian) plus bigrams. Sorted for stable comparison.
 */
export function extractTopics(text: string | null): string[] {
  if (text === null || text.trim() === '') return [];
  const normalized = aliasKey(text);
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && w.length <= 40);
  const topics = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === undefined) continue;
    topics.add(w);
    const next = words[i + 1];
    if (next !== undefined) topics.add(`${w} ${next}`);
  }
  return [...topics].sort();
}

function modalityAvailability(c: {
  contentType: AnalysisContentType;
  text: string | null;
  mediaUrl: string | null;
}): ContentModalityAvailability {
  const hasText = c.text !== null && c.text.trim() !== '';
  const hasMedia = c.mediaUrl !== null && c.mediaUrl.trim() !== '';
  switch (c.contentType) {
    case 'TEXT':
      return { text: hasText, image: false, video: false };
    case 'IMAGE':
      return { text: hasText, image: hasMedia, video: false };
    case 'VIDEO':
      return { text: hasText, image: false, video: hasMedia };
    case 'CAROUSEL':
      return { text: hasText, image: hasMedia, video: false };
    case 'LINK':
    case 'METADATA':
      return { text: hasText, image: false, video: false };
    case 'POST':
    default:
      return { text: hasText, image: hasMedia, video: false };
  }
}

/** Deterministic content hash over the canonical (non-provenance) fields. */
function contentHashOf(c: {
  contentType: AnalysisContentType;
  text: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
}): string {
  return sha256Hex(
    [c.contentType, c.text ?? '', c.mediaUrl ?? '', c.publishedAt ?? ''].join('|'),
  );
}

/**
 * Normalizes one lead_contents row into the analysis content view.
 * Pure function: same row → same NormalizedContent (idempotent reprocessing).
 */
export function normalizeContent(row: LeadContentContext): NormalizedContent {
  const contentType = canonicalContentType(row.contentType);
  const text = str(row.text);
  const mediaUrl = str(row.mediaUrl);
  const normalized: Omit<NormalizedContent, 'contentHash' | 'availability' | 'topics'> & {
    topics: string[];
  } = {
    contentId: row.id,
    contentType,
    rawContentType: row.contentType,
    text,
    mediaUrl,
    publishedAt: row.publishedAt,
    retrievedAt: row.retrievedAt,
    hashtags: extractHashtags(text),
    topics: [],
    engagement: {
      likes: num(row.metadata['likes']),
      comments: num(row.metadata['comments']),
      views: num(row.metadata['views']),
    },
    metadata: row.metadata,
  };
  normalized.topics = extractTopics(text);
  return {
    ...normalized,
    contentHash: contentHashOf({ contentType, text, mediaUrl, publishedAt: row.publishedAt }),
    availability: modalityAvailability({ contentType, text, mediaUrl }),
  };
}

/** Batch normalization (stable order = input order). */
export function normalizeContents(rows: readonly LeadContentContext[]): NormalizedContent[] {
  return rows.map(normalizeContent);
}
