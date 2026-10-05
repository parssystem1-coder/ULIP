# Model Registry and Routing

## Registry fields

- provider id
- model name/version
- capabilities
- status
- cost metadata (when known)
- latency class (optional)
- context/size metadata (optional)

## Routing policy

A routing decision should be deterministic for the same configuration and task class unless an intentional adaptive policy is being tested.

Example:

```text
Task = simple profession classification
→ low-cost LLM

Task = bounded ambiguity among 5 taxonomy options
→ Jev decision provider

Task = visual specialty detection
→ Vision provider

Task = unresolved after first pass
→ stronger model / human review
```

## Provider fallback

Fallbacks are capability-aware. Do not silently substitute a provider that lacks the required modality.

## Versioning

Results record exact provider/model/prompt/schema versions so they can be audited and reprocessed.
