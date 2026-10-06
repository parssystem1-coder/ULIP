# PHASE 18 — INSTAGRAM CONTENT INTELLIGENCE & MULTIMODAL ANALYSIS

**Status:** implemented (this repository)
**Commit phase:** 18
**Depends on:** Phase 15 (real discovery), Phase 16 (AI analysis runtime), Phase 17 (evaluation framework)
**ADR:** ADR-030

## Goal

Expand ULIP analysis from profile/Bio-centric extraction into evidence-based
analysis of the business's broader accessible content: profile metadata, bio,
posts, captions, images, reels/video metadata, hashtags, publication dates,
engagement signals, category/location and contact-presence signals.

Pipeline:

```text
Accessible Business Data
        ↓
Content Sampling
        ↓
Text + Image + Content Analysis
        ↓
Evidence Aggregation
        ↓
Business Intelligence
        ↓
Classification + Activity + Relevance + Confidence
```

## What shipped (post-implementation summary)

1. **Content as first-class input** — `lead_contents` widened to POST/REEL/CAROUSEL
   (+ existing TEXT/IMAGE/VIDEO/LINK/METADATA). Discovery ingests payload
   `posts`/`media`/`contents` arrays via `DbContentIngestor`
   (`blueprint/packages/discovery/src/content.ts`): deterministic ids, canonical
   content types, sha256 content hash, idempotent (UNIQUE
   `(lead_id, source_content_id, content_hash)`), historical content never
   overwritten.

2. **Deterministic sampling** — `@ulip/analysis` `sampling.ts`
   (`RECENCY_DIVERSITY_SIGNAL`): BASIC 3 / STANDARD 8 / DEEP 16 via RECENCY →
   TYPE_DIVERSITY → HIGH_SIGNAL → REPRESENTATIVE → ONLY_AVAILABLE passes; per-item
   selection reasons recorded; duplicate hashes collapsed; contentId tiebreaks.

3. **Multimodal pipeline with honest modality availability** — `normalizeContent`
   exposes text/image/video availability; `multimodal.ts` plans Vision per depth
   budget (BASIC 0 / STANDARD 2 / DEEP 4; newest media items only), executes it
   through the `AiRuntime.vision` slot, records `VISION_UNAVAILABLE` /
   `VISION_SKIPPED_BY_DEPTH` / `VISION_SELECTED` / FAILED outcomes, and never
   fabricates a missing modality. Video/reel stays METADATA_ONLY.

4. **Evidence-first** — every sampled item → `CAPTION_TEXT` evidence row citing
   `lead_contents/{id}`; every analyzed image → `IMAGE_OBSERVATION` row with
   provider/model stamps. Aggregated keyword signals (BT_*/CI_*) carry the
   evidence ids of every matching item; repeated hits raise confidence
   (0.55 + 0.08·(hits−1), cap 0.9). No chain-of-thought anywhere.

5. **Cross-content reasoning** — `intel.ts` aggregates across sampled items and
   computes profile-vs-content consistency
   (AGREE / PARTIAL / CONFLICT / INSUFFICIENT_CONTENT), per-item content relevance
   vs requested criteria (`relevanceCriteria` job payload), and content-derived
   activity signals.

6. **Consistency → policy** — conflicts demote confidence and force an
   otherwise-QUALIFIED verdict to REVIEW_REQUIRED. Structured review reasons:
   PROFILE_CONTENT_CONFLICT, INSUFFICIENT_CONTENT, WEAK_EVIDENCE,
   MODALITY_UNAVAILABLE, TAXONOMY_AMBIGUITY (persisted + API).

7. **Activity intelligence** — publication recency/cadence/30-day count/volume
   drive the activity dimension when content exists; follower count is at most a
   capped secondary additive signal; no follower-only claims, no growth prediction.

8. **Versioning** — `content_analyses` + `content_analysis_items` (migration
   `0005_content_intelligence`) with `is_current`/`superseded_at`, deterministic
   ids, idempotent replay, preserved history (`?history=1`). Separate
   VISUAL_ANALYSIS `ai_runs` row when Vision actually ran.

9. **Providers** — `DeterministicFakeVisionProvider` (`@ulip/ai` fake-vision.ts)
   for dev/test; the real HTTP vision provider remains honestly gated on
   `AI_VISION_MODEL` config. Embeddings untouched (no measurable-value case yet).

10. **Evaluation arms** — PROFILE_ONLY / TEXT_CONTENT / TEXT_IMAGE /
    FULL_AVAILABLE_EVIDENCE added to the Phase-17 framework (arm visibility +
    real sampling + budget-capped vision step; honest NOT_CONFIGURED when vision
    is required but absent). Baselines regenerated with `--write-baseline --stable`.

11. **API/OpenAPI** — `GET /leads/{leadId}/contents` and
    `GET /leads/{leadId}/content-analysis` (+ `?history=1`) with new schemas
    (LeadContent, ContentAnalysis, ContentAnalysisItem, ContentAnalysisVersion,
    ProfileContentConsistency); tenant-scoped.

12. **Docs** — this file, ADR-030, IMPLEMENTATION-PLAN, README, docs/ai/*,
    docs/database/*, REPOSITORY-FILE-TREE.

## Non-goals honored

No unofficial scraping; no platform-protection bypass; no automatic outreach; no
GNN; no fine-tuning; universal taxonomy untouched; existing AI contracts
untouched; not every image goes to Vision; follower count is never business
quality by itself.

## Definition of Done verification

- content is a first-class analysis input ✔ (ingestor + widened types)
- multiple content items contribute evidence ✔ (per-item citation)
- text and image analysis architecture works ✔ (LLM + optional Vision)
- configurable sampling exists ✔ (BASIC/STANDARD/DEEP)
- cross-content aggregation works ✔ (intel.ts + consistency)
- profile/content consistency works ✔ (incl. conflict → review)
- activity intelligence uses content signals ✔
- content relevance supported ✔ (per-item + aggregated)
- evidence persisted and versioned, history preserved, idempotent ✔
- fake/dev content + vision providers exist; real provider honestly gated ✔
- evaluation framework includes content/multimodal comparisons ✔
- API/OpenAPI synchronized ✔
- PostgreSQL integration + worker E2E tests pass ✔
- pnpm typecheck/lint/test/build/eval pass ✔
