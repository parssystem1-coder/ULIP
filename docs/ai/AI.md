# AI Engineering Specification

## 1. Principle

AI is a set of bounded capabilities, not the application itself.

## 2. Tasks

- profile extraction
- profession classification
- specialty classification
- location extraction
- content summarization
- evidence candidate extraction
- natural-language query parsing
- ambiguity resolution

## 3. Provider registry

Each provider declares supported task capabilities. Routing is based on capability, policy and configuration.

## 4. Analysis depth

### BASIC
Metadata/Bio + deterministic rules + minimal classification.

### STANDARD
Basic + representative text/media sampling + evidence.

### DEEP
Standard + additional content analysis when justified by uncertainty or an explicit user request.

## 5. AI output contract

Output is structured, validated and versioned. Free-form prose is a supporting field, not the source of truth for downstream business logic.

## 6. Grounding and evidence

For each important field, store evidence candidates where possible. Do not fabricate supporting text or visual claims.

## 7. Routing

The system may route a lead to different models based on:

- task complexity
- confidence
- tenant policy
- cost policy
- model availability

## 8. Failure behavior

A model failure does not automatically reject a lead. The system should record the failure and use a configured fallback/review path.
