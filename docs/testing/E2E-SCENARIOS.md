# E2E Scenarios

## E2E-001 Discovery to campaign

Given a valid source and search criteria, the user starts discovery, waits for processing, reviews qualifying leads, creates a campaign and exports it.

Assertions:

- job created
- raw records persisted
- normalized leads created
- duplicate candidate not duplicated
- scores present
- evidence present for AI classifications
- campaign contains selected lead IDs
- export contains only authorized tenant data

## E2E-002 Low-confidence review

Given ambiguous profile evidence, system routes lead to review. Reviewer changes specialty. The corrected value is stored and linked to the review.

## E2E-003 Source partial data

Given a source response with no city, the UI shows city unavailable/inferred rather than inventing it.

## E2E-004 Provider outage

Given a temporary AI provider failure, the job records failure and follows configured fallback/review behavior without duplicating the Lead.

## E2E-005 Cross-tenant isolation

A user from Tenant A cannot read, edit, export or add a Tenant B lead to a campaign even if they know the internal ID.

## E2E-006 Discovery to qualified lead (PHASE-16, automated)

Discovery produces leads in `ANALYSIS_PENDING`; the real worker picks up the
persistent `ANALYSIS` job and runs the AI analysis runtime.

Assertions:

- lifecycle `ANALYSIS_PENDING → ANALYZING → SCORED → QUALIFIED | REVIEW_REQUIRED | REJECTED`
- evidence rows exist before the analysis row becomes current
- all five score dimensions persisted with the scoring policy version
- exactly one current analysis and one current score row; history superseded, never deleted
- a reprocess creates a NEW analysis version instead of overwriting
- `GET /leads/{id}/analysis|evidence|scores` are tenant-scoped and authenticated
- the fake provider is labelled `fake` — never presented as a real model
- NOT_CONFIGURED fails honestly (no fabricated analysis)
- a foreign tenant gets 404 for every read and cannot trigger reprocess

Automated in `apps/api/test/integration.analysis.test.ts` and
`packages/analysis/test/integration.analysis-db.test.ts`.
