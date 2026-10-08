/**
 * Taxonomy resolver (Phase 20) — turns parsed filter terms (labels, slugs,
 * Persian aliases, node ids) into tenant-scoped taxonomy node ids.
 *
 * Reuses the alias surfaces that already exist:
 *  - taxonomy_nodes (slug, name) — resolved through the same aliasKey
 *    normalization as stored alias_norm values (ADR-019);
 *  - taxonomy_node_aliases (alias_norm) — Persian/English variants;
 *  - location_aliases (alias_norm → canonical country/city).
 *
 * Everything is tenant-scoped; a node id that belongs to another tenant does
 * not resolve. Unmatched terms are reported, never silently dropped.
 */

import { aliasKey } from '@ulip/domain';
import type { LeadSearchFilters } from '@ulip/domain/contracts';
import type { Database } from '@ulip/runtime';
import type {
  ResolvedTaxonomy,
  ResolvedTerm,
  TaxonomyField,
  TaxonomyResolver,
} from './contracts.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL rejects U+0000 in strings; NULs can never match real data. */
function stripNuls(value: string): string {
  return value.split('\u0000').join('');
}

interface NodeRow {
  id: string;
  node_kind: string;
  slug: string;
  name: string;
}

interface AliasRow {
  node_id: string;
  alias_norm: string;
}

interface LocationAliasRow {
  country: string;
  city: string;
}

const KIND_FOR_FIELD: Readonly<Record<TaxonomyField, string>> = {
  businessTypes: 'BUSINESS_TYPE',
  industries: 'INDUSTRY',
  specialties: 'SPECIALTY',
  subSpecialties: 'SUB_SPECIALTY',
};

export class DbTaxonomyResolver implements TaxonomyResolver {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async resolve(tenantId: string, filters: LeadSearchFilters): Promise<ResolvedTaxonomy> {
    const [nodes, aliases, locationAliases] = await Promise.all([
      this.db.query<NodeRow>(
        `SELECT id, node_kind::text AS node_kind, slug, name FROM taxonomy_nodes WHERE tenant_id = $1`,
        [tenantId],
      ),
      this.db.query<AliasRow>(
        `SELECT a.node_id, a.alias_norm FROM taxonomy_node_aliases a
         JOIN taxonomy_nodes n ON n.id = a.node_id WHERE n.tenant_id = $1`,
        [tenantId],
      ),
      this.db.query<LocationAliasRow>(
        `SELECT country, city FROM location_aliases WHERE alias_norm = $1 LIMIT 1`,
        [aliasKey(stripNuls(filters.city ?? ''))],
      ),
    ]);

    // aliasKey(node) → node id maps: slugs and names resolve through the same
    // normalization surface as stored aliases.
    const bySlug = new Map<string, NodeRow>();
    const byName = new Map<string, NodeRow>();
    for (const n of nodes.rows) {
      bySlug.set(aliasKey(n.slug), n);
      byName.set(aliasKey(n.name), n);
    }
    const byAlias = new Map<string, string>();
    for (const a of aliases.rows) {
      if (!byAlias.has(a.alias_norm)) byAlias.set(a.alias_norm, a.node_id);
    }
    const byId = new Map(nodes.rows.map((n) => [n.id, n]));

    const result: ResolvedTaxonomy = {
      businessTypes: [],
      industries: [],
      specialties: [],
      subSpecialties: [],
      terms: [],
      unresolved: [],
      city: null,
    };

    const fields: TaxonomyField[] = ['businessTypes', 'industries', 'specialties', 'subSpecialties'];
    for (const field of fields) {
      const values = filters[field];
      if (values === undefined) continue;
      const kind = KIND_FOR_FIELD[field];
      for (const rawValue of values) {
        const term = stripNuls(String(rawValue)).trim();
        if (term === '') continue;
        if (UUID_RE.test(term)) {
          const node = byId.get(term);
          if (node !== undefined && node.node_kind === kind) {
            result[field].push(node.id);
            result.terms.push({ field, term, nodeId: node.id, via: 'ID' });
          } else {
            result.unresolved.push(term);
            result.terms.push({ field, term, nodeId: null, via: 'UNRESOLVED' });
          }
          continue;
        }
        const key = aliasKey(term);
        const slugNode = bySlug.get(key);
        if (slugNode !== undefined && slugNode.node_kind === kind) {
          result[field].push(slugNode.id);
          result.terms.push({ field, term, nodeId: slugNode.id, via: 'SLUG' });
          continue;
        }
        const nameNode = byName.get(key);
        if (nameNode !== undefined && nameNode.node_kind === kind) {
          result[field].push(nameNode.id);
          result.terms.push({ field, term, nodeId: nameNode.id, via: 'NAME' });
          continue;
        }
        const aliasNode = byAlias.get(key);
        if (aliasNode !== undefined) {
          const node = byId.get(aliasNode);
          if (node !== undefined && node.node_kind === kind) {
            result[field].push(node.id);
            result.terms.push({ field, term, nodeId: node.id, via: 'ALIAS' });
            continue;
          }
        }
        // No node of the expected kind: report honestly.
        result.unresolved.push(term);
        result.terms.push({ field, term, nodeId: null, via: 'UNRESOLVED' });
      }
    }

    if (filters.city !== undefined && stripNuls(filters.city).trim() !== '') {
      const raw = stripNuls(filters.city).trim();
      const loc = locationAliases.rows[0];
      if (loc !== undefined) {
        result.city = { raw, canonical: loc.city, country: loc.country };
      } else {
        // No location alias: the raw term still filters via ILIKE in the executor.
        result.city = { raw, canonical: raw, country: null };
      }
    }

    return result;
  }
}
