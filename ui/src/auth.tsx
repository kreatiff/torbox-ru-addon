import React, { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { AuthContext, type AuthUser } from './auth-context.js';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as { authenticated: boolean; user?: AuthUser };
        return data.authenticated && data.user ? data.user : null;
      })
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-main)',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '400px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '40px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: '12px',
            backgroundColor: 'var(--accent-info)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 24px',
          }}
        >
          <Shield size={32} color="#fff" />
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: '22px' }}>TorBox RU Admin</h1>
        <p style={{ margin: '0 0 32px', color: 'var(--text-muted)', fontSize: '14px' }}>
          Sign in with Google to manage mappings and monitor health.
        </p>
        <a
          href="/auth/google"
          className="btn btn-primary"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            width: '100%',
            padding: '12px',
            fontSize: '14px',
            textDecoration: 'none',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#FFC107"
              d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
            />
            <path
              fill="#FF3D00"
              d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
            />
            <path
              fill="#4CAF50"
              d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
            />
            <path
              fill="#1976D2"
              d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
            />
          </svg>
          Sign in with Google
        </a>
      </div>
    </div>
  );
}
