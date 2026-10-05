'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Campaign {
  id: string;
  name: string;
  status: string;
}

export default function CampaignsPage() {
  const [rows, setRows] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: Campaign[] }>('/campaigns')
      .then((r) => setRows(r.data))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section>
      <h1>Campaigns</h1>
      {error !== null && <p style={{ color: '#ff8080' }}>{error}</p>}
      <ul>
        {rows.map((c) => (
          <li key={c.id}>{c.name} — {c.status}</li>
        ))}
      </ul>
    </section>
  );
}
