# Index and Query Strategy

Mirrors `database/schema/schema.sql`. When they disagree, the schema/migrations win.

## Required baseline indexes (declared in schema)

```sql
-- taxonomy
CREATE UNIQUE INDEX uniq_taxonomy_root_slug ON taxonomy_nodes (tenant_id, slug) WHERE parent_id IS NULL;
CREATE INDEX idx_taxonomy_aliases_norm ON taxonomy_node_aliases (alias_norm);
CREATE UNIQUE INDEX uniq_location_alias ON location_aliases (country, alias_norm);

-- discovery / leads
CREATE INDEX idx_lead_identities_lead ON lead_identities (lead_id);
CREATE INDEX idx_locations_city ON business_locations (country, city);
CREATE INDEX idx_businesses_type_industry ON businesses (tenant_id, business_type_node_id, industry_node_id);
CREATE INDEX idx_classifications_lead_type ON lead_classifications (lead_id, classification_type);
CREATE INDEX idx_classifications_node ON lead_classifications (taxonomy_node_id);

-- current-version fast paths (ADR-024)
CREATE UNIQUE INDEX uniq_leads_analysis_current ON lead_analyses (lead_id) WHERE is_current = TRUE;
CREATE INDEX idx_leads_analysis_current_existence ON lead_analyses (lead_id, confidence DESC) WHERE is_current = TRUE;
CREATE UNIQUE INDEX uniq_leads_score_current ON lead_scores (lead_id) WHERE is_current = TRUE;
CREATE INDEX idx_leads_scores_current_filters ON lead_scores (relevance_score DESC) WHERE is_current = TRUE;

-- evidence / content / ai / jobs / audit
CREATE INDEX idx_evidence_lead ON evidence (lead_id);
CREATE INDEX idx_evidence_analysis ON evidence (analysis_id);
CREATE INDEX idx_content_lead_published ON lead_contents (lead_id, published_at DESC);
CREATE INDEX idx_ai_runs_tenant_created ON ai_runs (tenant_id, created_at DESC);
CREATE INDEX idx_jobs_tenant_status ON jobs (tenant_id, status, priority DESC);
CREATE INDEX idx_jobs_correlation ON jobs (correlation_id);
CREATE INDEX idx_erc_pending ON entity_resolution_candidates (tenant_id, status) WHERE status = 'PENDING';
CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);
```

(Plus the table-level `UNIQUE` constraints: `lead_identities(source_id,
external_id)`, `raw_entities(source_id, external_id, content_hash)`,
`idempotency_keys(tenant_id, scope, idempotency_key)`.)

## Query rules

1. Always constrain tenant-scoped queries by tenant (server-resolved context).
2. Lead-list score filters hit the `is_current` partial indexes — never scan
   full history tables (ADR-024).
3. Avoid filtering on unindexed JSONB fields at high frequency; promote
   hot fields to columns instead.
4. Paginate with stable ordering; switch to cursor pagination when offset
   becomes expensive.
5. Avoid N+1 reads in Lead list/detail endpoints.
6. Never join `raw_entities` payloads into lead list queries.

## Search evolution

PostgreSQL full-text/GIN handles early text search (with the persian
normalization layer feeding it). Introduce OpenSearch only after measuring a
requirement that Postgres cannot handle acceptably.
