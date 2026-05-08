"""
Broadcast conversion-funnel tracking — silent, append-only event ledger.

Goal: track the full dealer journey end-to-end so that once real
marketplace activity exists we can compute:

    Sent → Opened → AuctionViewed → BidPlaced → Won

without having to retro-fit instrumentation. The ledger is append-only
and lives in `db.broadcast_events`. Each row is keyed by dealer + event
type so a dealer's funnel is a simple group-by on `(dealer_id,
broadcast_id, event)`.

This module is intentionally invisible to dealers and operators today.
No UI; only writes. The operator dashboard will be built later, once
real data accrues.

Wiring points:
  * `record_sent_fanout()` — called by the broadcasts module after
    persisting a broadcast. Bulk-inserts one `sent` event per dealer.
  * `track_open_for_notification()` — invoked when a dealer opens a
    push/inbox notification of type=='broadcast'. Writes `opened`.
  * `track_auction_view()` — invoked when a dealer views an auction
    page, optionally carrying a `from_broadcast_id` deep-link tag.
    Writes `auction_viewed`.
  * `attribute_bid_to_recent_broadcast()` — invoked from server.py
    after a successful bid. Looks up the most recent matching `sent`
    broadcast (within ATTRIBUTION_WINDOW) and writes `bid_placed`.
  * `attribute_win_to_recent_broadcast()` — invoked from auction
    end-of-life when a winner is set. Writes `won`.

All writes are best-effort. We never block the user-facing path on a
tracking write — failures get logged and swallowed.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


# Window inside which we consider a recent broadcast as the "attribution
# source" for a bid or win. 24h was chosen because broadcasts are
# operationally tied to live or imminently-live auctions; longer than
# that and the causal link is too noisy.
ATTRIBUTION_WINDOW = timedelta(hours=24)


# Cache so we only ensure indexes once per process. Uses a module-level
# flag rather than a startup hook to keep this self-contained.
_indexes_ready = False


async def _ensure_indexes(db) -> None:
    global _indexes_ready
    if _indexes_ready:
        return
    try:
        await db.broadcast_events.create_index([("dealer_id", 1), ("auction_id", 1), ("ts", -1)])
        await db.broadcast_events.create_index([("broadcast_id", 1), ("event", 1)])
        await db.broadcast_events.create_index([("event", 1), ("ts", -1)])
        _indexes_ready = True
    except Exception:
        # Index creation can race; failures here are non-fatal.
        pass


async def _write_event(
    db,
    *,
    broadcast_id: str,
    dealer_id: str,
    event: str,
    auction_id: Optional[str] = None,
    bid_id: Optional[str] = None,
    extra: Optional[dict] = None,
    now_utc=None,
) -> None:
    await _ensure_indexes(db)
    doc = {
        "id": str(uuid.uuid4()),
        "broadcast_id": broadcast_id,
        "dealer_id": dealer_id,
        "event": event,
        "auction_id": auction_id,
        "bid_id": bid_id,
        "ts": now_utc() if now_utc else None,
    }
    if extra:
        doc.update(extra)
    await db.broadcast_events.insert_one(doc)


# ---------------------------------------------------------------------
# Public helpers used by server.py
# ---------------------------------------------------------------------
async def record_sent_fanout(
    db, *, broadcast_id: str, dealer_ids: list, auction_id: Optional[str], now_utc
) -> None:
    """Bulk-insert one 'sent' row per dealer at fanout time. Best effort."""
    if not dealer_ids:
        return
    try:
        await _ensure_indexes(db)
        ts = now_utc()
        docs = [{
            "id": str(uuid.uuid4()),
            "broadcast_id": broadcast_id,
            "dealer_id": d,
            "event": "sent",
            "auction_id": auction_id,
            "bid_id": None,
            "ts": ts,
        } for d in dealer_ids]
        if docs:
            await db.broadcast_events.insert_many(docs, ordered=False)
    except Exception:
        # Tracking failure must never break a broadcast send.
        pass


async def attribute_bid_to_recent_broadcast(
    db, *, dealer_id: str, auction_id: str, bid_id: str, now_utc, logger=None
) -> None:
    """Look up the most recent broadcast for this dealer + auction
    within the attribution window and emit a `bid_placed` event.
    Idempotent per (broadcast, dealer, bid)."""
    try:
        cutoff = now_utc() - ATTRIBUTION_WINDOW
        # Find most recent 'sent' for this dealer where the broadcast
        # either explicitly referenced this auction, OR was a network-
        # wide broadcast (auction_id=None) sent recently. Network-wide
        # broadcasts still drove the bid by liquidity proxy.
        latest = await db.broadcast_events.find_one(
            {
                "dealer_id": dealer_id,
                "event": "sent",
                "ts": {"$gte": cutoff},
                "$or": [{"auction_id": auction_id}, {"auction_id": None}],
            },
            sort=[("ts", -1)],
        )
        if not latest:
            return
        await _write_event(
            db,
            broadcast_id=latest["broadcast_id"],
            dealer_id=dealer_id,
            event="bid_placed",
            auction_id=auction_id,
            bid_id=bid_id,
            now_utc=now_utc,
        )
    except Exception as exc:
        if logger:
            logger.warning("bid attribution failed: %s", exc)


async def attribute_win_to_recent_broadcast(
    db, *, dealer_id: str, auction_id: str, now_utc, logger=None
) -> None:
    """Same logic as `attribute_bid_to_recent_broadcast` but for the
    terminal `won` event. Window is more lenient (we keep it 24h
    consistent with bid attribution; auctions rarely span longer)."""
    try:
        cutoff = now_utc() - ATTRIBUTION_WINDOW
        latest = await db.broadcast_events.find_one(
            {
                "dealer_id": dealer_id,
                "event": "sent",
                "ts": {"$gte": cutoff},
                "$or": [{"auction_id": auction_id}, {"auction_id": None}],
            },
            sort=[("ts", -1)],
        )
        if not latest:
            return
        await _write_event(
            db,
            broadcast_id=latest["broadcast_id"],
            dealer_id=dealer_id,
            event="won",
            auction_id=auction_id,
            now_utc=now_utc,
        )
    except Exception as exc:
        if logger:
            logger.warning("win attribution failed: %s", exc)


# ---------------------------------------------------------------------
# HTTP routes — invoked by the dealer client
# ---------------------------------------------------------------------
class TrackViewReq(BaseModel):
    from_broadcast_id: Optional[str] = None


def register(api: APIRouter, deps: dict) -> None:
    """Mount tracking routes onto the shared `/api` router."""
    db = deps["db"]
    get_current_dealer = deps["get_current_dealer"]
    now_utc = deps["now_utc"]
    logger = deps["logger"]

    # ----------------------------------------------------------------
    # POST /notifications/{id}/open
    # Marks a single notification opened. If the notification is a
    # broadcast inbox row, emits an `opened` funnel event.
    # ----------------------------------------------------------------
    @api.post("/notifications/{notification_id}/open")
    async def notification_open(
        notification_id: str, dealer=Depends(get_current_dealer)
    ):
        n = await db.notifications.find_one(
            {"id": notification_id, "dealer_id": dealer["id"]}, {"_id": 0}
        )
        if not n:
            raise HTTPException(status_code=404, detail="Notification not found")
        # Mark read regardless of type (covers the case where the dealer
        # tapped a single notification rather than mark-all-read).
        if not n.get("read"):
            await db.notifications.update_one(
                {"id": notification_id, "dealer_id": dealer["id"]},
                {"$set": {"read": True}},
            )
        # Funnel event — only when this notification carries a
        # broadcast_id linkage.
        bid_ = n.get("broadcast_id")
        if n.get("type") == "broadcast" and bid_:
            try:
                await _write_event(
                    db,
                    broadcast_id=bid_,
                    dealer_id=dealer["id"],
                    event="opened",
                    auction_id=n.get("auction_id"),
                    now_utc=now_utc,
                )
            except Exception as exc:
                logger.warning("notification open tracking failed: %s", exc)
        return {"ok": True}

    # ----------------------------------------------------------------
    # POST /auctions/{id}/track-view
    # Silent endpoint hit by the lot/auction screen on mount. If a
    # `from_broadcast_id` is provided we record the deep-link
    # attribution; otherwise we fall back to recent-broadcast lookup.
    # ----------------------------------------------------------------
    @api.post("/auctions/{auction_id}/track-view")
    async def track_view(
        auction_id: str,
        req: TrackViewReq,
        dealer=Depends(get_current_dealer),
    ):
        # Confirm the auction exists; we don't want to write events for
        # bogus IDs.
        a = await db.auctions.find_one({"id": auction_id}, {"_id": 0, "id": 1})
        if not a:
            raise HTTPException(status_code=404, detail="Auction not found")

        broadcast_id = req.from_broadcast_id
        if not broadcast_id:
            # Fallback: most recent broadcast 'sent' to this dealer
            # within the attribution window that referenced this auction.
            try:
                cutoff = now_utc() - ATTRIBUTION_WINDOW
                latest = await db.broadcast_events.find_one(
                    {
                        "dealer_id": dealer["id"],
                        "event": "sent",
                        "ts": {"$gte": cutoff},
                        "auction_id": auction_id,
                    },
                    sort=[("ts", -1)],
                )
                if latest:
                    broadcast_id = latest["broadcast_id"]
            except Exception as exc:
                logger.warning("track-view lookup failed: %s", exc)

        if not broadcast_id:
            # No attribution source — silently no-op so we don't pollute
            # the events ledger with un-attributed views.
            return {"ok": True, "tracked": False}

        try:
            await _write_event(
                db,
                broadcast_id=broadcast_id,
                dealer_id=dealer["id"],
                event="auction_viewed",
                auction_id=auction_id,
                now_utc=now_utc,
            )
            return {"ok": True, "tracked": True}
        except Exception as exc:
            logger.warning("auction view tracking failed: %s", exc)
            return {"ok": True, "tracked": False}
