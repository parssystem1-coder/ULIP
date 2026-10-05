'use client';

import { useEffect, useState } from 'react';
import { getApiKey } from '../../lib/api';

export default function SettingsPage() {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    setSaved(getApiKey());
  }, []);

  const save = (e: React.FormEvent): void => {
    e.preventDefault();
    window.localStorage.setItem('ulip.apiKey', key.trim());
    setSaved(key.trim());
    setKey('');
  };

  return (
    <section>
      <h1>Settings</h1>
      <p>کلید API (فقط در مرورگر شما ذخیره می‌شود):</p>
      <form onSubmit={save} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Bearer API key"
        />
        <button type="submit">ذخیره</button>
      </form>
      {saved !== '' && <p style={{ color: '#7ddb91' }}>کلید فعلی: {saved.slice(0, 6)}…</p>}
    </section>
  );
}
