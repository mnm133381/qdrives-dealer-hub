/**
 * Resilient auction WebSocket hook.
 *
 * Responsibilities:
 *   • Open / close the WS using the existing wsUrl() helper.
 *   • Heartbeat: send {type:"ping"} every 25s; if no traffic at all
 *     for 60s, force-reconnect so dead-but-not-closed sockets are
 *     replaced.
 *   • Auto-reconnect with exponential backoff + jitter, capped.
 *   • Sequence-aware buffering: every inbound frame carries optional
 *     `seq` + `server_ns`. Out-of-order frames (`seq <= last_seq`) are
 *     dropped. Gaps (`seq > last_seq + 1`) trigger a snapshot fetch
 *     to reconcile against the server's authoritative state.
 *   • On every reconnect, the snapshot is the source of truth — the
 *     callback `onSnapshot` is fired with the server-provided state
 *     and the client MUST replace its local view.
 *
 * Wire format is fully backward compatible: the server emits the same
 * event types as before; new fields (`seq`, `server_ns`) are additive.
 * Old clients without this hook simply ignore them.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { api, wsUrl } from './api';

// Heartbeat / reconnect tunables — chosen so a 100s ingress idle-cap
// (Cloudflare default) cannot kill the connection silently.
const PING_INTERVAL_MS = 25_000;
const STALL_TIMEOUT_MS = 60_000;   // no traffic in 60s → force reconnect
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_MAX_ATTEMPTS = 12; // ~ minutes of total retry budget
const JITTER_RATIO = 0.2;          // ±20%

function backoffWithJitter(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
  const jitter = exp * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_BASE_MS, Math.floor(exp + jitter));
}

export interface AuctionWsHandlers {
  /** Called every time the server sends an authoritative snapshot.
   *  The client must REPLACE its local auction state — never merge. */
  onSnapshot: (snapshot: { auction: any; seq?: number; server_ns?: number }) => void;
  /** Called for each accepted bid the client should render. Frames
   *  arriving out-of-order are filtered before this fires. */
  onNewBid: (frame: any) => void;
  /** Called when the server kicks the session. Caller should bounce
   *  the user to login. */
  onSessionKilled?: (reason: string) => void;
  /** Called when connection state changes. UI uses this for the
   *  "reconnecting…" badge. */
  onConnectionState?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

/**
 * One-line entrypoint used by the auction lot screen.
 * Returns a cleanup function — call it on unmount.
 */
export function openAuctionWs(auctionId: string, handlers: AuctionWsHandlers): () => void {
  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let pingTimer: any = null;
  let stallTimer: any = null;
  let reconnectTimer: any = null;
  let lastSeq = -1;            // -1 = "not initialised yet, accept first frame"
  let resyncInFlight = false;

  const setState = (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => {
    try { handlers.onConnectionState?.(s); } catch { /* swallow */ }
  };

  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      // No traffic at all for STALL_TIMEOUT_MS — assume the socket
      // is half-open and reconnect from scratch.
      try { ws?.close(); } catch {}
    }, STALL_TIMEOUT_MS);
  };

  const startHeartbeat = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      } catch {
        // send failure means the socket is dead; close to trigger reconnect
        try { ws?.close(); } catch {}
      }
    }, PING_INTERVAL_MS);
  };

  const stopTimers = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const resyncFromSnapshot = async (reason: string) => {
    if (resyncInFlight) return;
    resyncInFlight = true;
    try {
      const snap: any = await api.auctionSnapshot(auctionId);
      // Server is authoritative — replace local state, reset seq.
      lastSeq = Number(snap?.seq ?? -1);
      handlers.onSnapshot({ auction: snap.auction, seq: snap.seq, server_ns: snap.server_ns });
      // Telemetry: tell the server we resynced
      try {
        await api.realtimeReport({
          event: 'snapshot_resync', auction_id: auctionId, detail: reason,
        });
      } catch { /* telemetry failures never break the path */ }
    } catch (e) {
      // Snapshot fetch failed — keep going. The next live frame will
      // either match seq+1 (great) or trigger another resync attempt.
    } finally {
      resyncInFlight = false;
    }
  };

  const handleMessage = (raw: string) => {
    armStallTimer();
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'session_killed') {
      try { handlers.onSessionKilled?.(String(msg.reason || 'unknown')); } catch {}
      try { ws?.close(); } catch {}
      return;
    }

    // Server-initiated heartbeat — reply so the server knows we're alive.
    if (msg.type === 'ping') {
      try { ws?.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {}
      return;
    }
    if (msg.type === 'pong') {
      return; // already updated armStallTimer above
    }

    if (msg.type === 'snapshot') {
      lastSeq = Number(msg.seq ?? -1);
      handlers.onSnapshot({ auction: msg.auction, seq: msg.seq, server_ns: msg.server_ns });
      return;
    }

    if (msg.type === 'new_bid') {
      const seq = Number(msg.seq ?? NaN);
      if (Number.isFinite(seq) && lastSeq >= 0) {
        if (seq <= lastSeq) {
          // Stale / duplicate frame — ignore. Most common cause is a
          // delivered-twice broadcast (network retransmission). Server
          // is the source of truth and has already counted this bid.
          return;
        }
        if (seq > lastSeq + 1) {
          // Gap detected — we missed at least one frame. Pull a
          // snapshot to fully reconcile, then continue. Don't render
          // this frame yet; the snapshot will include it.
          api.realtimeReport({
            event: 'frame_out_of_order',
            auction_id: auctionId,
            expected_seq: lastSeq + 1,
            got_seq: seq,
          }).catch(() => {});
          resyncFromSnapshot('seq_gap').catch(() => {});
          return;
        }
        lastSeq = seq;
      } else if (Number.isFinite(seq)) {
        lastSeq = seq;
      }
      try { handlers.onNewBid(msg); } catch {}
    }
  };

  const connect = async () => {
    if (cancelled) return;
    setState(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      const url = await wsUrl(auctionId);
      if (cancelled) return;
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    if (!ws) { scheduleReconnect(); return; }

    ws.onopen = async () => {
      attempt = 0;
      setState('open');
      startHeartbeat();
      armStallTimer();
      // Best-effort signal so operators see fresh churn metrics
      api.realtimeReport({ event: 'ws_reconnect', auction_id: auctionId })
        .catch(() => { /* ignore */ });
      // Defensive snapshot fetch on every (re)connect — if the WS
      // snapshot frame arrives first, it overwrites this with the
      // same data. If WS happens to drop the snapshot frame (rare
      // but possible mid-reconnect), this guarantees we still have
      // an authoritative view.
      if (lastSeq >= 0) {
        // We've been connected before — definitely resync.
        resyncFromSnapshot('reconnect').catch(() => {});
      }
    };

    ws.onmessage = (ev) => {
      try { handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data || '')); } catch {}
    };

    ws.onerror = () => {
      // onerror is followed by onclose in all browsers we care about;
      // let onclose handle the reconnect to avoid double-scheduling.
    };

    ws.onclose = () => {
      stopTimers();
      ws = null;
      if (cancelled) {
        setState('closed');
        return;
      }
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (cancelled) return;
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      setState('closed');
      return;
    }
    const delay = backoffWithJitter(attempt);
    attempt += 1;
    setState('reconnecting');
    reconnectTimer = setTimeout(connect, delay);
  };

  // Kick it off
  connect();

  return () => {
    cancelled = true;
    stopTimers();
    setState('closed');
    try { ws?.close(); } catch {}
    ws = null;
  };
}

export const __testing__ = {
  backoffWithJitter,
  PING_INTERVAL_MS,
  STALL_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MAX_ATTEMPTS,
};
