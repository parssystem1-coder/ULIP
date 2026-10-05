import type { ReactNode } from 'react';

export const metadata = {
  title: 'ULIP — Universal Lead Intelligence Platform',
  description: 'Runtime foundation (Phase 14)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0f1115', color: '#e6e8ee' }}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          <nav style={{ width: 200, background: '#161a22', padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 24 }}>ULIP</div>
            <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
              <li><a href="/dashboard" style={{ color: '#9db4ff', textDecoration: 'none' }}>Dashboard</a></li>
              <li><a href="/leads" style={{ color: '#9db4ff', textDecoration: 'none' }}>Leads</a></li>
              <li><a href="/campaigns" style={{ color: '#9db4ff', textDecoration: 'none' }}>Campaigns</a></li>
              <li><a href="/sources" style={{ color: '#9db4ff', textDecoration: 'none' }}>Sources</a></li>
              <li><a href="/settings" style={{ color: '#9db4ff', textDecoration: 'none' }}>Settings</a></li>
            </ul>
          </nav>
          <main style={{ flex: 1, padding: 24 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
