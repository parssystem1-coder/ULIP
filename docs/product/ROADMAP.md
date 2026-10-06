# Product Roadmap

## Phase A — Foundation / MVP

- one source connector
- discovery jobs
- normalized lead model
- taxonomy
- LLM structured extraction
- evidence
- basic Vision provider boundary
- Jev decision-provider boundary
- independent scoring
- review queue
- campaigns
- CSV/JSON export
- usage/audit

## Phase B — Multi-source

- Google Maps/business source
- website connector
- CSV import
- cross-source identity resolution
- semantic search
- richer quality signals

## Phase C — Intelligence expansion

- additional social/video sources
- automated taxonomy suggestions
- model benchmarking dashboard
- improved cost/quality routing
- deeper content sampling policies

## Phase D — Platformization

- plugin marketplace
- external API
- CRM integrations
- tenant plans/quotas
- advanced graph analytics
- optional outreach module as a separate bounded component

## Social Actions & Outreach (shipped architecture, ADR-026)

- Social Actions module: capability-gated open/follow/unfollow/message,
  idempotent, auditable, manual fallback for unsupported platforms.
- Outreach module: templates, campaigns (universal business-model filters),
  eligibility, explicit confirmation gate, bulk = one separate message per
  lead, progress + reporting.
- Instagram status: OPEN_PROFILE supported; FOLLOW/UNFOLLOW/SEND_MESSAGE
  NOT_SUPPORTED (manual fallback) until an authorized API path exists.

## Phase 14 — Runtime Foundation (shipped)

Real runtime exists: Next.js web shell, HTTP API (sources/taxonomy/leads/
campaigns/jobs/health), BullMQ worker on the persistent Job model, Dockerized
PostgreSQL + Redis, migration runner, smoke flow verified end-to-end.
Jev remains unplugged by design (optional DecisionProvider).

## Phase 15 — Real Discovery & First Source Integration (shipped)

Real, provider-agnostic discovery pipeline (raw → normalized → dedup/ER →
lead → ANALYSIS_PENDING) behind authorized-connector boundaries. First
adapter: configured HTTP-API/Instagram boundary (honest NOT_CONFIGURED /
UNSUPPORTED) + deterministic fake provider for local E2E. Jev remains
unplugged; analysis classification hints are RULE-sourced, AI layers next.

## Phase 16 — AI Analysis & Scoring Runtime (shipped)

The AI layer is live: ANALYSIS_PENDING leads are processed by the real worker
through ANALYZING → evidence → AI extraction → taxonomy mapping → policy
scoring → SCORED → QUALIFIED / REVIEW_REQUIRED / REJECTED. Configurable
OpenAI-compatible HTTP LLM adapter (provider-agnostic, honest NOT_CONFIGURED
state) + deterministic test-only fake provider; evidence-first validation;
five persisted score dimensions on versioned policies; versioned analyses
with single-current semantics; structured explainability through
`GET /leads/{id}/analysis`. Jev remains unplugged; vision/embedding slots are
optional and unconfigured by default. See ADR-028.

## Phase 17 — AI Evaluation, Calibration & Regression Framework (shipped)

Quality is now measured, not assumed (ADR-029): a versioned human-labeled
dataset (34 cases, frozen taxonomy), the `@ulip/eval` runner over the real
evidence pipeline, per-dimension classification metrics, confidence
calibration, score diagnostics, a nine-category error taxonomy, append-only
evaluation history with human corrections and feedback-dataset export, and
`pnpm eval` — a deterministic regression command with committed baselines and
a per-category release gate. Jev arms stay honestly NOT_CONFIGURED.
See ADR-029 and docs/ai/EVALUATION-AND-BENCHMARKING.md.

## Phase 18 — Instagram Content Intelligence & Multimodal Analysis (shipped)

Content is a first-class analysis input (ADR-030): connector payloads become
versioned `lead_contents` rows (POST/REEL/CAROUSEL types added), deterministically
sampled (BASIC/STANDARD/DEEP), analyzed as text + budget-capped Vision with
honest per-modality availability, aggregated into evidence-cited business
signals, profile-vs-content consistency (contradictions force review), content-
derived activity intelligence (never follower-only claims), per-item relevance
against requested search criteria, and versioned/idempotent persistence
(`content_analyses` + `content_analysis_items`, migration 0005). Read side:
`GET /leads/{id}/contents` and `GET /leads/{id}/content-analysis`.
Evaluation gains the PROFILE_ONLY / TEXT_CONTENT / TEXT_IMAGE /
FULL_AVAILABLE_EVIDENCE arms with committed baselines. Vision remains honestly
gated: fake provider for dev/E2E, real `HttpVisionProvider` only with
`AI_VISION_MODEL` configured. See ADR-030 and
prompts/phases/PHASE-18-CONTENT-INTELLIGENCE-MULTIMODAL.md.
