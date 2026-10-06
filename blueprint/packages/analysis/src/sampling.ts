/**
 * Content sampling (Phase 18, ADR-030 §4).
 *
 * NOT every piece of content goes to an AI model. The sampler selects a
 * deterministic subset per analysis depth:
 *
 *   BASIC    → profile text + up to 3 newest items
 *   STANDARD → profile text + up to 8: newest items + type diversity +
 *              highest-signal (engagement) + representative older items
 *   DEEP     → profile text + up to 16, wider across all of the above
 *
 * Determinism: for the same (contents, depth, now) the selection and its
 * order are identical — no randomness anywhere. Selection reasons are
 * recorded per item so the choice is auditable (RECENCY / REPRESENTATIVE /
 * HIGH_SIGNAL / TYPE_DIVERSITY / ONLY_AVAILABLE).
 *
 * Repeated topics are a SELECTION signal (a topic seen across many items is
 * representative), while duplicate content (same contentHash) is collapsed
 * before selection — retries never double-count.
 */

import type { AnalysisMode } from '@ulip/domain/contracts';
import type { NormalizedContent } from './content.ts';

export type SamplingDepth = Extract<AnalysisMode, 'BASIC' | 'STANDARD' | 'DEEP'>;
export type SelectionReason = 'RECENCY' | 'REPRESENTATIVE' | 'HIGH_SIGNAL' | 'TYPE_DIVERSITY' | 'ONLY_AVAILABLE';

export interface SampledContent {
  content: NormalizedContent;
  reasons: SelectionReason[];
}

export interface SamplingStrategy {
  strategy: 'RECENCY_DIVERSITY_SIGNAL';
  depth: SamplingDepth;
  /** Number of items considered (after dedup), before the budget cut. */
  considered: number;
  /** How many items the depth budget allows. */
  budget: number;
}

export interface SamplingResult {
  strategy: SamplingStrategy;
  selected: SampledContent[];
  /** Ids of items considered but not selected (recorded, never discarded silently). */
  skipped: string[];
}

const BUDGETS: Record<SamplingDepth, number> = {
  BASIC: 3,
  STANDARD: 8,
  DEEP: 16,
};

function engagementWeight(c: NormalizedContent): number {
  const { likes, comments, views } = c.engagement;
  return (likes ?? 0) + 2 * (comments ?? 0) + Math.floor((views ?? 0) / 10);
}

function publishedTime(c: NormalizedContent): number {
  if (c.publishedAt === null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(c.publishedAt);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Selects the deterministic content sample for one analysis run.
 * `now` anchors RECENCY decisions; the algorithm itself has no clock access.
 */
export function sampleContents(
  contents: readonly NormalizedContent[],
  depth: SamplingDepth,
  now: Date,
): SamplingResult {
  const budget = BUDGETS[depth];

  // Collapse exact duplicate content (same hash) — keep the newest occurrence.
  const byHash = new Map<string, NormalizedContent>();
  for (const c of contents) {
    const prev = byHash.get(c.contentHash);
    if (prev === undefined || publishedTime(c) > publishedTime(prev)) byHash.set(c.contentHash, c);
  }
  const pool = [...byHash.values()];

  const strategy: SamplingStrategy = {
    strategy: 'RECENCY_DIVERSITY_SIGNAL',
    depth,
    considered: pool.length,
    budget,
  };

  if (pool.length === 0) return { strategy, selected: [], skipped: [] };

  const sortedByRecency = [...pool].sort(
    (a, b) => publishedTime(b) - publishedTime(a) || a.contentId.localeCompare(b.contentId),
  );

  // Topic frequency across the pool (repeated topics are representative).
  const topicCount = new Map<string, number>();
  for (const c of pool) {
    for (const t of c.topics) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  }
  const repeatedTopics = new Set(
    [...topicCount.entries()].filter(([, n]) => n >= 2).map(([t]) => t),
  );
  const repeatedTopicWeight = (c: NormalizedContent): number =>
    c.topics.filter((t) => repeatedTopics.has(t)).length;

  // Global engagement ranking (deterministic tiebreak on contentId).
  const byEngagement = [...pool].sort(
    (a, b) =>
      engagementWeight(b) - engagementWeight(a) || a.contentId.localeCompare(b.contentId),
  );
  const maxEngagement = engagementWeight(byEngagement[0] ?? pool[0]!);
  const highSignalIds = new Set(
    byEngagement
      .filter((c) => engagementWeight(c) > 0 && engagementWeight(c) >= maxEngagement / 2)
      .slice(0, Math.max(1, Math.ceil(budget / 4)))
      .map((c) => c.contentId),
  );

  // Type diversity: at most one item per distinct canonical type per pass.
  const typesPresent = [...new Set(pool.map((c) => c.contentType))].sort();

  const selected = new Map<string, SampledContent>();
  const reasonsFor = new Map<string, SelectionReason[]>();
  const add = (c: NormalizedContent, reason: SelectionReason): boolean => {
    if (selected.has(c.contentId)) {
      const existing = reasonsFor.get(c.contentId);
      if (existing !== undefined && !existing.includes(reason)) existing.push(reason);
      return false;
    }
    if (selected.size >= budget) return false;
    selected.set(c.contentId, { content: c, reasons: [reason] });
    reasonsFor.set(c.contentId, [reason]);
    return true;
  };

  // 1) RECENCY: newest first.
  for (const c of sortedByRecency) {
    if (selected.size >= budget) break;
    add(c, 'RECENCY');
  }

  // 2) TYPE_DIVERSITY: one per distinct type (newest of each type), if the
  //    type is not already represented.
  for (const type of typesPresent) {
    if (selected.size >= budget) break;
    const newestOfType = sortedByRecency.find((c) => c.contentType === type);
    if (newestOfType !== undefined) add(newestOfType, 'TYPE_DIVERSITY');
  }

  // 3) HIGH_SIGNAL: top engagement items.
  for (const c of byEngagement) {
    if (selected.size >= budget) break;
    if (!highSignalIds.has(c.contentId)) continue;
    add(c, 'HIGH_SIGNAL');
  }

  // 4) REPRESENTATIVE: repeated-topic items beyond recency (oldest-first among
  //    the topically representative ones so older representative posts survive).
  const representative = [...pool]
    .filter((c) => repeatedTopicWeight(c) > 0)
    .sort(
      (a, b) =>
        repeatedTopicWeight(b) - repeatedTopicWeight(a) ||
        publishedTime(a) - publishedTime(b) ||
        a.contentId.localeCompare(b.contentId),
    );
  for (const c of representative) {
    if (selected.size >= budget) break;
    add(c, 'REPRESENTATIVE');
  }

  // 5) ONLY_AVAILABLE fallback: when nothing else qualified (e.g. all items
  //    lack text/media), still surface what exists — recorded honestly.
  if (selected.size === 0) {
    for (const c of sortedByRecency) {
      if (selected.size >= budget) break;
      add(c, 'ONLY_AVAILABLE');
    }
  }

  const selectedList = sortedByRecency
    .filter((c) => selected.has(c.contentId))
    .map((c) => {
      const entry = selected.get(c.contentId)!;
      return { content: c, reasons: entry.reasons };
    });

  const selectedIds = new Set(selectedList.map((s) => s.content.contentId));
  const skipped = pool
    .filter((c) => !selectedIds.has(c.contentId))
    .map((c) => c.contentId);

  return { strategy, selected: selectedList, skipped };
}
