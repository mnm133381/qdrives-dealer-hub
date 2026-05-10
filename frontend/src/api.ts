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
  // OTP transport: Firebase Phone Auth dispatches the SMS from the
  // client SDK; we post the resulting Firebase ID token to verify-otp
  // and the backend verifies it via firebase-admin. The legacy `otp`
  // string param is retained only for the (off-by-default) DEV bypass.
  dealerSendOtp: (phone: string) =>
    request('/auth/dealer/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  dealerVerifyOtp: (phone: string, firebase_id_token: string) =>
    request('/auth/dealer/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone, firebase_id_token }),
    }),
  operatorSendOtp: (phone: string) =>
    request('/auth/operator/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  operatorVerifyOtp: (phone: string, firebase_id_token: string) =>
    request('/auth/operator/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone, firebase_id_token }),
    }),

  me: () => request('/auth/me'),
  submitKyc: (payload: any) =>
    request<{ success: boolean; updated: boolean; dealer: any }>(
      '/auth/kyc',
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  auctions: (status?: string) => request(`/auctions${status ? `?status_filter=${status}` : ''}`),
  auction: (id: string) => request(`/auctions/${id}`),
  // Place a bid. `idempotency_key` (optional, recommended) is a
  // client-generated UUID — when supplied, retries from the bid retry
  // queue are deduplicated server-side so a flaky network can't cause
  // a double-bid. Old callers omitting the key still get the atomic
  // CAS path (no double-spend) but lose retry-safety.
  bid: (auctionId: string, amount: number, idempotency_key?: string) =>
    request<{ success: boolean; bid: any; seq?: number }>(
      `/auctions/${auctionId}/bid`,
      {
        method: 'POST',
        body: JSON.stringify(idempotency_key ? { amount, idempotency_key } : { amount }),
      },
    ),
  // Authoritative reconnect snapshot. Always preferred over locally
  // accumulated state when there's any conflict.
  auctionSnapshot: (auctionId: string) =>
    request<{ auction: any; bids: any[]; seq: number; server_ns: number }>(
      `/auctions/${auctionId}/snapshot`,
    ),
  // Lightweight client-side anomaly report (out-of-order frames,
  // resyncs, etc.) — fire-and-forget, never blocks UI.
  realtimeReport: (payload: {
    event: string;
    auction_id?: string;
    expected_seq?: number;
    got_seq?: number;
    detail?: string;
  }) =>
    request<{ ok: boolean }>('/realtime/report', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // Operator-only realtime health summary (live WS gauge + 1h event counts).
  adminRealtimeHealth: () =>
    request<{
      live_ws: number;
      rooms: Array<{ room: string; count: number; roles: string[] }>;
      events_1h: Record<string, number>;
      active_storms: Array<{ dealer_id: string; events_in_window: number; reconnects_5min: number; room?: string }>;
      race_top_auctions: Array<{ auction_id: string; conflicts_1h: number }>;
      close_races_1h: Array<{ auction_id: string; skew_ms: number; dealer_id?: string; ts?: string }>;
      broadcast_lag_ms: { samples: number; p50: number | null; p95: number | null; max: number | null };
      auctions: { live: number; ending_in_5m: number; paused: number };
      alerts: Array<{ id: string; severity: 'critical' | 'warn' | 'info'; title: string; detail: string; route?: string | null }>;
      thresholds: Record<string, number>;
      server_ns: number;
      generated_at: string;
    }>('/admin/realtime/health'),

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

  // ──────────────────────────────────────────────────────────────
  // Reputation Engine (P1)
  // ──────────────────────────────────────────────────────────────
  reputationMe: () => request<any>('/reputation/me'),
  reputationMeTimeline: (limit = 100) => request<any[]>(`/reputation/me/timeline?limit=${limit}`),
  reputationDealerSummary: (dealerId: string) =>
    request<any>(`/reputation/dealer/${dealerId}/summary`),

  adminReputationList: (params?: { sort?: string; tier?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.sort) q.set('sort', params.sort);
    if (params?.tier) q.set('tier', params.tier);
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<any[]>(`/admin/reputation/dealers${qs ? `?${qs}` : ''}`);
  },
  adminReputationDealer: (dealerId: string) =>
    request<any>(`/admin/reputation/dealer/${dealerId}`),
  adminReputationAdjust: (dealerId: string, delta: number, reason: string) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/adjust`, {
      method: 'POST', body: JSON.stringify({ delta, reason }),
    }),
  adminReputationSuspend: (dealerId: string, reason: string, duration_hours?: number | null) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/suspend`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours: duration_hours ?? null }),
    }),
  adminReputationCooldown: (dealerId: string, reason: string, duration_hours: number) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/cooldown`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours }),
    }),
  adminReputationShadow: (dealerId: string, reason: string, duration_hours?: number | null) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/shadow-restrict`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours: duration_hours ?? null }),
    }),
  adminReputationFlag: (dealerId: string, reason: string) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/flag`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours: null }),
    }),
  adminReputationForceKyc: (dealerId: string, reason: string) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/force-kyc-review`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours: null }),
    }),
  adminReputationLift: (dealerId: string, kind: string, reason: string) =>
    request<any>(`/admin/reputation/dealer/${dealerId}/lift/${kind}`, {
      method: 'POST', body: JSON.stringify({ reason, duration_hours: null }),
    }),
  adminReputationAddNote: (dealerId: string, note: string, visibility: 'operator' | 'dealer' = 'operator') =>
    request<any>(`/admin/reputation/dealer/${dealerId}/notes`, {
      method: 'POST', body: JSON.stringify({ note, visibility }),
    }),

  // ──────────────────────────────────────────────────────────────
  // Disputes (P1)
  // ──────────────────────────────────────────────────────────────
  disputeTypes: () => request<any[]>('/disputes/types'),
  disputesMine: () => request<any[]>('/disputes/me'),
  raiseDispute: (payload: {
    against_dealer_id?: string | null; auction_id?: string | null;
    dispute_type: string; title: string; description: string;
  }) => request<any>('/disputes', { method: 'POST', body: JSON.stringify(payload) }),
  getDispute: (id: string) => request<any>(`/disputes/${id}`),
  getDisputeEvidenceContent: (id: string, evidenceId: string) =>
    request<any>(`/disputes/${id}/evidence/${evidenceId}`),
  postDisputeMessage: (id: string, body: string) =>
    request<any>(`/disputes/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }),
  postDisputeEvidence: (id: string, payload: {
    kind: 'image' | 'document' | 'note'; filename?: string;
    mime_type?: string; content_base64?: string; note?: string;
  }) => request<any>(`/disputes/${id}/evidence`, { method: 'POST', body: JSON.stringify(payload) }),
  withdrawDispute: (id: string, reason?: string) =>
    request<any>(`/disputes/${id}/withdraw`, { method: 'POST', body: JSON.stringify({ reason: reason || null }) }),

  adminDisputeQueue: (params?: { state?: string; dispute_type?: string; only_open?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.state) q.set('state', params.state);
    if (params?.dispute_type) q.set('dispute_type', params.dispute_type);
    if (params?.only_open !== undefined) q.set('only_open', String(params.only_open));
    const qs = q.toString();
    return request<any[]>(`/admin/disputes/queue${qs ? `?${qs}` : ''}`);
  },
  adminDisputeSummary: () => request<any>('/admin/disputes/summary'),
  adminDisputeTakeReview: (id: string) =>
    request<any>(`/admin/disputes/${id}/take-review`, { method: 'POST' }),
  adminDisputeRequestEvidence: (id: string, requestText: string) =>
    request<any>(`/admin/disputes/${id}/request-evidence`, {
      method: 'POST', body: JSON.stringify({ request: requestText }),
    }),
  adminDisputeEscalate: (id: string, reason: string) =>
    request<any>(`/admin/disputes/${id}/escalate`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  adminDisputeDecide: (id: string, outcome: string, reason: string) =>
    request<any>(`/admin/disputes/${id}/decide`, {
      method: 'POST', body: JSON.stringify({ outcome, reason }),
    }),
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
  adminApproveDealer: (id: string, payload?: { note?: string; max_bid_limit?: number }) =>
    request<any>(`/admin/dealers/${id}/approve`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  adminSetMaxBid: (id: string, max_bid_limit: number | null) =>
    request<any>(`/admin/dealers/${id}/max-bid`, { method: 'POST', body: JSON.stringify({ max_bid_limit }) }),

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
  adminSettlementPipeline: (window_days = 30) =>
    request<{ items: any[]; by_state: Record<string, number>; ts: string; sla_hours: number; high_value_threshold: number }>(
      `/admin/settlements/pipeline?window_days=${window_days}`,
    ),
  adminSettlementAddNote: (id: string, note: string) =>
    request<{ ok: boolean; note: any }>(`/admin/auctions/${id}/settlement/note`, {
      method: 'POST', body: JSON.stringify({ note }),
    }),

  // ---- Settlement v2 (16-state, operator-controlled) ----
  settlementStatesCatalog: () => request<any>('/settlements/states'),
  settlementsMine: () => request<any[]>('/settlements/me'),
  settlementMine: (id: string) => request<any>(`/settlements/${id}`),
  settlementMarkPaymentSent: (id: string, payload: {
    kind?: string; filename?: string; mime_type?: string; content_base64?: string; note?: string;
  }) => request<any>(`/settlements/${id}/mark-payment-sent`, {
    method: 'POST', body: JSON.stringify(payload),
  }),
  settlementMyProof: (id: string) => request<any>(`/settlements/${id}/proof`),

  adminSettlementsQueue: (state?: string, limit = 200) =>
    request<any[]>(`/admin/settlements/queue?limit=${limit}${state ? `&state=${state}` : ''}`),
  adminSettlementsSummary: () =>
    request<{ by_state: Record<string, number>; buckets: Record<string, number>; total_open: number }>(
      '/admin/settlements/summary',
    ),
  adminSettlementDetail: (id: string) =>
    request<any>(`/admin/settlements/${id}`),
  adminSettlementTransitionV2: (id: string, action: string, payload?: Record<string, any>, reason?: string) =>
    request<any>(`/admin/settlements/${id}/transition`, {
      method: 'POST', body: JSON.stringify({ action, payload: payload || null, reason: reason || null }),
    }),
  adminSettlementInternalNote: (id: string, text: string) =>
    request<any>(`/admin/settlements/${id}/note`, {
      method: 'POST', body: JSON.stringify({ text }),
    }),
  adminSettlementDealerMessage: (id: string, text: string) =>
    request<any>(`/admin/settlements/${id}/dealer-message`, {
      method: 'POST', body: JSON.stringify({ text }),
    }),
  adminSettlementProof: (id: string) =>
    request<any>(`/admin/settlements/${id}/proof`),

  // ---- Seller portal (read-only owner tracking) ----
  // Same Firebase-Phone-Auth flow as dealer/operator. The seller
  // verify endpoint additionally checks the phone is on the
  // operator-curated sellers allow-list before issuing a JWT.
  sellerSendOtp: (phone: string) =>
    request<{ ok: boolean; provider?: string }>('/auth/seller/send-otp', {
      method: 'POST', body: JSON.stringify({ phone }),
    }),
  sellerVerifyOtp: (phone: string, firebase_id_token: string) =>
    request<{ token: string; seller: any }>('/auth/seller/verify-otp', {
      method: 'POST', body: JSON.stringify({ phone, firebase_id_token }),
    }),
  sellerMe: () => request<any>('/seller/me'),
  sellerVehicles: () => request<any[]>('/seller/vehicles'),
  sellerVehicleDetail: (id: string) => request<any>(`/seller/vehicles/${id}`),

  adminSellersList: (status?: string, limit = 200) =>
    request<any[]>(`/admin/sellers?limit=${limit}${status ? `&status=${status}` : ''}`),
  adminSellersCreate: (name: string, phone: string, email?: string) =>
    request<any>('/admin/sellers', {
      method: 'POST', body: JSON.stringify({ name, phone, email: email || null }),
    }),
  adminSellerDetail: (id: string) => request<any>(`/admin/sellers/${id}`),
  adminSellerLinkVehicle: (id: string, payload: { car_id?: string; registration_number?: string }) =>
    request<any>(`/admin/sellers/${id}/link-vehicle`, {
      method: 'POST', body: JSON.stringify(payload),
    }),
  adminSellerLookupVehicle: (q: string) =>
    request<any[]>(`/admin/sellers/lookup-vehicle?q=${encodeURIComponent(q)}`),

  // ---- Operator broadcasts ----
  adminBroadcastTemplates: () => request<any[]>('/admin/broadcasts/templates'),
  adminBroadcastsRecent: (limit = 30) => request<any[]>(`/admin/broadcasts/recent?limit=${limit}`),
  adminBroadcastAuctions: () => request<any[]>('/admin/broadcasts/auctions'),
  adminBroadcastSend: (payload: {
    type: string;
    auction_id?: string;
    title?: string;
    body?: string;
    audience?: string;
    dealer_ids?: string[];
  }) => request<any>('/admin/broadcasts', { method: 'POST', body: JSON.stringify(payload) }),
  adminSellerSendAccess: (id: string) =>
    request<any>(`/admin/sellers/${id}/send-access`, { method: 'POST', body: JSON.stringify({}) }),
  adminSellerRevoke: (id: string, reason?: string) =>
    request<any>(`/admin/sellers/${id}/revoke`, {
      method: 'POST', body: JSON.stringify({ reason: reason || null }),
    }),

  // ---- Phase 2C lifecycle ----
  inventoryWithdraw: (id: string, reason: string) =>
    request<{ ok: boolean; status: string }>(`/inventory/${id}/withdraw`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  inventoryArchive: (id: string, note?: string) =>
    request<{ ok: boolean; status: string }>(`/inventory/${id}/archive`, {
      method: 'POST', body: JSON.stringify({ note: note || '' }),
    }),
  inventorySetReserve: (id: string, reserve_price: number) =>
    request<{ ok: boolean; reserve_price: number }>(`/inventory/${id}/reserve`, {
      method: 'POST', body: JSON.stringify({ reserve_price }),
    }),
  adminInventoryLock: (id: string, locked: boolean, reason?: string) =>
    request<{ ok: boolean; operator_lock: boolean }>(`/admin/inventory/${id}/lock`, {
      method: 'POST', body: JSON.stringify({ locked, reason: reason || '' }),
    }),
  adminInventoryLifecycle: (id: string) =>
    request<{ auction_id: string; current_status: string; operator_lock: boolean; canonical: any; events: any[] }>(
      `/admin/inventory/${id}/lifecycle`,
    ),

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
  // Silent funnel tracking — fired when a dealer opens a single
  // notification (used to attribute Broadcast → Opened in
  // db.broadcast_events). Best-effort; failures are swallowed.
  notificationOpen: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/open`, { method: 'POST' }),
  // Silent funnel tracking — fired when a dealer lands on an auction
  // page. `from_broadcast_id` carries explicit deep-link attribution;
  // server falls back to recent-broadcast lookup when omitted.
  auctionTrackView: (auctionId: string, fromBroadcastId?: string) =>
    request<{ ok: boolean; tracked: boolean }>(
      `/auctions/${auctionId}/track-view`,
      {
        method: 'POST',
        body: JSON.stringify({ from_broadcast_id: fromBroadcastId || null }),
      },
    ),
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
