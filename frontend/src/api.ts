import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export const TOKEN_KEY = 'qdrives_token';

async function getToken() {
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { ...options, headers });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = (data && data.detail) || `Request failed (${res.status})`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data as T;
}

export const api = {
  sendOtp: (phone: string) => request('/auth/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  verifyOtp: (phone: string, otp: string) => request('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phone, otp }) }),
  me: () => request('/auth/me'),
  submitKyc: (payload: any) => request('/auth/kyc', { method: 'POST', body: JSON.stringify(payload) }),

  auctions: (status?: string) => request(`/auctions${status ? `?status_filter=${status}` : ''}`),
  auction: (id: string) => request(`/auctions/${id}`),
  bid: (auctionId: string, amount: number) => request(`/auctions/${auctionId}/bid`, { method: 'POST', body: JSON.stringify({ amount }) }),

  cars: () => request('/cars'),
  car: (id: string) => request(`/cars/${id}`),
  createCar: (payload: any) => request('/cars', { method: 'POST', body: JSON.stringify(payload) }),

  watchlist: () => request('/watchlist'),
  addWatch: (id: string) => request(`/watchlist/${id}`, { method: 'POST' }),
  removeWatch: (id: string) => request(`/watchlist/${id}`, { method: 'DELETE' }),

  notifications: () => request('/notifications'),
  markNotificationsRead: () => request('/notifications/mark-read', { method: 'POST' }),

  dashboard: () => request('/dashboard/stats'),
  marketPulse: () => request('/market/pulse'),
  priceEstimate: (payload: any) => request('/ai/price-estimate', { method: 'POST', body: JSON.stringify(payload) }),
};

export function wsUrl(auctionId: string) {
  const base = (BASE || '').replace(/^http/, 'ws');
  return `${base}/api/ws/auction/${auctionId}`;
}
