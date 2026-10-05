# 05 — First Connector

## Objective
Implement the first authorized/permitted source connector according to the source access boundary. Return raw source entities and explicit partial/unavailable fields. Do not place classification/scoring in the connector.

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
PHASE: 05 — First Connector
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
