import type { Database } from '@ulip/runtime';
import { aliasKey } from '@ulip/domain';
import type {
  ContactContext,
  LeadContext,
  LeadContentContext,
  LeadIdentityContext,
  LocationContext,
  RawPayloadContext,
  RuleClassificationContext,
  TaxonomyCatalog,
} from './contracts.ts';

const LEAD_SQL = `
  SELECT l.id, l.tenant_id, l.business_id, l.status::text AS status
  FROM leads l WHERE l.id = $1 AND l.tenant_id = $2`;

const TAXONOMY_SQL = `
  SELECT id, node_kind::text AS node_kind, name, slug, version
  FROM taxonomy_nodes WHERE tenant_id = $1`;

const ALIAS_SQL = `
  SELECT a.node_id, a.alias_norm
  FROM taxonomy_node_aliases a
  JOIN taxonomy_nodes n ON n.id = a.node_id
  WHERE n.tenant_id = $1`;

const RAW_SQL = `
  SELECT DISTINCT re.id, s.type::text AS source_type, re.external_id,
         re.entity_type, re.payload_json, re.collected_at
  FROM raw_entities re
  JOIN sources s ON s.id = re.source_id
  JOIN lead_identities li ON li.source_id = re.source_id AND li.lead_id = $1
  JOIN raw_entity_currents rc
    ON rc.source_id = re.source_id AND rc.external_id = re.external_id
   AND rc.raw_entity_id = re.id
  WHERE s.tenant_id = $2
    AND (re.external_id = li.external_id
         OR re.external_id = li.username
         OR re.payload_json->>'username' = li.username
         OR re.payload_json->>'external_id' = li.external_id)
  ORDER BY re.collected_at DESC
  LIMIT 5`;

async function loadTaxonomy(db: Database, tenantId: string): Promise<TaxonomyCatalog> {
  const [nodes, aliases] = await Promise.all([
    db.query<{ id: string; node_kind: string; name: string; slug: string; version: number }>(TAXONOMY_SQL, [tenantId]),
    db.query<{ node_id: string; alias_norm: string }>(ALIAS_SQL, [tenantId]),
  ]);
  const options = nodes.rows.map((n) => ({
    nodeId: n.id,
    label: n.name,
    nodeKind: n.node_kind as 'BUSINESS_TYPE' | 'INDUSTRY' | 'SPECIALTY' | 'SUB_SPECIALTY',
  }));
  const aliasList = aliases.rows.map((a) => ({ nodeId: a.node_id, aliasNorm: a.alias_norm }));
  // Slugs and names resolve through the same alias surface (ADR-019).
  for (const n of nodes.rows) {
    aliasList.push({ nodeId: n.id, aliasNorm: aliasKey(n.slug) });
    aliasList.push({ nodeId: n.id, aliasNorm: aliasKey(n.name) });
  }
  const version = nodes.rows.reduce((max, n) => Math.max(max, n.version), 1);
  return { nodes: options, aliases: aliasList, version };
}

/** Loads every input analysis may read, strictly tenant-scoped (404 = null). */
export async function loadLeadContext(
  db: Database,
  tenantId: string,
  leadId: string,
): Promise<LeadContext | null> {
  const lead = await db.query<{ id: string; tenant_id: string; business_id: string; status: string }>(LEAD_SQL, [leadId, tenantId]);
  const leadRow = lead.rows[0];
  if (leadRow === undefined) return null;

  const businessId = leadRow.business_id;
  const [biz, identities, contents, locations, contacts, classifications, raws, taxonomy] =
    await Promise.all([
      db.query<{ canonical_name: string; description: string | null; website: string | null; business_type_node_id: string | null; industry_node_id: string | null }>(
        'SELECT canonical_name, description, website, business_type_node_id, industry_node_id FROM businesses WHERE id = $1 AND tenant_id = $2',
        [businessId, tenantId],
      ),
      db.query<{ source_id: string; source_type: string; external_id: string; username: string | null; profile_url: string | null; display_name: string | null }>(
        `SELECT li.source_id, s.type::text AS source_type, li.external_id, li.username, li.profile_url, li.display_name
         FROM lead_identities li JOIN sources s ON s.id = li.source_id
         WHERE li.lead_id = $1 AND s.tenant_id = $2`,
        [leadId, tenantId],
      ),
      db.query<{ id: string; content_type: string; text: string | null; media_url: string | null; published_at: string | null; retrieved_at: string; metadata: Record<string, unknown> }>(
        `SELECT id, content_type::text AS content_type, text, media_url, published_at, retrieved_at, metadata
         FROM lead_contents WHERE lead_id = $1
         ORDER BY published_at DESC NULLS LAST LIMIT 50`,
        [leadId],
      ),
      db.query<{ country: string; province: string | null; city: string | null; district: string | null; raw_value: string; availability: string; confidence: number | null }>(
        `SELECT country, province, city, district, raw_value, availability::text AS availability, confidence
         FROM business_locations WHERE business_id = $1`,
        [businessId],
      ),
      db.query<{ kind: string; availability: string; is_sensitive: boolean }>(
        `SELECT kind::text AS kind, availability::text AS availability, is_sensitive
         FROM business_contacts WHERE business_id = $1`,
        [businessId],
      ),
      db.query<{ classification_type: string; taxonomy_node_id: string | null; value_text: string | null; value_normalized: string | null; source: string; confidence: number | null }>(
        `SELECT classification_type::text AS classification_type, taxonomy_node_id, value_text,
                value_normalized, source::text AS source, confidence
         FROM lead_classifications WHERE lead_id = $1`,
        [leadId],
      ),
      db.query<{ id: string; source_type: string; external_id: string; entity_type: string; payload_json: Record<string, unknown>; collected_at: string }>(RAW_SQL, [leadId, tenantId]),
      loadTaxonomy(db, tenantId),
    ]);

  const bizRow = biz.rows[0];
  const identityRows: LeadIdentityContext[] = identities.rows.map((r) => ({
    sourceId: r.source_id,
    sourceType: r.source_type,
    externalId: r.external_id,
    username: r.username,
    profileUrl: r.profile_url,
    displayName: r.display_name,
  }));
  const contentRows: LeadContentContext[] = contents.rows.map((r) => ({
    id: r.id,
    contentType: r.content_type,
    text: r.text,
    mediaUrl: r.media_url,
    publishedAt: r.published_at,
    retrievedAt: r.retrieved_at,
    metadata: r.metadata,
  }));
  const locationRows: LocationContext[] = locations.rows.map((r) => ({
    country: r.country,
    province: r.province,
    city: r.city,
    district: r.district,
    rawValue: r.raw_value,
    availability: r.availability as LocationContext['availability'],
    confidence: r.confidence,
  }));
  const contactRows: ContactContext[] = contacts.rows.map((r) => ({
    kind: r.kind,
    availability: r.availability as ContactContext['availability'],
    isSensitive: r.is_sensitive,
  }));
  const classificationRows: RuleClassificationContext[] = classifications.rows.map((r) => ({
    classificationType: r.classification_type as RuleClassificationContext['classificationType'],
    taxonomyNodeId: r.taxonomy_node_id,
    valueText: r.value_text,
    valueNormalized: r.value_normalized,
    source: r.source as RuleClassificationContext['source'],
    confidence: r.confidence,
  }));
  const rawRows: RawPayloadContext[] = raws.rows.map((r) => ({
    rawId: r.id,
    sourceType: r.source_type,
    externalId: r.external_id,
    entityType: r.entity_type,
    collectedAt: r.collected_at,
    payload: r.payload_json,
  }));

  return {
    leadId: leadRow.id,
    tenantId: leadRow.tenant_id,
    businessId,
    status: leadRow.status as LeadContext['status'],
    analysisMode: 'STANDARD',
    business: {
      canonicalName: bizRow?.canonical_name ?? '',
      description: bizRow?.description ?? null,
      website: bizRow?.website ?? null,
      businessTypeNodeId: bizRow?.business_type_node_id ?? null,
      industryNodeId: bizRow?.industry_node_id ?? null,
    },
    identities: identityRows,
    contents: contentRows,
    rawPayloads: rawRows,
    locations: locationRows,
    contacts: contactRows,
    existingClassifications: classificationRows,
    taxonomy,
  };
}
