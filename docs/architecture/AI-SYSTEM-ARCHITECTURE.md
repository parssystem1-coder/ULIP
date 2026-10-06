# AI System Architecture

## 1. AI responsibilities

### LLM
Used for:

- text understanding
- structured extraction
- terminology normalization proposals
- natural-language query parsing
- complex reasoning where rules cannot decide

### Vision model
Used for:

- visual classification
- representative-image analysis
- visual evidence generation

### Jev decision provider
Used for bounded decision spaces where application code supplies the options and owns thresholds/fallbacks.

### Embeddings
Reserved for semantic similarity, deduplication support and later retrieval/search.

## 2. AI gateway

The domain depends on interfaces such as:

```typescript
interface LLMProvider {}
interface VisionProvider {}
interface DecisionProvider {}
interface EmbeddingProvider {}
```

The gateway selects a provider based on task, configuration, capability and cost/latency policy.

## 3. AI run record

Every AI invocation should capture:

- tenant
- lead/job reference
- provider
- model/version
- task type
- prompt/schema versions
- input/output hashes
- latency
- usage metadata
- estimated cost if provider reports usable units
- status/error

Sensitive raw prompts should be subject to retention and minimization policy.

## 4. Confidence model

Confidence is an estimate of certainty in the system's inference. It must not be treated as calibrated probability until validated on labeled data.

Therefore the UI should describe confidence consistently and support calibration studies.

## 5. Cascaded inference

A default route is:

```text
Rules / metadata
  ↓
LLM extraction
  ↓
Jev when decision space is bounded
  ↓
Vision only when needed
  ↓
Strong model / deeper analysis when uncertainty remains
  ↓
Human review
```

The actual order is task-specific and must be benchmarked rather than assumed universally optimal.

## 6. Grounding

A structured prediction should be tied to one or more of:

- text evidence
- visual evidence
- source metadata
- deterministic signal
- human label

An unsupported prediction should carry reduced confidence and may be routed to review.

## 7. Model replacement

Adding or removing a provider must not change Lead/Taxonomy/Scoring domain models. Model routing belongs in infrastructure/application layers.

## 8. Implemented runtime (Phase 16, ADR-028)

Everything above is now connected end to end by `@ulip/ai` + `@ulip/analysis`:

```text
ANALYSIS_PENDING
  → job (DB truth, BullMQ transport) → worker
  → selectAiRuntime()          READY | NOT_CONFIGURED (fail-fast, never silent)
  → buildEvidenceDrafts()      observed facts only, persisted first
  → LLM extractStructuredProfile()   (HTTP OpenAI-compatible adapter, or fake in tests)
  → validateExtractionOutput() + enforceEvidenceFirst()
  → taxonomy mapping onto existing node ids
  → computeDimensions() on the persisted ACTIVE scoring policy
  → DbAnalysisStore           one transaction, one current analysis + score
  → orchestrator applyLeadEvent  SCORED → QUALIFIED | REVIEW_REQUIRED | REJECTED
```

- **Provider-agnostic:** the adapter is configured by `AI_PROVIDER`,
  `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`,
  `AI_MAX_RETRIES`, `AI_RETRY_BACKOFF_MS`; no vendor constant exists in code.
- **Honest states only:** without credentials the runtime reports
  `NOT_CONFIGURED` listing the missing keys; the deterministic fake is
  selectable only explicitly and is refused under `NODE_ENV=production`
  without `allowFake`.
- **Jev stays unplugged:** `DecisionProvider` remains an optional slot;
  `RULES_ONLY` and `LLM_ONLY` strategies work with no decision provider.
- **Model replacement** therefore stays an infrastructure concern: swapping the
  base URL/model changes `ai_runs.model_version`, nothing in domain or scoring.
