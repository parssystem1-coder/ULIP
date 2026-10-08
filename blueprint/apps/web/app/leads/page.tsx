'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

/**
 * Phase 20: minimal usable NL search surface on the leads page.
 * Persian-first natural-language search through POST /leads/search/natural-
 * language — the response carries the parser provenance, the structured
 * query, ranked leads with deterministic reasons, and an honest discovery
 * plan. No fabrication: empty results stay empty, UNSUPPORTED stays visible.
 */

interface SearchReason {
  type: string;
  detail: string;
}

interface SearchLead {
  id: string;
  status: string;
  canonicalName: string;
  city: string | null;
  searchScore: number;
  reasons: SearchReason[];
  contentMatches: string[];
}

interface PlanStep {
  sourceName: string;
  sourceType: string;
  verdict: string;
  reason: string;
}

interface NlResponse {
  parser: { kind: string; provider: string; modelVersion: string; confidence: number };
  locale: string;
  unmatchedTerms: string[];
  resolution: { unresolved: string[]; contentTerms: string[] };
  execution: { mode: string; discoveryPlan: { steps: PlanStep[]; note: string; executed: boolean } };
  data: SearchLead[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface Lead {
  id: string;
  status: string;
  /** API contract is camelCase (RankedLead) — business_id/snake_case never existed. */
  businessId: string;
  canonicalName?: string | null;
  createdAt: string;
}

const VERDICT_COLOR: Record<string, string> = {
  SUPPORTED: '#7fd18b',
  PARTIAL: '#e0c36a',
  UNSUPPORTED: '#ff8080',
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<NlResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: Lead[] }>('/leads?limit=50')
      .then((r) => setLeads(r.data))
      .catch((e: Error) => setError(e.message));
  }, []);

  const runSearch = useCallback(async () => {
    const text = query.trim();
    if (text === '') return;
    setSearching(true);
    setSearchError(null);
    try {
      const r = await apiFetch<NlResponse>('/leads/search/natural-language', {
        method: 'POST',
        body: JSON.stringify({ text, limit: 20 }),
      });
      setResult(r);
    } catch (e) {
      setResult(null);
      setSearchError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <section>
      <h1>Leads</h1>
      {error !== null && <p style={{ color: '#ff8080' }}>{error}</p>}

      <div style={{ margin: '16px 0', maxWidth: 720 }}>
        <label htmlFor="nlq" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
          Natural-language search (فارسی / English)
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="nlq"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder="مثال: عمده‌فروشان قطعات پرینتر HP در تهران"
            style={{ flex: 1, padding: '8px 10px' }}
          />
          <button type="button" onClick={() => void runSearch()} disabled={searching || query.trim() === ''}>
            {searching ? '…' : 'Search'}
          </button>
        </div>
        {searchError !== null && <p style={{ color: '#ff8080' }}>{searchError}</p>}
      </div>

      {result !== null && (
        <div style={{ margin: '12px 0 24px', padding: 12, border: '1px solid #444', borderRadius: 8 }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{result.pagination.total}</strong> result(s) · page {result.pagination.page}/{result.pagination.totalPages} · parser:{' '}
            <code>{result.parser.kind}</code> ({result.parser.provider}/{result.parser.modelVersion}, confidence{' '}
            {(result.parser.confidence * 100).toFixed(0)}%)
          </p>
          {result.resolution.unresolved.length > 0 && (
            <p style={{ margin: '0 0 8px', color: '#e0c36a' }}>
              Unresolved terms (used as content free-text): {result.resolution.unresolved.join(', ')}
            </p>
          )}
          <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th>score</th><th>name</th><th>status</th><th>city</th><th>why</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((l) => (
                <tr key={l.id}>
                  <td>{l.searchScore.toFixed(0)}</td>
                  <td>{l.canonicalName}</td>
                  <td>{l.status}</td>
                  <td>{l.city ?? '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {l.reasons.map((r) => r.type).join(', ')}
                    {l.contentMatches.length > 0 && (
                      <div style={{ color: '#9ab', fontSize: 11 }}>“{l.contentMatches[0]}…”</div>
                    )}
                  </td>
                </tr>
              ))}
              {result.data.length === 0 && (
                <tr>
                  <td colSpan={5}>No leads matched this query yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {result.execution.discoveryPlan.steps.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer' }}>
                Discovery plan ({result.execution.mode}) — {result.execution.discoveryPlan.steps.length} source(s)
              </summary>
              <ul style={{ fontSize: 12 }}>
                {result.execution.discoveryPlan.steps.map((s, i) => (
                  <li key={i}>
                    <span style={{ color: VERDICT_COLOR[s.verdict] ?? '#ccc' }}>{s.verdict}</span>{' '}
                    <strong>{s.sourceName}</strong> ({s.sourceType}) — {s.reason}
                  </li>
                ))}
              </ul>
              <p style={{ fontSize: 11, color: '#9ab' }}>{result.execution.discoveryPlan.note}</p>
            </details>
          )}
        </div>
      )}

      <h2>All leads</h2>
      <table cellPadding={8} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>id</th><th>status</th><th>business</th><th>first seen</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <td>{l.id.slice(0, 8)}…</td>
              <td>{l.status}</td>
              <td>{l.canonicalName ?? `${l.businessId.slice(0, 8)}…`}</td>
              <td>{new Date(l.createdAt).toLocaleString('fa-IR')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
