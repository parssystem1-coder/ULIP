# Taxonomy Engine

## 1. Data model

Taxonomy is a versioned tree. Every node has a stable internal identifier and a slug.

## 2. Operations

- create node
- rename node
- move node
- deactivate node
- activate node
- merge nodes through a reviewed migration
- create new version

## 3. Classification

A Lead may have:

- one primary Business Type, optionally one Industry and one or more Specialties
- levels are optional — not every business has every level (ADR-018)
- zero or more specialties
- optional secondary classifications

The exact multiplicity is configurable by tenant/workflow.

## 4. Synonyms

Aliases and translations are first-class and persisted in `taxonomy_node_aliases`,
`taxonomy_node_translations` and `location_aliases` with deterministic Persian
normalization (`alias_norm`, ADR-019). The canonical node remains the database identifier.

Example:

```text
"رنگ مو" → Hair Coloring
"رنگ و لایت" → Hair Coloring
"بالیاژ" → Balayage
```

Synonym mapping is data, not a conditional branch in application code.
