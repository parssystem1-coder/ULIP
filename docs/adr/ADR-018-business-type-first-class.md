# ADR 018 — Business Type as a First-Class Domain Concept

## Status
Accepted (remediation 2026-10-04)

## Context
The original model centered everything on Profession → Specialty → City. That
cannot represent Wholesalers, Manufacturers, Distributors, Importers or Brands
without abusing "profession". The product is a *business* discovery platform.

## Decision
The canonical classification structure is:

    Business Type (+ optional Industry) + Specialty (+ optional Sub-specialty)
    + Location (+ optional Brand attributes)

- `Business Type` (Wholesaler, Manufacturer, Service Provider, Retailer,
  Professional, Distributor, Importer, Exporter, Agency, Clinic, ...) is a
  first-class taxonomy kind (`node_kind = BUSINESS_TYPE`) and a first-class
  business attribute (`businesses.business_type_node_id`).
- **Profession is retired as a top-level term.** Where it remains useful it is
  modeled as taxonomy content under an appropriate Business Type (e.g.
  Professional), never as a parallel universal axis.
- Levels are optional per business (some businesses have only BT+Industry);
  hierarchy edges are enforced: BT→I→S→SS.

## Consequences
- Search, scoring dimensions, AI extraction outputs, API filters and NL-query
  parsing all carry businessType/industry/specialty — not profession.
- Migration: existing "profession" classification values map to
  BUSINESS_TYPE or INDUSTRY nodes during seed/migration authoring (no
  production data exists yet; seed taxonomy regenerated).
