# UX Specification

## 1. UX principles

The interface should feel like a professional data/operations product rather than a generic social dashboard.

Primary principles:

1. **Explain every score.** A user should be able to open Evidence without leaving the Lead detail view.
2. **Make uncertainty visible.** Confidence, unavailable fields and inferred values must have explicit states.
3. **Keep source details secondary.** The core Lead information should remain consistent regardless of source.
4. **Optimize for review throughput.** Reviewers need quick accept/reject/correct actions.
5. **Do not hide provenance.** Show where each important fact originated.

## 2. Main navigation

- Dashboard
- Discovery
- Leads
- Review Queue
- Campaigns
- Taxonomy
- Sources
- AI / Usage
- Settings
- Audit

## 3. Discovery screen

Required controls:

- Source selector
- Natural-language search box
- Structured profession filter
- Specialty filter
- City/location filter
- Minimum activity
- Minimum relevance
- Minimum audience quality
- Maximum candidates
- Analysis depth: Basic / Standard / Deep

The UI must display the estimated or configured processing strategy without promising an exact cost when the provider cannot supply one.

## 4. Lead list

Each row/card should expose:

- Name
- Handle/identity
- Business Type
- Industry
- Specialty
- City
- Relevance
- Audience Quality
- Activity
- Confidence
- Status
- Source

Bulk actions:

- Add to campaign
- Export
- Mark reviewed
- Reject

## 5. Lead detail

Sections:

### Overview
Canonical business and source identities.

### Classification
Business Type, industry, specialty, city, confidence and taxonomy path.

### Evidence
Each evidence item with source, type, timestamp and supporting snippet/reference.

### Scores
Individual score breakdowns and scoring version.

### Audience Quality
Quality score, risk level and signals; explicitly not represented as a guaranteed fake-follower count.

### Review
Human correction controls.

### History
Analysis versions, previous scores and human changes.

## 6. Review queue

Default sort should prioritize uncertainty and potentially important leads.

Reviewer should be able to resolve a lead in a small number of interactions.

## 7. Accessibility

Keyboard navigation, meaningful labels, visible focus states, semantic controls, and readable contrast are required. The exact visual theme can evolve independently from domain contracts.

## 8. Empty/error states

Do not use blank states without an explanation. Show whether the issue is:

- no results
- source unavailable
- data partially available
- analysis pending
- permission denied
- temporary provider error
