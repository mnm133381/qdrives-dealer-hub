"""
Seller Access & Vehicle Tracking — controlled read-only visibility layer.

DESIGN INVARIANTS
─────────────────
1. Sellers are NOT marketplace accounts. They're the original vehicle
   owners. Each seller is created by an operator and tied to one or more
   vehicles via `seller_id ↔ vehicle_id`.

2. No public signup. Operator manually creates the seller record and
   links it to a vehicle's car_id (which has 1:1 with auction_id).

3. Seller authentication = OTP via phone. We reuse the same mocked
   `123456` flow as the dealer side. Tokens are namespaced as
   `kind: "seller_access"` so a stolen seller token cannot be replayed
   against any dealer/operator endpoint.

4. Seller can ONLY see sanitized data for their own vehicle:
     - vehicle info
     - auction state + countdown
     - current bid (₹) + bidder count + reserve met/progress
     - settlement state (public audit only)
   NEVER:
     - dealer identities, names, phones, trust scores
     - bid history with dealer attribution
     - other vehicles in the marketplace

5. Append-only seller_audit ledger captures every event:
   otp_sent, otp_verified, access_granted, vehicle_viewed,
   settlement_viewed, access_revoked.

6. Seller access lifecycle:
     pending      — operator created, no OTP sent yet
     access_sent  — operator generated OTP / sent magic instructions
     viewed       — seller has logged in at least once
     active       — seller has viewed the vehicle screen at least once
     revoked      — operator killed the access (audit-locked)

7. This is a thin layer ON TOP OF the existing auction collection.
   No duplicate auction systems. No separate seller inventory.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("qdrives.sellers")


# ─────────────────────── helpers ───────────────────────

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize_phone(raw: str) -> str:
    """Normalise to +91XXXXXXXXXX."""
    if not raw:
        return ""
    digits = re.sub(r"[^\d]", "", raw)
    if len(digits) == 12 and digits.startswith("91"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+91{digits}"
    if raw.startswith("+"):
        return raw
    return f"+{digits}" if digits else ""


SELLER_STATES = (
    "pending", "access_sent", "viewed", "active", "revoked",
)
TERMINAL_SELLER_STATES = ("revoked",)


# ─────────────────────── audit ───────────────────────

async def _audit(db, *, seller_id: str, action: str, actor_id: Optional[str],
                 actor_role: str, vehicle_id: Optional[str] = None,
                 meta: Optional[Dict[str, Any]] = None) -> None:
    """Append-only seller_audit ledger entry."""
    await db.seller_audit.insert_one({
        "id": str(uuid.uuid4()),
        "seller_id": seller_id,
        "vehicle_id": vehicle_id,
        "action": action,
        "actor_id": actor_id,
        "actor_role": actor_role,    # 'operator' | 'seller' | 'system'
        "meta": meta or {},
        "ts": now_utc(),
    })


# ─────────────────────── operator-side ───────────────────────

async def operator_create_seller(
    db, *, name: str, phone: str, email: Optional[str],
    operator_id: str,
) -> Dict[str, Any]:
    """Create a seller record. Idempotent on phone — returns existing if
    one is on file (operator can then proceed to link a vehicle)."""
    phone_n = normalize_phone(phone)
    if not phone_n:
        raise ValueError("Invalid phone")

    existing = await db.sellers.find_one({"phone": phone_n}, {"_id": 0})
    if existing:
        return existing

    sid = str(uuid.uuid4())
    doc = {
        "id": sid,
        "name": (name or "").strip(),
        "phone": phone_n,
        "email": (email or "").strip() or None,
        "status": "pending",
        "created_by_operator_id": operator_id,
        "created_at": now_utc(),
        "updated_at": now_utc(),
        "linked_vehicles": [],         # list of car_id (= vehicle_id)
        "last_login_at": None,
        "last_viewed_vehicle_at": None,
    }
    await db.sellers.insert_one(doc)
    # Motor mutates doc with `_id` post-insert — strip it so FastAPI's
    # jsonable_encoder doesn't choke on the ObjectId.
    doc.pop("_id", None)
    await _audit(db, seller_id=sid, action="seller_created", actor_id=operator_id,
                 actor_role="operator", meta={"name": name, "phone": phone_n})
    return doc


async def operator_link_vehicle(
    db, *, seller_id: str, car_id: str, operator_id: str,
) -> Dict[str, Any]:
    """Bind a vehicle (car_id) to a seller. The car must exist; the
    auction with this car_id is the canonical record. We also denormalise
    `seller_id` onto the car for fast filtering."""
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        raise ValueError("Seller not found")
    if seller["status"] == "revoked":
        raise ValueError("Seller access is revoked")

    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        raise ValueError("Vehicle not found")

    # Denormalise seller_id onto the car (single source of truth: cars)
    await db.cars.update_one({"id": car_id}, {"$set": {"seller_id": seller_id, "updated_at": now_utc()}})

    if car_id not in (seller.get("linked_vehicles") or []):
        await db.sellers.update_one(
            {"id": seller_id},
            {
                "$addToSet": {"linked_vehicles": car_id},
                "$set": {"updated_at": now_utc()},
            },
        )
    await _audit(db, seller_id=seller_id, vehicle_id=car_id,
                 action="vehicle_linked", actor_id=operator_id,
                 actor_role="operator", meta={"car_reg": car.get("registration_number")})
    return {"ok": True, "seller_id": seller_id, "car_id": car_id}


async def operator_send_access(
    db, *, seller_id: str, operator_id: str,
) -> Dict[str, Any]:
    """Mark the seller access as 'access_sent'. (OTP is mocked 123456 for
    MVP — Twilio integration is separate.) Audit-logged."""
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        raise ValueError("Seller not found")
    if seller["status"] == "revoked":
        raise ValueError("Cannot send access for a revoked seller")

    new_status = "access_sent" if seller["status"] == "pending" else seller["status"]
    await db.sellers.update_one(
        {"id": seller_id},
        {"$set": {"status": new_status, "updated_at": now_utc(),
                  "access_sent_at": now_utc()}},
    )
    await _audit(db, seller_id=seller_id, action="access_sent",
                 actor_id=operator_id, actor_role="operator",
                 meta={"phone": seller["phone"]})
    return {"ok": True, "status": new_status, "phone": seller["phone"]}


async def operator_revoke(
    db, *, seller_id: str, operator_id: str, reason: Optional[str] = None,
) -> Dict[str, Any]:
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        raise ValueError("Seller not found")
    await db.sellers.update_one(
        {"id": seller_id},
        {"$set": {"status": "revoked", "updated_at": now_utc(),
                  "revoked_at": now_utc()}},
    )
    await _audit(db, seller_id=seller_id, action="access_revoked",
                 actor_id=operator_id, actor_role="operator",
                 meta={"reason": reason})
    return {"ok": True}


async def operator_list_sellers(
    db, *, status: Optional[str] = None, limit: int = 200,
) -> List[Dict[str, Any]]:
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    cur = db.sellers.find(q, {"_id": 0}).sort("created_at", -1).limit(limit)
    out: List[Dict[str, Any]] = []
    async for s in cur:
        # Lightweight enrichment: counts
        out.append({
            **s,
            "linked_vehicles_count": len(s.get("linked_vehicles") or []),
        })
    return out


async def operator_get_seller(
    db, *, seller_id: str,
) -> Optional[Dict[str, Any]]:
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        return None
    # Audit feed
    audit = await db.seller_audit.find(
        {"seller_id": seller_id}, {"_id": 0},
    ).sort("ts", -1).limit(80).to_list(80)
    # Linked vehicles enrichment
    car_ids = seller.get("linked_vehicles") or []
    cars: List[Dict[str, Any]] = []
    if car_ids:
        async for c in db.cars.find({"id": {"$in": car_ids}}, {"_id": 0}):
            auc = await db.auctions.find_one({"car_id": c["id"]}, {"_id": 0})
            cars.append({
                "id": c["id"],
                "registration_number": c.get("registration_number"),
                "make": c.get("make"), "model": c.get("model"),
                "year": c.get("year"), "variant": c.get("variant"),
                "auction_id": (auc or {}).get("id"),
                "auction_status": (auc or {}).get("status"),
                "current_bid": (auc or {}).get("current_bid"),
            })
    return {**seller, "audit": audit, "vehicles": cars}


# ─────────────────────── seller-side (read-only) ───────────────────────

async def find_seller_by_phone(db, phone: str) -> Optional[Dict[str, Any]]:
    p = normalize_phone(phone)
    if not p:
        return None
    return await db.sellers.find_one({"phone": p}, {"_id": 0})


async def mark_seller_login(db, *, seller_id: str, otp_method: str = "otp") -> None:
    """Called after successful OTP verify. Promotes status pending →
    access_sent → viewed and audits the event."""
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        return
    new_status = seller["status"]
    if seller["status"] in ("pending", "access_sent"):
        new_status = "viewed"
    await db.sellers.update_one(
        {"id": seller_id},
        {"$set": {"status": new_status, "last_login_at": now_utc(),
                  "updated_at": now_utc()}},
    )
    await _audit(db, seller_id=seller_id, action="otp_verified",
                 actor_id=seller_id, actor_role="seller",
                 meta={"method": otp_method})


def _sanitize_auction_for_seller(auction: Dict[str, Any]) -> Dict[str, Any]:
    """Strip dealer identities. Expose only the trust signals the seller
    needs to feel informed."""
    if not auction:
        return {}
    starting = auction.get("starting_bid") or 0
    reserve = auction.get("reserve_price") or 0
    current = auction.get("current_bid") or starting
    reserve_met = bool(reserve and current >= reserve)
    progress = 0.0
    try:
        if reserve and reserve > starting:
            progress = max(0.0, min(1.0, (current - starting) / (reserve - starting)))
    except Exception:  # noqa: BLE001
        progress = 0.0
    return {
        "id": auction.get("id"),
        "status": auction.get("status"),
        "start_time": auction.get("start_time"),
        "end_time": auction.get("end_time"),
        "current_bid": current,
        "starting_bid": starting,
        "reserve_met": reserve_met,
        "reserve_progress": round(progress, 4),
        "bid_count": auction.get("bid_count") or 0,
        "active_bidder_count": auction.get("active_bidder_count") or 0,
    }


async def list_my_vehicles(db, *, seller_id: str) -> List[Dict[str, Any]]:
    """Return only vehicles linked to this seller."""
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        return []
    car_ids = seller.get("linked_vehicles") or []
    if not car_ids:
        return []
    out: List[Dict[str, Any]] = []
    async for c in db.cars.find({"id": {"$in": car_ids}}, {"_id": 0}):
        auction = await db.auctions.find_one({"car_id": c["id"]}, {"_id": 0})
        sett = await db.settlements.find_one(
            {"auction_id": (auction or {}).get("id")}, {"_id": 0},
        ) if auction else None
        out.append({
            "vehicle_id": c["id"],
            "registration_number": c.get("registration_number"),
            "make": c.get("make"), "model": c.get("model"),
            "year": c.get("year"), "variant": c.get("variant"),
            "image": (c.get("images") or [None])[0],
            "auction": _sanitize_auction_for_seller(auction or {}),
            "settlement_state": (sett or {}).get("state"),
        })
    return out


async def get_vehicle_for_seller(
    db, *, seller_id: str, vehicle_id: str,
) -> Optional[Dict[str, Any]]:
    """Detail view — must enforce ownership."""
    car = await db.cars.find_one({"id": vehicle_id}, {"_id": 0})
    if not car:
        return None
    if car.get("seller_id") != seller_id:
        # 404 to avoid leaking existence
        return None
    auction = await db.auctions.find_one({"car_id": vehicle_id}, {"_id": 0})
    sett = await db.settlements.find_one(
        {"auction_id": (auction or {}).get("id")}, {"_id": 0},
    ) if auction else None

    # Update activity tracking
    await db.sellers.update_one(
        {"id": seller_id},
        {"$set": {"status": "active", "last_viewed_vehicle_at": now_utc(),
                  "updated_at": now_utc()}},
    )
    await _audit(db, seller_id=seller_id, vehicle_id=vehicle_id,
                 action="vehicle_viewed", actor_id=seller_id,
                 actor_role="seller", meta={})

    # Sanitised settlement view — public audit only (no operator metadata)
    sett_public = None
    if sett:
        sett_public = {
            "id": sett.get("id"),
            "state": sett.get("state"),
            "deposit_amount": sett.get("deposit_amount"),
            "winning_amount": sett.get("winning_amount"),
            "audit_public": [
                {
                    "id": a.get("id"),
                    "action": a.get("action"),
                    "from_state": a.get("from_state"),
                    "to_state": a.get("to_state"),
                    "ts": a.get("ts"),
                }
                for a in (sett.get("audit_public") or sett.get("audit") or [])
            ][-12:],
        }

    return {
        "vehicle_id": car["id"],
        "registration_number": car.get("registration_number"),
        "make": car.get("make"), "model": car.get("model"),
        "year": car.get("year"), "variant": car.get("variant"),
        "fuel_type": car.get("fuel_type"),
        "km_driven": car.get("km_driven"),
        "images": car.get("images") or [],
        "auction": _sanitize_auction_for_seller(auction or {}),
        "settlement": sett_public,
    }


async def record_settlement_view(
    db, *, seller_id: str, settlement_id: str,
) -> None:
    await _audit(db, seller_id=seller_id,
                 action="settlement_viewed", actor_id=seller_id,
                 actor_role="seller",
                 meta={"settlement_id": settlement_id})


async def get_seller_profile(db, *, seller_id: str) -> Optional[Dict[str, Any]]:
    s = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not s:
        return None
    return {
        "id": s["id"],
        "name": s.get("name"),
        "phone": s.get("phone"),
        "status": s.get("status"),
        "linked_vehicles_count": len(s.get("linked_vehicles") or []),
    }
