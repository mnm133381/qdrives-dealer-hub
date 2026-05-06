import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { storage } from './storage';
import { api, TOKEN_KEY, REFRESH_TOKEN_KEY, setOnSessionKilled } from './api';
import {
  registerForPushNotifications,
  unregisterFromPushNotifications,
  attachListeners as attachPushListeners,
} from './notifications';

type Dealer = {
  id: string;
  phone: string;
  full_name: string;
  dealership_name: string;
  city: string;
  kyc_completed: boolean;
  verified: boolean;
  trust_score: number;
  bid_success_rate: number;
  total_purchases: number;
  total_listed: number;
  role?: 'admin' | 'super_admin' | 'operations_admin' | 'inspection_admin' | 'dealer';
  avatar_url?: string;
  max_bid_limit?: number | null;
  suspended?: boolean;
  status?: 'pending' | 'approved' | 'suspended' | 'revoked';
  approved_at?: string | null;
  approved_by?: string | null;
  previous_status?: string | null;
  token_version?: number;
};

type AuthContextShape = {
  loading: boolean;
  dealer: Dealer | null;
  signIn: (token: string, dealer: Dealer, refreshToken?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextShape>({
  loading: true,
  dealer: null,
  signIn: async () => {},
  signOut: async () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [dealer, setDealer] = useState<Dealer | null>(null);

  const refresh = useCallback(async () => {
    let token: string | null = null;
    try {
      token = await storage.getItem(TOKEN_KEY);
    } catch (e) {
      // storage failure should never crash the app — proceed unauthed.
      // eslint-disable-next-line no-console
      console.warn('[auth] storage read failed:', e);
      token = null;
    }
    if (!token) {
      setDealer(null);
      return;
    }
    try {
      const me = await api.me();
      setDealer(me);
    } catch (e) {
      // Token invalid / network error — clear and let the user re-auth.
      // eslint-disable-next-line no-console
      console.warn('[auth] /me failed, clearing token:', e);
      setDealer(null);
      try { await storage.removeItem(TOKEN_KEY); } catch {}
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Register a global session-kill hook — when the api layer detects
    // SESSION_INVALIDATED / DEALER_ACCOUNT_SUSPENDED, it nukes storage and
    // notifies us to drop the dealer state so screens redirect to /(auth).
    setOnSessionKilled(() => { setDealer(null); });
    (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Attach listeners early so deep-link from a cold-start tap fires
    try { attachPushListeners(); } catch {}
    return () => { cancelled = true; setOnSessionKilled(null); };
  }, [refresh]);

  // Periodic /auth/me re-poll. If the operator bumps a dealer's
  // token_version (suspend / role change / max-bid update), the next /me
  // returns 401 SESSION_INVALIDATED → the api layer fires onSessionKilled
  // → setDealer(null) → all WS-using screens unmount and disconnect.
  // This closes the Phase 2A WS-auth gap (#d): re-validate WS auth on
  // tv-change. Polled every 30s while dealer is signed in.
  useEffect(() => {
    if (!dealer) return;
    const t = setInterval(() => { refresh().catch(() => {}); }, 30000);
    return () => clearInterval(t);
  }, [dealer?.id, refresh]);

  // After we have a dealer, register for push (best-effort, non-blocking)
  useEffect(() => {
    if (!dealer) return;
    registerForPushNotifications().catch(() => {});
  }, [dealer?.id]);

  const signIn = useCallback(async (token: string, d: Dealer, refreshToken?: string) => {
    try {
      await storage.setItem(TOKEN_KEY, token);
      if (refreshToken) await storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[auth] storage write failed (using in-memory):', e);
    }
    setDealer(d);
    // fire-and-forget
    registerForPushNotifications().catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    try { await unregisterFromPushNotifications(); } catch {}
    try {
      await storage.removeItem(TOKEN_KEY);
      await storage.removeItem(REFRESH_TOKEN_KEY);
    } catch {}
    setDealer(null);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, dealer, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
