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
