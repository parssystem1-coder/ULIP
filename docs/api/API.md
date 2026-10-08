# API Contract — Universal Lead Intelligence Platform

## API CONTRACT

# 1. API Principles

Base:

```text
/api/v1
```

JSON:

```text
application/json
```

Authentication:

```text
Bearer Token
```

---

# 2. Sources

### GET

```http
GET /api/v1/sources
```

### POST

```http
POST /api/v1/sources
```

Request:

```json
{
  "type": "INSTAGRAM",
  "name": "Instagram Main",
  "config": {}
}
```

---

# 3. Discovery

```http
POST /api/v1/discovery/search
```

Request:

```json
{
  "sourceId": "src_123",
  "query": "آرایشگران شیراز",
  "filters": {
    "city": "Shiraz",
    "profession": "beauty"
  }
}
```

Response:

```json
{
  "jobId": "job_123",
  "status": "QUEUED"
}
```

---

# 4. Discovery Job

```http
GET /api/v1/discovery/jobs/:jobId
```

Response:

```json
{
  "id": "job_123",
  "status": "PROCESSING",
  "progress": 65,
  "found": 420,
  "processed": 273
}
```

---

# 5. Leads

```http
GET /api/v1/leads
```

Query:

```text
source
profession
specialty
city
status
minRelevance
minAudienceQuality
minActivity
page
limit
sort
```

---

# 5b. Natural-Language Search (Phase 20)

```http
POST /api/v1/leads/search/natural-language
Content-Type: application/json

{ "text": "عمده‌فروشان قطعات پرینتر HP در تهران", "locale": "fa",
  "mode": "EXISTING_ONLY", "page": 1, "limit": 50 }
```

Persian-first (fa/en). The response is always honest about provenance:

- `parser.kind` = `LLM` (AI runtime READY) or `RULES_FALLBACK` (deterministic
  Persian-aware rules parser — used automatically when AI is NOT_CONFIGURED or
  the LLM output fails validation). The parser is ALWAYS named.
- `structuredQuery` is the typed `LeadSearchFilters` surface — the LLM never
  emits SQL or raw filter expressions; its output is sanitized before use.
- `resolution` shows taxonomy resolution per term (ID/SLUG/NAME/ALIAS) and
  lists unresolved terms — which ALSO fall back to content-aware free-text
  matching (`resolution.contentTerms`) against name/description/lead content.
- `data[]` is deterministically ranked: `searchScore` 0..100 (policy priority
  → relevance → neutral 50 baseline + fixed per-dimension boosts) with
  `reasons[]` explaining every point (no chain-of-thought).
- `execution.discoveryPlan` capability-checks every ACTIVE source through the
  real ConnectorRegistry: `SUPPORTED` / `PARTIAL` / `UNSUPPORTED` verdicts
  with reasons. Instagram is honest: only hashtag/username discovery exists,
  broad semantic/location queries are PARTIAL/UNSUPPORTED. With
  `mode=DISCOVER_WHEN_SUPPORTED` the first SUPPORTED step is executed (fake
  sources additionally require `allowFake: true`).

`GET /api/v1/leads` uses the SAME engine for structured filtering:
`businessType`, `industry`, `specialty`, `subSpecialty`, `brand`, `city`,
`country`, `source`, `status`, `minRelevance`, `minAudienceQuality`,
`minActivity`, `sort`, `order`, `page`, `limit` — parameterized SQL only
(SQL-injection safe), tenant-scoped, deterministic tiebreak.

---

# 6. Lead Detail

```http
GET /api/v1/leads/:leadId
```

Response:

```json
{
  "id": "lead_123",
  "identity": {},
  "classification": {},
  "scores": {},
  "audienceQuality": {},
  "evidence": [],
  "status": "REVIEW_REQUIRED"
}
```

---

# 7. Lead Analysis (Phase 16, ADR-028)

```http
GET /api/v1/leads/:leadId/analysis
```

Returns the **current** analysis row plus its explainability payload — structured
reasons, per-field confidence/availability, taxonomy mapping and evidence ids.
No chain-of-thought is ever returned. Historical versions are available in the
DB (ADR-024) but not exposed as a list endpoint yet.

```json
{
  "analysisId": "...",
  "analysisVersion": 3,
  "isCurrent": true,
  "analysisMode": "STANDARD",
  "provider": "fake",
  "modelVersion": "fake-1",
  "promptVersion": "p1",
  "schemaVersion": "s1",
  "confidence": 0.86,
  "classification": {
    "businessType": { "value": "wholesaler", "confidence": 0.9, "evidenceIds": ["ev_1"], "availability": "AVAILABLE" },
    "industry": { "value": "printing-supplies", "confidence": 0.88, "evidenceIds": ["ev_1"], "availability": "AVAILABLE" },
    "specialties": [],
    "brands": [],
    "city": { "value": "Tehran", "confidence": 0.95, "evidenceIds": ["ev_2"], "availability": "AVAILABLE", "provenance": "EXPLICIT" }
  },
  "reasons": [
    { "code": "BUSINESS_TYPE_MATCHED", "detail": "wholesaler", "evidenceIds": ["ev_1"] }
  ],
  "uncertainFields": ["brands"],
  "createdAt": "2026-10-06T00:00:00Z"
}
```

A lead that has never been analyzed returns `404 NOT_FOUND` — the API never
fabricates an analysis.

---

# 7b. Reprocess Lead

```http
POST /api/v1/leads/:leadId/reprocess
```

Creates (or reuses) the persistent `ANALYSIS`/`REPROCESS` job through the
orchestrator and returns it. `Idempotency-Key` is honoured: a duplicate request
returns the same job instead of starting a second one. Lifecycle state is only
ever moved by the orchestrator, never by this controller.

Response:

```json
{
  "jobId": "job_456",
  "status": "PENDING",
  "leadId": "lead_123"
}
```

---

# 8. Lead Evidence

```http
GET /api/v1/leads/:leadId/evidence
```

Paginated evidence rows for the lead: type, source reference, content snippet,
confidence, provenance and the analysis id they support.

---

# 9. Lead Scores

```http
GET /api/v1/leads/:leadId/scores
```

Returns the **current** score row: all five dimensions
(`relevanceScore`, `audienceQualityScore`, `activityScore`, `confidenceScore`,
`priorityScore`) plus `scoringPolicyVersionId` and `isCurrent` — the policy
version that produced them.

---

# 10. Human Review

```http
POST /api/v1/leads/:id/review
```

Request:

```json
{
  "decision": "CORRECT",
  "corrections": {
    "specialty": "balayage"
  },
  "reason": "Profile clearly specializes in balayage"
}
```

---

# 11. Taxonomy

```http
GET /api/v1/taxonomy
```

```http
POST /api/v1/taxonomy
```

```http
PATCH /api/v1/taxonomy/:id
```

---

# 12. Campaigns

```http
GET /api/v1/campaigns
```

```http
POST /api/v1/campaigns
```

Request:

```json
{
  "name": "Shiraz Beauty",
  "filters": {
    "city": "Shiraz",
    "profession": "beauty",
    "minRelevance": 80
  }
}
```

---

# 13. Add Lead to Campaign

```http
POST /api/v1/campaigns/:id/leads
```

Request:

```json
{
  "leadIds": [
    "lead_1",
    "lead_2",
    "lead_3"
  ]
}
```

---

# 14. Export

```http
POST /api/v1/exports
```

Request:

```json
{
  "type": "CSV",
  "campaignId": "camp_123"
}
```

Response:

```json
{
  "jobId": "job_999"
}
```

---

# 15. AI Providers

```http
GET /api/v1/ai/providers
```

Admin:

```http
POST /api/v1/ai/providers
```

---

# 16. Usage

```http
GET /api/v1/usage
```

Response:

```json
{
  "leadsProcessed": 1200,
  "llmCalls": 850,
  "visionCalls": 310,
  "jevCalls": 720,
  "estimatedCost": 12.42
}
```

---

# 17. Standard API Error

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid taxonomy node",
    "details": {}
  },
  "requestId": "req_123"
}
```

---

# 18. Pagination

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1240,
    "totalPages": 25
  }
}
```

---

# 19. API Rules

تمام Endpointها باید:

- Authentication
- Authorization
- Validation
- Rate Control
- Request ID
- Structured Error
- Audit در عملیات حساس

داشته باشند.

---

# 20. API Versioning

در آینده:

```text
/api/v2
```

بدون شکستن v1 اضافه شود.

---

# 21. Contract Testing

API Contract باید با:

```text
OpenAPI
```

تعریف شود.

سپس:

```text
Backend
Frontend
Integration Tests
```

بر اساس همان Contract کار کنند.

# 22. Social Actions (ADR-026)

مرجع نهایی: `docs/api/OPENAPI.yaml` (تگ‌های `Social Actions`).

### گزارش قابلیت‌ها (honest)

```http
GET /api/v1/social/capabilities/{sourceType}
```

```json
{
  "sourceType": "instagram",
  "capabilities": {
    "OPEN_PROFILE": "SUPPORTED",
    "FOLLOW_PROFILE": "NOT_SUPPORTED",
    "UNFOLLOW_PROFILE": "NOT_SUPPORTED",
    "SEND_MESSAGE": "NOT_SUPPORTED"
  }
}
```

فقط اکشن‌های `SUPPORTED` در UI به‌صورت قابل‌اجرا نمایش داده می‌شوند.

### اجرای یک اکشن (idempotent)

```http
POST /api/v1/social/actions
Idempotency-Key: <key>
```

```json
{
  "leadId": "lead_123",
  "sourceType": "instagram",
  "type": "SEND_MESSAGE",
  "message": "...",
  "requireApproval": false
}
```

پاسخ `kind` یکی از: `EXECUTED`, `NOT_SUPPORTED` (با `fallback`),
`IDEMPOTENT_REPLAY`, `BLOCKED_SUPPRESSED`, `BLOCKED_RECENT_CONTACT`,
`AWAITING_APPROVAL`, `COMPLETED_MANUALLY`.

اکشن پشتیبانی‌نشده هرگز اجرا نمی‌شود؛ خروجی شامل **برنامهٔ fallback دستی** است:
`Open Profile → Copy Prepared Message → انجام دستی → تیک‌زدن «انجام شد»`.

### سایر endpointها

- `GET /social/actions` — تاریخچهٔ اکشن‌ها (فیلتر بر اساس leadId/status)
- `GET /social/actions/{id}` / `DELETE /social/actions/{id}` (لغو)
- `POST /social/actions/{id}/approve` / `retry` / `fallback` / `complete-manual`
- `GET /social/actions/{id}/attempts` — audit کامل تلاش‌ها (شامل retry-after)

# 23. Outreach (ADR-026)

مرجع نهایی: `docs/api/OPENAPI.yaml` (تگ `Outreach`).

**پیام انبوه = یک پیام جداگانه برای هر lead انتخاب‌شده؛ هرگز group chat نیست.**

### قالب پیام

```http
GET/POST /api/v1/outreach/templates
POST /api/v1/outreach/templates/{templateId}/preview
```

بدنه با placeholder: `سلام {{business_name}}، ...`

### کمپین (فیلترها همان مدل جهانی کسب‌وکار)

```http
POST /api/v1/outreach/campaigns
```

```json
{
  "name": "Wholesaler → Printing → Printer Parts → Tehran",
  "templateId": "tpl_1",
  "filters": {
    "businessTypes": ["wholesaler"],
    "industries": ["printing"],
    "specialties": ["printer-parts"],
    "city": "تهران"
  }
}
```

### جریان اجرا (gate تأیید انسانی)

```text
PUT  /outreach/campaigns/{id}/recipients   انتخاب + بررسی واجد شرایطی + پیش‌نمایش هر lead
POST /outreach/campaigns/{id}/submit       DRAFT → PENDING_APPROVAL
POST /outreach/campaigns/{id}/confirm      تأیید صریح انسانی با تطابق اعداد (وگرنه 409)
POST /outreach/campaigns/{id}/execute      اجرای bulk (یک پیام جداگانه برای هر lead)
POST /outreach/campaigns/{id}/pause|cancel توقف/لغو تعاونی
GET  /outreach/campaigns/{id}/report       پیشرفت + گزارش ارسال
```

اجرای مجدد idempotent است: گیرندگان `SENT` دوباره پیام نمی‌گیرند.

### تاریخچه و suppression

- `GET /outreach/history` — تاریخچه تماس lead
- `GET/POST /outreach/suppression` — لیست/افزودن ممنوع‌التماس (همیشه برنده)

# 24. مرجعیت قرارداد و Idempotency

## مرجعیت OpenAPI (ADR-020)

`docs/api/OPENAPI.yaml` مرجعِ نهایی قرارداد API است؛ این سند توصیف انسانی آن است.
هر تغییری اول در OPENAPI اعمال می‌شود، سپس این سند سینک می‌شود. تست‌های contract
برای OpenAPI نوشته می‌شوند، نه برای این فایل.

## Content intelligence (Phase 18, ADR-030)

```http
GET /api/v1/leads/{leadId}/contents
GET /api/v1/leads/{leadId}/content-analysis
GET /api/v1/leads/{leadId}/content-analysis?history=1
```

- `contents` lists the lead's ingested content items (lead_contents) with type,
  caption, media reference, publication time, content hash and available
  engagement signals.
- `content-analysis` returns the current versioned content intelligence:
  deterministic sampling (strategy + per-item selection reasons),
  profile-vs-content consistency, content-derived activity signals, aggregated
  content relevance, structured review reasons and the per-item breakdown
  (which modalities were analyzed — missing modalities are recorded, never
  fabricated). `?history=1` lists superseded versions; history is never deleted.

Schemas live in `docs/api/OPENAPI.yaml` (LeadContent, ContentAnalysis,
ContentAnalysisItem, ContentAnalysisVersion, ProfileContentConsistency).

## Idempotency

هر POST قابل‌تکرار (`/sources`, `/discovery/jobs`, `/reprocessing`, `/exports`) باید
هدر `Idempotency-Key` بپذیرد:

- scope یکتایی: `tenant_id + endpoint + Idempotency-Key`
- replay: پاسخ ذخیره‌شدهٔ اولین اجرا با همان key برگردانده می‌شود (کد یکسان)
- انقضا: رکوردهای idempotency پس از ۲۴ ساعت قابل پاک‌سازی‌اند
- conflict: اگر همان key با payload متفاوت برسد → `409 Conflict`

جزئیات schema در `database/schema/schema.sql` (جدول `idempotency_keys`) و
معناشناسی کامل در OPENAPI.yaml.

# 25. Discovery (Phase 15, ADR-027)

`POST /discovery/search` — create a discovery job (OPENAPI.yaml is canonical):

- Headers: `Idempotency-Key` (required; replay returns the original 202 job),
  `Authorization: Bearer <api key>`.
- Body: `{ sourceId, query?, filters?, maxCandidates?, cursor?, allowFake? }`;
  `filters` carry the universal business model as strings:
  `businessType, industry, specialty, subSpecialty, brand, location`
  (e.g. Wholesaler/Printing/Printer Parts/HP/Tehran).
- Responses: `202` Job (with `transport.enqueued` honesty flag) · `400`
  validation or missing key · `404` source not in tenant · `409`
  `SOURCE_NOT_ACTIVE` / `IDEMPOTENCY_IN_FLIGHT` · `401` bad key.
- `GET /discovery/jobs/{jobId}` — tenant-scoped job status
  (404 for other tenants' jobs; non-DISCOVERY jobs are not visible here).

Worker side executes the REAL pipeline: connector → raw snapshot
(immutable, content-hash dedup) → Persian-aware normalization → dedup/ER →
lead → `ANALYSIS_PENDING`. Failures are honest: `NOT_CONFIGURED` (missing
credentials), `BAD_REQUEST` (malformed payload), `WORKER_ERROR`.

---

# 9. Evaluation (Phase 17, ADR-029)

Read-side only (plus correction recording). All responses are structured —
per-case outcomes, scores and error categories — never chain-of-thought.

- `GET /evaluation/runs?limit=` — recent runs: deterministic `runId`,
  `versions` (dataset/provider/model/prompt/schema/taxonomy/policy), `arm`,
  `armStatus` (EXECUTED | NOT_CONFIGURED | FAILED), full `metrics` block
  (overall, byDimension, macroF1, calibration, latency, cost, errors,
  abstention/coverage, outcomeAccuracy, byTag, scoreEvaluation).
- `GET /evaluation/runs/{runId}` — one run + per-case results
  (`exactMatch`, `dimensionAccuracy`, `errorCategory`, reviewOutcome,
  latency, tokens, detail with per-dimension outcomes).
- `GET /evaluation/runs/{runId}/regression` — per-metric findings vs the
  resolved baseline (same arm + dataset version): `CRITICAL` ≥ 0.10,
  `MAJOR` ≥ 0.05, `MINOR` > 0.02; `hasRegressions` is the release gate;
  404 when no baseline exists yet.
- `GET /evaluation/corrections?datasetVersion=` — human corrections
  (append-only; never part of AI output).
- `POST /evaluation/corrections` — record a correction
  (`caseId`, `datasetVersion`, `field` ∈ businessType/industry/specialty/
  subSpecialty/brand/location/outcome/score, `correctedValue`, optional
  `reviewerNote`). Duplicate (case, field, reviewer, dataset) → 409-style
  unique violation.
- `GET /evaluation/feedback-dataset?datasetVersion=` — draft of the next
  labeled dataset with corrections applied (`<minor+1>.0-draft`); requires
  human review before becoming a dataset version.

CLI: `pnpm eval` (baseline comparison + release gate). Live provider:
`ULIP_EVAL_LIVE=1` + `AI_PROVIDER=http` — never default, never in tests.
