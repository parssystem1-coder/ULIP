# ADR 026 — Provider-Agnostic Social Actions and Outreach

## Status

Accepted (supersedes the *implementation freeze* aspect of ADR-013; its
safety boundary remains fully in force).

## Context

ADR-013 kept automatic outreach out of the core while the lead-intelligence
pipeline stabilized. The platform now needs first-class **Social Actions**
(open / follow / unfollow / message) and **Outreach** (campaign-based,
human-approved bulk 1-to-1 messaging) — while keeping lead discovery and AI
analysis untouched.

Platform capabilities differ and authorized integrations must stay honest:
an action is executed only when the provider integration for that source
genuinely supports it. Instagram's authorized boundary does **not** include
programmatic follow or messaging today.

## Decision

1. **Two new bounded modules** (separate from discovery/analysis):
   - `@ulip/social-actions` — single action lifecycle, capability gating,
     idempotency `(tenant_id, idempotency_key)`, attempts audit, suppression
     and recent-contact guards, manual fallback.
   - `@ulip/outreach` — message templates, campaigns, recipients (one row per
     (campaign, lead) = one separate message per lead, never a group chat),
     eligibility, explicit confirmation gate, bulk execution, reporting.
2. **Action capability negotiation** extends the connector contract:
   `OPEN_PROFILE`, `FOLLOW_PROFILE`, `UNFOLLOW_PROFILE`, `SEND_MESSAGE`,
   `BULK_SEND_MESSAGE` (the bulk form is an orchestration of `SEND_MESSAGE`
   inside outreach; a connector never performs a "group" send).
3. **Honest support + manual fallback**: unsupported ⇒ `NOT_SUPPORTED` plus a
   manual plan — *Open Profile → Copy Prepared Message → user performs the
   action manually → mark completed*. Success is never faked.
4. **Human confirmation gate**: bulk execution requires explicit confirmation
   of the previewed plan (Select Leads → Choose Template → Preview →
   Eligibility Check → Confirm → Execute → Progress → Report). Campaigns can
   be paused/cancelled cooperatively.
5. **Persistent models** (migration `0002_social_actions_outreach`):
   `social_actions`, `social_action_attempts`, `message_templates`,
   `outreach_campaigns`, `outreach_recipients`, `lead_contact_history`,
   `suppression_entries`; bulk execution reuses persistent jobs (new job type
   `OUTREACH`).
6. **Business model preserved**: campaign filters reuse the universal
   taxonomy — Business Type → Industry → Specialty → Sub-specialty + Location
   (e.g. `Wholesaler → Printing → Printer Parts → Tehran`).

## Safety boundary (unchanged, binding)

No CAPTCHA bypass, no anti-bot bypass, no rate-limit evasion, no
cookie/session theft, no credential abuse, no unauthorized access. Provider
`retry-after` responses are **respected and persisted**, never circumvented.
Suppression entries always win: a suppressed lead is never contacted.

## Consequences

- UIs render only `SUPPORTED` actions as executable; unsupported ones offer
  the manual fallback plan.
- All external actions are tenant-scoped, permission-controlled, auditable,
  idempotent and retry-safe — enforced by schema constraints and service
  invariants, not by convention.
- Outreach is separate from Lead Discovery and AI Analysis at package,
  database, and API level.

## Review trigger

A new authorized integration with genuine action support, or a regulatory
change on automated outreach, reopens this ADR.
