# ADR-030: Content Intelligence & Multimodal Analysis

**Status:** Accepted (Phase 18)
**Date:** 2026-10-06
**Extends:** ADR-008 (evidence-first), ADR-019 (Persian alias normalization), ADR-024 (current-version semantics), ADR-027 (real discovery pipeline), ADR-028 (AI analysis & scoring runtime), ADR-029 (evaluation & regression framework). Supersedes nothing.

## Context

Through Phase 17 the analysis runtime (ADR-028) classified businesses primarily from
profile evidence — canonical name, bio/description, category, identity metadata —
while content rows (posts/captions) flowed into evidence only as bulk caption text
(`ctx.contents.slice(0, 20)`), with no sampling discipline, no per-content outcome
model, no cross-content aggregation and no way to detect that content contradicts
the profile.

Phase 18 makes content a **first-class analysis input**:

```text
Accessible business data
    → deterministic content sampling
    → text + image + video-metadata analysis (as available)
    → evidence aggregation
    → business intelligence
    → classification + activity + relevance + confidence
```

## Decisions

### 1. Reuse, never replace, the existing models

There is no competing Content/Evidence/AI/Lead contract. Content rows stay in
`lead_contents` (widened `content_type` CHECK: + POST / REEL / CAROUSEL);
conclusions stay `EvidenceDraft`s (`CAPTION_TEXT`, `IMAGE_OBSERVATION`);
intelligence stays `StructuredProfile` + universal model; scoring stays
`@ulip/scoring`. New persistence is **additive**: `content_analyses` (one versioned
content-intelligence result per lead run, current-version semantics mirroring
`lead_analyses`) and `content_analysis_items` (per-sampled-item outcome, unique
per `(content_analysis_id, lead_content_id)`).

### 2. Deterministic sampling (RECENCY_DIVERSITY_SIGNAL)

The sampler (`@ulip/analysis` `sampling.ts`) selects a bounded subset per depth —
BASIC 3 / STANDARD 8 / DEEP 16 — via fixed passes: RECENCY (newest first),
TYPE_DIVERSITY (one per canonical type), HIGH_SIGNAL (top engagement),
REPRESENTATIVE (repeated topics, oldest-first), ONLY_AVAILABLE (fallback).
Idempotent: duplicate content hashes collapse before selection; all ties break on
`contentId` so the same (contents, depth, now) always selects the same set, and
every item records its selection reasons.

### 3. Honest modality availability

`normalizeContent` records what the connector actually supplied (`availability`:
text/image/video). A missing modality is **recorded** (`VISION_UNAVAILABLE ...`,
`METADATA_ONLY`), never fabricated. Video/reel items are analyzed at metadata
level only; no video-frame understanding is claimed.

### 4. Cost-aware Vision routing

Vision (the existing `VisionProvider` slot on `AiRuntime`) is optional by
contract. The plan step (BASIC 0 / STANDARD 2 / DEEP 4 images, newest-first,
media-bearing only) refuses to send every image. A missing or failing provider
degrades gracefully — the run continues with text evidence and the failure is
recorded as a `FAILED` outcome plus a `MODALITY_UNAVAILABLE` review reason. The
deterministic fake vision provider (`fake-vision.ts`) matches keywords against the
context text and emits observations only for what it can actually see; empty
context yields zero observations.

### 5. Evidence-first conclusions with per-item citations

Each sampled item gets its own `CAPTION_TEXT` evidence row
(`lead_contents/{id}`, metadata carries `contentId` + selection reasons); each
analyzed image gets an `IMAGE_OBSERVATION` row (`lead_contents/{id}#vision`,
provider/model stamped). Aggregated signals (`BT_*` business-type rules,
`CI_*` commercial-intent rules) carry the evidence ids of every matching item, so
"printer parts ← posts 12, 18, 23" is literally queryable, and repeated
independent hits raise confidence (`0.55 + 0.08·(hits−1)`, capped 0.9).

### 6. Profile-vs-content consistency + structured review reasons

`computeConsistency` compares profile topic terms against sampled content:
`PROFILE_CONTENT_AGREE` / `PROFILE_CONTENT_PARTIAL` /
`PROFILE_CONTENT_CONFLICT` / `INSUFFICIENT_CONTENT`. Contradictions (content
strongly showing a different business type than the profile) demote confidence and
force an otherwise-QUALIFIED verdict to REVIEW_REQUIRED. Review reasons are
structured codes — `PROFILE_CONTENT_CONFLICT`, `INSUFFICIENT_CONTENT`,
`WEAK_EVIDENCE`, `MODALITY_UNAVAILABLE`, `TAXONOMY_AMBIGUITY` — persisted on the
content analysis and exposed via API; never chain-of-thought.

### 7. Content-derived activity (no follower-only claims)

`computeActivitySignals` uses publication recency, 30-day count, median cadence
and sample volume — publication behavior only. Follower counts are at most a
low-capped secondary additive signal and never standalone activity evidence. No
growth prediction is produced.

### 8. Per-item content relevance

Against requested search criteria (job payload `relevanceCriteria`), every sampled
item receives a deterministic term-coverage relevance. Field-dependent content is
scored differently ("Funny New Year recipes" fails the refrigerator-service and
bulk-order expectation); aggregated relevance folds into the existing relevance
dimension as an additive term without replacing the score architecture.

### 9. Reprocessing stays idempotent + versioned

Content analysis ids are deterministic per (job, lead); items per
(content analysis, content). Replays insert nothing new; a new job supersedes
(`is_current=false, superseded_at`) while history remains readable
(`?history=1`). Evidence rows are deduped by deterministic ids — a retry never
duplicates content evidence.

## Alternatives rejected

- **Full LLM content analysis over every post** — cost explosion, non-reviewable;
  sampling is deterministic and bounded instead.
- **Separate "content" domain package** — duplicates lead_contents and evidence;
  additive table + shared contracts instead.
- **Auto-generating taxonomy nodes from content topics** — remains forbidden
  (ADR-011); unmapped values stay free text and raise `TAXONOMY_AMBIGUITY`.
- **Pretending images are analyzed when only metadata exists** — honesty rules
  from ADR-027/028 apply; `MODALITY_UNAVAILABLE` is explicit.

## Consequences

- Analysis jobs read bounded content only; cost is predictable per depth.
- Contradictory content can no longer silently produce high-confidence results.
- Two new tables + widened CHECKs ship in migration
  `database/migrations/0005_content_intelligence` (snapshot
  `database/schema/schema.sql` kept in sync).
- The evaluation framework gains content/multimodal arms (PROFILE_ONLY,
  TEXT_CONTENT, TEXT_IMAGE, FULL_AVAILABLE_EVIDENCE) with their own baselines.
- An authorized connector actually publishing posts/media arrays is sufficient —
  no pipeline change is needed for content to flow (`DbContentIngestor`).
