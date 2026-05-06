import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { storage } from './storage';
import { api, TOKEN_KEY } from './api';
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
  avatar_url?: string;
};

type AuthContextShape = {
  loading: boolean;
  dealer: Dealer | null;
  signIn: (token: string, dealer: Dealer) => Promise<void>;
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
    (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Attach listeners early so deep-link from a cold-start tap fires
    try { attachPushListeners(); } catch {}
    return () => { cancelled = true; };
  }, [refresh]);

  // After we have a dealer, register for push (best-effort, non-blocking)
  useEffect(() => {
    if (!dealer) return;
    registerForPushNotifications().catch(() => {});
  }, [dealer?.id]);

  const signIn = useCallback(async (token: string, d: Dealer) => {
    try {
      await storage.setItem(TOKEN_KEY, token);
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
