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
