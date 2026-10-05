'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Source {
  id: string;
  type: string;
  name: string;
  status: string;
}

export default function SourcesPage() {
  const [rows, setRows] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState('INSTAGRAM');
  const [name, setName] = useState('');

  const refresh = (): void => {
    apiFetch<{ data: Source[] }>('/sources')
      .then((r) => setRows(r.data))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(refresh, []);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/sources', { method: 'POST', body: JSON.stringify({ type, name }) });
      setName('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <h1>Sources</h1>
      {error !== null && <p style={{ color: '#ff8080' }}>{error}</p>}
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
        <input value={type} onChange={(e) => setType(e.target.value)} placeholder="type" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" required />
        <button type="submit">افزودن</button>
      </form>
      <ul>
        {rows.map((s) => (
          <li key={s.id}>{s.name} ({s.type}) — {s.status}</li>
        ))}
      </ul>
    </section>
  );
}
