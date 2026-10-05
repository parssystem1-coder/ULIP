'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Health {
  status: string;
  checks?: Record<string, boolean>;
}

export default function DashboardPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [ready, setReady] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Health>('/health')
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
    apiFetch<Health>('/ready')
      .then(setReady)
      .catch(() => undefined);
  }, []);

  return (
    <section>
      <h1>Dashboard</h1>
      <p>Runtime foundation (Phase 14) — وضعیت سرویس‌ها:</p>
      {error !== null && <p style={{ color: '#ff8080' }}>API error: {error}</p>}
      <ul>
        <li>health: {health?.status ?? '…'}</li>
        <li>
          ready: {ready?.status ?? '…'}
          {ready?.checks !== undefined && ` (postgres: ${String(ready.checks.postgres)})`}
        </li>
      </ul>
    </section>
  );
}
