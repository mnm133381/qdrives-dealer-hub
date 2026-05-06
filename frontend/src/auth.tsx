import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, TOKEN_KEY } from './api';

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
    try {
      const token = await AsyncStorage.getItem(TOKEN_KEY);
      if (!token) {
        setDealer(null);
        return;
      }
      const me = await api.me();
      setDealer(me);
    } catch {
      setDealer(null);
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const signIn = useCallback(async (token: string, d: Dealer) => {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    setDealer(d);
  }, []);

  const signOut = useCallback(async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setDealer(null);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, dealer, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
