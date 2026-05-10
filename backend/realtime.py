"""
Realtime reliability + operational telemetry.

Three responsibilities:
  1. Process-monotonic timestamps for total ordering of bids.
  2. Lightweight anomaly counters written to db.realtime_metrics for
     operator health visibility.
  3. WS reconnect-storm + dealer-level connection churn tracking.

All writes are fire-and-forget; the bid path NEVER blocks on a metric
write, and a metric-store outage cannot break realtime delivery.

The collection is opportunistically TTL'd (30 days) on first write.
"""
from __future__ import annotations

import logging
import time
import threading
from collections import defaultdict, deque
from typing import Deque, Dict, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------
# Monotonic time helpers — used for bid total ordering. Wall-clock may
# jump (NTP, manual change); monotonic_ns never goes backwards within
# the lifetime of this process. Pair with an integer bid_seq sourced
# from a Mongo $inc to give a globally consistent (process-id, seq, ns)
# ordering tuple.
# ---------------------------------------------------------------------
def monotonic_ns() -> int:
    return time.monotonic_ns()


# ---------------------------------------------------------------------
# Metrics writer (best-effort, async)
# ---------------------------------------------------------------------
_METRICS_INDEX_READY = False


async def _ensure_index(db) -> None:
    """Idempotent TTL index on realtime_metrics. Called lazily on first write."""
    global _METRICS_INDEX_READY
    if _METRICS_INDEX_READY:
        return
    try:
        await db.realtime_metrics.create_index("ts", expireAfterSeconds=60 * 60 * 24 * 30)
        await db.realtime_metrics.create_index([("event", 1), ("ts", -1)])
        await db.realtime_metrics.create_index([("auction_id", 1), ("ts", -1)])
        _METRICS_INDEX_READY = True
    except Exception as exc:  # pragma: no cover - boot path
        logger.warning("realtime_metrics index init failed: %s", exc)


async def emit(db, event: str, *, now_utc, **fields) -> None:
    """Append a metric row. Never raises — telemetry must not break the
    request path. `now_utc` is the project's existing helper, passed
    explicitly to avoid an import cycle.
    """
    try:
        await _ensure_index(db)
        doc = {"event": event, "ts": now_utc(), **fields}
        await db.realtime_metrics.insert_one(doc)
    except Exception as exc:
        # Budget: log once per minute per event-type to avoid log spam
        # under sustained metrics-store outage. We don't bother with the
        # rate-limit primitive here — pylogger's own ratelimit handler
        # is sufficient.
        logger.debug("realtime metric drop (%s): %s", event, exc)


# ---------------------------------------------------------------------
# Reconnect-storm detection (in-memory sliding window per dealer)
# ---------------------------------------------------------------------
_STORM_LOCK = threading.Lock()
_RECONNECT_BUCKETS: Dict[str, Deque[float]] = defaultdict(deque)
_STORM_WINDOW_SEC = 5 * 60  # 5 minutes
_STORM_THRESHOLD = 5         # >5 reconnects/5min from same dealer = storm


def record_reconnect(dealer_id: Optional[str]) -> int:
    """Record a connect attempt for `dealer_id` and return how many
    reconnects fall in the current 5-minute window. Caller decides
    whether to emit a `ws_reconnect_storm` metric.
    """
    if not dealer_id:
        return 0
    now = time.monotonic()
    cutoff = now - _STORM_WINDOW_SEC
    with _STORM_LOCK:
        buf = _RECONNECT_BUCKETS[dealer_id]
        while buf and buf[0] < cutoff:
            buf.popleft()
        buf.append(now)
        # Opportunistic GC — keep the dict bounded under churn
        if len(_RECONNECT_BUCKETS) > 8192:  # pragma: no cover
            stale = [k for k, b in _RECONNECT_BUCKETS.items() if not b or b[-1] < cutoff]
            for k in stale[:1024]:
                _RECONNECT_BUCKETS.pop(k, None)
        return len(buf)


def is_reconnect_storm(count: int) -> bool:
    return count > _STORM_THRESHOLD
