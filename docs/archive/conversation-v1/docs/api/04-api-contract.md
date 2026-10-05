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

# 6. Lead Detail

```http
GET /api/v1/leads/:id
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

# 7. Analyze Lead

```http
POST /api/v1/leads/:id/analyze
```

Request:

```json
{
  "mode": "STANDARD"
}
```

Response:

```json
{
  "jobId": "job_456",
  "status": "QUEUED"
}
```

---

# 8. Lead Evidence

```http
GET /api/v1/leads/:id/evidence
```

---

# 9. Lead Scores

```http
GET /api/v1/leads/:id/scores
```

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
