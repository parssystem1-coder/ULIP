# AI Engineering Specification

## 1. Principle

AI is a set of bounded capabilities, not the application itself.

## 2. Tasks

- profile extraction
- profession classification
- specialty classification
- location extraction
- content summarization
- evidence candidate extraction
- natural-language query parsing
- ambiguity resolution

## 3. Provider registry

Each provider declares supported task capabilities. Routing is based on capability, policy and configuration.

## 4. Analysis depth

### BASIC
Metadata/Bio + deterministic rules + minimal classification.

### STANDARD
Basic + representative text/media sampling + evidence.

### DEEP
Standard + additional content analysis when justified by uncertainty or an explicit user request.

## 5. AI output contract

Output is structured, validated and versioned. Free-form prose is a supporting field, not the source of truth for downstream business logic.

## 6. Grounding and evidence

For each important field, store evidence candidates where possible. Do not fabricate supporting text or visual claims.

## 7. Routing

The system may route a lead to different models based on:

- task complexity
- confidence
- tenant policy
- cost policy
- model availability

## 8. Failure behavior

A model failure does not automatically reject a lead. The system should record the failure and use a configured fallback/review path.

## 9. Implemented runtime (Phase 16)

Implementation: `blueprint/packages/ai/src/*` (contracts unchanged).

- **Selection** — `selectAiRuntime(config, opts)` is the only place a provider
  is chosen. Two honest states: `READY` or `NOT_CONFIGURED` (with the missing
  environment keys). Nothing is ever fabricated in the NOT_CONFIGURED state.
- **Configuration** (`loadAiConfig`, fail-fast): `AI_PROVIDER`
  (`http` | `fake` | `none`), `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`,
  `AI_TIMEOUT_MS` (default 30000), `AI_MAX_RETRIES` (default 2),
  `AI_RETRY_BACKOFF_MS` (default 500), `AI_PROMPT_VERSION`, `AI_SCHEMA_VERSION`,
  optional `AI_VISION_MODEL` / `AI_EMBEDDING_MODEL`. Production requires an
  `https://` base URL.
- **HTTP adapter** — `HttpLlmProvider` speaks OpenAI-compatible Chat
  Completions against the configured base URL (no vendor hard-coded):
  timeout, exponential backoff, Retry-After on 429, one sanitized retry when an
  endpoint rejects `response_format`, and exactly one bounded contract-repair
  attempt before `SCHEMA_VALIDATION_ERROR`.
- **Optional slots** — `HttpVisionProvider` / `HttpEmbeddingProvider` exist but
  stay `null` unless their model is configured; `DecisionProvider` (Jev) stays
  optional and is never required (ADR-017).

## 10. Evaluation (Phase 17)

`@ulip/eval` measures the runtime instead of assuming quality (ADR-029):
human-labeled dataset v1.0.0 (34 cases, frozen taxonomy snapshot), five arms
(Jev arms honest NOT_CONFIGURED), per-dimension accuracy/precision/recall/F1,
calibration (ECE, over-confidence), score diagnostics, a nine-category error
taxonomy, deterministic run ids, append-only history with human corrections,
and `pnpm eval` — a per-category regression gate against committed baselines.
LLM providers under test are always the same `LLMProvider` implementations
from this package (deterministic fake by default; live HTTP only via
`ULIP_EVAL_LIVE=1`).
- **Deterministic fake** — `DeterministicFakeLlmProvider` for tests and local
  E2E only: fixed keyword dictionaries, constant confidences, stable ordering.
  It requires `AI_PROVIDER=fake` and is refused when `NODE_ENV=production`
  without an explicit `allowFake` opt-in.
- **Observability** — every run records `ai_runs` (provider, model, latency,
  input/output hash, prompt/schema version, status) and the structured log
  carries `jobId`/`tenantId`/`leadId`/`correlationId` end to end.
