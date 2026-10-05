'use client';

/**
 * Minimal API client (Phase 14). The API key is entered once in Settings and
 * kept in localStorage; every request carries it as a Bearer token. Requests
 * go through NEXT_PUBLIC_API_URL (default http://localhost:3001).
 */

export function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  return `${base}${path}`;
}

export function getApiKey(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem('ulip.apiKey') ?? '';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(key !== '' ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
