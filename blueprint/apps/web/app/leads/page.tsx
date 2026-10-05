'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Lead {
  id: string;
  status: string;
  business_id: string;
  first_seen_at: string;
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: Lead[] }>('/leads?limit=50')
      .then((r) => setLeads(r.data))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section>
      <h1>Leads</h1>
      {error !== null && <p style={{ color: '#ff8080' }}>{error}</p>}
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
              <td>{l.business_id.slice(0, 8)}…</td>
              <td>{new Date(l.first_seen_at).toLocaleString('fa-IR')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
