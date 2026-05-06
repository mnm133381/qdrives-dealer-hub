from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import re
import jwt
import uuid
import json
import asyncio
import logging
import random
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, status, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.encoders import jsonable_encoder
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket
from pydantic import BaseModel, Field

from push import send_to_dealer, send_to_dealers, is_valid_expo_token
import storage_service
import media as media_svc

# ---------- Setup ----------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
inspections_bucket = AsyncIOMotorGridFSBucket(db, bucket_name="inspections")

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGO = "HS256"
MOCK_OTP = "123456"
ADMIN_PHONES = {p.strip() for p in os.environ.get("ADMIN_PHONES", "").split(",") if p.strip()}


def is_admin_phone(phone: str) -> bool:
    return phone.strip() in ADMIN_PHONES


# ---- Audit logging ----
async def audit(db, action: str, actor_id: Optional[str], target_id: Optional[str], meta: Optional[Dict[str, Any]] = None) -> None:
    """Append-only operational audit log. All admin mutations and login events
    flow through here so we have a forensic trail."""
    try:
        await db.audit_logs.insert_one({
            "id": str(uuid.uuid4()),
            "action": action,
            "actor_id": actor_id,
            "target_id": target_id,
            "meta": meta or {},
            "ts": now_utc(),
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit log failed (%s): %s", action, exc)

app = FastAPI(title="Q Drives API")
api = APIRouter(prefix="/api")
security = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("qdrives")


# ---------- Helpers ----------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def create_jwt(dealer_id: str, token_version: int = 0, kind: str = "access") -> str:
    """Issue a JWT.
    - access tokens are short-lived (8h) and carry token_version (`tv`).
      Bumping the dealer's token_version in DB instantly invalidates all
      outstanding access tokens for that dealer.
    - refresh tokens are 30d, also carry tv, and have kind='refresh'.
    """
    ttl = timedelta(hours=8) if kind == "access" else timedelta(days=30)
    payload = {
        "sub": dealer_id,
        "tv": int(token_version),
        "kind": kind,
        "exp": now_utc() + ttl,
        "iat": now_utc(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def issue_token_pair(dealer: Dict[str, Any]) -> Dict[str, str]:
    tv = int(dealer.get("token_version") or 0)
    return {
        "token": create_jwt(dealer["id"], tv, "access"),
        "refresh_token": create_jwt(dealer["id"], tv, "refresh"),
    }


async def bump_token_version(dealer_id: str, reason: str, actor_id: Optional[str] = None) -> None:
    """Server-side session kill. Atomically bumps token_version on the dealer
    doc — every outstanding JWT for this dealer fails the next /auth/me check
    with 401 KILLED. Also force-disconnects every live WebSocket for this
    dealer so live updates are immediately cut off. Audits the event."""
    res = await db.dealers.find_one_and_update(
        {"id": dealer_id},
        {"$inc": {"token_version": 1}},
        return_document=True,
    )
    if res:
        # Force-close every WS owned by this dealer.
        try:
            await manager.kill_dealer(dealer_id, reason=reason)
        except Exception as e:
            logger.warning("WS kill failed for %s: %s", dealer_id, e)
        asyncio.create_task(audit(db, "token_invalidation", actor_id, dealer_id, {
            "reason": reason, "new_tv": int(res.get("token_version") or 0),
        }))


async def get_current_dealer(creds: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Dict[str, Any]:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        dealer_id = payload["sub"]
        token_kind = payload.get("kind", "access")
        token_tv = int(payload.get("tv", 0))
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if token_kind != "access":
        raise HTTPException(status_code=401, detail="Wrong token kind")

    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not dealer:
        raise HTTPException(status_code=401, detail="Dealer not found")

    # Token-version check — bumped on suspend / revoke / role-change.
    current_tv = int(dealer.get("token_version") or 0)
    if token_tv != current_tv:
        raise HTTPException(status_code=401, detail="SESSION_INVALIDATED")

    # Defense in depth — hard block any access by suspended dealers, even
    # if their token somehow survived a tv bump (e.g. edge race).
    if dealer.get("suspended") and (dealer.get("role") or "dealer") == "dealer":
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")

    return dealer


async def get_current_admin(dealer = Depends(get_current_dealer)) -> Dict[str, Any]:
    """Admin-only guard. Accepts any admin tier (super_admin, operations_admin,
    inspection_admin, or legacy 'admin'). Raises 403 for dealers."""
    role = dealer.get("role") or "dealer"
    if role not in ("admin", "super_admin", "operations_admin", "inspection_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return dealer


async def get_current_super_admin(dealer = Depends(get_current_dealer)) -> Dict[str, Any]:
    """Super-admin only. Used for irreversible / privileged operations like
    promoting another operator or revoking allow-list entries."""
    role = dealer.get("role") or "dealer"
    if role not in ("admin", "super_admin"):
        # Note: legacy "admin" role is treated as super_admin for backward compat
        # during the multi-tier migration. New operators get specific tiers.
        raise HTTPException(status_code=403, detail="Super-admin access required")
    return dealer


# Permission catalog — single source of truth for what each role can do.
ROLE_PERMISSIONS: Dict[str, set] = {
    "super_admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_allow_list", "promote_operator", "manage_inventory",
        "launch_auction", "pause_auction", "cancel_auction", "extend_auction",
        "cancel_bid", "broadcast", "view_audit", "upload_inspection",
    },
    # Legacy 'admin' tier maps to super_admin powers for backward compatibility
    "admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_allow_list", "promote_operator", "manage_inventory",
        "launch_auction", "pause_auction", "cancel_auction", "extend_auction",
        "cancel_bid", "broadcast", "view_audit", "upload_inspection",
    },
    "operations_admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_inventory", "launch_auction", "pause_auction",
        "extend_auction", "broadcast", "view_audit",
    },
    "inspection_admin": {
        "manage_inventory", "upload_inspection", "view_audit",
    },
    "dealer": set(),
}


def has_permission(dealer: Dict[str, Any], perm: str) -> bool:
    role = dealer.get("role") or "dealer"
    return perm in ROLE_PERMISSIONS.get(role, set())


def require_permission(perm: str):
    """FastAPI dependency factory for permission-gated endpoints."""
    async def _dep(dealer = Depends(get_current_admin)):
        if not has_permission(dealer, perm):
            raise HTTPException(status_code=403, detail=f"Permission denied: {perm}")
        return dealer
    return _dep


def serialize(doc: dict) -> dict:
    """Strip _id and convert datetimes to ISO."""
    if not doc:
        return doc
    out = {}
    for k, v in doc.items():
        if k == "_id":
            continue
        if isinstance(v, datetime):
            out[k] = iso(v)
        else:
            out[k] = v
    return out


# ---------- Models ----------
class SendOtpReq(BaseModel):
    phone: str

class VerifyOtpReq(BaseModel):
    phone: str
    otp: str

class KycReq(BaseModel):
    full_name: str
    dealership_name: str
    city: str
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None

class BidReq(BaseModel):
    amount: int

class CarCreateReq(BaseModel):
    registration_number: str
    make: str
    model: str
    variant: Optional[str] = None
    year: int  # registration year (kept for backward compat with existing UI)
    manufacturing_year: Optional[int] = None
    registration_year: Optional[int] = None
    fuel_type: str
    transmission: str
    km_driven: int
    color: Optional[str] = ""
    owners: int = 1
    insurance_validity: Optional[str] = None  # free-form MM/YYYY or ISO
    rto_details: Optional[str] = None
    notes: Optional[str] = None
    reserve_price: int
    starting_bid: int
    images: List[str] = []
    description: Optional[str] = ""
    duration_minutes: int = 60

class PriceEstimateReq(BaseModel):
    make: str
    model: str
    year: int
    km_driven: int
    fuel_type: str
    owners: int
    condition_score: float


class RegisterPushTokenReq(BaseModel):
    token: str
    platform: Optional[str] = None  # "ios" | "android" | "web"


class TestPushReq(BaseModel):
    title: Optional[str] = "Q Drives"
    body: Optional[str] = "Test notification"


class ReorderMediaReq(BaseModel):
    ordered_ids: List[str]


class UpdateMediaReq(BaseModel):
    section: Optional[str] = None
    subsection: Optional[str] = None


class AttestNoDamageReq(BaseModel):
    no_damage_attested: bool


class DealerVerifyReq(BaseModel):
    verified: Optional[bool] = None
    kyc_completed: Optional[bool] = None
    suspended: Optional[bool] = None


class BroadcastReq(BaseModel):
    title: str
    body: str
    audience: Optional[str] = "all"  # "all" | "verified" | "active"


# ---- Allow-list / approval queue management ----
class ApprovedDealerReq(BaseModel):
    """Operator pre-fills the dealer profile when adding a phone to the
    closed-network allow-list. This avoids junk onboarding."""
    phone: str
    full_name: Optional[str] = ""
    dealership_name: Optional[str] = ""
    city: Optional[str] = ""
    trust_score: Optional[float] = 4.5
    max_bid_limit: Optional[int] = None
    notes: Optional[str] = ""


class ApprovedDealerPatch(BaseModel):
    full_name: Optional[str] = None
    dealership_name: Optional[str] = None
    city: Optional[str] = None
    trust_score: Optional[float] = None
    max_bid_limit: Optional[int] = None
    notes: Optional[str] = None
    status: Optional[str] = None  # 'active' | 'paused' | 'revoked'


class MaxBidReq(BaseModel):
    max_bid_limit: Optional[int] = None  # None or 0 → no limit


# ---------- WebSocket Manager ----------
class ConnectionManager:
    """Authenticated WebSocket connection registry.

    Every connection is tagged with `dealer_id`, `role`, and `tv` (the
    token_version it was authorised under). On a bump_token_version call
    we forcibly close every connection for that dealer so revoked /
    suspended dealers lose live updates instantly.

    Two channel kinds:
      • auction rooms (room_key = f"auction:{auction_id}") — dealers + operators
      • operator-only ops bus (room_key = "ops") — operator-private events
    """
    def __init__(self):
        self.rooms: Dict[str, List[Dict[str, Any]]] = {}

    async def connect(self, room_key: str, ws: WebSocket, *, dealer_id: str, role: str, tv: int):
        await ws.accept()
        self.rooms.setdefault(room_key, []).append({
            "ws": ws, "dealer_id": dealer_id, "role": role, "tv": tv,
        })

    def disconnect(self, room_key: str, ws: WebSocket):
        if room_key in self.rooms:
            self.rooms[room_key] = [c for c in self.rooms[room_key] if c["ws"] is not ws]

    async def broadcast(self, auction_id: str, payload: dict):
        """Broadcast to every subscriber of an auction room. Backwards-compat
        signature — accepts the bare auction_id and prefixes it internally.

        Payload is run through jsonable_encoder so nested datetime values
        survive serialization without raising.
        """
        room_key = f"auction:{auction_id}"
        if room_key not in self.rooms:
            return
        encoded = jsonable_encoder(payload)
        dead: List[WebSocket] = []
        for c in list(self.rooms[room_key]):
            try:
                await c["ws"].send_json(encoded)
            except Exception:
                dead.append(c["ws"])
        for ws in dead:
            self.disconnect(room_key, ws)

    async def broadcast_ops(self, payload: dict):
        """Operator-only channel — never delivered to dealers."""
        room_key = "ops"
        if room_key not in self.rooms:
            return
        encoded = jsonable_encoder(payload)
        dead: List[WebSocket] = []
        for c in list(self.rooms[room_key]):
            try:
                await c["ws"].send_json(encoded)
            except Exception:
                dead.append(c["ws"])
        for ws in dead:
            self.disconnect(room_key, ws)

    async def kill_dealer(self, dealer_id: str, reason: str = "session_invalidated"):
        """Force-disconnect every socket owned by a dealer. Called from
        bump_token_version() so suspend / revoke / role-change reflect
        on already-open WebSocket sessions."""
        for room_key in list(self.rooms.keys()):
            survivors = []
            for c in self.rooms[room_key]:
                if c["dealer_id"] == dealer_id:
                    try:
                        await c["ws"].send_json({"type": "session_killed", "reason": reason})
                    except Exception:
                        pass
                    try:
                        await c["ws"].close(code=4401)  # custom 4401 = "auth invalidated"
                    except Exception:
                        pass
                else:
                    survivors.append(c)
            self.rooms[room_key] = survivors


manager = ConnectionManager()


# ---------- Auth Endpoints ----------
# Closed-network architecture:
#   • Dealers authenticate ONLY via /auth/dealer/* (approved_dealers allow-list)
#   • Operators authenticate ONLY via /auth/operator/* (operators allow-list)
# There is NO generic auth route, NO public registration, NO role downgrade.
# A phone that is not on the relevant allow-list gets 403 with a stable
# error code that the frontend maps to a premium error message.

# ---- Dealer auth (closed network — approved_dealers allow-list) ----
@api.post("/auth/dealer/send-otp")
async def dealer_send_otp(req: SendOtpReq):
    phone = req.phone.strip()
    if len(phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    approved = await db.approved_dealers.find_one({"phone": phone})
    if not approved or approved.get("status") not in (None, "active"):
        # Off-list OR explicitly paused/revoked → same denial copy (don't leak state).
        asyncio.create_task(audit(db, "dealer_access_denied", None, None, {
            "phone": phone, "reason": "not_active" if approved else "not_on_list",
        }))
        raise HTTPException(status_code=403, detail="DEALER_ACCESS_NOT_APPROVED")
    return {"success": True, "message": "OTP sent", "dev_otp": MOCK_OTP}


@api.post("/auth/dealer/verify-otp")
async def dealer_verify_otp(req: VerifyOtpReq):
    phone = req.phone.strip()
    approved = await db.approved_dealers.find_one({"phone": phone})
    if not approved or approved.get("status") not in (None, "active"):
        asyncio.create_task(audit(db, "dealer_access_denied", None, None, {
            "phone": phone, "stage": "verify",
            "reason": "not_active" if approved else "not_on_list",
        }))
        raise HTTPException(status_code=403, detail="DEALER_ACCESS_NOT_APPROVED")
    if req.otp != MOCK_OTP:
        raise HTTPException(status_code=400, detail="Invalid OTP. Use 123456 for dev.")

    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    is_new = False
    if not dealer:
        is_new = True
        dealer = {
            "id": str(uuid.uuid4()), "phone": phone,
            "full_name": approved.get("seed_full_name", ""),
            "dealership_name": approved.get("seed_dealership_name", ""),
            "city": approved.get("seed_city", ""),
            "gst_number": "", "pan_number": "",
            "kyc_completed": False, "verified": False, "suspended": False,
            "trust_score": float(approved.get("trust_score", 4.5)),
            "max_bid_limit": approved.get("max_bid_limit"),
            "bid_success_rate": 0,
            "total_purchases": 0, "total_listed": 0,
            "role": "dealer",
            "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80",
            "created_at": now_utc(),
        }
        await db.dealers.insert_one(dict(dealer))
    else:
        # Operator role can only be assigned via the operator endpoint.
        if dealer.get("role") != "dealer":
            await db.dealers.update_one({"id": dealer["id"]}, {"$set": {"role": "dealer"}})
            dealer["role"] = "dealer"
        if dealer.get("suspended"):
            raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")
        # Sync max_bid_limit from allow-list (operator may have updated it).
        if approved.get("max_bid_limit") != dealer.get("max_bid_limit"):
            await db.dealers.update_one(
                {"id": dealer["id"]},
                {"$set": {"max_bid_limit": approved.get("max_bid_limit")}},
            )
            dealer["max_bid_limit"] = approved.get("max_bid_limit")

    asyncio.create_task(audit(db, "dealer_login", dealer["id"], None, {"phone": phone}))
    pair = issue_token_pair(dealer)
    return {**pair, "is_new": is_new, "dealer": serialize(dealer)}


# ---- Operator auth (operators allow-list only) ----
@api.post("/auth/operator/send-otp")
async def operator_send_otp(req: SendOtpReq):
    phone = req.phone.strip()
    if not await db.operators.find_one({"phone": phone}):
        asyncio.create_task(audit(db, "operator_access_denied", None, None, {"phone": phone}))
        raise HTTPException(status_code=403, detail="OPERATOR_ACCESS_DENIED")
    return {"success": True, "message": "OTP sent", "dev_otp": MOCK_OTP}


@api.post("/auth/operator/verify-otp")
async def operator_verify_otp(req: VerifyOtpReq):
    phone = req.phone.strip()
    op = await db.operators.find_one({"phone": phone}, {"_id": 0})
    if not op:
        asyncio.create_task(audit(db, "operator_access_denied", None, None, {"phone": phone, "stage": "verify"}))
        raise HTTPException(status_code=403, detail="OPERATOR_ACCESS_DENIED")
    if req.otp != MOCK_OTP:
        raise HTTPException(status_code=400, detail="Invalid OTP. Use 123456 for dev.")

    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    is_new = False
    if not dealer:
        is_new = True
        dealer = {
            "id": str(uuid.uuid4()), "phone": phone,
            "full_name": op.get("full_name", "Q Drives Operator"),
            "dealership_name": op.get("display_name", "Q Drives Operations"),
            "city": op.get("city", "Mumbai"),
            "gst_number": "", "pan_number": "",
            "kyc_completed": True, "verified": True, "suspended": False,
            "trust_score": 5.0, "bid_success_rate": 0,
            "total_purchases": 0, "total_listed": 0,
            "role": op.get("role", "super_admin"),
            "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80",
            "created_at": now_utc(),
        }
        await db.dealers.insert_one(dict(dealer))
    else:
        if dealer.get("role") != "admin" and dealer.get("role") != "super_admin":
            await db.dealers.update_one({"id": dealer["id"]}, {"$set": {"role": op.get("role", "super_admin")}})
            dealer["role"] = op.get("role", "super_admin")

    asyncio.create_task(audit(db, "operator_login", dealer["id"], None, {"phone": phone}))
    pair = issue_token_pair(dealer)
    return {**pair, "is_new": is_new, "dealer": serialize(dealer)}


@api.get("/auth/me")
async def me(dealer = Depends(get_current_dealer)):
    return serialize(dealer)


@api.post("/auth/kyc")
async def submit_kyc(req: KycReq, dealer = Depends(get_current_dealer)):
    update = {
        "full_name": req.full_name,
        "dealership_name": req.dealership_name,
        "city": req.city,
        "gst_number": req.gst_number or "",
        "pan_number": req.pan_number or "",
        "kyc_completed": True,
        "verified": True,
    }
    await db.dealers.update_one({"id": dealer["id"]}, {"$set": update})
    updated = await db.dealers.find_one({"id": dealer["id"]}, {"_id": 0})

    # KYC verification notification (DB + push)
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()),
        "dealer_id": dealer["id"],
        "type": "verification",
        "title": "Verification approved",
        "body": f"Welcome aboard, {req.dealership_name}. You can now bid and list cars.",
        "auction_id": None,
        "read": False,
        "created_at": now_utc(),
    })
    asyncio.create_task(send_to_dealer(
        db, dealer["id"], "Verification approved",
        f"Welcome to Q Drives, {req.dealership_name}. You can now bid & list.",
        data={"type": "verification"},
    ))
    # Standardised response shape — frontend relies on dealer.role for routing.
    return {"success": True, "updated": True, "dealer": serialize(updated)}


# ---------- Auctions ----------
async def _enrich_auction(a: dict) -> dict:
    car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
    seller = await db.dealers.find_one({"id": a.get("seller_id")}, {"_id": 0}) or {}
    insp = await db.inspections.find_one({"car_id": a["car_id"]}, {"_id": 0})
    a = serialize(a)
    a["car"] = serialize(car) if car else None
    a["seller"] = {"id": seller.get("id"), "dealership_name": seller.get("dealership_name", ""), "city": seller.get("city", ""), "verified": seller.get("verified", False)} if seller else None
    a["inspection_pdf"] = serialize(insp) if insp else None
    # compute live state — explicit lifecycle states (paused, cancelled,
    # settled, dispute, force-close payment lifecycle) win over time-based
    # logic. Otherwise compute from time window.
    explicit = a.get("status")
    end = a.get("end_time")
    if isinstance(end, str):
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        end_dt = end
    if end_dt and end_dt.tzinfo is None: end_dt = end_dt.replace(tzinfo=timezone.utc)
    now = now_utc()
    start = a.get("start_time")
    if isinstance(start, str):
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    else:
        start_dt = start
    if start_dt and start_dt.tzinfo is None: start_dt = start_dt.replace(tzinfo=timezone.utc)
    if explicit in ("paused", "cancelled", "settled", "dispute",
                     "ended_pending_payment", "payment_received",
                     "vehicle_released"):
        a["status"] = explicit
    elif start_dt and now < start_dt:
        a["status"] = "upcoming"
    elif end_dt and now > end_dt:
        a["status"] = "ended"
    else:
        a["status"] = "live"
    a["seconds_remaining"] = max(0, int((end_dt - now).total_seconds())) if end_dt else 0
    return a


@api.get("/auctions")
async def list_auctions(status_filter: Optional[str] = None, limit: int = 50):
    cursor = db.auctions.find({}).sort("start_time", -1).limit(limit)
    auctions = await cursor.to_list(limit)
    enriched = [await _enrich_auction(a) for a in auctions]
    if status_filter:
        enriched = [a for a in enriched if a["status"] == status_filter]
    return enriched


@api.get("/auctions/{auction_id}")
async def get_auction(auction_id: str):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    enriched = await _enrich_auction(a)
    bids = await db.bids.find({"auction_id": auction_id}, {"_id": 0}).sort("created_at", -1).limit(20).to_list(20)
    enriched["recent_bids"] = [serialize(b) for b in bids]
    return enriched


@api.post("/auctions/{auction_id}/bid")
async def place_bid(auction_id: str, req: BidReq, dealer = Depends(get_current_dealer)):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    enriched = await _enrich_auction(a)
    if enriched["status"] != "live":
        raise HTTPException(status_code=400, detail="Auction is not live")
    current_bid = a.get("current_bid", 0) or a.get("starting_bid", 0)
    min_increment = 5000
    if req.amount < current_bid + min_increment:
        raise HTTPException(status_code=400, detail=f"Bid must be at least ₹{current_bid + min_increment:,}")
    if dealer["id"] == a.get("seller_id"):
        raise HTTPException(status_code=400, detail="You cannot bid on your own auction")

    # Suspended dealers cannot bid (defense in depth — they can't even login).
    if dealer.get("suspended"):
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")

    # Hard max-bid-limit enforcement. If the operator has set a per-dealer
    # ceiling, ANY attempt above it is rejected (no soft warnings).
    max_limit = dealer.get("max_bid_limit")
    if max_limit and req.amount > int(max_limit):
        raise HTTPException(status_code=403, detail="BID_EXCEEDS_DEALER_LIMIT")

    bid = {
        "id": str(uuid.uuid4()),
        "auction_id": auction_id,
        "dealer_id": dealer["id"],
        "dealer_name": dealer.get("dealership_name") or dealer.get("full_name") or "Dealer",
        "amount": req.amount,
        "cancelled": False,
        "created_at": now_utc(),
    }
    await db.bids.insert_one(dict(bid))

    prev_top = a.get("top_bidder_id")
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {
            "current_bid": req.amount,
            "top_bidder_id": dealer["id"],
            "top_bidder_name": bid["dealer_name"],
            "total_bids": (a.get("total_bids", 0) + 1),
        }}
    )

    # Notify previous top bidder (outbid)
    if prev_top and prev_top != dealer["id"]:
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
        car_label = f"{car.get('year', '')} {car.get('make', '')} {car.get('model', '')}".strip() or "your watched auction"
        push_title = "You've been outbid"
        push_body = f"{bid['dealer_name']} bid ₹{req.amount:,} on {car_label}"
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "dealer_id": prev_top,
            "type": "outbid",
            "title": push_title,
            "body": push_body,
            "auction_id": auction_id,
            "read": False,
            "created_at": now_utc(),
        })
        # Fire-and-forget Expo push (don't block bid response)
        asyncio.create_task(send_to_dealer(
            db, prev_top, push_title, push_body,
            data={"type": "outbid", "auction_id": auction_id},
        ))

    # Broadcast to room
    await manager.broadcast(auction_id, {
        "type": "new_bid",
        "bid": serialize(bid),
        "current_bid": req.amount,
        "top_bidder_id": dealer["id"],
        "top_bidder_name": bid["dealer_name"],
        "total_bids": a.get("total_bids", 0) + 1,
    })

    return {"success": True, "bid": serialize(bid)}


# ---------- Cars / Sell flow ----------
@api.get("/cars")
async def list_cars(limit: int = 50):
    cars = await db.cars.find({}, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    return [serialize(c) for c in cars]


@api.get("/cars/{car_id}")
async def get_car(car_id: str):
    c = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Car not found")
    return serialize(c)


@api.post("/cars")
async def create_car(req: CarCreateReq, dealer = Depends(get_current_admin)):
    car_id = str(uuid.uuid4())
    # Use registration_year as primary "year" (sale year) when provided,
    # otherwise fall back to req.year for backward compat.
    reg_year = req.registration_year or req.year
    mfg_year = req.manufacturing_year or reg_year
    car = {
        "id": car_id,
        "registration_number": req.registration_number.upper(),
        "make": req.make,
        "model": req.model,
        "variant": req.variant or "",
        "year": reg_year,
        "manufacturing_year": mfg_year,
        "registration_year": reg_year,
        "fuel_type": req.fuel_type,
        "transmission": req.transmission,
        "km_driven": req.km_driven,
        "color": req.color or "",
        "owners": req.owners,
        "insurance_validity": req.insurance_validity or "",
        "rto_details": req.rto_details or "",
        "notes": req.notes or "",
        "images": req.images or ["https://images.unsplash.com/photo-1768965468641-39e87aa78a9d?w=1200&q=80"],
        "description": req.description or req.notes or "",
        "inspection_score": round(random.uniform(7.5, 9.4), 1),
        "condition_grade": random.choice(["A", "A", "B", "B+"]),
        "tyre_condition": random.choice(["Excellent", "Good", "Average"]),
        "accident_history": random.choice(["None Reported", "Minor (Repaired)"]),
        "service_history": random.choice(["Authorised Service", "Multi-Brand Service"]),
        "rc_verified": False,
        "seller_id": dealer["id"],
        "created_at": now_utc(),
    }
    await db.cars.insert_one(dict(car))
    asyncio.create_task(audit(db, "car_created", dealer["id"], car_id, {"reg": car["registration_number"], "reserve": req.reserve_price}))

    auction_id = str(uuid.uuid4())
    auction = {
        "id": auction_id,
        "car_id": car_id,
        "seller_id": dealer["id"],
        "starting_bid": req.starting_bid,
        "current_bid": req.starting_bid,
        "reserve_price": req.reserve_price,
        "top_bidder_id": None,
        "top_bidder_name": None,
        "total_bids": 0,
        "interested_dealers": random.randint(8, 24),
        "start_time": now_utc(),
        "end_time": now_utc() + timedelta(minutes=req.duration_minutes),
        "created_at": now_utc(),
    }
    await db.auctions.insert_one(dict(auction))

    await db.dealers.update_one({"id": dealer["id"]}, {"$inc": {"total_listed": 1}})
    return {"car": serialize(car), "auction": await _enrich_auction(auction)}


# ---------- Watchlist ----------
@api.get("/watchlist")
async def get_watchlist(dealer = Depends(get_current_dealer)):
    items = await db.watchlist.find({"dealer_id": dealer["id"]}, {"_id": 0}).to_list(200)
    out = []
    for it in items:
        a = await db.auctions.find_one({"id": it["auction_id"]}, {"_id": 0})
        if a:
            out.append(await _enrich_auction(a))
    return out


@api.post("/watchlist/{auction_id}")
async def add_watchlist(auction_id: str, dealer = Depends(get_current_dealer)):
    existing = await db.watchlist.find_one({"dealer_id": dealer["id"], "auction_id": auction_id})
    if existing:
        return {"success": True, "watching": True}
    await db.watchlist.insert_one({
        "id": str(uuid.uuid4()),
        "dealer_id": dealer["id"],
        "auction_id": auction_id,
        "created_at": now_utc(),
    })
    return {"success": True, "watching": True}


@api.delete("/watchlist/{auction_id}")
async def remove_watchlist(auction_id: str, dealer = Depends(get_current_dealer)):
    await db.watchlist.delete_one({"dealer_id": dealer["id"], "auction_id": auction_id})
    return {"success": True, "watching": False}


# ---------- Purchases (won auctions) ----------
@api.get("/purchases")
async def get_purchases(dealer = Depends(get_current_dealer)):
    """
    Returns auctions where the current dealer is the top bidder. Splits into
    `won` (auction ended + reserve met) and `active` (still live, currently winning).
    Used by the dealer Purchases tab.
    """
    auctions = await db.auctions.find(
        {"top_bidder_id": dealer["id"]}, {"_id": 0}
    ).sort("end_time", -1).limit(100).to_list(100)
    won, active = [], []
    for a in auctions:
        ea = await _enrich_auction(a)
        final_bid = ea.get("current_bid", 0) or 0
        reserve = ea.get("reserve_price", 0) or 0
        if ea["status"] == "ended":
            ea["reserve_met"] = final_bid >= reserve
            ea["outcome"] = "won" if ea["reserve_met"] else "reserve_not_met"
            won.append(ea)
        elif ea["status"] == "live":
            active.append(ea)
    return {"won": won, "active": active}


# ---------- Notifications ----------
@api.get("/notifications")
async def get_notifications(dealer = Depends(get_current_dealer)):
    items = await db.notifications.find({"dealer_id": dealer["id"]}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    return [serialize(n) for n in items]


@api.post("/notifications/mark-read")
async def mark_read(dealer = Depends(get_current_dealer)):
    await db.notifications.update_many({"dealer_id": dealer["id"], "read": False}, {"$set": {"read": True}})
    return {"success": True}


@api.get("/notifications/unread-count")
async def unread_count(dealer = Depends(get_current_dealer)):
    n = await db.notifications.count_documents({"dealer_id": dealer["id"], "read": False})
    return {"unread": n}


@api.post("/notifications/register-token")
async def register_push_token(req: RegisterPushTokenReq, dealer = Depends(get_current_dealer)):
    token = (req.token or "").strip()
    if not is_valid_expo_token(token):
        raise HTTPException(status_code=400, detail="Invalid Expo push token")
    # addToSet keeps tokens unique. Track a small per-token meta doc separately
    # in case we want to know platform/last-seen later.
    await db.dealers.update_one(
        {"id": dealer["id"]},
        {"$addToSet": {"push_tokens": token}},
    )
    await db.push_tokens.update_one(
        {"token": token},
        {"$set": {
            "token": token,
            "dealer_id": dealer["id"],
            "platform": (req.platform or "unknown"),
            "updated_at": now_utc(),
        }},
        upsert=True,
    )
    return {"success": True}


@api.post("/notifications/unregister-token")
async def unregister_push_token(req: RegisterPushTokenReq, dealer = Depends(get_current_dealer)):
    token = (req.token or "").strip()
    if not token:
        return {"success": True}
    await db.dealers.update_one(
        {"id": dealer["id"]},
        {"$pull": {"push_tokens": token}},
    )
    await db.push_tokens.delete_one({"token": token})
    return {"success": True}


@api.post("/notifications/test")
async def test_push(req: TestPushReq, dealer = Depends(get_current_dealer)):
    """Dev/diagnostic helper — sends a test notification to the current dealer's devices."""
    asyncio.create_task(send_to_dealer(
        db, dealer["id"], req.title or "Q Drives", req.body or "Test notification",
        data={"type": "test"},
    ))
    return {"success": True}


# ---------- Admin Operations ----------
@api.get("/admin/dashboard")
async def admin_dashboard(admin = Depends(get_current_admin)):
    """Operational dashboard for the Q Drives admin shell."""
    now = now_utc()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    [
        live_count, upcoming_count, ended_today,
        total_dealers, verified_dealers, suspended_dealers,
        total_inventory, listings_today, bids_today,
    ] = await asyncio.gather(
        db.auctions.count_documents({"status": "live"}),
        db.auctions.count_documents({"status": "upcoming"}),
        db.auctions.count_documents({"status": "ended", "end_time": {"$gte": today_start}}),
        db.dealers.count_documents({"role": {"$ne": "admin"}}),
        db.dealers.count_documents({"role": {"$ne": "admin"}, "verified": True}),
        db.dealers.count_documents({"role": {"$ne": "admin"}, "suspended": True}),
        db.cars.count_documents({}),
        db.cars.count_documents({"created_at": {"$gte": today_start}}),
        db.bids.count_documents({"created_at": {"$gte": today_start}}),
    )

    # Today's GMV (sum of current_bid for ended-today auctions where reserve met)
    gmv_pipeline = [
        {"$match": {"status": "ended", "end_time": {"$gte": today_start}}},
        {"$project": {"current_bid": 1, "reserve_price": 1, "won": {"$gte": ["$current_bid", "$reserve_price"]}}},
        {"$match": {"won": True}},
        {"$group": {"_id": None, "total": {"$sum": "$current_bid"}, "n": {"$sum": 1}}},
    ]
    gmv_today = 0
    deals_today = 0
    async for doc in db.auctions.aggregate(gmv_pipeline):
        gmv_today = doc.get("total") or 0
        deals_today = doc.get("n") or 0

    # Top dealers by purchases
    top_pipeline = [
        {"$match": {"status": "ended", "top_bidder_id": {"$ne": None}}},
        {"$group": {"_id": "$top_bidder_id", "wins": {"$sum": 1}, "spend": {"$sum": "$current_bid"}}},
        {"$sort": {"spend": -1}},
        {"$limit": 5},
    ]
    top_dealers: List[Dict[str, Any]] = []
    async for doc in db.auctions.aggregate(top_pipeline):
        d = await db.dealers.find_one({"id": doc["_id"]}, {"_id": 0, "id": 1, "dealership_name": 1, "city": 1, "trust_score": 1})
        if d:
            top_dealers.append({**d, "wins": doc["wins"], "spend": doc["spend"]})

    # Recent admin-relevant activity (last 5 ended auctions)
    recent: List[Dict[str, Any]] = []
    async for a in db.auctions.find({"status": "ended"}).sort("end_time", -1).limit(5):
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0, "make": 1, "model": 1, "year": 1, "registration_number": 1})
        recent.append({
            "id": a["id"],
            "car": car or {},
            "final_bid": a.get("current_bid", 0),
            "reserve_price": a.get("reserve_price", 0),
            "ended_at": a.get("end_time").isoformat() if a.get("end_time") else None,
            "reserve_met": (a.get("current_bid", 0) >= a.get("reserve_price", 0)),
        })

    return {
        "auctions": {
            "live": live_count, "upcoming": upcoming_count, "ended_today": ended_today,
        },
        "dealers": {
            "total": total_dealers, "verified": verified_dealers, "suspended": suspended_dealers,
            "pending_verification": max(total_dealers - verified_dealers, 0),
        },
        "inventory": {
            "total": total_inventory, "listings_today": listings_today,
        },
        "activity": {
            "bids_today": bids_today, "deals_today": deals_today, "gmv_today_inr": gmv_today,
        },
        "top_dealers": top_dealers,
        "recent_outcomes": recent,
    }


@api.get("/admin/dealers")
async def admin_dealers(
    q: Optional[str] = None,
    status_filter: Optional[str] = None,  # 'verified' | 'pending' | 'suspended'
    admin = Depends(get_current_admin),
):
    """List dealers (excluding other admins) with filters for the approval queue."""
    query: Dict[str, Any] = {"role": {"$ne": "admin"}}
    if status_filter == "verified":
        query["verified"] = True
        query["suspended"] = {"$ne": True}
    elif status_filter == "pending":
        query["verified"] = {"$ne": True}
    elif status_filter == "suspended":
        query["suspended"] = True
    if q:
        safe = re.escape(q)
        query["$or"] = [
            {"phone": {"$regex": safe, "$options": "i"}},
            {"dealership_name": {"$regex": safe, "$options": "i"}},
            {"full_name": {"$regex": safe, "$options": "i"}},
            {"city": {"$regex": safe, "$options": "i"}},
        ]
    items = await db.dealers.find(query, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    # Enrich with quick metrics
    out = []
    for d in items:
        bids = await db.bids.count_documents({"dealer_id": d["id"]})
        wins = await db.auctions.count_documents({"top_bidder_id": d["id"], "status": "ended"})
        out.append({**serialize(d), "bids_count": bids, "wins_count": wins})
    return out


@api.post("/admin/dealers/{dealer_id}/verify")
async def admin_verify_dealer(
    dealer_id: str, req: DealerVerifyReq, admin = Depends(get_current_admin),
):
    """Approve / suspend / re-verify a dealer."""
    target = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Dealer not found")
    if target.get("role") == "admin":
        raise HTTPException(status_code=400, detail="Cannot mutate admin accounts")

    update: Dict[str, Any] = {}
    if req.verified is not None:
        update["verified"] = bool(req.verified)
        if req.verified:
            update["suspended"] = False
    if req.kyc_completed is not None:
        update["kyc_completed"] = bool(req.kyc_completed)
    if req.suspended is not None:
        update["suspended"] = bool(req.suspended)
    if not update:
        return serialize(target)
    await db.dealers.update_one({"id": dealer_id}, {"$set": update})
    updated = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})

    # Audit
    asyncio.create_task(audit(db, "dealer_status_change", admin["id"], dealer_id, {"changes": update}))

    # Server-side session kill on suspend OR loss of verified flag.
    if update.get("suspended") is True or update.get("verified") is False:
        asyncio.create_task(bump_token_version(dealer_id, reason="dealer_status_change", actor_id=admin["id"]))

    # Push verification status change
    if req.verified is True:
        title = "Dealer status verified"
        body = f"Welcome, {updated.get('dealership_name') or 'dealer'}. You are now an active Q Drives dealer."
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer_id, "type": "verification",
            "title": title, "body": body, "auction_id": None,
            "read": False, "created_at": now_utc(),
        })
        asyncio.create_task(send_to_dealer(db, dealer_id, title, body, data={"type": "verification"}))
    elif req.suspended is True:
        title = "Account suspended"
        body = "Your Q Drives account has been suspended. Contact support for details."
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer_id, "type": "suspended",
            "title": title, "body": body, "auction_id": None,
            "read": False, "created_at": now_utc(),
        })
        asyncio.create_task(send_to_dealer(db, dealer_id, title, body, data={"type": "suspended"}))
    return serialize(updated)


@api.post("/auth/refresh")
async def auth_refresh(creds: Optional[HTTPAuthorizationCredentials] = Depends(security)):
    """Exchange a valid refresh token for a fresh access+refresh pair.
    The submitted refresh token MUST have kind='refresh' and a tv that
    matches the dealer's current token_version. Otherwise 401."""
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        dealer_id = payload["sub"]
        if payload.get("kind") != "refresh":
            raise HTTPException(status_code=401, detail="Wrong token kind")
        token_tv = int(payload.get("tv", 0))
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Refresh expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid refresh")

    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not dealer:
        raise HTTPException(status_code=401, detail="Dealer not found")
    current_tv = int(dealer.get("token_version") or 0)
    if token_tv != current_tv:
        raise HTTPException(status_code=401, detail="SESSION_INVALIDATED")
    if dealer.get("suspended") and (dealer.get("role") or "dealer") == "dealer":
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")
    pair = issue_token_pair(dealer)
    return {**pair, "dealer": serialize(dealer)}


# ============================================================
# Settlement state machine (explicit, immutable, timestamp-mandatory)
# ============================================================

# Allowed transitions: only forward + dispute fork. No reverse motion
# without an explicit operator override (which is itself audited).
SETTLEMENT_FLOW: Dict[str, set] = {
    "live": {"ended_pending_payment", "cancelled"},
    "ended_pending_payment": {"payment_received", "dispute", "cancelled"},
    "payment_received": {"vehicle_released", "dispute"},
    "vehicle_released": {"settled", "dispute"},
    "settled": set(),  # terminal — closed forever
    "dispute": {"settled", "cancelled"},  # admin-resolved fork
    "cancelled": set(),  # terminal
    "ended": {"ended_pending_payment", "cancelled"},  # legacy alias
    "scheduled": {"live", "cancelled"},
    "paused": {"live", "cancelled"},
}

# Timestamp field per state.
SETTLEMENT_TS_FIELD: Dict[str, str] = {
    "ended_pending_payment": "ended_at",
    "payment_received": "payment_received_at",
    "vehicle_released": "released_at",
    "settled": "settled_at",
    "dispute": "dispute_opened_at",
    "cancelled": "cancelled_at",
    "live": "started_at",
    "paused": "paused_at",
}


class SettlementTransitionReq(BaseModel):
    target_state: str
    note: Optional[str] = ""


@api.post("/admin/auctions/{auction_id}/settlement")
async def admin_settlement_transition(
    auction_id: str, req: SettlementTransitionReq,
    admin = Depends(require_permission("manage_inventory")),
):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    src = await _effective_status(a) or "live"
    tgt = req.target_state
    if tgt not in SETTLEMENT_FLOW:
        raise HTTPException(status_code=400, detail=f"Unknown state: {tgt}")
    if tgt not in SETTLEMENT_FLOW.get(src, set()):
        raise HTTPException(status_code=400, detail=f"Illegal transition {src} -> {tgt}")
    update: Dict[str, Any] = {"status": tgt}
    ts_field = SETTLEMENT_TS_FIELD.get(tgt)
    if ts_field:
        update[ts_field] = now_utc()
    await db.auctions.update_one({"id": auction_id}, {"$set": update})
    asyncio.create_task(audit(db, "settlement_state_change", admin["id"], auction_id, {
        "from": src, "to": tgt, "note": req.note or "",
    }))
    # Broadcast to subscribed clients
    await manager.broadcast(auction_id, {"type": "settlement_state", "status": tgt})
    return {"ok": True, "status": tgt}


# ============================================================
# Operator auction controls — pause / extend / cancel / force_close
# Every action is audited; nothing is hard-deleted.
# ============================================================

class AuctionPauseReq(BaseModel):
    reason: str


class AuctionExtendReq(BaseModel):
    extend_seconds: int
    reason: Optional[str] = ""


class AuctionCancelReq(BaseModel):
    reason: str


async def _effective_status(a: Dict[str, Any]) -> str:
    """Return the canonical lifecycle state for an auction, accounting for
    time-based transitions when the DB status is unset (legacy seed data).
    Explicit lifecycle states (paused, ended_pending_payment, settled,
    cancelled, dispute, payment_received, vehicle_released) win over time."""
    explicit = a.get("status")
    if explicit and explicit != "live":
        return explicit
    end = a.get("end_time")
    start = a.get("start_time")
    if isinstance(end, str): end = datetime.fromisoformat(end.replace("Z", "+00:00"))
    if isinstance(start, str): start = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if end and end.tzinfo is None: end = end.replace(tzinfo=timezone.utc)
    if start and start.tzinfo is None: start = start.replace(tzinfo=timezone.utc)
    now = now_utc()
    if start and now < start:
        return "scheduled"
    if end and now >= end:
        return "ended"
    return "live"


@api.post("/admin/auctions/{auction_id}/pause")
async def admin_pause_auction(
    auction_id: str, req: AuctionPauseReq,
    admin = Depends(require_permission("pause_auction")),
):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    eff = await _effective_status(a)
    if eff not in ("live", "scheduled"):
        raise HTTPException(status_code=400, detail=f"Only live/scheduled auctions can be paused (current: {eff})")
    if not req.reason or not req.reason.strip():
        raise HTTPException(status_code=400, detail="Reason is mandatory")
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {"status": "paused", "paused_at": now_utc(),
                  "paused_reason": req.reason.strip(), "paused_by": admin["id"]}},
    )
    asyncio.create_task(audit(db, "auction_pause", admin["id"], auction_id, {"reason": req.reason}))
    await manager.broadcast(auction_id, {"type": "auction_pause", "reason": req.reason})
    return {"ok": True}


@api.post("/admin/auctions/{auction_id}/resume")
async def admin_resume_auction(
    auction_id: str,
    admin = Depends(require_permission("pause_auction")),
):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a or a.get("status") != "paused":
        raise HTTPException(status_code=400, detail="Auction is not paused")
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {"status": "live", "resumed_at": now_utc()}},
    )
    asyncio.create_task(audit(db, "auction_resume", admin["id"], auction_id, {}))
    await manager.broadcast(auction_id, {"type": "auction_resume"})
    return {"ok": True}


@api.post("/admin/auctions/{auction_id}/extend")
async def admin_extend_auction(
    auction_id: str, req: AuctionExtendReq,
    admin = Depends(require_permission("extend_auction")),
):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    eff = await _effective_status(a)
    if eff not in ("live", "paused"):
        raise HTTPException(status_code=400, detail=f"Cannot extend a non-live auction (current: {eff})")
    if req.extend_seconds < 30 or req.extend_seconds > 24 * 3600:
        raise HTTPException(status_code=400, detail="Extension must be between 30s and 24h")
    end_time = a.get("end_time")
    if not end_time:
        raise HTTPException(status_code=400, detail="Auction has no end_time")
    if isinstance(end_time, str):
        end_time = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
    new_end = end_time + timedelta(seconds=req.extend_seconds)
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {"end_time": new_end, "last_extended_at": now_utc(),
                  "last_extended_by": admin["id"], "last_extension_seconds": req.extend_seconds},
         "$inc": {"extension_count": 1}},
    )
    asyncio.create_task(audit(db, "auction_extend", admin["id"], auction_id, {
        "extend_seconds": req.extend_seconds, "reason": req.reason or "",
        "new_end": iso(new_end),
    }))
    await manager.broadcast(auction_id, {"type": "auction_extend", "new_end": iso(new_end), "extend_seconds": req.extend_seconds})
    return {"ok": True, "new_end": iso(new_end)}


@api.post("/admin/auctions/{auction_id}/cancel")
async def admin_cancel_auction(
    auction_id: str, req: AuctionCancelReq,
    admin = Depends(require_permission("cancel_auction")),
):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    eff = await _effective_status(a)
    if eff in ("settled", "cancelled"):
        raise HTTPException(status_code=400, detail="Already terminal")
    if not req.reason or not req.reason.strip():
        raise HTTPException(status_code=400, detail="Reason is mandatory")
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {"status": "cancelled", "cancelled_at": now_utc(),
                  "cancelled_reason": req.reason.strip(), "cancelled_by": admin["id"]}},
    )
    asyncio.create_task(audit(db, "auction_cancel", admin["id"], auction_id, {"reason": req.reason}))
    await manager.broadcast(auction_id, {"type": "auction_cancel", "reason": req.reason})
    return {"ok": True}


@api.post("/admin/auctions/{auction_id}/force-close")
async def admin_force_close(
    auction_id: str, req: AuctionCancelReq,
    admin = Depends(require_permission("cancel_auction")),
):
    """Immediately ends a live auction (declares the current top bidder
    the winner if any) and moves it to ended_pending_payment. Otherwise
    transitions to cancelled if no bids."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    eff = await _effective_status(a)
    if eff not in ("live", "paused"):
        raise HTTPException(status_code=400, detail=f"Cannot force-close a non-live auction (current: {eff})")
    if not req.reason or not req.reason.strip():
        raise HTTPException(status_code=400, detail="Reason is mandatory")
    has_winner = bool(a.get("top_bidder_id"))
    target = "ended_pending_payment" if has_winner else "cancelled"
    update: Dict[str, Any] = {
        "status": target,
        "ended_at": now_utc(),
        "force_closed_at": now_utc(),
        "force_closed_by": admin["id"],
        "force_closed_reason": req.reason.strip(),
    }
    if target == "cancelled":
        update["cancelled_at"] = now_utc()
        update["cancelled_reason"] = req.reason.strip()
    await db.auctions.update_one({"id": auction_id}, {"$set": update})
    asyncio.create_task(audit(db, "force_close", admin["id"], auction_id, {
        "reason": req.reason, "winner": a.get("top_bidder_id"), "amount": a.get("current_bid"),
    }))
    await manager.broadcast(auction_id, {"type": "force_close", "status": target})
    return {"ok": True, "status": target}


# ============================================================
# Immutable bid cancellation (compensating reversal pattern)
# Original bid is NEVER deleted/edited. A bid_reversals doc is appended,
# the bid is flagged cancelled=true, and the auction current_bid is
# recomputed from the next-highest non-cancelled bid.
# ============================================================

class BidCancelReq(BaseModel):
    reason: str


@api.post("/admin/auctions/{auction_id}/bids/{bid_id}/cancel")
async def admin_cancel_bid(
    auction_id: str, bid_id: str, req: BidCancelReq,
    request: Request,
    admin = Depends(require_permission("cancel_bid")),
):
    if not req.reason or not req.reason.strip():
        raise HTTPException(status_code=400, detail="Reason is mandatory")
    bid = await db.bids.find_one({"id": bid_id, "auction_id": auction_id}, {"_id": 0})
    if not bid:
        raise HTTPException(status_code=404, detail="Bid not found")
    if bid.get("cancelled"):
        raise HTTPException(status_code=400, detail="Bid already cancelled")

    # Append-only reversal event — preserves original bid and creates
    # a complete forensic audit trail. We capture IP/UA when available.
    ip = request.client.host if request and request.client else None
    ua = request.headers.get("user-agent") if request else None
    reversal = {
        "id": str(uuid.uuid4()),
        "kind": "bid_cancellation",
        "bid_id": bid_id,
        "auction_id": auction_id,
        "dealer_id": bid["dealer_id"],
        "amount": bid["amount"],  # snapshot of cancelled amount
        "reason": req.reason.strip(),
        "operator_id": admin["id"],
        "operator_ip": ip,
        "operator_ua": ua,
        "created_at": now_utc(),
    }
    await db.bid_reversals.insert_one(dict(reversal))

    # Flag the bid as cancelled (NOT delete).
    await db.bids.update_one(
        {"id": bid_id},
        {"$set": {"cancelled": True, "cancelled_at": now_utc(),
                  "cancelled_by": admin["id"], "cancellation_reason": req.reason.strip()}},
    )

    # Recompute current_bid from highest non-cancelled bid on this auction.
    next_top = await db.bids.find_one(
        {"auction_id": auction_id, "cancelled": {"$ne": True}},
        sort=[("amount", -1)],
    )
    set_doc: Dict[str, Any] = {}
    if next_top:
        set_doc["current_bid"] = next_top["amount"]
        set_doc["top_bidder_id"] = next_top["dealer_id"]
        set_doc["top_bidder_name"] = next_top.get("dealer_name", "Dealer")
    else:
        # No remaining bids — fall back to starting price, no top bidder.
        a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
        set_doc["current_bid"] = (a or {}).get("starting_bid", 0)
        set_doc["top_bidder_id"] = None
        set_doc["top_bidder_name"] = None
    # total_bids tracks valid-only bids
    valid_count = await db.bids.count_documents({"auction_id": auction_id, "cancelled": {"$ne": True}})
    set_doc["total_bids"] = valid_count
    await db.auctions.update_one({"id": auction_id}, {"$set": set_doc})

    asyncio.create_task(audit(db, "bid_cancel", admin["id"], bid["dealer_id"], {
        "bid_id": bid_id, "auction_id": auction_id, "amount": bid["amount"],
        "reason": req.reason, "ip": ip,
    }))
    await manager.broadcast(auction_id, {
        "type": "bid_cancelled", "bid_id": bid_id,
        "current_bid": set_doc["current_bid"],
        "top_bidder_id": set_doc.get("top_bidder_id"),
    })
    # Notify the affected dealer
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()), "dealer_id": bid["dealer_id"],
        "type": "bid_cancelled", "title": "Your bid was cancelled",
        "body": f"Your bid of ₹{bid['amount']:,} was cancelled by Q Drives. Reason: {req.reason}",
        "auction_id": auction_id, "read": False, "created_at": now_utc(),
    })
    asyncio.create_task(send_to_dealer(
        db, bid["dealer_id"], "Your bid was cancelled",
        f"₹{bid['amount']:,} cancelled. Reason: {req.reason}",
        data={"type": "bid_cancelled", "auction_id": auction_id},
    ))
    return {"ok": True, "reversal_id": reversal["id"], "current_bid": set_doc["current_bid"]}


# ============================================================
# Live auction grid — operator real-time monitor data
# ============================================================

@api.get("/admin/auctions/live-grid")
async def admin_live_grid(admin = Depends(get_current_admin)):
    """Dense real-time grid for the operator console. Returns one row
    per non-terminal auction with everything needed to monitor it.

    Status on auction docs is computed at enrich-time (live/upcoming/ended)
    so we filter by time window or explicit lifecycle states."""
    now = now_utc()
    # An auction is "monitorable" if:
    #   • it is currently live (start_time <= now < end_time and not in a
    #     terminal lifecycle state), OR
    #   • it is in an explicit operator-managed state.
    cursor = db.auctions.find(
        {
            "$or": [
                {"status": {"$in": ["live", "paused", "scheduled",
                                     "ended_pending_payment", "payment_received",
                                     "vehicle_released", "dispute"]}},
                # Time-window fallback for legacy docs without an explicit status
                {"$and": [
                    {"end_time": {"$gt": now}},
                    {"$or": [{"status": None}, {"status": {"$exists": False}}]},
                ]},
                # Recently ended (within 7d) but no terminal state set
                {"$and": [
                    {"end_time": {"$lte": now, "$gte": now - timedelta(days=7)}},
                    {"$or": [{"status": None}, {"status": {"$exists": False}}]},
                ]},
            ],
        },
        {"_id": 0},
    ).sort("end_time", 1).limit(200)
    items: List[Dict[str, Any]] = []
    async for a in cursor:
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0,
            "make": 1, "model": 1, "year": 1, "registration_number": 1}) or {}
        bidder = None
        if a.get("top_bidder_id"):
            b = await db.dealers.find_one({"id": a["top_bidder_id"]}, {"_id": 0,
                "id": 1, "dealership_name": 1, "trust_score": 1, "city": 1, "max_bid_limit": 1})
            if b:
                bidder = {
                    "id": b["id"],
                    "dealership_name": b.get("dealership_name", ""),
                    "trust_score": b.get("trust_score", 4.5),
                    "city": b.get("city", ""),
                    "max_bid_limit": b.get("max_bid_limit"),
                }
        # Bid velocity: bids in last 60 seconds
        velocity = await db.bids.count_documents({
            "auction_id": a["id"], "cancelled": {"$ne": True},
            "created_at": {"$gte": now - timedelta(seconds=60)},
        })
        # Last bid timestamp
        last_bid = await db.bids.find_one(
            {"auction_id": a["id"], "cancelled": {"$ne": True}},
            sort=[("created_at", -1)],
        )
        end = a.get("end_time")
        if isinstance(end, str):
            end = datetime.fromisoformat(end.replace("Z", "+00:00"))
        if end and end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        time_left_s = int((end - now).total_seconds()) if end else 0
        items.append({
            "id": a["id"],
            "status": a.get("status"),
            "car": {**car, "id": a["car_id"]},
            "current_bid": a.get("current_bid", a.get("starting_bid", 0)),
            "starting_bid": a.get("starting_bid", 0),
            "reserve_price": a.get("reserve_price"),
            "reserve_met": (a.get("current_bid", 0) or 0) >= (a.get("reserve_price") or 0),
            "top_bidder": bidder,
            "total_bids": a.get("total_bids", 0),
            "watcher_count": a.get("watcher_count", 0),
            "velocity_60s": velocity,
            "last_bid_at": iso(last_bid["created_at"]) if last_bid and isinstance(last_bid.get("created_at"), datetime) else None,
            "end_time": iso(end) if end else None,
            "time_left_s": max(0, time_left_s),
            "extension_count": a.get("extension_count", 0),
            "paused_reason": a.get("paused_reason"),
        })
    return {"items": items, "ts": iso(now)}


@api.get("/admin/auctions/{auction_id}/control-panel")
async def admin_auction_control_panel(
    auction_id: str, admin = Depends(get_current_admin),
):
    """Detail view for the operator with full bid book including
    cancelled bids and reversals. Append-only forensic data."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
    bids = []
    async for b in db.bids.find({"auction_id": auction_id}, {"_id": 0}).sort("created_at", -1).limit(200):
        d = await db.dealers.find_one({"id": b["dealer_id"]}, {"_id": 0,
            "dealership_name": 1, "trust_score": 1, "city": 1})
        bids.append({**b,
            "created_at": iso(b["created_at"]) if isinstance(b.get("created_at"), datetime) else b.get("created_at"),
            "cancelled_at": iso(b["cancelled_at"]) if isinstance(b.get("cancelled_at"), datetime) else b.get("cancelled_at"),
            "dealer": d,
        })
    reversals = []
    async for r in db.bid_reversals.find({"auction_id": auction_id}, {"_id": 0}).sort("created_at", -1).limit(50):
        reversals.append({**r,
            "created_at": iso(r["created_at"]) if isinstance(r.get("created_at"), datetime) else r.get("created_at"),
        })
    return {
        "auction": serialize(a),
        "car": serialize(car),
        "bids": bids,
        "reversals": reversals,
    }


# ============================================================
# Settlement Pipeline — operator Kanban data feed.
# Returns auctions in any settlement-relevant state (post-live)
# with operator-focused enrichment (age, overdue flag, dealer
# trust, suspended flag, dispute marker, notes, high-value flag).
# ============================================================

class SettlementNoteReq(BaseModel):
    note: str


SETTLEMENT_STATES = (
    "ended_pending_payment",
    "payment_received",
    "vehicle_released",
    "settled",
    "dispute",
    "cancelled",
)

# Payment SLA — auctions in ended_pending_payment for longer than this
# are flagged as overdue on the operator console.
PAYMENT_SLA_HOURS = 48
HIGH_VALUE_THRESHOLD = 1000000  # ₹10L+ flagged as high-value-unsettled


@api.get("/admin/settlements/pipeline")
async def admin_settlement_pipeline(
    window_days: int = 30,
    admin = Depends(get_current_admin),
):
    """Settlement Kanban data. Returns one row per auction currently in
    a settlement-relevant state, plus terminal states (settled / cancelled)
    within the recent window. Designed for the operator pipeline tracker.

    Highlights:
      • settlement_age_h — hours elapsed since the auction entered the
        current state (or end_time for ended_pending_payment).
      • payment_overdue — bool, true if status==ended_pending_payment AND
        age > PAYMENT_SLA_HOURS.
      • high_value_unsettled — bool, current_bid >= HIGH_VALUE_THRESHOLD AND
        status not in {settled, cancelled}.
      • dispute_flag — bool, status==dispute OR auction has any
        settlement_state_change → dispute audit log.
      • suspended_dealer — bool, top_bidder is currently suspended.
    """
    now = now_utc()
    window_start = now - timedelta(days=max(1, min(window_days, 90)))

    # Non-terminal states: always include regardless of age.
    nonterminal = ["ended_pending_payment", "payment_received", "vehicle_released", "dispute"]
    # Terminal states: only within window.
    terminal = ["settled", "cancelled"]

    cursor = db.auctions.find(
        {
            "$or": [
                {"status": {"$in": nonterminal}},
                {"status": {"$in": terminal}, "$or": [
                    {"settled_at": {"$gte": window_start}},
                    {"cancelled_at": {"$gte": window_start}},
                    {"ended_at": {"$gte": window_start}},
                ]},
            ],
        },
        {"_id": 0},
    ).sort("ended_at", -1).limit(300)

    items: List[Dict[str, Any]] = []
    counts = {s: 0 for s in SETTLEMENT_STATES}
    async for a in cursor:
        status = a.get("status")
        if status not in SETTLEMENT_STATES:
            continue
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0,
            "make": 1, "model": 1, "year": 1, "registration_number": 1}) or {}
        bidder = None
        suspended_dealer = False
        if a.get("top_bidder_id"):
            b = await db.dealers.find_one({"id": a["top_bidder_id"]}, {"_id": 0,
                "id": 1, "dealership_name": 1, "full_name": 1, "trust_score": 1,
                "city": 1, "phone": 1, "max_bid_limit": 1, "suspended": 1})
            if b:
                suspended_dealer = bool(b.get("suspended"))
                bidder = {
                    "id": b["id"],
                    "dealership_name": b.get("dealership_name", ""),
                    "full_name": b.get("full_name", ""),
                    "trust_score": b.get("trust_score", 4.5),
                    "city": b.get("city", ""),
                    "phone": b.get("phone", ""),
                    "max_bid_limit": b.get("max_bid_limit"),
                    "suspended": suspended_dealer,
                }

        # Determine the timestamp anchor for "settlement_age" — the time
        # the auction entered its current state. For ended_pending_payment,
        # use ended_at; for paid/released/settled/dispute/cancelled, use
        # their respective ts fields.
        anchor_field = SETTLEMENT_TS_FIELD.get(status, "ended_at")
        anchor = a.get(anchor_field) or a.get("ended_at") or a.get("end_time")
        if isinstance(anchor, str):
            try:
                anchor = datetime.fromisoformat(anchor.replace("Z", "+00:00"))
            except Exception:
                anchor = None
        if anchor and anchor.tzinfo is None:
            anchor = anchor.replace(tzinfo=timezone.utc)
        age_h = int((now - anchor).total_seconds() / 3600) if anchor else 0

        current_bid = a.get("current_bid", 0) or 0
        payment_overdue = (status == "ended_pending_payment" and age_h > PAYMENT_SLA_HOURS)
        high_value_unsettled = (current_bid >= HIGH_VALUE_THRESHOLD
                                and status not in ("settled", "cancelled"))

        counts[status] += 1
        items.append({
            "id": a["id"],
            "status": status,
            "car": {**car, "id": a["car_id"]},
            "final_bid": current_bid,
            "starting_bid": a.get("starting_bid", 0),
            "reserve_price": a.get("reserve_price"),
            "reserve_met": (current_bid >= (a.get("reserve_price") or 0)) if a.get("reserve_price") else None,
            "top_bidder": bidder,
            "suspended_dealer": suspended_dealer,
            "total_bids": a.get("total_bids", 0),
            "ended_at": iso(a.get("ended_at")) if isinstance(a.get("ended_at"), datetime) else a.get("ended_at"),
            "payment_received_at": iso(a.get("payment_received_at")) if isinstance(a.get("payment_received_at"), datetime) else a.get("payment_received_at"),
            "released_at": iso(a.get("released_at")) if isinstance(a.get("released_at"), datetime) else a.get("released_at"),
            "settled_at": iso(a.get("settled_at")) if isinstance(a.get("settled_at"), datetime) else a.get("settled_at"),
            "cancelled_at": iso(a.get("cancelled_at")) if isinstance(a.get("cancelled_at"), datetime) else a.get("cancelled_at"),
            "dispute_opened_at": iso(a.get("dispute_opened_at")) if isinstance(a.get("dispute_opened_at"), datetime) else a.get("dispute_opened_at"),
            "settlement_age_h": age_h,
            "payment_overdue": payment_overdue,
            "high_value_unsettled": high_value_unsettled,
            "dispute_flag": status == "dispute",
            "settlement_notes": a.get("settlement_notes", []) or [],
            "cancelled_reason": a.get("cancelled_reason"),
        })

    return {
        "items": items,
        "by_state": counts,
        "ts": iso(now),
        "sla_hours": PAYMENT_SLA_HOURS,
        "high_value_threshold": HIGH_VALUE_THRESHOLD,
    }


@api.post("/admin/auctions/{auction_id}/settlement/note")
async def admin_settlement_add_note(
    auction_id: str, req: SettlementNoteReq,
    admin = Depends(require_permission("manage_inventory")),
):
    """Append an immutable operator note to an auction's settlement_notes
    array. Each note carries operator_id, ts and text. Audited."""
    note = (req.note or "").strip()
    if len(note) < 5:
        raise HTTPException(status_code=400, detail="Note must be at least 5 characters")
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0, "id": 1, "status": 1})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    entry = {
        "id": str(uuid.uuid4()),
        "text": note,
        "operator_id": admin["id"],
        "operator_name": admin.get("full_name") or admin.get("dealership_name") or "Operator",
        "created_at": now_utc(),
    }
    await db.auctions.update_one({"id": auction_id}, {"$push": {"settlement_notes": entry}})
    asyncio.create_task(audit(db, "settlement_note_add", admin["id"], auction_id, {
        "note_id": entry["id"], "text": note[:200],
    }))
    # Broadcast to live ops listeners so the kanban can refresh in-place.
    try:
        await manager.broadcast(auction_id, {"type": "settlement_note", "note": {**entry, "created_at": iso(entry["created_at"])}})
    except Exception:
        pass
    return {"ok": True, "note": {**entry, "created_at": iso(entry["created_at"])}}



# ============================================================
# Dealer Risk Visibility feed
# ============================================================

@api.get("/admin/risk/dealers")
async def admin_dealer_risk(admin = Depends(get_current_admin)):
    """Aggregated risk indicators across the dealer network. Surfaces
    suspended dealers, repeated denied logins, cancelled bids,
    abnormal bidding frequency, high-value bidding spikes, and
    inactive high-limit dealers."""
    now = now_utc()
    h24 = now - timedelta(hours=24)
    d7 = now - timedelta(days=7)
    d30 = now - timedelta(days=30)

    suspended = await db.dealers.find(
        {"suspended": True, "role": "dealer"}, {"_id": 0, "id": 1, "phone": 1, "dealership_name": 1, "city": 1},
    ).limit(100).to_list(100)

    # Repeat denied login attempts in 24h (already aggregated)
    denied_pipeline = [
        {"$match": {"action": {"$in": ["dealer_access_denied", "operator_access_denied"]}, "ts": {"$gte": h24}}},
        {"$group": {"_id": "$meta.phone", "attempts": {"$sum": 1}}},
        {"$match": {"attempts": {"$gte": 3}}},
        {"$sort": {"attempts": -1}}, {"$limit": 20},
    ]
    repeat_denied = [{"phone": r["_id"], "attempts": r["attempts"]} async for r in db.audit_logs.aggregate(denied_pipeline) if r["_id"]]

    # Cancelled bids in 7d, by dealer
    cancel_pipeline = [
        {"$match": {"created_at": {"$gte": d7}}},
        {"$group": {"_id": "$dealer_id", "cancellations": {"$sum": 1}, "amount": {"$sum": "$amount"}}},
        {"$sort": {"cancellations": -1}}, {"$limit": 10},
    ]
    cancellations = []
    async for r in db.bid_reversals.aggregate(cancel_pipeline):
        if not r["_id"]:
            continue
        d = await db.dealers.find_one({"id": r["_id"]}, {"_id": 0, "dealership_name": 1, "phone": 1})
        cancellations.append({"dealer_id": r["_id"], "cancellations": r["cancellations"], "amount": r["amount"], "dealer": d or {}})

    # Abnormal bidding frequency: >50 bids in 1h
    freq_pipeline = [
        {"$match": {"created_at": {"$gte": now - timedelta(hours=1)}, "cancelled": {"$ne": True}}},
        {"$group": {"_id": "$dealer_id", "bids": {"$sum": 1}}},
        {"$match": {"bids": {"$gte": 50}}},
        {"$sort": {"bids": -1}}, {"$limit": 10},
    ]
    abnormal_freq = []
    async for r in db.bids.aggregate(freq_pipeline):
        d = await db.dealers.find_one({"id": r["_id"]}, {"_id": 0, "dealership_name": 1, "phone": 1})
        abnormal_freq.append({"dealer_id": r["_id"], "bids_1h": r["bids"], "dealer": d or {}})

    # High-value spikes: any single bid > 50L in 24h
    spikes = []
    async for b in db.bids.find({
        "created_at": {"$gte": h24}, "cancelled": {"$ne": True}, "amount": {"$gte": 5000000},
    }, {"_id": 0}).sort("amount", -1).limit(10):
        d = await db.dealers.find_one({"id": b["dealer_id"]}, {"_id": 0, "dealership_name": 1})
        spikes.append({
            "bid_id": b["id"], "amount": b["amount"], "dealer_id": b["dealer_id"],
            "dealership_name": (d or {}).get("dealership_name", ""),
            "auction_id": b["auction_id"],
            "created_at": iso(b["created_at"]) if isinstance(b.get("created_at"), datetime) else b.get("created_at"),
        })

    # Inactive high-limit dealers: max_bid_limit set but 0 bids in 30d
    inactive = []
    async for d in db.dealers.find(
        {"role": "dealer", "max_bid_limit": {"$gte": 1000000}, "suspended": {"$ne": True}},
        {"_id": 0, "id": 1, "phone": 1, "dealership_name": 1, "max_bid_limit": 1, "city": 1},
    ).limit(200):
        recent_bids = await db.bids.count_documents({"dealer_id": d["id"], "created_at": {"$gte": d30}})
        if recent_bids == 0:
            inactive.append({**d, "days_inactive": 30})

    return {
        "suspended": suspended,
        "repeat_denied_24h": repeat_denied,
        "cancellations_7d": cancellations,
        "abnormal_frequency_1h": abnormal_freq,
        "high_value_spikes_24h": spikes,
        "inactive_high_limit": inactive[:10],
        "ts": iso(now),
    }


@api.post("/admin/notifications/broadcast")
async def admin_broadcast(req: BroadcastReq, admin = Depends(get_current_admin)):
    """Broadcast a push to all (verified|active) dealers."""
    audience = (req.audience or "all").lower()
    q: Dict[str, Any] = {"role": {"$ne": "admin"}}
    if audience == "verified":
        q["verified"] = True
        q["suspended"] = {"$ne": True}
    elif audience == "active":
        q["suspended"] = {"$ne": True}
    ids = [d["id"] async for d in db.dealers.find(q, {"id": 1, "_id": 0})]
    if not ids:
        return {"sent": 0}
    # Persist notification per dealer + dispatch push fan-out
    docs = []
    now = now_utc()
    for did in ids:
        docs.append({
            "id": str(uuid.uuid4()), "dealer_id": did, "type": "broadcast",
            "title": req.title, "body": req.body, "auction_id": None,
            "read": False, "created_at": now,
        })
    if docs:
        await db.notifications.insert_many(docs)
    asyncio.create_task(send_to_dealers(db, ids, req.title, req.body, data={"type": "broadcast"}))
    asyncio.create_task(audit(db, "admin_broadcast", admin["id"], None, {
        "audience": audience, "title": req.title, "recipients": len(ids),
    }))
    return {"sent": len(ids)}


# ============================================================
# Allow-list management — Operator-controlled dealer onboarding.
# Phase 1 of the closed-network architecture: operator pre-fills
# the dealer profile when whitelisting a phone. The dealer's first
# OTP login then uses these pre-filled values, eliminating junk
# self-onboarding.
# ============================================================

@api.get("/admin/approved-dealers")
async def list_approved_dealers(
    status_filter: Optional[str] = None,
    q: Optional[str] = None,
    admin = Depends(require_permission("manage_allow_list")),
):
    """List the dealer allow-list with onboarding status.
    status: 'active' | 'paused' | 'revoked' (joined with dealer KYC state)."""
    query: Dict[str, Any] = {}
    if status_filter and status_filter != "all":
        if status_filter == "active":
            query["status"] = {"$in": ["active", None]}
        else:
            query["status"] = status_filter
    if q:
        safe = re.escape(q)
        query["$or"] = [
            {"phone": {"$regex": safe, "$options": "i"}},
            {"seed_full_name": {"$regex": safe, "$options": "i"}},
            {"seed_dealership_name": {"$regex": safe, "$options": "i"}},
            {"seed_city": {"$regex": safe, "$options": "i"}},
        ]
    rows = await db.approved_dealers.find(query, {"_id": 0}).sort("added_at", -1).limit(500).to_list(500)
    out = []
    for r in rows:
        # Join with dealer document if they've logged in at least once.
        dealer_doc = await db.dealers.find_one({"phone": r["phone"]}, {"_id": 0})
        onboarding = "never_logged_in"
        if dealer_doc:
            if dealer_doc.get("suspended"):
                onboarding = "suspended"
            elif dealer_doc.get("kyc_completed"):
                onboarding = "active"
            else:
                onboarding = "kyc_pending"
        out.append({
            "phone": r["phone"],
            "full_name": r.get("seed_full_name", ""),
            "dealership_name": r.get("seed_dealership_name", ""),
            "city": r.get("seed_city", ""),
            "trust_score": r.get("trust_score", 4.5),
            "max_bid_limit": r.get("max_bid_limit"),
            "notes": r.get("notes", ""),
            "status": r.get("status", "active"),
            "added_at": iso(r["added_at"]) if isinstance(r.get("added_at"), datetime) else r.get("added_at"),
            "added_by": r.get("added_by"),
            "onboarding": onboarding,
            "dealer_id": dealer_doc["id"] if dealer_doc else None,
        })
    return out


@api.post("/admin/approved-dealers")
async def add_approved_dealer(
    req: ApprovedDealerReq,
    admin = Depends(require_permission("manage_allow_list")),
):
    """Add a phone to the dealer allow-list with a pre-filled draft profile.
    Idempotent on phone — subsequent calls update the seed values."""
    phone = req.phone.strip()
    if len(phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    existing = await db.approved_dealers.find_one({"phone": phone})
    if existing:
        raise HTTPException(status_code=409, detail="Phone is already on the allow-list")
    # Block adding an operator phone as a dealer (defense in depth).
    if await db.operators.find_one({"phone": phone}):
        raise HTTPException(status_code=409, detail="Phone is registered as an operator")
    doc = {
        "phone": phone,
        "seed_full_name": req.full_name or "",
        "seed_dealership_name": req.dealership_name or "",
        "seed_city": req.city or "",
        "trust_score": float(req.trust_score) if req.trust_score is not None else 4.5,
        "max_bid_limit": int(req.max_bid_limit) if req.max_bid_limit else None,
        "notes": req.notes or "",
        "status": "active",
        "added_by": admin["id"],
        "added_at": now_utc(),
    }
    await db.approved_dealers.insert_one(dict(doc))
    asyncio.create_task(audit(db, "allow_list_add", admin["id"], None, {
        "phone": phone,
        "dealership_name": doc["seed_dealership_name"],
        "max_bid_limit": doc["max_bid_limit"],
    }))
    doc.pop("_id", None)
    if isinstance(doc.get("added_at"), datetime):
        doc["added_at"] = iso(doc["added_at"])
    return doc


@api.patch("/admin/approved-dealers/{phone}")
async def patch_approved_dealer(
    phone: str,
    req: ApprovedDealerPatch,
    admin = Depends(require_permission("manage_allow_list")),
):
    """Edit the pre-filled draft profile or change status (active/paused/revoked).
    Status changes propagate to the live dealer doc when applicable."""
    existing = await db.approved_dealers.find_one({"phone": phone})
    if not existing:
        raise HTTPException(status_code=404, detail="Allow-list entry not found")
    update: Dict[str, Any] = {}
    if req.full_name is not None: update["seed_full_name"] = req.full_name
    if req.dealership_name is not None: update["seed_dealership_name"] = req.dealership_name
    if req.city is not None: update["seed_city"] = req.city
    if req.trust_score is not None: update["trust_score"] = float(req.trust_score)
    if req.max_bid_limit is not None:
        update["max_bid_limit"] = int(req.max_bid_limit) if req.max_bid_limit else None
    if req.notes is not None: update["notes"] = req.notes
    if req.status is not None:
        if req.status not in ("active", "paused", "revoked"):
            raise HTTPException(status_code=400, detail="Invalid status")
        update["status"] = req.status
    if not update:
        return {"ok": True}
    await db.approved_dealers.update_one({"phone": phone}, {"$set": update})

    # Propagate max_bid_limit + status side-effects to live dealer doc.
    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    if dealer:
        side: Dict[str, Any] = {}
        if "max_bid_limit" in update:
            side["max_bid_limit"] = update["max_bid_limit"]
        if update.get("status") == "revoked":
            side["suspended"] = True
        if side:
            await db.dealers.update_one({"id": dealer["id"]}, {"$set": side})

    asyncio.create_task(audit(db, "allow_list_update", admin["id"],
                              dealer["id"] if dealer else None,
                              {"phone": phone, "changes": update}))
    return {"ok": True, "updated": update}


@api.delete("/admin/approved-dealers/{phone}")
async def remove_approved_dealer(
    phone: str,
    admin = Depends(require_permission("manage_allow_list")),
):
    """Soft-revoke (set status='revoked'). Never hard-delete — we keep the
    audit trail intact for fraud/abuse investigations."""
    existing = await db.approved_dealers.find_one({"phone": phone})
    if not existing:
        raise HTTPException(status_code=404, detail="Allow-list entry not found")
    await db.approved_dealers.update_one(
        {"phone": phone},
        {"$set": {"status": "revoked", "revoked_at": now_utc(), "revoked_by": admin["id"]}},
    )
    # Also suspend the live dealer doc immediately if present.
    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    if dealer:
        await db.dealers.update_one({"id": dealer["id"]}, {"$set": {"suspended": True}})
        # Server-side session kill — every outstanding JWT for this dealer dies now.
        asyncio.create_task(bump_token_version(dealer["id"], reason="allow_list_revoke", actor_id=admin["id"]))
    asyncio.create_task(audit(db, "allow_list_revoke", admin["id"],
                              dealer["id"] if dealer else None, {"phone": phone}))
    return {"ok": True}


# ============================================================
# Per-dealer max bid limit (hard backend enforcement)
# ============================================================

@api.post("/admin/dealers/{dealer_id}/max-bid")
async def set_dealer_max_bid(
    dealer_id: str,
    req: MaxBidReq,
    admin = Depends(require_permission("set_max_bid")),
):
    """Set the per-dealer max bid ceiling. None or 0 → no limit. Hard
    enforced at /auctions/{id}/bid (returns 403 BID_EXCEEDS_DEALER_LIMIT)."""
    target = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Dealer not found")
    if (target.get("role") or "dealer") != "dealer":
        raise HTTPException(status_code=400, detail="Cannot set bid limits on operator accounts")
    new_limit = int(req.max_bid_limit) if req.max_bid_limit else None
    await db.dealers.update_one({"id": dealer_id}, {"$set": {"max_bid_limit": new_limit}})
    # Mirror to allow-list entry for source-of-truth consistency.
    await db.approved_dealers.update_one(
        {"phone": target["phone"]}, {"$set": {"max_bid_limit": new_limit}},
    )
    asyncio.create_task(audit(db, "max_bid_change", admin["id"], dealer_id, {
        "phone": target["phone"],
        "previous": target.get("max_bid_limit"),
        "new": new_limit,
    }))
    updated = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    return serialize(updated)


# ============================================================
# Dealer detail view (full profile, bid history, activity)
# ============================================================

@api.get("/admin/dealers/{dealer_id}")
async def admin_dealer_detail(
    dealer_id: str,
    admin = Depends(get_current_admin),
):
    target = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Dealer not found")
    if (target.get("role") or "dealer") != "dealer":
        raise HTTPException(status_code=403, detail="Cannot view operator accounts via this endpoint")

    # Aggregate bid history (recent 50)
    bids = []
    async for b in db.bids.find({"dealer_id": dealer_id}).sort("created_at", -1).limit(50):
        a = await db.auctions.find_one({"id": b["auction_id"]}, {"_id": 0, "id": 1, "car_id": 1, "status": 1, "current_bid": 1, "top_bidder_id": 1})
        car = {}
        if a:
            car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0, "make": 1, "model": 1, "year": 1, "registration_number": 1}) or {}
        bids.append({
            "id": b["id"],
            "auction_id": b["auction_id"],
            "amount": b["amount"],
            "created_at": iso(b["created_at"]) if isinstance(b.get("created_at"), datetime) else b.get("created_at"),
            "car": car,
            "auction_status": (a or {}).get("status"),
            "is_top_bidder": (a or {}).get("top_bidder_id") == dealer_id,
        })

    wins_count = await db.auctions.count_documents({"top_bidder_id": dealer_id, "status": "ended"})
    bids_count = await db.bids.count_documents({"dealer_id": dealer_id})
    recent_logins = await db.audit_logs.find(
        {"actor_id": dealer_id, "action": "dealer_login"},
        {"_id": 0, "ts": 1, "meta": 1},
    ).sort("ts", -1).limit(10).to_list(10)
    for r in recent_logins:
        if isinstance(r.get("ts"), datetime):
            r["ts"] = iso(r["ts"])

    allow = await db.approved_dealers.find_one({"phone": target["phone"]}, {"_id": 0})

    return {
        "dealer": serialize(target),
        "bids_count": bids_count,
        "wins_count": wins_count,
        "recent_bids": bids,
        "recent_logins": recent_logins,
        "allow_list": {
            "status": (allow or {}).get("status", "active"),
            "added_at": iso(allow["added_at"]) if allow and isinstance(allow.get("added_at"), datetime) else None,
            "notes": (allow or {}).get("notes", ""),
        } if allow else None,
    }


# ============================================================
# Audit log viewer (security-focused events only)
# ============================================================

# Whitelist of actions surfaced in the operator audit viewer.
SECURITY_AUDIT_ACTIONS = {
    "dealer_login", "operator_login",
    "dealer_access_denied", "operator_access_denied",
    "allow_list_add", "allow_list_update", "allow_list_revoke",
    "dealer_status_change", "max_bid_change",
    "auction_pause", "auction_resume", "auction_extend",
    "auction_cancel", "force_close", "settlement_state_change",
    "settlement_note_add",
    "bid_cancel", "admin_broadcast", "operator_promotion",
    "token_invalidation", "suspicious_activity_flag",
}


@api.get("/admin/audit-logs")
async def admin_audit_logs(
    action: Optional[str] = None,
    q: Optional[str] = None,
    since_hours: Optional[int] = None,
    limit: int = 100,
    admin = Depends(require_permission("view_audit")),
):
    """Security-focused audit feed. Filters: action, free-text in meta.phone /
    meta.changes, since_hours."""
    query: Dict[str, Any] = {"action": {"$in": list(SECURITY_AUDIT_ACTIONS)}}
    if action and action in SECURITY_AUDIT_ACTIONS:
        query["action"] = action
    if since_hours:
        query["ts"] = {"$gte": now_utc() - timedelta(hours=int(since_hours))}
    if q:
        safe = re.escape(q)
        query["$or"] = [
            {"meta.phone": {"$regex": safe, "$options": "i"}},
            {"actor_id": {"$regex": safe, "$options": "i"}},
            {"target_id": {"$regex": safe, "$options": "i"}},
        ]
    limit = max(1, min(int(limit), 500))
    rows = await db.audit_logs.find(query, {"_id": 0}).sort("ts", -1).limit(limit).to_list(limit)
    for r in rows:
        if isinstance(r.get("ts"), datetime):
            r["ts"] = iso(r["ts"])
    return {
        "items": rows,
        "total": await db.audit_logs.count_documents(query),
    }


@api.get("/admin/security/denied-logins")
async def admin_denied_logins(
    since_hours: Optional[int] = None,
    limit: int = 100,
    admin = Depends(require_permission("view_audit")),
):
    """Last N denied login attempts (dealer + operator). Persists permanently
    in audit_logs — used for fraud detection & abuse tracking."""
    query: Dict[str, Any] = {
        "action": {"$in": ["dealer_access_denied", "operator_access_denied"]},
    }
    if since_hours:
        query["ts"] = {"$gte": now_utc() - timedelta(hours=int(since_hours))}
    limit = max(1, min(int(limit), 500))
    rows = await db.audit_logs.find(query, {"_id": 0}).sort("ts", -1).limit(limit).to_list(limit)
    for r in rows:
        if isinstance(r.get("ts"), datetime):
            r["ts"] = iso(r["ts"])
    # Aggregate counts per phone for quick risk visibility
    phone_counts: Dict[str, int] = {}
    for r in rows:
        ph = (r.get("meta") or {}).get("phone")
        if ph:
            phone_counts[ph] = phone_counts.get(ph, 0) + 1
    repeat_offenders = sorted(
        [{"phone": p, "attempts": c} for p, c in phone_counts.items()],
        key=lambda x: -x["attempts"],
    )[:10]
    return {
        "items": rows,
        "total_attempts": len(rows),
        "repeat_offenders": repeat_offenders,
    }


# ---------- Auction Lifecycle Scheduler (ending-soon / ended winner) ----------
async def _push_ending_soon(auction: dict, minutes_left: int) -> None:
    car = await db.cars.find_one({"id": auction["car_id"]}, {"_id": 0}) or {}
    label = f"{car.get('year', '')} {car.get('make', '')} {car.get('model', '')}".strip() or "an auction"
    title = f"Closing in {minutes_left} min"
    body = f"{label} is ending soon at ₹{auction.get('current_bid', 0):,}."

    # Top bidder + watchers
    recipients: set = set()
    if auction.get("top_bidder_id"):
        recipients.add(auction["top_bidder_id"])
    watchers = await db.watchlist.find(
        {"auction_id": auction["id"]}, {"_id": 0, "dealer_id": 1}
    ).to_list(500)
    for w in watchers:
        recipients.add(w["dealer_id"])
    # Don't notify the seller about their own auction closing (keeps focus on bidders)
    recipients.discard(auction.get("seller_id"))
    if not recipients:
        return

    # Persist DB notif for each + send pushes
    docs = []
    now = now_utc()
    for did in recipients:
        docs.append({
            "id": str(uuid.uuid4()),
            "dealer_id": did,
            "type": "ending_soon",
            "title": title,
            "body": body,
            "auction_id": auction["id"],
            "read": False,
            "created_at": now,
        })
    if docs:
        await db.notifications.insert_many(docs)
    await send_to_dealers(
        db, list(recipients), title, body,
        data={"type": "ending_soon", "auction_id": auction["id"]},
    )


async def _push_auction_ended(auction: dict) -> None:
    car = await db.cars.find_one({"id": auction["car_id"]}, {"_id": 0}) or {}
    label = f"{car.get('year', '')} {car.get('make', '')} {car.get('model', '')}".strip() or "your auction"
    final_bid = auction.get("current_bid", 0) or 0
    reserve = auction.get("reserve_price", 0) or 0
    won = bool(auction.get("top_bidder_id")) and final_bid >= reserve
    now = now_utc()
    docs: List[Dict[str, Any]] = []

    # Winner / loser
    top = auction.get("top_bidder_id")
    if top:
        if won:
            t = "You won!"
            b = f"{label} sold to you for ₹{final_bid:,}. Payment instructions next."
        else:
            t = "Auction ended below reserve"
            b = f"{label} closed at ₹{final_bid:,} — reserve not met. Seller will review."
        docs.append({
            "id": str(uuid.uuid4()), "dealer_id": top, "type": "win" if won else "ended",
            "title": t, "body": b, "auction_id": auction["id"],
            "read": False, "created_at": now,
        })
        asyncio.create_task(send_to_dealer(
            db, top, t, b, data={"type": "win" if won else "ended", "auction_id": auction["id"]},
        ))

    # Seller
    seller = auction.get("seller_id")
    if seller:
        if won:
            t = "Your car sold"
            b = f"{label} sold for ₹{final_bid:,}. Buyer details inside."
        elif final_bid > 0:
            t = "Reserve not met"
            b = f"{label} closed at ₹{final_bid:,}. Choose to relist or accept best offer."
        else:
            t = "Auction ended"
            b = f"{label} ended with no bids. Try relisting with a fresh inspection."
        docs.append({
            "id": str(uuid.uuid4()), "dealer_id": seller, "type": "auction_closed",
            "title": t, "body": b, "auction_id": auction["id"],
            "read": False, "created_at": now,
        })
        asyncio.create_task(send_to_dealer(
            db, seller, t, b, data={"type": "auction_closed", "auction_id": auction["id"]},
        ))

    if docs:
        await db.notifications.insert_many(docs)


async def auction_scheduler() -> None:
    """
    Background loop that runs every ~30s and dispatches:
      • "ending_soon" pushes ~5 min before close (one-shot per auction)
      • "auction ended" pushes when an auction crosses end_time (one-shot)
    Idempotent via flags written back onto the auction doc.
    """
    await asyncio.sleep(15)  # let the app warm up + finish seeding
    while True:
        try:
            now = now_utc()
            soon_window_low = now + timedelta(minutes=4)
            soon_window_high = now + timedelta(minutes=6)

            # Ending-soon (one shot per auction, only for those still live)
            soon_cursor = db.auctions.find({
                "ending_soon_notified": {"$ne": True},
                "end_time": {"$gte": soon_window_low, "$lte": soon_window_high},
                "start_time": {"$lte": now},
            }, {"_id": 0})
            async for a in soon_cursor:
                try:
                    await _push_ending_soon(a, 5)
                    await db.auctions.update_one(
                        {"id": a["id"]},
                        {"$set": {"ending_soon_notified": True}},
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("ending_soon push failed for %s: %s", a.get("id"), exc)

            # Ended (one-shot)
            ended_cursor = db.auctions.find({
                "ended_notified": {"$ne": True},
                "end_time": {"$lte": now},
            }, {"_id": 0})
            async for a in ended_cursor:
                try:
                    await _push_auction_ended(a)
                    await db.auctions.update_one(
                        {"id": a["id"]},
                        {"$set": {"ended_notified": True}},
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("auction_ended push failed for %s: %s", a.get("id"), exc)

        except Exception as exc:  # noqa: BLE001
            logger.warning("auction_scheduler tick failed: %s", exc)
        await asyncio.sleep(30)


# ---------- Dashboard ----------
@api.get("/dashboard/stats")
async def dashboard_stats(dealer = Depends(get_current_dealer)):
    total_bids = await db.bids.count_documents({"dealer_id": dealer["id"]})
    won_count = await db.auctions.count_documents({"top_bidder_id": dealer["id"]})
    listed = dealer.get("total_listed", 0)
    live_count = 0
    all_auctions = await db.auctions.find({}, {"_id": 0}).to_list(500)
    market_volume = 0
    for a in all_auctions:
        ea = await _enrich_auction(a)
        if ea["status"] == "live":
            live_count += 1
            market_volume += ea.get("current_bid", 0)
    return {
        "live_auctions": live_count,
        "market_volume_today": market_volume,
        "your_bids": total_bids,
        "your_wins": won_count,
        "your_listings": listed,
        "trust_score": dealer.get("trust_score", 4.5),
        "bid_success_rate": round((won_count / total_bids * 100) if total_bids else 0, 1),
    }


# ---------- AI Pricing ----------
@api.post("/ai/price-estimate")
async def ai_price_estimate(req: PriceEstimateReq):
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=os.environ["EMERGENT_LLM_KEY"],
            session_id=f"price-{uuid.uuid4()}",
            system_message=(
                "You are an expert Indian wholesale used-car pricing analyst for B2B dealer auctions. "
                "Given car details, return a realistic wholesale (dealer-to-dealer) price estimate in INR. "
                "Always reply ONLY with strict JSON: "
                '{"estimated_price_inr": int, "market_low_inr": int, "market_high_inr": int, "confidence": "high|medium|low", "reasoning": "1-2 sentences"}'
            ),
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        prompt = (
            f"Car: {req.year} {req.make} {req.model}\n"
            f"KM driven: {req.km_driven:,}\n"
            f"Fuel: {req.fuel_type}\n"
            f"Owners: {req.owners}\n"
            f"Inspection condition score (out of 10): {req.condition_score}\n"
            "Provide a wholesale dealer-to-dealer auction price in Indian Rupees. JSON only."
        )
        resp = await chat.send_message(UserMessage(text=prompt))
        text = str(resp).strip()
        # extract JSON
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            text = text[start:end+1]
        data = json.loads(text)
        return data
    except Exception as e:
        logger.exception("AI price estimate failed: %s", e)
        # Reasonable fallback heuristic so UI never breaks
        base = max(80000, 1500000 - (2026 - req.year) * 70000 - req.km_driven * 0.6)
        base *= (0.85 if req.owners > 2 else 1.0)
        base *= (req.condition_score / 8.5)
        est = int(base)
        return {
            "estimated_price_inr": est,
            "market_low_inr": int(est * 0.92),
            "market_high_inr": int(est * 1.10),
            "confidence": "medium",
            "reasoning": "Heuristic estimate (AI unavailable). Based on age, kms, owners and inspection score.",
        }


# ---------- Inspection PDF Endpoints ----------
MAX_PDF_BYTES = 10 * 1024 * 1024  # 10 MB

@api.post("/inspections/upload")
async def upload_inspection_pdf(
    car_id: str = Form(...),
    version: Optional[str] = Form("v1"),
    file: UploadFile = File(...),
    dealer = Depends(get_current_admin),
):
    # Validate file
    if file.content_type not in ("application/pdf", "application/x-pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Filename must end with .pdf")

    # Read into memory and enforce size cap
    contents = await file.read()
    if len(contents) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail=f"PDF exceeds {MAX_PDF_BYTES // (1024*1024)} MB limit")
    if len(contents) < 200:
        raise HTTPException(status_code=400, detail="PDF file looks empty/corrupt")

    # Validate associated car (admin can attach to any Q Drives listing)
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")

    # Persist into GridFS
    safe_name = (file.filename or f"inspection-{car_id}.pdf").replace("/", "_")
    gridfs_id = await inspections_bucket.upload_from_stream(
        safe_name,
        contents,
        metadata={"car_id": car_id, "uploader_id": dealer["id"], "version": version or "v1"},
    )

    # Replace any existing inspection record for this car (keep latest)
    inspection = {
        "id": str(uuid.uuid4()),
        "car_id": car_id,
        "uploader_id": dealer["id"],
        "uploader_name": dealer.get("dealership_name") or dealer.get("full_name") or "Dealer",
        "filename": safe_name,
        "size_bytes": len(contents),
        "version": version or "v1",
        "status": "verified",
        "gridfs_id": str(gridfs_id),
        "created_at": now_utc(),
    }
    await db.inspections.delete_many({"car_id": car_id})
    await db.inspections.insert_one(dict(inspection))

    return serialize(inspection)


@api.get("/inspections/by-car/{car_id}")
async def get_inspection_for_car(car_id: str):
    insp = await db.inspections.find_one({"car_id": car_id}, {"_id": 0})
    if not insp:
        return None
    return serialize(insp)


@api.get("/inspections/file/{inspection_id}")
async def download_inspection_pdf(
    inspection_id: str,
    token: Optional[str] = Query(default=None),
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """
    Auth-gated PDF stream.
    Accepts JWT either via Authorization header (creds) OR ?token= query
    param so <a href> / Linking.openURL can stream the file from native/web
    without having to inject custom headers.
    """
    raw = None
    if creds and creds.credentials:
        raw = creds.credentials
    elif token:
        raw = token
    if not raw:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        jwt.decode(raw, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    insp = await db.inspections.find_one({"id": inspection_id}, {"_id": 0})
    if not insp:
        raise HTTPException(status_code=404, detail="Inspection not found")

    try:
        from bson import ObjectId
        gid = ObjectId(insp["gridfs_id"])
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid stored file id")

    try:
        stream = await inspections_bucket.open_download_stream(gid)
    except Exception:
        raise HTTPException(status_code=404, detail="File missing in storage")

    async def iterator():
        while True:
            chunk = await stream.readchunk()
            if not chunk:
                break
            yield chunk

    headers = {
        "Content-Disposition": f'inline; filename="{insp.get("filename", "inspection.pdf")}"',
        "Cache-Control": "private, max-age=300",
    }
    return StreamingResponse(iterator(), media_type="application/pdf", headers=headers)


# ---------- Vehicle Media (provider-agnostic) ----------
@api.get("/cars/{car_id}/media")
async def list_car_media(car_id: str, section: Optional[str] = None):
    """Public — returns ordered media records for the car (with `url` + `thumb_url`).
    Includes external/legacy URLs as well as GridFS-stored uploads."""
    items = await media_svc.list_for_car(db, car_id, section=section)
    return items


@api.get("/cars/{car_id}/media/completeness")
async def media_completeness(car_id: str, dealer = Depends(get_current_dealer)):
    """Returns counts per section + missing items + valid flag."""
    return await media_svc.completeness(db, car_id)


@api.post("/media/upload")
async def upload_media(
    car_id: str = Form(...),
    section: str = Form(...),
    subsection: Optional[str] = Form(None),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    file: UploadFile = File(...),
    thumb: Optional[UploadFile] = File(None),
    dealer = Depends(get_current_admin),
):
    """Admin-only multi-image upload. The client compresses each photo to
    1920px JPEG q≈80% before posting; an optional 400px thumbnail is sent
    in the same multipart request to avoid a second round-trip."""
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    if section not in media_svc.SECTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown section: {section}")

    full_bytes = await file.read()
    full_ct = (file.content_type or "image/jpeg").lower()
    thumb_bytes = None
    thumb_ct = None
    if thumb is not None:
        thumb_bytes = await thumb.read()
        thumb_ct = (thumb.content_type or "image/jpeg").lower()

    try:
        record = await media_svc.create_uploaded(
            db,
            car_id=car_id,
            section=section,
            full_bytes=full_bytes,
            full_content_type=full_ct,
            full_filename=file.filename or "upload.jpg",
            thumb_bytes=thumb_bytes,
            thumb_content_type=thumb_ct,
            width=width,
            height=height,
            subsection=subsection,
            created_by=dealer["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return record


@api.delete("/media/{media_id}")
async def delete_car_media(media_id: str, dealer = Depends(get_current_admin)):
    ok = await media_svc.delete_media(db, media_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Media not found")
    return {"success": True}


@api.patch("/media/{media_id}")
async def patch_media(media_id: str, req: UpdateMediaReq, dealer = Depends(get_current_admin)):
    try:
        return await media_svc.update_section(db, media_id, req.section, req.subsection)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/cars/{car_id}/media/reorder")
async def reorder_media(car_id: str, req: ReorderMediaReq, dealer = Depends(get_current_admin)):
    await media_svc.reorder(db, car_id, req.ordered_ids)
    return {"success": True}


@api.post("/cars/{car_id}/media/featured/{media_id}")
async def set_featured_media(car_id: str, media_id: str, dealer = Depends(get_current_admin)):
    ok = await media_svc.set_featured(db, car_id, media_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Media not found for this car")
    # Reflect featured into car.images[0] for backwards compat (if non-external)
    feat = await db.media.find_one({"id": media_id}, {"_id": 0})
    if feat and feat.get("provider") == "external" and feat.get("external_url"):
        await db.cars.update_one({"id": car_id}, {"$set": {"images.0": feat["external_url"]}})
    return {"success": True}


@api.post("/cars/{car_id}/attest-no-damage")
async def attest_no_damage(car_id: str, req: AttestNoDamageReq, dealer = Depends(get_current_admin)):
    await db.cars.update_one(
        {"id": car_id}, {"$set": {"no_damage_attested": req.no_damage_attested}}
    )
    return {"success": True}


@api.get("/media/{media_id}/file")
async def media_file(media_id: str):
    m = await media_svc.get(db, media_id)
    if not m:
        raise HTTPException(status_code=404, detail="Media not found")
    if m.get("provider") == "external" and m.get("external_url"):
        # 302 to external URL
        return RedirectResponse(url=m["external_url"], status_code=302)
    storage = storage_service.get_default_storage()
    sid = m.get("storage_id")
    if not sid:
        raise HTTPException(status_code=404, detail="Storage object missing")
    meta = await storage.get_meta(sid)
    if not meta:
        raise HTTPException(status_code=404, detail="File not found in storage")
    headers = {"Cache-Control": "public, max-age=86400"}
    return StreamingResponse(
        storage.stream(sid),
        media_type=meta.get("content_type", "image/jpeg"),
        headers=headers,
    )


@api.get("/media/{media_id}/thumb")
async def media_thumb(media_id: str):
    m = await media_svc.get(db, media_id)
    if not m:
        raise HTTPException(status_code=404, detail="Media not found")
    if m.get("provider") == "external" and m.get("external_url"):
        return RedirectResponse(url=m["external_url"], status_code=302)
    storage = storage_service.get_default_storage()
    sid = m.get("thumb_storage_id") or m.get("storage_id")
    if not sid:
        raise HTTPException(status_code=404, detail="Storage object missing")
    meta = await storage.get_meta(sid)
    if not meta:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    headers = {"Cache-Control": "public, max-age=86400"}
    return StreamingResponse(
        storage.stream(sid),
        media_type=meta.get("content_type", "image/jpeg"),
        headers=headers,
    )


# ---------- Network activity (public ticker) ----------
@api.get("/network/activity")
async def network_activity(limit: int = 12):
    bids = await db.bids.find({}, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    items = []
    for b in bids:
        a = await db.auctions.find_one({"id": b["auction_id"]}, {"_id": 0})
        if not a:
            continue
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
        items.append({
            "id": b["id"],
            "amount": b["amount"],
            "dealer_name": b.get("dealer_name", "Dealer"),
            "auction_id": a["id"],
            "car_short": f"{car.get('year', '')} {car.get('make', '')} {car.get('model', '')}".strip(),
            "created_at": iso(b["created_at"]) if isinstance(b.get("created_at"), datetime) else b.get("created_at"),
        })
    return items


# ---------- Live market pulse (public) ----------
@api.get("/market/pulse")
async def market_pulse():
    all_auctions = await db.auctions.find({}, {"_id": 0}).to_list(500)
    live = upcoming = ended = 0
    volume = 0
    top_makes: Dict[str, int] = {}
    for a in all_auctions:
        ea = await _enrich_auction(a)
        s = ea["status"]
        if s == "live":
            live += 1
            volume += ea.get("current_bid", 0)
        elif s == "upcoming":
            upcoming += 1
        else:
            ended += 1
        car = ea.get("car") or {}
        mk = car.get("make")
        if mk:
            top_makes[mk] = top_makes.get(mk, 0) + 1
    return {
        "live": live,
        "upcoming": upcoming,
        "ended": ended,
        "live_volume_inr": volume,
        "top_makes": sorted([{"make": k, "count": v} for k, v in top_makes.items()], key=lambda x: -x["count"])[:5],
    }


# ---------- WebSocket ----------
async def _ws_authenticate(token: str) -> Optional[Dict[str, Any]]:
    """Validate a JWT for WebSocket use. Returns the dealer dict on success
    (with role + tv) or None on any failure. Failure modes:
      • missing/empty token
      • signature/format invalid
      • expired
      • wrong kind (refresh used instead of access)
      • dealer not found
      • token_version mismatch (suspended/revoked/role-change)
      • suspended dealer (defense in depth)
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("kind", "access") != "access":
            return None
        dealer_id = payload["sub"]
        token_tv = int(payload.get("tv", 0))
    except Exception:
        return None
    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not dealer:
        return None
    if int(dealer.get("token_version") or 0) != token_tv:
        return None
    if dealer.get("suspended") and (dealer.get("role") or "dealer") == "dealer":
        return None
    return dealer


@app.websocket("/api/ws/auction/{auction_id}")
async def ws_auction(websocket: WebSocket, auction_id: str):
    """Authenticated dealer/operator WS for live auction streams.
    Token MUST be passed as a query parameter `?token=<jwt>` on connect.
    Anonymous or invalid connections are rejected with code 4401."""
    token = websocket.query_params.get("token", "")
    dealer = await _ws_authenticate(token)
    if not dealer:
        await websocket.close(code=4401)
        return

    role = dealer.get("role") or "dealer"
    tv = int(dealer.get("token_version") or 0)
    room_key = f"auction:{auction_id}"
    await manager.connect(room_key, websocket, dealer_id=dealer["id"], role=role, tv=tv)

    try:
        # On connect, send latest snapshot. Use jsonable_encoder to handle
        # nested datetime values inside enriched auction (car/seller/etc).
        a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
        if a:
            ea = await _enrich_auction(a)
            await websocket.send_json({"type": "snapshot", "auction": jsonable_encoder(ea)})
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
                # Periodic re-validation: if the dealer's tv has bumped server-
                # side (allow-list revoke / role change in another worker), kill
                # this socket on the next keepalive.
                fresh = await db.dealers.find_one(
                    {"id": dealer["id"]}, {"_id": 0, "token_version": 1, "suspended": 1, "role": 1},
                )
                if (not fresh
                    or int(fresh.get("token_version") or 0) != tv
                    or (fresh.get("suspended") and (fresh.get("role") or "dealer") == "dealer")):
                    try: await websocket.send_json({"type": "session_killed", "reason": "tv_drift"})
                    except Exception: pass
                    await websocket.close(code=4401)
                    break
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("WS error: %s", e)
    finally:
        manager.disconnect(room_key, websocket)


@app.websocket("/api/ws/ops")
async def ws_ops(websocket: WebSocket):
    """Operator-only WebSocket channel — receives ops events (live grid
    updates, settlement transitions, dealer status changes) and is fully
    isolated from dealer subscribers. Dealer JWTs are rejected even if
    valid, because dealers must NEVER see internal ops chatter."""
    token = websocket.query_params.get("token", "")
    dealer = await _ws_authenticate(token)
    if not dealer:
        await websocket.close(code=4401)
        return
    role = dealer.get("role") or "dealer"
    if role not in ("admin", "super_admin", "operations_admin", "inspection_admin"):
        await websocket.close(code=4403)  # role denied
        return
    tv = int(dealer.get("token_version") or 0)
    await manager.connect("ops", websocket, dealer_id=dealer["id"], role=role, tv=tv)
    try:
        await websocket.send_json({"type": "ops_connected", "role": role})
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
                fresh = await db.dealers.find_one(
                    {"id": dealer["id"]}, {"_id": 0, "token_version": 1, "role": 1},
                )
                if (not fresh
                    or int(fresh.get("token_version") or 0) != tv
                    or (fresh.get("role") or "dealer") not in
                        ("admin", "super_admin", "operations_admin", "inspection_admin")):
                    try: await websocket.send_json({"type": "session_killed", "reason": "tv_drift"})
                    except Exception: pass
                    await websocket.close(code=4401)
                    break
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("WS-ops error: %s", e)
    finally:
        manager.disconnect("ops", websocket)


@api.get("/")
async def root():
    return {"service": "Q Drives API", "status": "ok"}


# Mount router
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Seed Data ----------
SEED_DEALERS = [
    {"phone": "+919900000099", "full_name": "Q Drives Admin", "dealership_name": "Q Drives Inventory", "city": "Mumbai", "verified": True, "trust_score": 5.0, "bid_success_rate": 0, "total_purchases": 0, "total_listed": 0, "kyc_completed": True, "role": "admin", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000001", "full_name": "Rahul Mehta", "dealership_name": "Apex Premium Motors", "city": "Mumbai", "verified": True, "trust_score": 4.9, "bid_success_rate": 78.0, "total_purchases": 142, "total_listed": 38, "kyc_completed": True, "role": "dealer", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000002", "full_name": "Arjun Singh", "dealership_name": "Royal Drives Co.", "city": "Delhi", "verified": True, "trust_score": 4.7, "bid_success_rate": 65.0, "total_purchases": 88, "total_listed": 22, "kyc_completed": True, "role": "dealer", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000003", "full_name": "Vikram Patel", "dealership_name": "Velocity Wheels", "city": "Bangalore", "verified": True, "trust_score": 4.6, "bid_success_rate": 71.0, "total_purchases": 64, "total_listed": 19, "kyc_completed": True, "role": "dealer", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000004", "full_name": "Karan Kapoor", "dealership_name": "Drive Republic", "city": "Pune", "verified": True, "trust_score": 4.5, "bid_success_rate": 58.0, "total_purchases": 41, "total_listed": 15, "kyc_completed": True, "role": "dealer", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000005", "full_name": "Sameer Joshi", "dealership_name": "Nexus AutoTrade", "city": "Hyderabad", "verified": True, "trust_score": 4.8, "bid_success_rate": 73.0, "total_purchases": 102, "total_listed": 27, "kyc_completed": True, "role": "dealer", "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
]

CAR_IMAGES = [
    "https://images.unsplash.com/photo-1768965468641-39e87aa78a9d?w=1400&q=85",
    "https://images.unsplash.com/photo-1764089859664-30aa6919ef0b?w=1400&q=85",
    "https://images.pexels.com/photos/31298995/pexels-photo-31298995.jpeg?auto=compress&cs=tinysrgb&w=1400",
    "https://images.unsplash.com/photo-1761229170508-f4791c297af8?w=1400&q=85",
    "https://images.pexels.com/photos/29755707/pexels-photo-29755707.jpeg?auto=compress&cs=tinysrgb&w=1400",
    "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=1400&q=85",
    "https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1400&q=85",
    "https://images.unsplash.com/photo-1542362567-b07e54358753?w=1400&q=85",
    "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=1400&q=85",
    "https://images.unsplash.com/photo-1605559424843-9e4c228bf1c2?w=1400&q=85",
    "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=1400&q=85",
    "https://images.unsplash.com/photo-1502877338535-766e1452684a?w=1400&q=85",
]

INTERIOR_IMAGES = [
    "https://images.unsplash.com/photo-1765522074881-c4c3e81cb846?w=1400&q=85",
    "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=1400&q=85",
]

CAR_CATALOG = [
    {"make": "Mercedes-Benz", "model": "GLC 220d", "variant": "AMG Line", "year": 2022, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 24500, "color": "Obsidian Black", "owners": 1, "starting_bid": 4500000, "reserve_price": 4900000, "registration_number": "MH02AB1234"},
    {"make": "BMW", "model": "5 Series 530i", "variant": "M Sport", "year": 2021, "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 31200, "color": "Mineral Grey", "owners": 1, "starting_bid": 4200000, "reserve_price": 4600000, "registration_number": "DL3CCC5678"},
    {"make": "Audi", "model": "Q5 45 TFSI", "variant": "Technology", "year": 2020, "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 42100, "color": "Glacier White", "owners": 2, "starting_bid": 3800000, "reserve_price": 4200000, "registration_number": "KA01MM9988"},
    {"make": "Volvo", "model": "XC60", "variant": "Inscription", "year": 2022, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 18900, "color": "Onyx Black", "owners": 1, "starting_bid": 4900000, "reserve_price": 5300000, "registration_number": "MH14JK2211"},
    {"make": "Toyota", "model": "Fortuner Legender", "variant": "4x4", "year": 2023, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 12400, "color": "Attitude Black", "owners": 1, "starting_bid": 3900000, "reserve_price": 4200000, "registration_number": "TS09EE7766"},
    {"make": "Jeep", "model": "Compass", "variant": "Trailhawk", "year": 2021, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 38200, "color": "Brilliant Black", "owners": 1, "starting_bid": 1900000, "reserve_price": 2100000, "registration_number": "MH04ZZ4321"},
    {"make": "Hyundai", "model": "Tucson", "variant": "Signature", "year": 2023, "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 9800, "color": "Phantom Black", "owners": 1, "starting_bid": 2700000, "reserve_price": 2950000, "registration_number": "DL8CAE5599"},
    {"make": "Skoda", "model": "Superb", "variant": "L&K", "year": 2020, "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 46500, "color": "Magic Black", "owners": 2, "starting_bid": 2100000, "reserve_price": 2350000, "registration_number": "KA05CD3344"},
    {"make": "Kia", "model": "Carnival", "variant": "Limousine", "year": 2022, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 28700, "color": "Aurora Black", "owners": 1, "starting_bid": 3200000, "reserve_price": 3500000, "registration_number": "GJ01HR2244"},
    {"make": "Mahindra", "model": "XUV700", "variant": "AX7L", "year": 2023, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 15600, "color": "Napoli Black", "owners": 1, "starting_bid": 2150000, "reserve_price": 2350000, "registration_number": "MH12NP1199"},
    {"make": "Tata", "model": "Harrier", "variant": "XZ+ Dark", "year": 2022, "fuel_type": "Diesel", "transmission": "Automatic", "km_driven": 33400, "color": "Oberon Black", "owners": 1, "starting_bid": 1700000, "reserve_price": 1850000, "registration_number": "WB02FF5566"},
    {"make": "Honda", "model": "City", "variant": "ZX CVT", "year": 2021, "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 41200, "color": "Modern Steel", "owners": 1, "starting_bid": 1100000, "reserve_price": 1200000, "registration_number": "TN10PL8877"},
]


async def seed_data():
    if await db.dealers.count_documents({}) > 0:
        # Idempotent admin upgrade — make sure ADMIN_PHONES still resolve to admin
        # in case someone seeded earlier without role markers.
        for ph in ADMIN_PHONES:
            await db.dealers.update_one({"phone": ph}, {"$set": {"role": "admin"}})
        await db.dealers.update_many(
            {"role": {"$exists": False}}, {"$set": {"role": "dealer"}}
        )
        return
    logger.info("Seeding Q Drives demo data...")
    dealer_ids = []
    admin_id: Optional[str] = None
    for d in SEED_DEALERS:
        doc = {
            "id": str(uuid.uuid4()),
            **d,
            "gst_number": "29ABCDE1234F1Z" + str(random.randint(0, 9)),
            "pan_number": "ABCDE" + str(random.randint(1000, 9999)) + "F",
            "created_at": now_utc(),
        }
        if d.get("role") == "admin" or is_admin_phone(d["phone"]):
            doc["role"] = "admin"
            admin_id = doc["id"]
        await db.dealers.insert_one(doc)
        if doc.get("role") != "admin":
            dealer_ids.append(doc["id"])

    # Fallback if no admin entry was provided in seed
    if admin_id is None and dealer_ids:
        admin_id = dealer_ids[0]
        await db.dealers.update_one({"id": admin_id}, {"$set": {"role": "admin"}})

    now = now_utc()
    for i, c in enumerate(CAR_CATALOG):
        car_id = str(uuid.uuid4())
        seller_id = admin_id  # Q Drives is the only seller in the curated marketplace
        primary = CAR_IMAGES[i % len(CAR_IMAGES)]
        gallery = [primary, random.choice(CAR_IMAGES), random.choice(INTERIOR_IMAGES), random.choice(CAR_IMAGES)]
        car = {
            "id": car_id,
            **c,
            "images": gallery,
            "description": f"{c['year']} {c['make']} {c['model']} in pristine condition with full service history.",
            "inspection_score": round(random.uniform(7.6, 9.5), 1),
            "condition_grade": random.choice(["A", "A", "A+", "B+"]),
            "tyre_condition": random.choice(["Excellent", "Good"]),
            "accident_history": random.choice(["None Reported", "None Reported", "Minor (Repaired)"]),
            "service_history": "Authorised Service",
            "rc_verified": True,
            "seller_id": seller_id,
            "created_at": now,
        }
        await db.cars.insert_one(car)

        # Create auction with mixed states
        # First 6 -> live, next 3 -> upcoming, last 3 -> ended
        if i < 6:
            start = now - timedelta(minutes=random.randint(5, 30))
            end = now + timedelta(minutes=random.randint(8, 90))
            current_bid = c["starting_bid"] + random.randint(2, 18) * 5000
            top_bidder_id = random.choice([d for d in dealer_ids if d != seller_id])
            top_bidder = await db.dealers.find_one({"id": top_bidder_id}, {"_id": 0})
            top_name = top_bidder.get("dealership_name", "Dealer")
            total_bids = random.randint(6, 28)
        elif i < 9:
            start = now + timedelta(hours=random.randint(2, 24))
            end = start + timedelta(minutes=60)
            current_bid = c["starting_bid"]
            top_bidder_id = None
            top_name = None
            total_bids = 0
        else:
            start = now - timedelta(hours=random.randint(6, 48))
            end = now - timedelta(hours=random.randint(1, 4))
            current_bid = c["starting_bid"] + random.randint(8, 30) * 5000
            top_bidder_id = random.choice([d for d in dealer_ids if d != seller_id])
            top_bidder = await db.dealers.find_one({"id": top_bidder_id}, {"_id": 0})
            top_name = top_bidder.get("dealership_name", "Dealer")
            total_bids = random.randint(15, 42)

        auction = {
            "id": str(uuid.uuid4()),
            "car_id": car_id,
            "seller_id": seller_id,
            "starting_bid": c["starting_bid"],
            "current_bid": current_bid,
            "reserve_price": c["reserve_price"],
            "top_bidder_id": top_bidder_id,
            "top_bidder_name": top_name,
            "total_bids": total_bids,
            "interested_dealers": random.randint(10, 45),
            "start_time": start,
            "end_time": end,
            "created_at": now,
        }
        await db.auctions.insert_one(auction)

        # seed some bids history
        if total_bids > 0:
            for _ in range(min(total_bids, 8)):
                amt = c["starting_bid"] + random.randint(1, 18) * 5000
                bidder = random.choice([d for d in dealer_ids if d != seller_id])
                bd = await db.dealers.find_one({"id": bidder}, {"_id": 0})
                await db.bids.insert_one({
                    "id": str(uuid.uuid4()),
                    "auction_id": auction["id"],
                    "dealer_id": bidder,
                    "dealer_name": bd.get("dealership_name", "Dealer"),
                    "amount": amt,
                    "created_at": now - timedelta(minutes=random.randint(1, 25)),
                })

    logger.info("Seed completed: %d dealers, %d cars", len(dealer_ids), len(CAR_CATALOG))


@app.on_event("startup")
async def on_startup():
    storage_service.init_default_storage(db)
    await db.dealers.create_index("phone", unique=True)
    await db.cars.create_index("id", unique=True)
    await db.auctions.create_index("id", unique=True)
    await db.bids.create_index([("auction_id", 1), ("created_at", -1)])
    await db.inspections.create_index("car_id")
    await db.inspections.create_index("id", unique=True)
    await db.notifications.create_index([("dealer_id", 1), ("created_at", -1)])
    await db.push_tokens.create_index("token", unique=True)
    await db.media.create_index([("car_id", 1), ("order", 1)])
    await db.media.create_index("id", unique=True)
    await db.approved_dealers.create_index("phone", unique=True)
    await db.operators.create_index("phone", unique=True)
    await db.audit_logs.create_index([("ts", -1)])
    await seed_data()
    await seed_allow_lists()
    # background loops
    asyncio.create_task(auction_scheduler())


async def seed_allow_lists() -> None:
    """Bootstrap the closed-network allow-lists. Idempotent.
    Operators are bootstrapped from ADMIN_PHONES env (single super-admin)."""
    for ph in ADMIN_PHONES:
        await db.operators.update_one(
            {"phone": ph},
            {"$setOnInsert": {
                "phone": ph,
                "full_name": "Q Drives Operator",
                "display_name": "Q Drives Operations",
                "city": "Mumbai",
                "role": "super_admin",
                "added_by": "system_bootstrap",
                "added_at": now_utc(),
            }},
            upsert=True,
        )
        # Idempotent role upgrade if role wasn't set before.
        await db.operators.update_one(
            {"phone": ph, "role": {"$exists": False}},
            {"$set": {"role": "super_admin"}},
        )
        # Promote existing dealer doc to super_admin too.
        await db.dealers.update_one(
            {"phone": ph},
            {"$set": {"role": "super_admin"}},
        )
    # Approved dealers — for the MVP we mirror the existing seeded dealer phones
    # so demo flows keep working. In production an operator adds them via
    # POST /admin/approved-dealers from the operator console.
    for d in SEED_DEALERS:
        if d.get("role") in ("admin", "super_admin"):
            continue
        await db.approved_dealers.update_one(
            {"phone": d["phone"]},
            {"$setOnInsert": {
                "phone": d["phone"],
                "seed_full_name": d.get("full_name", ""),
                "seed_dealership_name": d.get("dealership_name", ""),
                "seed_city": d.get("city", ""),
                "trust_score": d.get("trust_score", 4.5),
                "max_bid_limit": None,
                "notes": "",
                "status": "active",
                "added_by": "system_bootstrap",
                "added_at": now_utc(),
            }},
            upsert=True,
        )
        # Backfill status field on existing docs.
        await db.approved_dealers.update_one(
            {"phone": d["phone"], "status": {"$exists": False}},
            {"$set": {"status": "active"}},
        )


@app.on_event("shutdown")
async def on_shutdown():
    client.close()
