import type { EvidenceType } from '@ulip/domain/contracts';
import type { EvidenceDraft, EvidenceSample, LeadContext } from './contracts.ts';
import { deterministicUuid, sha256Hex } from './ids.ts';

const CONFIDENCE: Record<EvidenceType, number> = {
  PROFILE_METADATA: 0.95,
  BIO_TEXT: 0.95,
  CAPTION_TEXT: 0.9,
  LOCATION_SIGNAL: 0.9,
  CONTENT_METADATA: 0.8,
  ENGAGEMENT_SIGNAL: 0.75,
  IMAGE_OBSERVATION: 0.7,
  MODEL_INFERENCE: 0.6,
  HUMAN_CORRECTION: 1,
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Builds evidence drafts from observed data ONLY. Nothing is inferred here:
 * an absent field simply produces no evidence row (explicitly unavailable).
 * Ids are deterministic per (analysis, type, source ref, content) so a retry
 * of the same job never duplicates rows.
 */
export function buildEvidenceDrafts(
  leadId: string,
  analysisId: string,
  ctx: LeadContext,
  now: Date,
): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  const seen = new Set<string>();
  const nowIso = now.toISOString();

  const push = (
    evidenceType: EvidenceType,
    sourceType: string,
    sourceReference: string,
    content: string | null,
    retrievedAt: string,
    metadata: Record<string, string | number | boolean | null> = {},
  ): void => {
    const key = `${evidenceType}|${sourceReference}`;
    if (seen.has(key)) return;
    seen.add(key);
    const contentHash = sha256Hex(`${evidenceType}|${sourceReference}|${content ?? ''}`);
    drafts.push({
      id: deterministicUuid('evidence', analysisId, evidenceType, sourceReference, contentHash),
      leadId,
      evidenceType,
      sourceType,
      sourceReference,
      content,
      contentHash,
      retrievedAt,
      confidence: CONFIDENCE[evidenceType],
      metadata,
    });
  };

  // 1) Business profile
  const nameText = ctx.business.description
    ? `${ctx.business.canonicalName} — ${ctx.business.description}`
    : ctx.business.canonicalName;
  push('PROFILE_METADATA', 'PLATFORM', `businesses/${ctx.businessId}`, nameText, nowIso, {
    field: 'canonicalName',
  });
  if (ctx.business.website !== null) {
    push('PROFILE_METADATA', 'PLATFORM', `businesses/${ctx.businessId}#website`,
      `website: ${ctx.business.website}`, nowIso, { field: 'website' });
  }

  // 2) Source identities (display name / username / profile url)
  for (const idn of ctx.identities.slice(0, 5)) {
    const parts = [
      idn.displayName !== null ? `name: ${idn.displayName}` : null,
      idn.username !== null ? `username: ${idn.username}` : null,
      idn.profileUrl !== null ? `profile: ${idn.profileUrl}` : null,
    ].filter((p): p is string => p !== null);
    if (parts.length === 0) continue;
    push('PROFILE_METADATA', idn.sourceType,
      `lead_identities/${idn.sourceId}/${idn.externalId}`, parts.join(' | '), nowIso,
      { field: 'identity' });
  }

  // 3) Structured locations (country required by schema → always explicit)
  ctx.locations.slice(0, 5).forEach((loc, i) => {
    push('LOCATION_SIGNAL', 'PLATFORM', `businesses/${ctx.businessId}#location-${i}`,
      loc.rawValue, nowIso, { country: loc.country, city: loc.city, availability: loc.availability });
  });

  // 4) Contact PRESENCE only — values are never copied into evidence (PII).
  for (const c of ctx.contacts.slice(0, 8)) {
    push('PROFILE_METADATA', 'PLATFORM', `businesses/${ctx.businessId}#contact-${c.kind}`,
      `contact channel available: ${c.kind}`, nowIso, { field: 'contact', kind: c.kind });
  }

  // 5) Raw source payloads (bio, city, category, engagement, posts)
  for (const raw of ctx.rawPayloads.slice(0, 5)) {
    const p = raw.payload;
    const bio = str(p['biography']) ?? str(p['description']) ?? str(p['bio']);
    if (bio !== undefined) {
      push('BIO_TEXT', raw.sourceType, `raw_entities/${raw.rawId}#biography`, bio,
        raw.collectedAt, { field: 'biography' });
    }
    const city = str(p['city']) ?? str(p['location']);
    if (city !== undefined) {
      push('LOCATION_SIGNAL', raw.sourceType, `raw_entities/${raw.rawId}#city`, city,
        raw.collectedAt, { field: 'city' });
    }
    const category = str(p['category']);
    if (category !== undefined) {
      push('PROFILE_METADATA', raw.sourceType, `raw_entities/${raw.rawId}#category`,
        `category: ${category}`, raw.collectedAt, { field: 'category' });
    }
    const site = str(p['external_url']) ?? str(p['website']);
    if (site !== undefined) {
      push('PROFILE_METADATA', raw.sourceType, `raw_entities/${raw.rawId}#website`,
        `website: ${site}`, raw.collectedAt, { field: 'website' });
    }
    const followers = num(p['followers_count']) ?? num(p['followers']);
    const posts = num(p['posts_count']) ?? num(p['media_count']);
    if (followers !== null || posts !== null) {
      push('ENGAGEMENT_SIGNAL', raw.sourceType, `raw_entities/${raw.rawId}#engagement`,
        `followers: ${followers ?? 'n/a'} | posts: ${posts ?? 'n/a'}`, raw.collectedAt,
        { followers, posts });
    }
    const arr = Array.isArray(p['posts']) ? (p['posts'] as unknown[]) : [];
    arr.slice(0, 5).forEach((item, i) => {
      const text = typeof item === 'string' ? item : str((item as Record<string, unknown>)?.['text'])
        ?? str((item as Record<string, unknown>)?.['caption']);
      if (text === undefined) return;
      push('CAPTION_TEXT', raw.sourceType, `raw_entities/${raw.rawId}#post-${i}`, text,
        raw.collectedAt, { field: 'post' });
    });
  }

  // 6) Sampled lead contents (captions + media metadata)
  for (const c of ctx.contents.slice(0, 20)) {
    if (c.text !== null && c.text.trim() !== '') {
      push('CAPTION_TEXT', 'PLATFORM', `lead_contents/${c.id}`, c.text, c.retrievedAt,
        { contentType: c.contentType, publishedAt: c.publishedAt });
    }
    if (c.mediaUrl !== null) {
      push('CONTENT_METADATA', 'PLATFORM', `lead_contents/${c.id}#media`,
        `media: ${c.mediaUrl}`, c.retrievedAt, { contentType: c.contentType });
    }
  }

  return drafts;
}

/** Evidence samples handed to the LLM (contentId === evidence id). */
export function evidenceSamples(drafts: readonly EvidenceDraft[]): EvidenceSample[] {
  return drafts
    .filter((d) => d.content !== null)
    .map((d) => ({ contentId: d.id, text: d.content as string, publishedAt: d.retrievedAt }));
}

/** Aggregate text view used as the profile text (also cited as a sample). */
export function profileText(drafts: readonly EvidenceDraft[]): string {
  return drafts
    .filter((d) => d.content !== null)
    .map((d) => d.content as string)
    .join('\n');
}
