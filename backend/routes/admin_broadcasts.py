"""
Operator → Dealer Broadcasts.

Liquidity-activation infrastructure: every broadcast is a manual nudge
the operator desk fires to push dealers back into the auction floor.
The intent is *not* a chat surface; it is a marketplace control plane.

Capabilities exposed to the operator UI:

  * GET  /admin/broadcasts/templates  → catalog of preset templates
                                        (new_listing, auction_live,
                                        reserve_met, ending_soon,
                                        settlement_completed, custom)
  * GET  /admin/broadcasts/recent     → audit ledger of recent sends
  * GET  /admin/broadcasts/auctions   → vehicle/auction picker payload
                                        (live + recently-launched +
                                        ended_pending) for targeting
  * POST /admin/broadcasts            → fire a broadcast.
        Targeting modes:
          - audience: 'all_verified'    (all approved dealers)
          - audience: 'bidders'         (auction-specific)
          - audience: 'watchers'        (auction-specific)
          - audience: 'bidders_and_watchers'
          - audience: 'specific'        (uses dealer_ids[])

Persisted in `db.broadcasts` as the operational audit trail. Push
delivery + inbox fanout run in best-effort background tasks so a
mass send never blocks the operator's UI thread.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


# ---------------------------------------------------------------------
# Template catalog — content the UI offers as one-tap presets.
# Each carries a default audience so operators rarely need to think.
# ---------------------------------------------------------------------
_BROADCAST_TEMPLATES = {
    "new_listing": {
        "label": "New car listed",
        "title": "New inventory on the floor",
        "body": "A new vehicle is listed for auction. Tap to view details.",
        "audience": "all_verified",
        "needs_auction": False,
        "tone": "info",
        "cta_hint": "Notify the entire verified dealer network",
    },
    "auction_live": {
        "label": "Auction live",
        "title": "Auction is live",
        "body": "Live bidding has started. Place your bid before the timer runs out.",
        "audience": "all_verified",
        "needs_auction": True,
        "tone": "live",
        "cta_hint": "Open bidding to the floor",
    },
    "reserve_met": {
        "label": "Reserve met",
        "title": "Reserve has been met",
        "body": "Reserve cleared — the highest bidder will close this deal if the timer expires.",
        "audience": "bidders_and_watchers",
        "needs_auction": True,
        "tone": "success",
        "cta_hint": "Pull bidders + watchers back to the lot",
    },
    "ending_soon": {
        "label": "Auction ending soon",
        "title": "Auction ending soon",
        "body": "Less than 10 minutes left on this auction. Last chance to bid.",
        "audience": "bidders_and_watchers",
        "needs_auction": True,
        "tone": "urgent",
        "cta_hint": "Drive last-minute liquidity",
    },
    "settlement_completed": {
        "label": "Settlement completed",
        "title": "Settlement completed",
        "body": "Vehicle handover is complete. Settlement closed without dispute.",
        "audience": "all_verified",
        "needs_auction": True,
        "tone": "success",
        "cta_hint": "Signal a clean close to the network",
    },
}


class BroadcastReq(BaseModel):
    """
    Request payload for `/admin/broadcasts`.

    `type` is required and selects the template (or 'custom' for free
    composition). Title/body override the template defaults. Audience
    overrides the template's default audience and adds explicit dealer
    targeting via `dealer_ids` when audience='specific'.
    """

    type: str
    auction_id: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    audience: Optional[str] = None
    dealer_ids: Optional[List[str]] = None


def register(api: APIRouter, deps: dict) -> None:
    """Mount admin broadcast routes onto the shared `/api` router.

    `deps` carries the runtime callables the route handlers need so we
    avoid a circular import with `server.py`.
    """
    db = deps["db"]
    get_current_admin = deps["get_current_admin"]
    send_to_dealers = deps["send_to_dealers"]
    audit = deps["audit"]
    now_utc = deps["now_utc"]
    iso = deps["iso"]
    logger = deps["logger"]

    # ----------------------------------------------------------------
    # Audience resolver
    # ----------------------------------------------------------------
    async def _resolve_audience(
        audience: str,
        auction_id: Optional[str],
        dealer_ids: Optional[List[str]],
    ) -> List[str]:
        """Resolve a logical audience to a concrete list of dealer ids."""
        if audience == "specific":
            if not dealer_ids:
                return []
            # Filter to only existing, non-blocked dealers.
            ids = await db.dealers.distinct(
                "id",
                {"id": {"$in": dealer_ids}, "blocked": {"$ne": True}},
            )
            return list(ids or [])

        if audience == "all_verified":
            ids = await db.dealers.distinct(
                "id", {"verified": True, "blocked": {"$ne": True}}
            )
            return list(ids or [])

        # Auction-scoped audiences require a valid auction_id
        if not auction_id:
            return []

        ids: set = set()
        if audience in ("bidders", "bidders_and_watchers"):
            async for b in db.bids.find(
                {"auction_id": auction_id}, {"dealer_id": 1, "_id": 0}
            ).limit(2000):
                if b.get("dealer_id"):
                    ids.add(b["dealer_id"])
        if audience in ("watchers", "bidders_and_watchers"):
            async for w in db.watchlist.find(
                {"auction_id": auction_id}, {"dealer_id": 1, "_id": 0}
            ).limit(2000):
                if w.get("dealer_id"):
                    ids.add(w["dealer_id"])
        return list(ids)

    # ----------------------------------------------------------------
    # GET /admin/broadcasts/templates
    # ----------------------------------------------------------------
    @api.get("/admin/broadcasts/templates")
    async def admin_broadcast_templates(admin=Depends(get_current_admin)):
        out = []
        for k, t in _BROADCAST_TEMPLATES.items():
            out.append({
                "type": k,
                "label": t["label"],
                "default_title": t["title"],
                "default_body": t["body"],
                "audience": t["audience"],
                "needs_auction": t["needs_auction"],
                "tone": t["tone"],
                "cta_hint": t["cta_hint"],
            })
        # Always advertise 'custom' as the last option for free composition
        out.append({
            "type": "custom",
            "label": "Custom message",
            "default_title": "",
            "default_body": "",
            "audience": "all_verified",
            "needs_auction": False,
            "tone": "info",
            "cta_hint": "Free-form announcement",
        })
        return out

    # ----------------------------------------------------------------
    # GET /admin/broadcasts/recent
    # ----------------------------------------------------------------
    @api.get("/admin/broadcasts/recent")
    async def admin_broadcast_recent(
        limit: int = 30, admin=Depends(get_current_admin)
    ):
        cur = (
            db.broadcasts.find({}, {"_id": 0})
            .sort("ts", -1)
            .limit(min(limit, 100))
        )
        rows = await cur.to_list(length=limit)
        # Hydrate vehicle context for each ledger row so the UI doesn't need
        # to back-fetch each auction. Cheap because list is bounded.
        auction_ids = list({r.get("auction_id") for r in rows if r.get("auction_id")})
        car_ctx: dict = {}
        if auction_ids:
            async for a in db.auctions.find(
                {"id": {"$in": auction_ids}}, {"_id": 0, "id": 1, "car_id": 1}
            ):
                car_ctx[a["id"]] = a.get("car_id")
            car_ids = list({v for v in car_ctx.values() if v})
            if car_ids:
                car_meta: dict = {}
                async for c in db.cars.find(
                    {"id": {"$in": car_ids}},
                    {"_id": 0, "id": 1, "year": 1, "make": 1, "model": 1, "registration_number": 1},
                ):
                    car_meta[c["id"]] = c
                for r in rows:
                    cid = car_ctx.get(r.get("auction_id"))
                    car = car_meta.get(cid) if cid else None
                    if car:
                        r["vehicle"] = {
                            "year": car.get("year"),
                            "make": car.get("make"),
                            "model": car.get("model"),
                            "registration_number": car.get("registration_number"),
                        }
        # Stringify timestamps for the JSON wire
        for r in rows:
            if r.get("ts"):
                r["ts"] = iso(r["ts"])
        return rows

    # ----------------------------------------------------------------
    # GET /admin/broadcasts/auctions
    # vehicle picker for the broadcast composer
    # ----------------------------------------------------------------
    @api.get("/admin/broadcasts/auctions")
    async def admin_broadcast_auctions(admin=Depends(get_current_admin)):
        """Return an ordered list of auctions/vehicles the operator can
        target. Ordering: live → ended_pending_payment → upcoming →
        recently_launched. Each row carries denormalized vehicle context
        so the picker renders without a follow-up fetch."""
        STATUS_ORDER = [
            "live",
            "ended_pending_payment",
            "payment_received",
            "upcoming",
            "scheduled",
            "vehicle_released",
            "settled",
        ]
        rows = []
        async for a in db.auctions.find(
            {"status": {"$in": STATUS_ORDER}}, {"_id": 0}
        ).sort("created_at", -1).limit(200):
            rows.append(a)

        car_ids = list({r.get("car_id") for r in rows if r.get("car_id")})
        cars: dict = {}
        if car_ids:
            async for c in db.cars.find(
                {"id": {"$in": car_ids}},
                {
                    "_id": 0, "id": 1, "year": 1, "make": 1, "model": 1,
                    "variant": 1, "registration_number": 1, "city": 1, "fuel_type": 1,
                },
            ):
                cars[c["id"]] = c

        out = []
        for r in rows:
            car = cars.get(r.get("car_id")) or {}
            label = " ".join(
                str(x) for x in [car.get("year"), car.get("make"), car.get("model")] if x
            ).strip() or "Vehicle"
            if car.get("variant"):
                label = f"{label} {car.get('variant')}"
            out.append({
                "auction_id": r.get("id"),
                "status": r.get("status"),
                "current_bid": r.get("current_bid", 0),
                "reserve_price": r.get("reserve_price", 0),
                "reserve_met": bool(r.get("reserve_met")),
                "end_time": iso(r["end_time"]) if r.get("end_time") else None,
                "label": label,
                "registration_number": car.get("registration_number"),
                "city": car.get("city"),
                "fuel_type": car.get("fuel_type"),
            })
        # Stable status sort
        rank = {s: i for i, s in enumerate(STATUS_ORDER)}
        out.sort(key=lambda x: (rank.get(x["status"], 99), x["label"]))
        return out

    # ----------------------------------------------------------------
    # POST /admin/broadcasts — main send handler
    # ----------------------------------------------------------------
    @api.post("/admin/broadcasts")
    async def admin_broadcast_send(
        req: BroadcastReq, admin=Depends(get_current_admin)
    ):
        # Resolve template
        tpl = _BROADCAST_TEMPLATES.get(req.type) if req.type != "custom" else None
        if req.type != "custom" and not tpl:
            raise HTTPException(
                status_code=400, detail=f"Unknown broadcast type: {req.type}"
            )

        title = (req.title or (tpl or {}).get("title") or "").strip()
        body = (req.body or (tpl or {}).get("body") or "").strip()
        if not title or not body:
            raise HTTPException(
                status_code=400, detail="title and body are required"
            )

        # Audience resolution: explicit override wins over template default
        audience = req.audience or (tpl or {}).get("audience") or "all_verified"

        # Auction context — required when template needs it OR when audience
        # is bidder/watcher-scoped.
        needs_auction = bool((tpl or {}).get("needs_auction")) or audience in (
            "bidders", "watchers", "bidders_and_watchers"
        )
        if needs_auction and not req.auction_id:
            raise HTTPException(
                status_code=400,
                detail="auction_id is required for this broadcast",
            )

        # Hydrate vehicle context to enrich the body line ("2022 Hyundai Creta SX")
        vehicle: Optional[dict] = None
        if req.auction_id:
            auction = await db.auctions.find_one(
                {"id": req.auction_id}, {"_id": 0}
            )
            if not auction:
                raise HTTPException(status_code=404, detail="Auction not found")
            car = await db.cars.find_one(
                {"id": auction.get("car_id")}, {"_id": 0}
            )
            if car:
                ctx = (
                    f"{car.get('year','')} {car.get('make','')} {car.get('model','')}"
                ).strip()
                if ctx and ctx not in body:
                    body = f"{body} ({ctx})"
                vehicle = {
                    "year": car.get("year"),
                    "make": car.get("make"),
                    "model": car.get("model"),
                    "registration_number": car.get("registration_number"),
                }

        # Audience → concrete dealer_id list
        dealer_ids = await _resolve_audience(
            audience, req.auction_id, req.dealer_ids
        )

        # Persist audit row first so even a failed fanout leaves a trail
        bid_ = str(uuid.uuid4())
        rec = {
            "id": bid_,
            "type": req.type,
            "title": title,
            "body": body,
            "audience": audience,
            "auction_id": req.auction_id,
            "vehicle": vehicle,
            "recipient_count": len(dealer_ids),
            "explicit_dealer_ids": (
                req.dealer_ids if audience == "specific" else None
            ),
            "sent_by": admin["id"],
            "sent_by_name": admin.get("dealership_name") or admin.get("full_name"),
            "ts": now_utc(),
        }
        # Broadcast fanout: persist the audit row first, then dispatch
        # tracking events, inbox, and push in parallel best-effort tasks.
        await db.broadcasts.insert_one(dict(rec))
        rec["ts"] = iso(rec["ts"])

        # Tracking — record one `sent` row per recipient. Lazy-imported so
        # `routes/admin_broadcasts.py` stays dependency-free of tracking.
        if dealer_ids:
            try:
                from routes import broadcast_tracking as _track
                asyncio.create_task(_track.record_sent_fanout(
                    db, broadcast_id=bid_, dealer_ids=dealer_ids,
                    auction_id=req.auction_id, now_utc=now_utc,
                ))
            except Exception as exc:
                logger.warning("broadcast tracking fanout failed: %s", exc)

        # Inbox notifications + push fanout, best effort
        if dealer_ids:
            try:
                inbox_docs = [{
                    "id": str(uuid.uuid4()),
                    "dealer_id": d,
                    "type": "broadcast",
                    "title": title,
                    "body": body,
                    "auction_id": req.auction_id,
                    "broadcast_id": bid_,
                    "read": False,
                    "created_at": now_utc(),
                } for d in dealer_ids]
                await db.notifications.insert_many(inbox_docs)
            except Exception as exc:
                logger.warning("broadcast inbox fanout failed: %s", exc)
            try:
                asyncio.create_task(send_to_dealers(
                    db, dealer_ids, title, body,
                    data={
                        "type": "broadcast",
                        "broadcast_id": bid_,
                        "auction_id": req.auction_id,
                    },
                ))
            except Exception as exc:
                logger.warning("broadcast push fanout failed: %s", exc)

        asyncio.create_task(audit(db, "broadcast_sent", admin["id"], bid_, {
            "type": req.type,
            "audience": audience,
            "recipients": len(dealer_ids),
            "auction_id": req.auction_id,
        }))
        return rec
