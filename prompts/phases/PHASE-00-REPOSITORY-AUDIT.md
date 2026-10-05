# 00 — Repository Audit

## Objective
Audit the repository without implementing features. Identify framework, dependency graph, modules, database, test setup, deployment, conventions, security risks, and architectural mismatches. Produce an audit report and recommended phase order. Do not make broad code changes.

## Instructions

1. Read `prompts/master/MASTER-PROMPT.md` first.
2. Read the phase-specific documents under `docs/`.
3. Inspect the current repository state.
4. Preserve compatible existing work.
5. Implement only this phase's scope.
6. Add/update tests for every new behavior.
7. Run typecheck/lint/tests.
8. Update documentation if the implementation differs from the blueprint.
9. Stop at the phase boundary unless a small prerequisite fix is necessary.

## Required report

```text
PHASE: 00 — Repository Audit
STATUS:
IMPLEMENTED:
FILES CHANGED:
DATABASE CHANGES:
TESTS:
ARCHITECTURE DEVIATIONS:
KNOWN ISSUES:
NEXT PHASE:
```

## Non-negotiable safety boundary

Do not implement or recommend mechanisms intended to bypass source/platform security controls, CAPTCHA, rate limits, anti-bot systems, authentication controls or unauthorized private-data access.
