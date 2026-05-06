import { storage } from './storage';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export const TOKEN_KEY = 'qdrives_token';
export const REFRESH_TOKEN_KEY = 'qdrives_refresh_token';

// Pluggable hook the auth provider sets to nuke session on hard 401s
// (SESSION_INVALIDATED, DEALER_ACCOUNT_SUSPENDED). Avoids an import cycle
// between auth.tsx and api.ts.
let onSessionKilled: (() => void) | null = null;
export function setOnSessionKilled(fn: (() => void) | null) {
  onSessionKilled = fn;
}

async function getToken() {
  return await storage.getItem(TOKEN_KEY);
}

async function tryRefresh(): Promise<string | null> {
  try {
    const rt = await storage.getItem(REFRESH_TOKEN_KEY);
    if (!rt) return null;
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.token) await storage.setItem(TOKEN_KEY, data.token);
    if (data?.refresh_token) await storage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
    return data?.token || null;
  } catch { return null; }
}

async function request<T = any>(path: string, options: RequestInit = {}, _retried = false): Promise<T> {
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
    const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);

    // 401 with token-expiry → try a transparent refresh once.
    if (res.status === 401 && !_retried && token && !path.startsWith('/auth/')) {
      const isExpired = detailStr === 'Token expired';
      if (isExpired) {
        const newTok = await tryRefresh();
        if (newTok) return request<T>(path, options, true);
      }
    }

    // Hard kill on session invalidation / suspension / wrong tv.
    if (res.status === 401 && (detailStr === 'SESSION_INVALIDATED' || detailStr === 'Wrong token kind')) {
      try { await storage.removeItem(TOKEN_KEY); } catch {}
      try { await storage.removeItem(REFRESH_TOKEN_KEY); } catch {}
      onSessionKilled?.();
    }
    if (res.status === 403 && detailStr === 'DEALER_ACCOUNT_SUSPENDED') {
      try { await storage.removeItem(TOKEN_KEY); } catch {}
      try { await storage.removeItem(REFRESH_TOKEN_KEY); } catch {}
      onSessionKilled?.();
    }
    throw new Error(detailStr);
  }
  return data as T;
}

export const api = {
  // ---- Auth (strict role-isolated allow-list endpoints) ----
  // No generic auth route exists. Each role has its own dedicated channel.
  dealerSendOtp: (phone: string) =>
    request('/auth/dealer/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  dealerVerifyOtp: (phone: string, otp: string) =>
    request('/auth/dealer/verify-otp', { method: 'POST', body: JSON.stringify({ phone, otp }) }),
  operatorSendOtp: (phone: string) =>
    request('/auth/operator/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  operatorVerifyOtp: (phone: string, otp: string) =>
    request('/auth/operator/verify-otp', { method: 'POST', body: JSON.stringify({ phone, otp }) }),

  me: () => request('/auth/me'),
  submitKyc: (payload: any) =>
    request<{ success: boolean; updated: boolean; dealer: any }>(
      '/auth/kyc',
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  auctions: (status?: string) => request(`/auctions${status ? `?status_filter=${status}` : ''}`),
  auction: (id: string) => request(`/auctions/${id}`),
  bid: (auctionId: string, amount: number) => request(`/auctions/${auctionId}/bid`, { method: 'POST', body: JSON.stringify({ amount }) }),

  cars: () => request('/cars'),
  car: (id: string) => request(`/cars/${id}`),
  createCar: (payload: any) => request('/cars', { method: 'POST', body: JSON.stringify(payload) }),

  watchlist: () => request('/watchlist'),
  addWatch: (id: string) => request(`/watchlist/${id}`, { method: 'POST' }),
  removeWatch: (id: string) => request(`/watchlist/${id}`, { method: 'DELETE' }),
  purchases: () => request<{ won: any[]; active: any[] }>('/purchases'),

  // ---- Media ----
  carMedia: (carId: string, section?: string) =>
    request<any[]>(`/cars/${carId}/media${section ? `?section=${section}` : ''}`),
  mediaCompleteness: (carId: string) =>
    request<any>(`/cars/${carId}/media/completeness`),
  deleteMedia: (id: string) => request(`/media/${id}`, { method: 'DELETE' }),
  reorderMedia: (carId: string, ordered_ids: string[]) =>
    request(`/cars/${carId}/media/reorder`, { method: 'POST', body: JSON.stringify({ ordered_ids }) }),
  setFeaturedMedia: (carId: string, mediaId: string) =>
    request(`/cars/${carId}/media/featured/${mediaId}`, { method: 'POST' }),
  patchMedia: (id: string, payload: { section?: string; subsection?: string }) =>
    request(`/media/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  attestNoDamage: (carId: string, val: boolean) =>
    request(`/cars/${carId}/attest-no-damage`, {
      method: 'POST',
      body: JSON.stringify({ no_damage_attested: val }),
    }),

  // ---- Admin operations ----
  adminDashboard: () => request<any>('/admin/dashboard'),
  adminDealers: (params?: { q?: string; status_filter?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.status_filter) qs.set('status_filter', params.status_filter);
    const s = qs.toString();
    return request<any[]>(`/admin/dealers${s ? `?${s}` : ''}`);
  },
  adminDealerDetail: (id: string) => request<any>(`/admin/dealers/${id}`),
  adminVerifyDealer: (id: string, payload: { verified?: boolean; suspended?: boolean; kyc_completed?: boolean }) =>
    request(`/admin/dealers/${id}/verify`, { method: 'POST', body: JSON.stringify(payload) }),
  adminSetMaxBid: (id: string, max_bid_limit: number | null) =>
    request<any>(`/admin/dealers/${id}/max-bid`, { method: 'POST', body: JSON.stringify({ max_bid_limit }) }),
  adminBroadcast: (payload: { title: string; body: string; audience?: string }) =>
    request<{ sent: number }>('/admin/notifications/broadcast', { method: 'POST', body: JSON.stringify(payload) }),

  // ---- Phase 2B: Live ops console ----
  adminLiveGrid: () => request<{ items: any[]; ts: string }>('/admin/auctions/live-grid'),
  adminAuctionControlPanel: (id: string) =>
    request<{ auction: any; car: any; bids: any[]; reversals: any[] }>(
      `/admin/auctions/${id}/control-panel`,
    ),
  adminPauseAuction: (id: string, reason: string) =>
    request(`/admin/auctions/${id}/pause`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminResumeAuction: (id: string) =>
    request(`/admin/auctions/${id}/resume`, { method: 'POST' }),
  adminExtendAuction: (id: string, extend_seconds: number, reason: string) =>
    request(`/admin/auctions/${id}/extend`, {
      method: 'POST', body: JSON.stringify({ extend_seconds, reason }),
    }),
  adminCancelAuction: (id: string, reason: string) =>
    request(`/admin/auctions/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminForceClose: (id: string, reason: string) =>
    request<{ ok: boolean; status: string }>(
      `/admin/auctions/${id}/force-close`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  adminCancelBid: (auctionId: string, bidId: string, reason: string) =>
    request<{ ok: boolean; reversal_id: string; current_bid: number }>(
      `/admin/auctions/${auctionId}/bids/${bidId}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  adminSettlementTransition: (id: string, target_state: string, note?: string) =>
    request<{ ok: boolean; status: string }>(`/admin/auctions/${id}/settlement`, {
      method: 'POST', body: JSON.stringify({ target_state, note: note || '' }),
    }),
  adminRiskDealers: () => request<any>('/admin/risk/dealers'),

  // ---- Allow-list (closed-network dealer onboarding) ----
  adminApprovedDealers: (params?: { q?: string; status_filter?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.status_filter) qs.set('status_filter', params.status_filter);
    const s = qs.toString();
    return request<any[]>(`/admin/approved-dealers${s ? `?${s}` : ''}`);
  },
  adminAddApprovedDealer: (payload: {
    phone: string; full_name?: string; dealership_name?: string; city?: string;
    trust_score?: number; max_bid_limit?: number | null; notes?: string;
  }) => request<any>('/admin/approved-dealers', { method: 'POST', body: JSON.stringify(payload) }),
  adminPatchApprovedDealer: (phone: string, payload: any) =>
    request(`/admin/approved-dealers/${encodeURIComponent(phone)}`, {
      method: 'PATCH', body: JSON.stringify(payload),
    }),
  adminRevokeApprovedDealer: (phone: string) =>
    request(`/admin/approved-dealers/${encodeURIComponent(phone)}`, { method: 'DELETE' }),

  // ---- Audit & Security ----
  adminAuditLogs: (params?: { action?: string; q?: string; since_hours?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.action) qs.set('action', params.action);
    if (params?.q) qs.set('q', params.q);
    if (params?.since_hours) qs.set('since_hours', String(params.since_hours));
    if (params?.limit) qs.set('limit', String(params.limit));
    const s = qs.toString();
    return request<{ items: any[]; total: number }>(`/admin/audit-logs${s ? `?${s}` : ''}`);
  },
  adminDeniedLogins: (since_hours?: number) => {
    const s = since_hours ? `?since_hours=${since_hours}` : '';
    return request<{ items: any[]; total_attempts: number; repeat_offenders: any[] }>(`/admin/security/denied-logins${s}`);
  },

  notifications: () => request('/notifications'),
  markNotificationsRead: () => request('/notifications/mark-read', { method: 'POST' }),
  unreadCount: () => request<{ unread: number }>('/notifications/unread-count'),
  registerPushToken: (token: string, platform?: string) =>
    request('/notifications/register-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  unregisterPushToken: (token: string) =>
    request('/notifications/unregister-token', { method: 'POST', body: JSON.stringify({ token }) }),
  testPush: (title?: string, body?: string) =>
    request('/notifications/test', { method: 'POST', body: JSON.stringify({ title, body }) }),

  dashboard: () => request('/dashboard/stats'),
  marketPulse: () => request('/market/pulse'),
  networkActivity: () => request('/network/activity'),
  priceEstimate: (payload: any) => request('/ai/price-estimate', { method: 'POST', body: JSON.stringify(payload) }),

  inspectionByCar: (carId: string) => request(`/inspections/by-car/${carId}`),
  uploadInspection: async (carId: string, fileUri: string, fileName: string, version = 'v1') => {
    const token = await storage.getItem(TOKEN_KEY);
    const form = new FormData();
    form.append('car_id', carId);
    form.append('version', version);
    // React Native FormData expects { uri, name, type } for native; on web we may have a Blob
    if (fileUri.startsWith('blob:') || fileUri.startsWith('data:')) {
      const blob = await (await fetch(fileUri)).blob();
      form.append('file', new File([blob], fileName, { type: 'application/pdf' }));
    } else {
      // @ts-ignore React Native form-data shape
      form.append('file', { uri: fileUri, name: fileName, type: 'application/pdf' });
    }
    const res = await fetch(`${BASE}/api/inspections/upload`, {
      method: 'POST',
      headers: { Authorization: token ? `Bearer ${token}` : '' },
      body: form,
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = (data && data.detail) || `Upload failed (${res.status})`;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return data;
  },
};

export async function inspectionPdfUrl(inspectionId: string): Promise<string> {
  const token = await storage.getItem(TOKEN_KEY);
  return `${BASE}/api/inspections/file/${inspectionId}?token=${encodeURIComponent(token || '')}`;
}

export async function wsUrl(auctionId: string): Promise<string> {
  const base = (BASE || '').replace(/^http/, 'ws');
  const token = await storage.getItem(TOKEN_KEY);
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/api/ws/auction/${auctionId}${qs}`;
}

export async function opsWsUrl(): Promise<string> {
  const base = (BASE || '').replace(/^http/, 'ws');
  const token = await storage.getItem(TOKEN_KEY);
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/api/ws/ops${qs}`;
}
