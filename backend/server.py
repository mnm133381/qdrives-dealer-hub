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

from push import send_to_dealer, send_to_dealers, is_valid_expo_token, is_likely_fcm_web_token, send_to_dealer_all_channels
import storage_service
import media as media_svc
import realtime as rt
from auth_firebase import (
    FirebaseAuthError,
    verify_id_token_phone,
    check_send_rate,
    check_send_cooldown,
    check_verify_rate,
    dev_bypass_enabled,
)

# ---------- Setup ----------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
inspections_bucket = AsyncIOMotorGridFSBucket(db, bucket_name="inspections")

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGO = "HS256"
# NOTE: Mocked OTP path was removed in favour of Firebase Phone Auth.
# A `DEV_BYPASS_OTP=true` env flag (off by default) is honoured ONLY for
# staging/CI smoke tests; do not enable in production.
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

    # Defense in depth — hard block any access by suspended/revoked dealers
    # at the auth layer EXCEPT login surfaces. Login is allowed (handled by
    # /auth/dealer/verify-otp not depending on this guard); this guard runs
    # on authenticated API calls only. We allow read-only access (GET) for
    # suspended/revoked so they can see their restriction state, but
    # require_approved_dealer enforces write-action blocks.
    role = dealer.get("role") or "dealer"
    if role == "dealer":
        # Backfill `status` for legacy docs missing it (extra safety in
        # addition to the verify-otp backfill).
        if not dealer.get("status"):
            dealer["status"] = "approved" if not dealer.get("suspended") else "suspended"

    return dealer


async def require_approved_dealer(dealer = Depends(get_current_dealer)) -> Dict[str, Any]:
    """Strict guard for any action that requires an approved dealer (bid,
    purchases, settlement participation). Returns 403 with explicit error
    code so the frontend can surface the right copy.

      • status='pending'   → 403 DEALER_PENDING_APPROVAL
      • status='suspended' → 403 DEALER_ACCOUNT_SUSPENDED
      • status='revoked'   → 403 DEALER_ACCOUNT_REVOKED

    Operators (non-dealer roles) bypass this gate (they have their own
    require_permission/require_admin guards).
    """
    role = dealer.get("role") or "dealer"
    if role != "dealer":
        return dealer
    status = dealer.get("status") or ("approved" if not dealer.get("suspended") else "suspended")
    if status == "approved":
        return dealer
    if status == "pending":
        raise HTTPException(status_code=403, detail="DEALER_PENDING_APPROVAL")
    if status == "suspended":
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")
    if status == "revoked":
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_REVOKED")
    raise HTTPException(status_code=403, detail="DEALER_ACCESS_RESTRICTED")


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


# ─────────────────────────────────────────────────────────────────────
# Reserve-price privacy (P0 marketplace-integrity invariant)
# ─────────────────────────────────────────────────────────────────────
# The exact `reserve_price` is competitive intelligence: if a bidder
# knows the floor, they bid the floor + 1. The platform therefore
# strips reserve_price from every payload served to a bidder /
# anonymous viewer, replacing it with:
#   • reserve_met  — bool, "did the current bid meet the reserve?"
#   • has_reserve  — bool, "does this listing have a reserve at all?"
#
# Sellers see the reserve on their OWN listings (it's their number).
# Operators and admins see every reserve everywhere.
#
# Both the REST listing endpoints and the WebSocket snapshot/state
# frames apply this same filter, so reserve never leaks via inspect-
# network, devtools, or a saved WS frame replay.
async def get_optional_dealer(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[Dict[str, Any]]:
    """Auth-friendly variant of get_current_dealer that returns None
    for unauthenticated callers instead of 401. Used on read endpoints
    that are open to anonymous viewers but need to know the caller's
    role to decide what to redact (e.g. reserve_price)."""
    if not creds or not creds.credentials:
        return None
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        if payload.get("kind", "access") != "access":
            return None
        dealer = await db.dealers.find_one({"id": payload["sub"]}, {"_id": 0})
        if not dealer:
            return None
        token_tv = int(payload.get("tv", 0))
        if token_tv != int(dealer.get("token_version") or 0):
            return None
        return dealer
    except Exception:
        return None


def _viewer_role(viewer: Optional[Dict[str, Any]]) -> str:
    """Normalise the caller's role for serializer decisions. Anonymous
    viewers and dealers are both treated as 'bidder' for reserve
    visibility — neither should ever see the floor."""
    if not viewer:
        return "anonymous"
    return viewer.get("role") or "dealer"


def _can_see_reserve(viewer: Optional[Dict[str, Any]], auction: Dict[str, Any]) -> bool:
    """True only if the viewer is allowed to see the exact reserve
    price for THIS auction. Operators always; the seller of the
    listing for their own auctions. Everyone else: no."""
    role = _viewer_role(viewer)
    if role in ("admin", "super_admin", "operations_admin", "inspection_admin"):
        return True
    if viewer and viewer.get("id") and viewer["id"] == auction.get("seller_id"):
        return True
    return False


def _strip_reserve_for_viewer(payload: Dict[str, Any], viewer: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return a defensive shallow copy of `payload` with reserve_price
    stripped when the viewer is not authorised to see it. Adds the
    `reserve_met` + `has_reserve` derived flags so the UI can still
    surface "Reserve met / not met" without leaking the floor.

    NOTE: this is the ONLY place reserve gets stripped — every
    bidder-facing endpoint (REST + WS) routes through this helper.
    """
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    current_bid = int(out.get("current_bid") or 0)
    raw_reserve = out.get("reserve_price")
    try:
        raw_reserve_int = int(raw_reserve) if raw_reserve is not None else 0
    except (TypeError, ValueError):
        raw_reserve_int = 0
    has_reserve = raw_reserve_int > 0
    reserve_met = (current_bid >= raw_reserve_int) if has_reserve else None

    if not _can_see_reserve(viewer, out):
        # Pop every alias / mirror we know about so the payload never
        # contains the literal floor for an unauthorised viewer.
        out.pop("reserve_price", None)
        # Some legacy code paths nested reserve onto the car block.
        if isinstance(out.get("car"), dict):
            car = dict(out["car"])
            car.pop("reserve_price", None)
            out["car"] = car
    # ALWAYS expose the derived flags — even to operators — so the
    # frontend's render branch is uniform across roles.
    out["has_reserve"] = has_reserve
    out["reserve_met"] = reserve_met
    return out


# Permission catalog — single source of truth for what each role can do.
ROLE_PERMISSIONS: Dict[str, set] = {
    "super_admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_allow_list", "promote_operator", "manage_inventory",
        "launch_auction", "pause_auction", "cancel_auction", "extend_auction",
        "cancel_bid", "broadcast", "view_audit", "upload_inspection",
        "manage_reputation", "resolve_disputes",
    },
    # Legacy 'admin' tier maps to super_admin powers for backward compatibility
    "admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_allow_list", "promote_operator", "manage_inventory",
        "launch_auction", "pause_auction", "cancel_auction", "extend_auction",
        "cancel_bid", "broadcast", "view_audit", "upload_inspection",
        "manage_reputation", "resolve_disputes",
    },
    "operations_admin": {
        "approve_dealers", "suspend_dealers", "set_max_bid",
        "manage_inventory", "launch_auction", "pause_auction",
        "extend_auction", "broadcast", "view_audit",
        "manage_reputation", "resolve_disputes",
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
    # Firebase ID token issued by the client SDK after the user enters
    # the SMS code. The legacy `otp` field is retained as an OPTIONAL
    # fallback ONLY for the DEV_BYPASS path; never accepted in prod.
    firebase_id_token: Optional[str] = None
    otp: Optional[str] = None

class KycReq(BaseModel):
    full_name: str
    dealership_name: str
    city: str
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None

class BidReq(BaseModel):
    amount: int
    # Optional client-generated UUID. When supplied, the bid is
    # processed exactly once even across retries / reconnects. Old
    # clients omit this field — they get the legacy non-idempotent
    # path which is still safe (atomic CAS on the auction doc),
    # just without the duplicate-suppression guarantee.
    idempotency_key: Optional[str] = None

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
    # 5 min ≤ duration ≤ 14 days. 14 days is the marketplace ceiling so
    # the "7 Days" UI option (10080 min) has clear headroom. The lower
    # bound prevents a typo (e.g. `1`) from producing an instant-end
    # auction the moment it launches.
    duration_minutes: int = Field(default=60, ge=5, le=14 * 24 * 60)
    # Pre-launch workflow flag. Default False → auction is created as a
    # DRAFT (status="draft") so operators can upload media + organise
    # the gallery BEFORE launching to dealers. Set True only for legacy
    # callers that want the immediate-live behaviour. The recommended
    # path is: create draft → upload media → set featured → call
    # /api/admin/auctions/{id}/launch.
    launch_immediately: bool = False
    # ---- Real inspection summary (operator-entered) ----
    # The dealer-facing vehicle detail page renders THESE fields. If
    # the operator hasn't filled the inspection report we now persist
    # them as None (NEVER synthesize). The renderer falls back to
    # explicit "Not scored" / "Not graded" / "Not specified" copy so
    # bidders are never shown invented inspection results.
    inspection_score: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    condition_grade: Optional[str] = None  # "A" / "B" / "C" / "D"
    accident_history: Optional[str] = None  # free text from the operator

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



# ---------------------------------------------------------------------
# Firebase phone-auth verifier helpers
# ---------------------------------------------------------------------
def _client_ip(request: Optional[Request]) -> str:
    if not request:
        return ""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _resolve_otp_phone(req: VerifyOtpReq, request: Optional[Request]) -> str:
    """Verify a Firebase ID token (or honour DEV_BYPASS_OTP if enabled) and
    return the canonical phone number. Raises HTTPException on any failure.

    Single source of truth shared by dealer / operator / seller verify endpoints
    so the audit trail and rate-limit semantics stay consistent.
    """
    phone = (req.phone or "").strip()
    if len(phone) < 8:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    ip = _client_ip(request)

    # Per-phone + per-IP verify rate limit (anti-brute-force)
    ok, msg = check_verify_rate(phone, ip=ip)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)

    # Dev escape hatch — staging only.
    if not req.firebase_id_token and dev_bypass_enabled() and (req.otp or "").strip() == "123456":
        logger.warning("DEV_BYPASS_OTP active for %s (NOT FOR PRODUCTION)", phone)
        return phone

    if not req.firebase_id_token:
        raise HTTPException(status_code=400, detail="OTP_TOKEN_REQUIRED")

    try:
        verified_phone = verify_id_token_phone(req.firebase_id_token, expected_phone=phone)
    except FirebaseAuthError as exc:
        # Map Firebase error codes to user-friendly HTTP statuses
        code_map = {
            "expired": (400, "OTP_EXPIRED"),
            "revoked": (401, "OTP_REVOKED"),
            "invalid": (400, "OTP_INVALID"),
            "missing_token": (400, "OTP_TOKEN_REQUIRED"),
            "no_phone": (400, "OTP_NO_PHONE"),
            "phone_mismatch": (400, "OTP_PHONE_MISMATCH"),
            "wrong_provider": (400, "OTP_WRONG_PROVIDER"),
            "wrong_project": (401, "OTP_WRONG_PROJECT"),
            "firebase_unavailable": (503, "OTP_BACKEND_UNAVAILABLE"),
            "verify_failed": (400, "OTP_VERIFY_FAILED"),
        }
        status_code, detail = code_map.get(exc.code, (400, exc.code or "OTP_VERIFY_FAILED"))
        raise HTTPException(status_code=status_code, detail=detail)
    return verified_phone



# ---------- Auth Endpoints ----------
# Closed-network architecture:
#   • Dealers authenticate ONLY via /auth/dealer/* (approved_dealers allow-list)
#   • Operators authenticate ONLY via /auth/operator/* (operators allow-list)
# There is NO generic auth route, NO public registration, NO role downgrade.
# A phone that is not on the relevant allow-list gets 403 with a stable
# error code that the frontend maps to a premium error message.

# ---- Dealer auth (open onboarding — anyone can sign up; capabilities gated by `status`) ----
# Business model: dealer access is open to any phone number. New dealers
# enter as `status='pending'` and can browse/watch but cannot bid until an
# operator approves them. Phones present in the legacy `approved_dealers`
# preset collection are auto-promoted to `status='approved'` on first
# verification (preserving dealership name, trust_score, max_bid_limit).
@api.post("/auth/dealer/send-otp")
async def dealer_send_otp(req: SendOtpReq, request: Request):
    phone = req.phone.strip()
    if len(phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    # Hard barrier: operator phones must NEVER use the dealer flow. This
    # prevents accidental role confusion if an operator types into the
    # dealer login screen.
    if await db.operators.find_one({"phone": phone}):
        asyncio.create_task(audit(db, "dealer_send_otp_blocked_operator", None, None, {"phone": phone}))
        raise HTTPException(status_code=403, detail="USE_OPERATOR_LOGIN")
    # Rate-limit: max 5 sends/hour/phone + short retry cooldown. The
    # actual SMS is dispatched by the Firebase client SDK; we only gate
    # role + abuse here.
    ip = _client_ip(request)
    ok, msg = check_send_rate(phone, ip=ip)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    ok, msg = check_send_cooldown(phone)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    return {"success": True, "message": "OTP gate cleared", "provider": "firebase"}


@api.post("/auth/dealer/verify-otp")
async def dealer_verify_otp(req: VerifyOtpReq, request: Request):
    phone_in = req.phone.strip()
    # Operator phones still blocked from dealer flow at verify too.
    if await db.operators.find_one({"phone": phone_in}):
        asyncio.create_task(audit(db, "dealer_verify_blocked_operator", None, None, {"phone": phone_in}))
        raise HTTPException(status_code=403, detail="USE_OPERATOR_LOGIN")
    phone = _resolve_otp_phone(req, request)

    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    is_new = False
    # `approved_dealers` is now an OPTIONAL "auto-approve preset" layer.
    # Phone present + status=active → auto-promote to approved on first
    # verification with the seeded dealership profile applied.
    preset = await db.approved_dealers.find_one({"phone": phone})
    auto_approve = bool(preset) and preset.get("status") in (None, "active")

    if not dealer:
        is_new = True
        # Default new signup: pending status, no bid power, browse-only.
        initial_status = "approved" if auto_approve else "pending"
        # Verification ALWAYS starts unverified — operator must explicitly
        # mark verified after KYC review. Auto-approve presets land on
        # 'verified' since the operator pre-curated them.
        initial_verification = "verified" if auto_approve else "unverified"
        dealer = {
            "id": str(uuid.uuid4()), "phone": phone,
            "full_name": (preset or {}).get("seed_full_name", ""),
            "dealership_name": (preset or {}).get("seed_dealership_name", ""),
            "city": (preset or {}).get("seed_city", ""),
            "gst_number": "", "pan_number": "",
            "kyc_completed": False, "verified": (initial_status == "approved"),
            "suspended": False,
            "status": initial_status,
            "verification_status": initial_verification,
            "previous_status": None,
            "approved_at": now_utc() if initial_status == "approved" else None,
            "approved_by": "system_preset" if initial_status == "approved" else None,
            "trust_score": float((preset or {}).get("trust_score", 4.5)),
            "max_bid_limit": (preset or {}).get("max_bid_limit"),
            "bid_success_rate": 0,
            "total_purchases": 0, "total_listed": 0,
            "role": "dealer",
            "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80",
            "created_at": now_utc(),
        }
        await db.dealers.insert_one(dict(dealer))
        asyncio.create_task(audit(db, "dealer_signup", dealer["id"], None, {
            "phone": phone, "auto_approved": auto_approve, "preset": bool(preset),
        }))
        # Real-time operator visibility — push a `dealer_pending_created`
        # event into the operator ops room so the approval queue badge
        # increments instantly. broadcast_ops only delivers to operators
        # so dealers never see this signal.
        if not auto_approve:
            try:
                asyncio.create_task(manager.broadcast_ops({
                    "type": "dealer_pending_created",
                    "dealer": {
                        "id": dealer["id"], "phone": phone,
                        "full_name": dealer.get("full_name", ""),
                        "dealership_name": dealer.get("dealership_name", ""),
                        "city": dealer.get("city", ""),
                        "kyc_completed": dealer.get("kyc_completed", False),
                        "created_at": dealer["created_at"],
                    },
                }))
            except Exception:
                pass
    else:
        # Existing dealer login.
        # Operator role can only be assigned via the operator endpoint.
        if dealer.get("role") != "dealer":
            await db.dealers.update_one({"id": dealer["id"]}, {"$set": {"role": "dealer"}})
            dealer["role"] = "dealer"
        # Backfill `status` for legacy docs that pre-date this refactor.
        # Heuristic: not-suspended + not-revoked → 'approved' (they were
        # implicitly approved under the old allow-list gate).
        if not dealer.get("status"):
            backfilled = "approved" if not dealer.get("suspended") else "suspended"
            await db.dealers.update_one(
                {"id": dealer["id"]},
                {"$set": {
                    "status": backfilled,
                    "approved_at": dealer.get("created_at") or now_utc(),
                    "approved_by": "system_backfill",
                }},
            )
            dealer["status"] = backfilled
        # Suspended / revoked dealers can still log in (operationally useful
        # so they see their restriction state) but are blocked from
        # bidding/settlement at the API gate. Login is allowed.
        # Sync max_bid_limit from preset (operator may have updated it).
        if preset and preset.get("max_bid_limit") != dealer.get("max_bid_limit"):
            await db.dealers.update_one(
                {"id": dealer["id"]},
                {"$set": {"max_bid_limit": preset.get("max_bid_limit")}},
            )
            dealer["max_bid_limit"] = preset.get("max_bid_limit")

    # Re-fetch to surface backfilled / synced values to the JWT issuer & client.
    dealer = await db.dealers.find_one({"id": dealer["id"]}, {"_id": 0}) or dealer
    asyncio.create_task(audit(db, "dealer_login", dealer["id"], None, {
        "phone": phone, "status": dealer.get("status"),
    }))
    pair = issue_token_pair(dealer)
    return {**pair, "is_new": is_new, "dealer": serialize(dealer)}


# ---- Operator auth (operators allow-list only) ----
@api.post("/auth/operator/send-otp")
async def operator_send_otp(req: SendOtpReq, request: Request):
    phone = req.phone.strip()
    if not await db.operators.find_one({"phone": phone}):
        asyncio.create_task(audit(db, "operator_access_denied", None, None, {"phone": phone}))
        raise HTTPException(status_code=403, detail="OPERATOR_ACCESS_DENIED")
    ip = _client_ip(request)
    ok, msg = check_send_rate(phone, ip=ip)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    ok, msg = check_send_cooldown(phone)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    return {"success": True, "message": "OTP gate cleared", "provider": "firebase"}


@api.post("/auth/operator/verify-otp")
async def operator_verify_otp(req: VerifyOtpReq, request: Request):
    phone_in = req.phone.strip()
    op = await db.operators.find_one({"phone": phone_in}, {"_id": 0})
    if not op:
        asyncio.create_task(audit(db, "operator_access_denied", None, None, {"phone": phone_in, "stage": "verify"}))
        raise HTTPException(status_code=403, detail="OPERATOR_ACCESS_DENIED")
    phone = _resolve_otp_phone(req, request)
    # Re-check operator allow-list using the *Firebase-verified* phone — defends
    # against any client-supplied phone vs token-claim mismatch.
    if phone != phone_in:
        # _resolve_otp_phone already enforces equality, but be explicit.
        raise HTTPException(status_code=400, detail="OTP_PHONE_MISMATCH")

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
    """Dealer self-submits KYC profile. CRITICAL: this is NOT approval.
    KYC submission flips kyc_completed=true but the dealer remains in
    status='pending' until an operator explicitly approves them via
    /admin/dealers/{id}/approve. The dealer is told their KYC was
    received — never that they are approved.
    """
    # Operator role accounts must never be re-flipped to 'dealer' here;
    # /auth/kyc is dealer-only.
    if (dealer.get("role") or "dealer") != "dealer":
        raise HTTPException(status_code=403, detail="KYC is for dealer accounts only")

    update = {
        "full_name": req.full_name,
        "dealership_name": req.dealership_name,
        "city": req.city,
        "gst_number": req.gst_number or "",
        "pan_number": req.pan_number or "",
        "kyc_completed": True,
        # State separation: KYC submission flips verification_status to
        # 'kyc_pending' (operator review queue). Approval is independent.
        # If dealer was already 'verified' (e.g. preset), do not downgrade.
        # `verified` (legacy bool) is NOT touched here.
    }
    current_v = dealer.get("verification_status") or "unverified"
    if current_v != "verified":
        update["verification_status"] = "kyc_pending"
    await db.dealers.update_one({"id": dealer["id"]}, {"$set": update})
    updated = await db.dealers.find_one({"id": dealer["id"]}, {"_id": 0})

    asyncio.create_task(audit(db, "kyc_submitted", dealer["id"], None, {
        "dealership_name": req.dealership_name, "city": req.city,
        "gst_number_present": bool(req.gst_number), "pan_number_present": bool(req.pan_number),
    }))

    current_status = updated.get("status") or "pending"
    if current_status == "approved":
        # Re-submission by an already-approved dealer (e.g. profile edit).
        # No misleading "approval" notification — just a quiet confirmation.
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer["id"],
            "type": "kyc_updated",
            "title": "Profile updated",
            "body": "Your dealership profile has been updated.",
            "auction_id": None, "read": False, "created_at": now_utc(),
        })
    else:
        # Pending dealer: tell them KYC is RECEIVED — explicitly NOT approved.
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer["id"],
            "type": "kyc_received",
            "title": "KYC received · pending review",
            "body": "Thanks. Q Drives will review your KYC shortly. Bidding activates once an operator approves your account.",
            "auction_id": None, "read": False, "created_at": now_utc(),
        })
        asyncio.create_task(send_to_dealer(
            db, dealer["id"], "KYC received · pending review",
            "Q Drives is reviewing your dealership. Bidding activates after operator approval.",
            data={"type": "kyc_received"},
        ))

    return {"success": True, "updated": True, "dealer": serialize(updated)}


# ---------- Auctions ----------
async def _enrich_auction(a: dict) -> dict:
    car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
    seller = await db.dealers.find_one({"id": a.get("seller_id")}, {"_id": 0}) or {}
    insp = await db.inspections.find_one({"car_id": a["car_id"]}, {"_id": 0})
    a = serialize(a)

    # ------------------------------------------------------------------
    # Media join — single source of truth for what every consumer sees.
    #
    # Historical layout:  car.images[] was a list of legacy Unsplash demo
    # URLs auto-seeded at car creation.
    # New layout:         operators upload to db.media (gridfs / external
    # providers, section-aware, with is_featured + order). Without this
    # join the legacy demo URLs leak through to the dealer marketplace
    # even after a fresh upload — that's the "Audi demo over Honda
    # Amaze" bug.
    #
    # Strategy:
    #   1. Pull ALL media rows for car_id (featured first, then ordered).
    #   2. Build resolved absolute URLs (gridfs → /api/media/<id>/file).
    #   3. Override car.images[] with this resolved list IF any uploaded
    #      (non-external) media exists, OR if external media has been
    #      explicitly featured. Else keep legacy car.images for back-compat.
    #   4. Surface the full media list as auction.media + auction.car.media
    #      so future frontend can render section-aware galleries directly
    #      without a second HTTP round-trip.
    # ------------------------------------------------------------------
    if car:
        try:
            media_docs = await db.media.find(
                {"car_id": car["id"]}, {"_id": 0},
            ).sort([("is_featured", -1), ("order", 1), ("created_at", 1)]).to_list(80)
        except Exception:
            media_docs = []

        def _abs_url(m: dict) -> str:
            if m.get("provider") == "external" and m.get("external_url"):
                return str(m["external_url"])
            mid = m.get("id")
            return f"/api/media/{mid}/file" if mid else ""

        resolved = [_abs_url(m) for m in media_docs if _abs_url(m)]
        has_uploaded = any(m.get("provider") != "external" for m in media_docs)

        if resolved and (has_uploaded or any(m.get("is_featured") for m in media_docs)):
            # Override legacy demo URLs with the authoritative list.
            car["images"] = resolved
        elif not car.get("images"):
            # Defensive: never let an empty array silently render as broken
            # tiles; let the frontend show its own "no image yet" tile.
            car["images"] = []

        # Compact serialised media for clients that want section-aware view
        car["media"] = [
            {
                "id": m.get("id"),
                "section": m.get("section"),
                "subsection": m.get("subsection"),
                "url": _abs_url(m),
                "thumb_url": (
                    f"/api/media/{m['id']}/thumb"
                    if m.get("thumb_storage_id") and m.get("id") else _abs_url(m)
                ),
                "is_featured": bool(m.get("is_featured")),
                "order": m.get("order"),
                "provider": m.get("provider"),
            }
            for m in media_docs
        ]

    a["car"] = serialize(car) if car else None
    a["seller"] = {"id": seller.get("id"), "dealership_name": seller.get("dealership_name", ""), "city": seller.get("city", ""), "verified": seller.get("verified", False)} if seller else None
    a["inspection_pdf"] = serialize(insp) if insp else None

    # ── Canonical inspection block joined onto auction.car.inspection
    # Every role (operator, seller, buyer, anonymous) sees the SAME
    # values. The frontend should prefer this block over the legacy
    # flat fields (car.inspection_score, car.condition_grade etc.) —
    # those remain present only for backward compatibility with
    # screens that haven't been migrated yet.
    a["inspection_updated_after_launch"] = bool(a.get("inspection_updated_after_launch"))
    a["inspection_last_updated_at"]      = a.get("inspection_last_updated_at")
    if a["car"] is not None:
        if insp:
            car_block = a["car"]
            car_block["inspection"] = {
                "id":                     insp.get("id"),
                "car_id":                 insp.get("car_id"),
                "sections":               insp.get("sections") or {},
                "accident_history":       insp.get("accident_history"),
                "tyre_condition":         insp.get("tyre_condition"),
                "service_history":        insp.get("service_history"),
                "inspection_score":       insp.get("inspection_score"),
                "condition_grade":        insp.get("condition_grade"),
                "liquidity_rating":       insp.get("liquidity_rating"),
                "completion_percentage":  insp.get("completion_percentage", 0),
                "sections_completed":     insp.get("sections_completed") or [],
                # Versioning / audit surface — bidders can see who
                # last graded the car and at what version. Used by
                # the "Inspection updated" badge timestamp tooltip
                # in the lot screen.
                "version":                insp.get("version"),
                "updated_by":             insp.get("updated_by") or insp.get("uploader_name"),
                "updated_by_id":          insp.get("updated_by_id") or insp.get("uploader_id"),
                "pdf": (insp.get("pdf") if isinstance(insp.get("pdf"), dict) else (
                    # back-compat: synthesise a pdf sub-doc from the
                    # legacy flat shape if the inspection was uploaded
                    # before the architecture change.
                    {
                        "filename":    insp.get("filename"),
                        "size_bytes": insp.get("size_bytes"),
                        "gridfs_id": insp.get("gridfs_id"),
                        "status":     insp.get("status"),
                    } if insp.get("gridfs_id") else None
                )),
                "updated_at":             insp.get("updated_at") or insp.get("created_at"),
            }
        else:
            # Stable empty shape so the frontend never has to null-guard.
            a["car"]["inspection"] = {
                "id": None, "car_id": (car or {}).get("id"),
                "sections": {k: {"completed": False} for k in INSPECTION_SECTION_KEYS},
                "accident_history": None, "tyre_condition": None, "service_history": None,
                "inspection_score": None, "condition_grade": None, "liquidity_rating": None,
                "completion_percentage": 0, "sections_completed": [],
                "pdf": None, "updated_at": None,
            }
    # compute live state — explicit lifecycle states win over time-based
    # logic. Critical: this list MUST include every operator-managed and
    # terminal state, otherwise enrichment will resurrect archived /
    # withdrawn / cancelled auctions as "live" purely because their
    # end_time is in the future. That bug previously leaked 16 archived
    # auctions into the dealer marketplace pulse.
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
    EXPLICIT_PRESERVE = {
        # operator-managed / mid-flight
        "paused", "cancelled", "settled", "dispute",
        "ended_pending_payment", "payment_received", "vehicle_released",
        # Phase 2C lifecycle (operator-only / non-marketplace)
        "archived", "withdrawn", "draft",
        # explicit terminal — preserve so enrichment does not "resurrect"
        # an ended auction as live just because end_time was bumped
        "ended", "scheduled",
    }
    if explicit in EXPLICIT_PRESERVE:
        a["status"] = explicit
    elif start_dt and now < start_dt:
        a["status"] = "upcoming"
    elif end_dt and now > end_dt:
        a["status"] = "ended"
    else:
        a["status"] = "live"
    a["seconds_remaining"] = max(0, int((end_dt - now).total_seconds())) if end_dt else 0
    return a


# ============================================================
# Marketplace visibility — single source of truth for "what is
# dealer-facing right now". Operator surfaces (live-grid, settlement
# pipeline, audit) use their own queries; marketplace endpoints
# MUST go through this filter so dealer counts and dealer cards
# always agree. The four conditions:
#
#   1. `hidden_from_marketplace != True`   — Phase 2C hard-cleanup flag
#   2. `status NOT IN [archived, withdrawn, draft, cancelled, ended,
#                       settled, dispute, ended_pending_payment,
#                       payment_received, vehicle_released]`
#                                          — exclude operator-only and
#                                            terminal lifecycle records
#
# This guarantees `/market/pulse`, `/auctions`, and `/dashboard/stats`
# all derive from the same dataset, eliminating the "16 live · empty
# inventory" trust failure caused by mismatched filters.
# ============================================================
MARKETPLACE_EXCLUDED_STATUSES = [
    "archived", "withdrawn", "draft", "cancelled",
    # Settlement-pipeline states are operator surfaces only; the dealer
    # marketplace should not surface them as bidable.
    "settled", "dispute",
    "ended_pending_payment", "payment_received", "vehicle_released",
]
def marketplace_query() -> Dict[str, Any]:
    return {
        "hidden_from_marketplace": {"$ne": True},
        "status": {"$nin": MARKETPLACE_EXCLUDED_STATUSES},
    }


@api.get("/auctions")
async def list_auctions(
    status_filter: Optional[str] = None,
    limit: int = 50,
    seller_id: Optional[str] = None,
    request: Request = None,
    viewer: Optional[Dict[str, Any]] = Depends(get_optional_dealer),
):
    """Public marketplace listing — Phase 2C hygiene drops archived /
    withdrawn / draft / settlement-pipeline auctions.

    OPERATOR ESCAPE HATCH: `?seller_id=me` returns the OPERATOR'S OWN
    auctions including drafts (bypasses the marketplace filter). This is
    what powers the operator's my-listings → Drafts tab so a freshly
    created draft is immediately visible and can be opened to upload
    media + launch. Non-operator callers attempting `seller_id=me` are
    silently fallback'd to the marketplace filter (no privacy leak).
    """
    show_drafts_for_me = False
    me_dealer_id = None
    if seller_id == "me":
        # Resolve the caller via bearer token. We do NOT depend on
        # get_current_dealer at the route signature so anonymous callers
        # can still hit /auctions (used by the public marketplace).
        try:
            auth = (request.headers.get("authorization") or "") if request else ""
            if auth.lower().startswith("bearer "):
                token = auth.split(None, 1)[1].strip()
                payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
                me_dealer_id = payload.get("sub")
                me = await db.dealers.find_one({"id": me_dealer_id}, {"_id": 0, "role": 1})
                if me and me.get("role") in ("admin", "super_admin", "operations_admin", "inspection_admin"):
                    show_drafts_for_me = True
        except Exception:
            show_drafts_for_me = False  # malformed token → fall through to public

    if show_drafts_for_me and me_dealer_id:
        # Operator viewing their own pipeline — include drafts but still
        # exclude soft-deleted records (archived/withdrawn) to keep the
        # list clean.
        base_query = {
            "seller_id": me_dealer_id,
            "status": {"$nin": ["archived", "withdrawn", "cancelled"]},
        }
    else:
        # Phase 2C hygiene — public marketplace must NEVER surface
        # archived, withdrawn, hidden, settled, dispute, or settlement-
        # pipeline inventory. Use marketplace_query() so this filter
        # stays in lockstep with /market/pulse and /dashboard/stats.
        base_query = marketplace_query()
    cursor = db.auctions.find(base_query).sort("start_time", -1).limit(limit)
    auctions = await cursor.to_list(limit)
    enriched = [await _enrich_auction(a) for a in auctions]
    if status_filter:
        enriched = [a for a in enriched if a["status"] == status_filter]
    # ── Reserve-price privacy (P0) ───────────────────────────────────
    # Strip reserve_price from every auction object before the
    # marketplace feed reaches the caller. Operators / sellers see the
    # real number; bidders + anonymous see only reserve_met /
    # has_reserve flags. This filter MUST stay co-located with the
    # serialization step — never trust upstream callers to strip.
    return [_strip_reserve_for_viewer(a, viewer) for a in enriched]


@api.get("/auctions/{auction_id}")
async def get_auction(auction_id: str, viewer: Optional[Dict[str, Any]] = Depends(get_optional_dealer)):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    enriched = await _enrich_auction(a)
    bids = await db.bids.find({"auction_id": auction_id}, {"_id": 0}).sort("created_at", -1).limit(20).to_list(20)
    enriched["recent_bids"] = [serialize(b) for b in bids]
    return _strip_reserve_for_viewer(enriched, viewer)


@api.post("/auctions/{auction_id}/bid")
async def place_bid(auction_id: str, req: BidReq, request: Request, dealer = Depends(require_approved_dealer)):
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    enriched = await _enrich_auction(a)
    if enriched["status"] != "live":
        raise HTTPException(status_code=400, detail="Auction is not live")

    # ------------------------------------------------------------------
    # Idempotency: if the client supplied an idempotency_key and we've
    # already processed it, return the cached result. Old clients that
    # don't supply a key fall through to the atomic CAS path below —
    # that path is safe (no double-spend) but lacks duplicate-suppression.
    # ------------------------------------------------------------------
    idem_key = (req.idempotency_key or "").strip() or None
    if idem_key:
        cached = await db.bid_idempotency.find_one(
            {"key": idem_key, "dealer_id": dealer["id"]}, {"_id": 0},
        )
        if cached:
            asyncio.create_task(rt.emit(
                db, "bid_duplicate_attempt", now_utc=now_utc,
                dealer_id=dealer["id"], auction_id=auction_id,
                idempotency_key=idem_key,
            ))
            if cached.get("ok"):
                return cached.get("response") or {"success": True, "bid": cached.get("bid")}
            # Surface the original failure shape (status + detail) so
            # the client retry sees identical semantics.
            raise HTTPException(
                status_code=int(cached.get("status_code") or 400),
                detail=str(cached.get("detail") or "Bid rejected"),
            )

    # ------------------------------------------------------------------
    # Pre-flight role / cap checks (cheap; same as before)
    # ------------------------------------------------------------------
    current_bid_seen = a.get("current_bid", 0) or a.get("starting_bid", 0)
    min_increment = 5000
    if req.amount < current_bid_seen + min_increment:
        raise HTTPException(status_code=400, detail=f"Bid must be at least ₹{current_bid_seen + min_increment:,}")
    if dealer["id"] == a.get("seller_id"):
        raise HTTPException(status_code=400, detail="You cannot bid on your own auction")
    if dealer.get("suspended"):
        raise HTTPException(status_code=403, detail="DEALER_ACCOUNT_SUSPENDED")
    from services import reputation as _rep_check
    blocked, kind = await _rep_check.is_dealer_blocked_from_bidding(db, dealer["id"])
    if blocked:
        raise HTTPException(status_code=403, detail=f"DEALER_BIDDING_RESTRICTED:{kind}")
    max_limit = dealer.get("max_bid_limit")
    if max_limit and req.amount > int(max_limit):
        raise HTTPException(status_code=403, detail="BID_EXCEEDS_DEALER_LIMIT")

    # ------------------------------------------------------------------
    # ATOMIC bid acceptance via Mongo find_one_and_update.
    # The compound filter is the source of truth — only one of two
    # concurrent bids can succeed. The loser sees `updated is None` and
    # we re-read the doc to give them a precise BID_OUTBID error.
    # `bid_seq` is the per-auction monotonically-increasing integer
    # used by the WS sequence-aware client buffer.
    # ------------------------------------------------------------------
    accepted_at = now_utc()
    accepted_ns = rt.monotonic_ns()
    prev_top = a.get("top_bidder_id")
    bid_doc = {
        "id": str(uuid.uuid4()),
        "auction_id": auction_id,
        "dealer_id": dealer["id"],
        "dealer_name": dealer.get("dealership_name") or dealer.get("full_name") or "Dealer",
        "amount": req.amount,
        "cancelled": False,
        "created_at": accepted_at,
        # Server-stamped ordering fields. The (seq, accepted_ns) tuple
        # is the canonical total order for this auction.
        "accepted_ns": accepted_ns,
    }

    updated = await db.auctions.find_one_and_update(
        {
            "id": auction_id,
            "status": "live",
            # Reject if anyone else has bid >= our amount in the meantime.
            "$or": [
                {"current_bid": {"$lt": req.amount}},
                {"current_bid": {"$exists": False}},
            ],
        },
        {
            "$set": {
                "current_bid": req.amount,
                "top_bidder_id": dealer["id"],
                "top_bidder_name": bid_doc["dealer_name"],
                "last_bid_at": accepted_at,
            },
            "$inc": {"total_bids": 1, "bid_seq": 1},
        },
        return_document=True,  # ReturnDocument.AFTER
        projection={"_id": 0, "bid_seq": 1, "current_bid": 1, "total_bids": 1, "top_bidder_id": 1},
    )
    if not updated:
        # Race: another bid landed first OR auction transitioned out of live.
        latest = await db.auctions.find_one({"id": auction_id}, {"_id": 0, "current_bid": 1, "status": 1, "top_bidder_id": 1})
        if latest and latest.get("status") != "live":
            detail = "Auction is no longer live"
            status_code = 400
        else:
            detail = "BID_OUTBID"
            status_code = 409
        # Telemetry: bid_race_conflict (loser perspective)
        asyncio.create_task(rt.emit(
            db, "bid_race_conflict", now_utc=now_utc,
            auction_id=auction_id, losing_dealer_id=dealer["id"],
            winning_dealer_id=(latest or {}).get("top_bidder_id"),
            attempted_amount=req.amount,
            current_bid=(latest or {}).get("current_bid"),
        ))
        if idem_key:
            async def _cache_failure():
                await db.bid_idempotency.update_one(
                    {"key": idem_key, "dealer_id": dealer["id"]},
                    {"$set": {
                        "ok": False, "status_code": status_code, "detail": detail,
                        "auction_id": auction_id, "ts": accepted_at,
                    }},
                    upsert=True,
                )
            asyncio.create_task(_cache_failure())
        raise HTTPException(status_code=status_code, detail=detail)

    # Stamp the bid with its authoritative seq (post-increment value)
    bid_doc["seq"] = int(updated.get("bid_seq") or 0)
    await db.bids.insert_one(dict(bid_doc))

    # Auction-close-race telemetry: did this bid land within the final 2s?
    end_time = a.get("end_time")
    if end_time:
        try:
            skew_ms = int((end_time - accepted_at).total_seconds() * 1000)
            if 0 <= skew_ms <= 2000:
                asyncio.create_task(rt.emit(
                    db, "auction_close_race", now_utc=now_utc,
                    auction_id=auction_id, dealer_id=dealer["id"],
                    end_time_skew_ms=skew_ms, last_seq=bid_doc["seq"],
                ))
        except Exception:
            pass

    # Cache idempotency result BEFORE side-effects so a retry during the
    # broadcast step still hits the cached success.
    # NOTE: Motor's update_one returns an asyncio.Future, NOT a coroutine
    # — passing it directly to asyncio.create_task() raises TypeError.
    # Wrap it in an inner async function before scheduling.
    if idem_key:
        async def _cache_success():
            await db.bid_idempotency.update_one(
                {"key": idem_key, "dealer_id": dealer["id"]},
                {"$set": {
                    "ok": True, "auction_id": auction_id, "ts": accepted_at,
                    "bid": serialize(bid_doc),
                    "response": {"success": True, "bid": serialize(bid_doc), "seq": bid_doc["seq"]},
                }},
                upsert=True,
            )
        asyncio.create_task(_cache_success())

    # Notify previous top bidder (outbid)
    if prev_top and prev_top != dealer["id"]:
        car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
        car_label = f"{car.get('year', '')} {car.get('make', '')} {car.get('model', '')}".strip() or "your watched auction"
        push_title = "You've been outbid"
        push_body = f"{bid_doc['dealer_name']} bid ₹{req.amount:,} on {car_label}"
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

    # Broadcast to room — payload is ADDITIVE: legacy clients keep
    # working (they ignore unknown fields). New clients use `seq` for
    # gap detection and `server_ns` for ordering merges across
    # reconnect snapshot vs live tail.
    bcast_started_ns = rt.monotonic_ns()
    await manager.broadcast(auction_id, {
        "type": "new_bid",
        "bid": serialize(bid_doc),
        "current_bid": req.amount,
        "top_bidder_id": dealer["id"],
        "top_bidder_name": bid_doc["dealer_name"],
        "total_bids": int(updated.get("total_bids") or 0),
        "seq": bid_doc["seq"],
        "server_ns": accepted_ns,
    })
    bcast_ms = max(0, (rt.monotonic_ns() - bcast_started_ns) // 1_000_000)
    if bcast_ms > 500:
        asyncio.create_task(rt.emit(
            db, "broadcast_lag_spike", now_utc=now_utc,
            auction_id=auction_id, dispatch_ms=int(bcast_ms),
            target_count=len(manager.rooms.get(f"auction:{auction_id}", []) or []),
        ))

    # Silent funnel attribution — if this dealer received a recent
    # broadcast for this auction (or a recent network-wide broadcast),
    # emit a `bid_placed` event into broadcast_events. Strictly
    # background, never blocks the bid response.
    try:
        from routes import broadcast_tracking as _track
        asyncio.create_task(_track.attribute_bid_to_recent_broadcast(
            db, dealer_id=dealer["id"], auction_id=auction_id,
            bid_id=bid_doc["id"], now_utc=now_utc, logger=logger,
        ))
    except Exception:
        pass

    return {"success": True, "bid": serialize(bid_doc), "seq": bid_doc["seq"]}


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
        "images": req.images or [],  # No demo placeholder — operator uploads
                                       # media via /api/media/upload during the
                                       # draft phase; _enrich_auction joins
                                       # db.media at read time. An empty array
                                       # is the safe "no photos yet" sentinel.
        "description": req.description or req.notes or "",
        # ---- Inspection summary (P0 trust fix) ----
        # Use ONLY the operator-supplied inspection values. NEVER
        # synthesize. If the operator hasn't filled the inspection yet
        # we persist None so the renderer can show explicit "Not
        # scored" / "Not graded" / "Not specified" copy. Bidders must
        # never be shown invented inspection results.
        "inspection_score": req.inspection_score,   # float | None
        "condition_grade":  (req.condition_grade or "").strip().upper() or None,
        "accident_history": (req.accident_history or "").strip() or None,
        # Retired RNG fields (kept absent rather than randomised so
        # downstream consumers can opt into "Not specified" UX).
        "tyre_condition":   None,
        "service_history":  None,
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
        "interested_dealers": 0,  # Real watcher count drives this; no fake liquidity
        "start_time": now_utc(),
        "end_time": now_utc() + timedelta(minutes=req.duration_minutes),
        "created_at": now_utc(),
        # Pre-launch workflow: new auctions start as drafts so the
        # operator can upload media + organise the gallery BEFORE
        # dealers see the listing. `launch_immediately=True` preserves
        # the legacy "create live" semantics for any caller that needs
        # it (e.g. seeded data scripts).
        "status": "live" if req.launch_immediately else "draft",
        "status_changed_at": now_utc(),
        "status_changed_by": dealer["id"],
        # Data isolation tag — production auctions are tagged so they can
        # never be confused with demo_seed_data / qa_data / archived_legacy.
        "data_class": "production_live_data",
        "hidden_from_marketplace": False,
        "hidden_from_live_ops": False,
        "hidden_from_settlement": False,
    }
    await db.auctions.insert_one(dict(auction))

    # ── Seed canonical inspection record so db.inspections is ALWAYS
    # the single source of truth, even when the legacy create_car
    # path supplied flat aggregates instead of a full section
    # breakdown. The PUT /api/cars/{id}/inspection endpoint is the
    # preferred path going forward; this short-circuit only fires
    # when at least one inspection field was sent through create_car.
    if (
        req.inspection_score is not None
        or (req.condition_grade or "").strip()
        or (req.accident_history or "").strip()
    ):
        # If a score was given but no per-section breakdown, fabricate
        # a single "overall" pseudo-section so the aggregator round-
        # trips the same score. Real operators will quickly overwrite
        # this via PUT /inspection with the actual breakdown.
        score_val = float(req.inspection_score) if isinstance(req.inspection_score, (int, float)) else None
        seed_sections: Dict[str, Any] = {k: {"completed": False} for k in INSPECTION_SECTION_KEYS}
        if score_val and score_val > 0:
            seed_sections["exterior"] = {"completed": True, "score": score_val}
        derived = _aggregate_inspection(seed_sections)
        # When the operator explicitly supplied a grade, honour it
        # verbatim — the spec lets the operator override the derived
        # grade for non-standard fleets (e.g. heritage / showpiece).
        explicit_grade = (req.condition_grade or "").strip().upper() or None
        now = now_utc()
        insp_doc = {
            "id": str(uuid.uuid4()),
            "car_id": car_id,
            "sections": seed_sections,
            "accident_history": _normalise_text_field(req.accident_history),
            "tyre_condition":   None,
            "service_history":  None,
            "inspection_score": derived["inspection_score"] if derived["inspection_score"] is not None else score_val,
            "condition_grade":  explicit_grade or derived["condition_grade"],
            "liquidity_rating": derived["liquidity_rating"],
            "completion_percentage": derived["completion_percentage"],
            "sections_completed":    derived["sections_completed"],
            "pdf": None,
            "uploader_id":   dealer["id"],
            "uploader_name": dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
            "created_at": now,
            "updated_at": now,
        }
        await db.inspections.update_one({"car_id": car_id}, {"$set": insp_doc}, upsert=True)
        await _mirror_inspection_to_car(car_id, insp_doc)

    await db.dealers.update_one({"id": dealer["id"]}, {"$inc": {"total_listed": 1}})
    return {"car": serialize(car), "auction": await _enrich_auction(auction)}


# ---------- Pre-launch workflow (draft → live) ------------------------
# Minimum media gates for an auction to be allowed to go live. Without
# these dealers see empty / placeholder galleries and the listing has
# no chance of attracting a bid.
LAUNCH_MIN_PHOTOS = 3              # minimum total photos across all sections
LAUNCH_REQUIRE_FEATURED = True     # must have an explicitly featured image


async def _launch_readiness(auction_id: str) -> Dict[str, Any]:
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    car_id = a.get("car_id")
    media_count = await db.media.count_documents({"car_id": car_id}) if car_id else 0
    featured_count = await db.media.count_documents(
        {"car_id": car_id, "is_featured": True}
    ) if car_id else 0
    issues: List[str] = []
    if media_count < LAUNCH_MIN_PHOTOS:
        issues.append(f"Upload at least {LAUNCH_MIN_PHOTOS} photos (current: {media_count}).")
    if LAUNCH_REQUIRE_FEATURED and featured_count < 1:
        issues.append("Mark one photo as Featured before launching.")
    if a.get("status") not in ("draft", "ready", "live"):
        issues.append(f"Auction is in status='{a.get('status')}' — cannot launch.")
    return {
        "auction_id": auction_id,
        "status": a.get("status"),
        "media_count": int(media_count),
        "featured_count": int(featured_count),
        "min_photos_required": LAUNCH_MIN_PHOTOS,
        "ready": len(issues) == 0 and a.get("status") in ("draft", "ready"),
        "issues": issues,
    }


@api.get("/admin/auctions/{auction_id}/launch-readiness")
async def admin_auction_launch_readiness(auction_id: str, _op = Depends(get_current_admin)):
    """Operator-facing pre-flight: returns whether a draft auction can
    safely be launched. UI uses this to render a green Launch button
    vs a grey-with-reason button."""
    return await _launch_readiness(auction_id)


class AuctionLaunchReq(BaseModel):
    # Optional override of the duration set at draft creation. If omitted
    # the existing start/end_time on the doc is preserved (but start_time
    # is bumped to now() so the countdown is accurate at launch moment).
    # Bounded to 5 min ≤ d ≤ 14 days — mirrors CarCreateReq so a 7-day
    # marketplace listing fits comfortably with headroom.
    duration_minutes: Optional[int] = Field(default=None, ge=5, le=14 * 24 * 60)


@api.post("/admin/auctions/{auction_id}/launch")
async def admin_auction_launch(auction_id: str, req: AuctionLaunchReq, op = Depends(get_current_admin)):
    """Atomically transition a draft auction → live.

    Hard-gated on _launch_readiness so an unfinished listing can NEVER
    surface to dealers. start_time is reset to now() and end_time is
    recomputed from req.duration_minutes (or the existing window if not
    overridden). Emits an ops broadcast so live grids update instantly.
    """
    # ── Wrong-state guard FIRST so a double-tap on the Launch button
    # returns the spec-correct 409 (the auction has already transitioned),
    # not a misleading 422 LAUNCH_NOT_READY with empty issues[] (which
    # would otherwise be the result of _launch_readiness flagging
    # status!='draft' but stripping the human-readable message). Keeps
    # the API contract simple: 422 == fix media / featured; 409 ==
    # nothing to do, auction is no longer a draft.
    pre = await db.auctions.find_one({"id": auction_id}, {"_id": 0, "status": 1})
    if not pre:
        raise HTTPException(status_code=404, detail="Auction not found")
    if pre.get("status") not in ("draft", "ready"):
        raise HTTPException(status_code=409, detail="Auction is no longer in draft state.")

    readiness = await _launch_readiness(auction_id)
    if not readiness["ready"]:
        # 422 is the right status here — request is well-formed but the
        # resource state isn't acceptable for the transition.
        raise HTTPException(
            status_code=422,
            detail={"code": "LAUNCH_NOT_READY", "issues": readiness["issues"]},
        )
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")

    new_start = now_utc()
    if req.duration_minutes and req.duration_minutes > 0:
        new_end = new_start + timedelta(minutes=int(req.duration_minutes))
    elif a.get("start_time") and a.get("end_time"):
        # Preserve the originally-planned duration window
        try:
            old_start = a["start_time"]
            old_end = a["end_time"]
            if isinstance(old_start, str):
                old_start = datetime.fromisoformat(old_start.replace("Z", "+00:00"))
            if isinstance(old_end, str):
                old_end = datetime.fromisoformat(old_end.replace("Z", "+00:00"))
            new_end = new_start + (old_end - old_start)
        except Exception:
            new_end = new_start + timedelta(minutes=60)
    else:
        new_end = new_start + timedelta(minutes=60)

    # Atomic transition — guarded on status=draft so a double-tap on the
    # Launch button cannot transition an already-live auction.
    updated = await db.auctions.find_one_and_update(
        {"id": auction_id, "status": {"$in": ["draft", "ready"]}},
        {"$set": {
            "status": "live",
            "start_time": new_start,
            "end_time": new_end,
            "status_changed_at": new_start,
            "status_changed_by": op["id"],
        }},
        return_document=True,
    )
    if not updated:
        raise HTTPException(status_code=409, detail="Auction is no longer in draft state.")

    asyncio.create_task(audit(
        db, "auction_launched", op["id"], auction_id,
        {"media_count": readiness["media_count"]},
    ))
    enriched = await _enrich_auction(updated)
    # Tell live ops + watchers immediately
    try:
        await manager.broadcast("ops", {"type": "auction_launched", "auction": jsonable_encoder(enriched)})
    except Exception:
        pass
    return {"success": True, "auction": enriched, "launched_at": new_start.isoformat()}


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
async def get_purchases(dealer = Depends(require_approved_dealer)):
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
            # Compute reserve_met BEFORE stripping so the outcome
            # label is correct, then strip the literal reserve.
            reserve_met = final_bid >= reserve
            ea = _strip_reserve_for_viewer(ea, dealer)
            ea["reserve_met"] = reserve_met
            ea["outcome"] = "won" if reserve_met else "reserve_not_met"
            won.append(ea)
        elif ea["status"] == "live":
            ea = _strip_reserve_for_viewer(ea, dealer)
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
    platform = (req.platform or "unknown").lower()
    # Accept two token shapes:
    #   - Expo native tokens          (ExponentPushToken[...])
    #   - FCM web tokens for the PWA  (long opaque strings, platform='web')
    if not token:
        raise HTTPException(status_code=400, detail="Missing push token")
    is_expo = is_valid_expo_token(token)
    is_web_fcm = (platform == "web") and is_likely_fcm_web_token(token)
    if not (is_expo or is_web_fcm):
        raise HTTPException(status_code=400, detail="Invalid push token")
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
            "platform": platform,
            "channel": "fcm_web" if is_web_fcm else "expo",
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
    if status_filter == "verified" or status_filter == "approved":
        # Approved dealers — supports both legacy `verified` lookups and
        # the new `status='approved'` open-onboarding model.
        query["$or"] = [
            {"status": "approved"},
            {"status": {"$exists": False}, "verified": True, "suspended": {"$ne": True}},
        ]
    elif status_filter == "pending":
        # Pending = newly signed-up dealer awaiting operator approval.
        query["$or"] = [
            {"status": "pending"},
            {"status": {"$exists": False}, "verified": {"$ne": True}, "suspended": {"$ne": True}},
        ]
    elif status_filter == "suspended":
        query["$or"] = [
            {"status": "suspended"},
            {"status": {"$exists": False}, "suspended": True},
        ]
    elif status_filter == "revoked":
        query["status"] = "revoked"
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

    # Mirror legacy verified/suspended changes onto the new `status` field
    # so the open-onboarding gate stays in sync with the legacy verify
    # endpoint. Order matters: suspended dominates.
    new_status = target.get("status") or ("approved" if target.get("verified") else "pending")
    prev_status = new_status
    if update.get("suspended") is True:
        new_status = "suspended"
    elif update.get("verified") is True:
        new_status = "approved"
        update["approved_at"] = now_utc()
        update["approved_by"] = admin["id"]
        update["previous_status"] = prev_status
    elif update.get("verified") is False:
        new_status = "pending"
    update["status"] = new_status

    await db.dealers.update_one({"id": dealer_id}, {"$set": update})
    updated = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})

    # Audit
    asyncio.create_task(audit(db, "dealer_status_change", admin["id"], dealer_id, {"changes": update}))

    # Server-side session kill on suspend OR loss of verified flag.
    if update.get("suspended") is True or update.get("verified") is False:
        asyncio.create_task(bump_token_version(dealer_id, reason="dealer_status_change", actor_id=admin["id"]))

    # Push verification status change. Idempotent: only emit when the
    # status actually transitioned (prevents duplicate "approved" pings if
    # operator re-clicks). Same rule for suspend.
    if req.verified is True and prev_status != "approved":
        title = "Dealer status verified"
        body = f"Welcome, {updated.get('dealership_name') or 'dealer'}. You are now an active Q Drives dealer."
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer_id, "type": "verification",
            "title": title, "body": body, "auction_id": None,
            "read": False, "created_at": now_utc(),
        })
        asyncio.create_task(send_to_dealer(db, dealer_id, title, body, data={"type": "verification"}))
    elif req.suspended is True and prev_status != "suspended":
        title = "Account suspended"
        body = "Your Q Drives account has been suspended. Contact support for details."
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()), "dealer_id": dealer_id, "type": "suspended",
            "title": title, "body": body, "auction_id": None,
            "read": False, "created_at": now_utc(),
        })
        asyncio.create_task(send_to_dealer(db, dealer_id, title, body, data={"type": "suspended"}))
    return serialize(updated)


# ============================================================
# Operator-driven dealer approval (NEW canonical surface for the
# pending → approved transition under the open-onboarding model).
# /verify is retained for legacy callers and continues to mirror status.
# ============================================================
class DealerApproveReq(BaseModel):
    note: Optional[str] = None
    max_bid_limit: Optional[int] = None  # operator can set/override at approval time


@api.post("/admin/dealers/{dealer_id}/approve")
async def admin_approve_dealer(
    request: Request,
    dealer_id: str, req: DealerApproveReq,
    admin = Depends(require_permission("approve_dealers")),
):
    """Approve a dealer. Pending → approved transition. Audited with
    operator id, ip, user-agent (when available), previous_status. Sends
    push + creates a notification entry.
    Idempotent: re-approving an already-approved dealer is a no-op."""
    target = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Dealer not found")
    if target.get("role") != "dealer":
        raise HTTPException(status_code=400, detail="Cannot approve non-dealer accounts")

    prev_status = target.get("status") or ("approved" if target.get("verified") else "pending")
    if prev_status == "approved":
        # Idempotent — return current snapshot.
        return serialize(target)

    update: Dict[str, Any] = {
        "status": "approved",
        "previous_status": prev_status,
        "verified": True,            # keep legacy field in sync
        "suspended": False,           # approval clears suspension
        "approved_at": now_utc(),
        "approved_by": admin["id"],
    }
    # Verification is independent. If the dealer submitted KYC (or had
    # legacy kyc_completed=True), this approval implicitly attests to it.
    # Otherwise, leave verification_status as-is (operator can verify
    # separately later via the dedicated endpoint).
    prev_verification = target.get("verification_status") or "unverified"
    if target.get("kyc_completed"):
        update["verification_status"] = "verified"
        update["verified_at"] = now_utc()
        update["verified_by"] = admin["id"]
    if req.max_bid_limit is not None:
        if req.max_bid_limit <= 0:
            raise HTTPException(status_code=400, detail="max_bid_limit must be positive")
        update["max_bid_limit"] = int(req.max_bid_limit)

    await db.dealers.update_one({"id": dealer_id}, {"$set": update})
    updated = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})

    # Audit with full operational context.
    asyncio.create_task(audit(db, "dealer_approved", admin["id"], dealer_id, {
        "previous_status": prev_status,
        "approved_by": admin["id"],
        "approved_by_name": admin.get("full_name") or admin.get("dealership_name") or "Operator",
        "ip": (request.client.host if request and request.client else None),
        "user_agent": (request.headers.get("user-agent") if request else None),
        "max_bid_limit": update.get("max_bid_limit"),
        "note": (req.note or None),
    }))

    # Notify dealer
    title = "Account approved"
    body = f"Welcome aboard. Bidding is now active on your Q Drives account."
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()), "dealer_id": dealer_id, "type": "verification",
        "title": title, "body": body, "auction_id": None,
        "read": False, "created_at": now_utc(),
    })
    asyncio.create_task(send_to_dealer(db, dealer_id, title, body, data={"type": "verification"}))

    # NOTE: We intentionally DO NOT bump token_version here. Approval is a
    # capability EXPANSION, not a security event — the dealer's existing
    # JWT remains valid and their app's periodic /auth/me poll picks up
    # the new `status='approved'` within ~15s, unlocking bid/purchase UI
    # without forcing a re-login. Compare with suspend/revoke (in /verify)
    # where tv IS bumped — those are restrictions that must drop the
    # session instantly.

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


# ============================================================
# Phase 2C — Inventory Lifecycle Endpoints
#   • withdraw — seller-initiated removal (audit-permanent, no hard delete)
#   • archive  — terminal historical state (only on already-ended auctions)
#   • lock/unlock — operator override prevents downstream seller-side edits
#   • reserve-edit — pre-bid only
# All endpoints capture {actor_id, role, ip, user_agent, before_state,
# after_state} on every transition.
# ============================================================
INVENTORY_TERMINAL = {"settled", "cancelled", "withdrawn", "archived"}
INVENTORY_PRE_LIVE = {"scheduled", "draft"}


def _client_ctx(request: Request) -> Dict[str, Any]:
    """Best-effort extraction of operator IP + user-agent for audit trail."""
    return {
        "ip": (request.client.host if request and request.client else None),
        "user_agent": (request.headers.get("user-agent") if request else None),
    }


async def _check_inventory_lock(a: Dict[str, Any], admin: Dict[str, Any]) -> None:
    """Raise if the auction has been operator-locked AND the caller is NOT a
    super_admin. Operator overrides bypass the lock."""
    if a.get("operator_lock") and admin.get("role") != "super_admin":
        raise HTTPException(status_code=423, detail="INVENTORY_LOCKED_BY_OPERATOR")


class InventoryWithdrawReq(BaseModel):
    reason: str


@api.post("/inventory/{auction_id}/withdraw")
async def inventory_withdraw(
    request: Request,
    auction_id: str, req: InventoryWithdrawReq,
    admin = Depends(require_permission("manage_inventory")),
):
    """Seller-initiated withdrawal. Mandatory reason ≥10 chars when the
    auction is live or has already received any bid (transparency to bidders).
    Settlement-state auctions are immutable and cannot be withdrawn."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    await _check_inventory_lock(a, admin)
    eff = await _effective_status(a)
    if eff in INVENTORY_TERMINAL:
        raise HTTPException(status_code=400, detail=f"Auction is in terminal state ({eff}) — cannot withdraw")
    # Settlement-pipeline states (post-end) are immutable.
    if eff in ("ended_pending_payment", "payment_received", "vehicle_released", "dispute"):
        raise HTTPException(status_code=400, detail="SETTLEMENT_LOCKED — withdraw not allowed in settlement pipeline")
    bids_count = await db.bids.count_documents({"auction_id": auction_id})
    require_long_reason = (eff == "live" or bids_count > 0)
    reason = (req.reason or "").strip()
    if require_long_reason and len(reason) < 10:
        raise HTTPException(status_code=400, detail="REASON_TOO_SHORT — withdraw with bids/live requires reason ≥10 chars")
    if not require_long_reason and len(reason) < 5:
        raise HTTPException(status_code=400, detail="REASON_TOO_SHORT — minimum 5 chars")

    before_state = {"status": a.get("status"), "end_time": iso(a.get("end_time")) if isinstance(a.get("end_time"), datetime) else a.get("end_time")}
    update = {
        "status": "withdrawn",
        "withdraw_reason": reason,
        "withdrawn_at": now_utc(),
        "withdrawn_by": admin["id"],
        "status_changed_at": now_utc(),
        "status_changed_by": admin["id"],
    }
    await db.auctions.update_one({"id": auction_id}, {"$set": update})
    after_state = {"status": "withdrawn", "had_bids": bids_count}
    asyncio.create_task(audit(db, "inventory_withdrawn", admin["id"], auction_id, {
        **_client_ctx(request),
        "role": admin.get("role"),
        "reason": reason, "had_bids": bids_count,
        "before_state": before_state, "after_state": after_state,
    }))
    try:
        await manager.broadcast(auction_id, {"type": "inventory_withdrawn", "reason": reason})
        await manager.broadcast_ops({"type": "inventory_withdrawn", "auction_id": auction_id, "reason": reason})
    except Exception:
        pass
    return {"ok": True, "status": "withdrawn"}


class InventoryArchiveReq(BaseModel):
    note: Optional[str] = None


@api.post("/inventory/{auction_id}/archive")
async def inventory_archive(
    request: Request,
    auction_id: str, req: InventoryArchiveReq,
    admin = Depends(require_permission("manage_inventory")),
):
    """Move a terminal-state auction (settled / cancelled / withdrawn) into
    the archived bucket. Cannot archive a still-trading auction."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    await _check_inventory_lock(a, admin)
    eff = await _effective_status(a)
    if eff not in {"settled", "cancelled", "withdrawn", "ended"}:
        raise HTTPException(status_code=400, detail=f"Cannot archive auction in state '{eff}' — must be terminal")
    before_state = {"status": eff}
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {
            "previous_status_before_archive": eff,
            "status": "archived",
            "archived_at": now_utc(),
            "archived_by": admin["id"],
            "archive_note": (req.note or "").strip() or None,
            "status_changed_at": now_utc(),
            "status_changed_by": admin["id"],
        }},
    )
    asyncio.create_task(audit(db, "inventory_archived", admin["id"], auction_id, {
        **_client_ctx(request), "role": admin.get("role"),
        "note": (req.note or "").strip() or None,
        "before_state": before_state, "after_state": {"status": "archived"},
    }))
    return {"ok": True, "status": "archived"}


class InventoryLockReq(BaseModel):
    locked: bool
    reason: Optional[str] = None


@api.post("/admin/inventory/{auction_id}/lock")
async def admin_inventory_lock(
    request: Request,
    auction_id: str, req: InventoryLockReq,
    admin = Depends(require_permission("manage_inventory")),
):
    """Operator override — sets/clears `operator_lock` on an auction.
    While locked, downstream lifecycle actions (withdraw / archive /
    reserve-edit) are blocked for everyone EXCEPT super_admin. Used to
    freeze inventory under investigation or pending-dispute."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    if a.get("operator_lock") == bool(req.locked):
        return {"ok": True, "operator_lock": bool(req.locked), "no_change": True}
    before_state = {"operator_lock": bool(a.get("operator_lock"))}
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {
            "operator_lock": bool(req.locked),
            "operator_lock_reason": (req.reason or "").strip() or None,
            "operator_lock_at": now_utc() if req.locked else None,
            "operator_lock_by": admin["id"] if req.locked else None,
            "status_changed_at": now_utc(),
            "status_changed_by": admin["id"],
        }},
    )
    asyncio.create_task(audit(db, "inventory_locked" if req.locked else "inventory_unlocked",
                              admin["id"], auction_id, {
        **_client_ctx(request), "role": admin.get("role"),
        "reason": (req.reason or "").strip() or None,
        "before_state": before_state, "after_state": {"operator_lock": bool(req.locked)},
    }))
    try:
        await manager.broadcast_ops({"type": "inventory_lock_change", "auction_id": auction_id, "locked": bool(req.locked)})
    except Exception:
        pass
    return {"ok": True, "operator_lock": bool(req.locked)}


class ReservePriceReq(BaseModel):
    reserve_price: int


@api.post("/inventory/{auction_id}/reserve")
async def inventory_set_reserve(
    request: Request,
    auction_id: str, req: ReservePriceReq,
    admin = Depends(require_permission("manage_inventory")),
):
    """Edit reserve price. STRICT business rule: editable ONLY before the
    first bid is placed. Once any bid has hit the ledger, the reserve is
    immutable to preserve trust."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    await _check_inventory_lock(a, admin)
    bids_count = await db.bids.count_documents({"auction_id": auction_id})
    if bids_count > 0:
        raise HTTPException(status_code=400, detail="RESERVE_LOCKED — bids already placed; reserve cannot change")
    if req.reserve_price <= 0:
        raise HTTPException(status_code=400, detail="reserve_price must be positive")
    before_state = {"reserve_price": a.get("reserve_price")}
    await db.auctions.update_one(
        {"id": auction_id},
        {"$set": {"reserve_price": int(req.reserve_price)}},
    )
    asyncio.create_task(audit(db, "reserve_price_changed", admin["id"], auction_id, {
        **_client_ctx(request), "role": admin.get("role"),
        "before_state": before_state,
        "after_state": {"reserve_price": int(req.reserve_price)},
    }))
    return {"ok": True, "reserve_price": int(req.reserve_price)}


@api.get("/admin/inventory/{auction_id}/lifecycle")
async def inventory_lifecycle_timeline(
    auction_id: str,
    admin = Depends(require_permission("view_audit")),
):
    """Return the full audit-derived lifecycle timeline for an auction,
    plus the canonical timestamps from the auction doc itself. Read-only."""
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    actions = [
        "auction_pause", "auction_resume", "auction_extend",
        "auction_cancel", "force_close", "settlement_state_change",
        "settlement_note_add", "inventory_withdrawn", "inventory_archived",
        "inventory_locked", "inventory_unlocked", "reserve_price_changed",
    ]
    timeline: List[Dict[str, Any]] = []
    cur = db.audit_logs.find({"target_id": auction_id, "action": {"$in": actions}}, {"_id": 0}).sort("ts", 1).limit(200)
    async for ev in cur:
        timeline.append({
            "action": ev.get("action"),
            "actor_id": ev.get("actor_id"),
            "ts": iso(ev.get("ts")) if isinstance(ev.get("ts"), datetime) else ev.get("ts"),
            "meta": ev.get("meta") or {},
        })
    canonical = {
        "created_at": iso(a.get("created_at")) if isinstance(a.get("created_at"), datetime) else a.get("created_at"),
        "start_time": iso(a.get("start_time")) if isinstance(a.get("start_time"), datetime) else a.get("start_time"),
        "end_time": iso(a.get("end_time")) if isinstance(a.get("end_time"), datetime) else a.get("end_time"),
        "ended_at": iso(a.get("ended_at")) if isinstance(a.get("ended_at"), datetime) else a.get("ended_at"),
        "paused_at": iso(a.get("paused_at")) if isinstance(a.get("paused_at"), datetime) else a.get("paused_at"),
        "resumed_at": iso(a.get("resumed_at")) if isinstance(a.get("resumed_at"), datetime) else a.get("resumed_at"),
        "withdrawn_at": iso(a.get("withdrawn_at")) if isinstance(a.get("withdrawn_at"), datetime) else a.get("withdrawn_at"),
        "archived_at": iso(a.get("archived_at")) if isinstance(a.get("archived_at"), datetime) else a.get("archived_at"),
        "settled_at": iso(a.get("settled_at")) if isinstance(a.get("settled_at"), datetime) else a.get("settled_at"),
        "cancelled_at": iso(a.get("cancelled_at")) if isinstance(a.get("cancelled_at"), datetime) else a.get("cancelled_at"),
    }
    return {
        "auction_id": auction_id,
        "current_status": await _effective_status(a),
        "operator_lock": bool(a.get("operator_lock")),
        "canonical": canonical,
        "events": timeline,
    }


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
            # Phase 2C hygiene — exclude archived/withdrawn/hidden inventory
            # from operator dashboard. Cleanup migration sets these flags.
            "hidden_from_live_ops": {"$ne": True},
            "status": {"$nin": ["archived", "withdrawn"]},
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
    # Operational KPIs surfaced inline so the Live Ops dashboard can
    # render a `pending_approvals` badge without a second round-trip.
    pending_dealers = await db.dealers.count_documents({"role": "dealer", "status": "pending"})
    return {"items": items, "ts": iso(now), "pending_dealers": pending_dealers}


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
            # Phase 2C hygiene: settlement pipeline must never surface
            # archived/withdrawn or operator-hidden inventory.
            "hidden_from_settlement": {"$ne": True},
            "hidden_from_live_ops": {"$ne": True},
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
    "settlement_note_add", "dealer_approved", "dealer_signup",
    "inventory_withdrawn", "inventory_archived",
    "inventory_locked", "inventory_unlocked", "reserve_price_changed",
    "bid_cancel", "admin_broadcast", "broadcast_sent", "operator_promotion",
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

    # Silent funnel attribution — if the winner was reached after a
    # recent broadcast referenced this auction (or a recent network
    # broadcast), emit a `won` event into broadcast_events.
    if top:
        try:
            from routes import broadcast_tracking as _track
            asyncio.create_task(_track.attribute_win_to_recent_broadcast(
                db, dealer_id=top, auction_id=auction["id"],
                now_utc=now_utc, logger=logger,
            ))
        except Exception:
            pass

    # ---- Settlement intake hook ---------------------------------------
    # If the auction has a winner whose final bid hits reserve, create
    # the operator-controlled settlement record. Idempotent — repeated
    # ticks won't double-create.
    if won and top:
        try:
            full_auction = await db.auctions.find_one({"id": auction["id"]}, {"_id": 0}) or auction
            full_auction = dict(full_auction)
            full_auction["car"] = car
            full_auction["ended_at"] = full_auction.get("end_time") or now
            full_auction["reserve_met"] = True
            await sett_svc.create_for_auction_win(
                db,
                auction=full_auction,
                winner_dealer_id=top,
                winning_amount=float(final_bid),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("settlement intake failed for %s: %s", auction.get("id"), exc)


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
    # Phase 2C hygiene — dealer dashboard must align with /market/pulse
    # and /auctions. Filter at DB level so archived/withdrawn/settled
    # records never leak into "live_auctions" or "market_volume_today".
    visible = await db.auctions.find(marketplace_query(), {"_id": 0}).to_list(500)
    market_volume = 0
    for a in visible:
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


# ─────────────────────────────────────────────────────────────────────
# Canonical Inspection Object
# ─────────────────────────────────────────────────────────────────────
# db.inspections is the SINGLE SOURCE OF TRUTH for per-car inspection
# data. Operator writes here via PUT /api/cars/{id}/inspection. All
# roles (operator / seller / buyer / bidder / anonymous) read the same
# record via GET /api/cars/{id}/inspection or via the joined
# `auction.car.inspection` block on _enrich_auction.
#
# Aggregated fields (inspection_score / condition_grade /
# liquidity_rating / completion_percentage / sections_completed) are
# computed by the aggregation engine on every PUT and mirrored to the
# `cars` collection so the existing listing API surfaces remain
# backward-compatible. The mirror is a one-way write: cars.*
# inspection columns are NEVER edited by hand anywhere else in the
# codebase.
INSPECTION_SECTION_KEYS = ["exterior", "interior", "mechanical", "tyres", "documents", "photos"]
GRADE_LADDER = [(9.0, "A"), (8.0, "B"), (7.0, "C"), (0.0, "D")]
LIQUIDITY_LADDER = [(8.5, "HIGH"), (7.0, "MEDIUM"), (0.0, "LOW")]


class InspectionSection(BaseModel):
    completed: bool = False
    score: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    notes: Optional[str] = None
    # documents-only flags
    rc: Optional[bool] = None
    insurance: Optional[bool] = None
    puc: Optional[bool] = None
    # photos-only counter
    photo_count: Optional[int] = Field(default=None, ge=0)


class InspectionUpsertReq(BaseModel):
    sections: Dict[str, InspectionSection] = Field(default_factory=dict)
    accident_history: Optional[str] = None
    tyre_condition: Optional[str] = None
    service_history: Optional[str] = None


def _aggregate_inspection(sections: Dict[str, Any]) -> Dict[str, Any]:
    """Pure aggregation: takes section dict → returns derived metrics.

    Critically, only sections with a numeric `score > 0` contribute to
    the average. Sections like `documents` and `photos` (which never
    carry a numeric score) DO NOT pull the average down to zero —
    that's exactly the "missing optional section silently grades the
    car a D" bug we're closing.
    """
    numeric_scores: List[float] = []
    for k, v in (sections or {}).items():
        if not isinstance(v, dict):
            continue
        s = v.get("score")
        if isinstance(s, (int, float)) and not isinstance(s, bool) and float(s) > 0:
            numeric_scores.append(float(s))

    if numeric_scores:
        avg = sum(numeric_scores) / len(numeric_scores)
        score = round(avg, 1)
        grade = next((g for thr, g in GRADE_LADDER if score >= thr), "D")
        liquidity = next((l for thr, l in LIQUIDITY_LADDER if score >= thr), "LOW")
    else:
        score = None
        grade = None
        liquidity = None

    sections_completed = sorted([k for k, v in (sections or {}).items()
                                  if isinstance(v, dict) and v.get("completed")])
    total = max(1, len(INSPECTION_SECTION_KEYS))
    pct = round(len(sections_completed) / total * 100)

    return {
        "inspection_score": score,
        "condition_grade": grade,
        "liquidity_rating": liquidity,
        "completion_percentage": pct,
        "sections_completed": sections_completed,
    }


def _normalise_text_field(raw: Optional[str]) -> Optional[str]:
    """None / empty / whitespace → None. Strip otherwise."""
    if raw is None:
        return None
    s = str(raw).strip()
    return s if s else None


async def _mirror_inspection_to_car(car_id: str, doc: Dict[str, Any]) -> None:
    """One-way write: copy aggregated fields onto cars.{car_id} so the
    legacy /api/cars and /api/auctions surfaces keep working without
    every consumer having to learn the new join."""
    await db.cars.update_one(
        {"id": car_id},
        {"$set": {
            "inspection_score":  doc.get("inspection_score"),
            "condition_grade":   doc.get("condition_grade"),
            "tyre_condition":    doc.get("tyre_condition"),
            "accident_history":  doc.get("accident_history"),
            "service_history":   doc.get("service_history"),
            "liquidity_rating":  doc.get("liquidity_rating"),
        }},
    )


async def _broadcast_inspection_update(car_id: str) -> None:
    """Notify any live WS subscribers that the inspection changed so
    open lot screens can refetch + redraw. Best-effort; never raises."""
    try:
        auction = await db.auctions.find_one({"car_id": car_id}, {"_id": 0, "id": 1})
        if not auction:
            return
        aid = auction["id"]
        # `manager` is the module-level ConnectionManager singleton
        # defined at server.py:510. The .broadcast() helper short-
        # circuits when no one is subscribed, so this is a no-op for
        # auctions nobody is watching.
        await manager.broadcast(aid, {
            "type": "inspection_updated",
            "auction_id": aid,
            "car_id": car_id,
            "ts": now_utc().isoformat(),
        })
    except Exception as exc:
        logger.warning("inspection broadcast failed for car=%s: %s", car_id, exc)


def _diff_inspection_for_history(prev: Optional[Dict[str, Any]], new: Dict[str, Any]) -> Dict[str, Any]:
    """Compute a human-readable + machine-parseable diff for the
    audit log. Returns the set of fields that changed plus their
    before/after values. Section-level diffs roll up to the section
    key (no need to log every nested completed/score/notes mutation
    individually — bidders care about per-section change, not the
    micro-state)."""
    prev = prev or {}
    changed: List[Dict[str, Any]] = []
    # Top-level scalar fields
    for field in ("inspection_score", "condition_grade", "tyre_condition",
                  "accident_history", "service_history", "liquidity_rating",
                  "completion_percentage"):
        a, b = prev.get(field), new.get(field)
        if a != b:
            changed.append({"field": field, "before": a, "after": b})
    # Section-level diffs
    prev_sections = prev.get("sections") or {}
    new_sections  = new.get("sections")  or {}
    for k in INSPECTION_SECTION_KEYS:
        ps, ns = prev_sections.get(k) or {}, new_sections.get(k) or {}
        if ps != ns:
            changed.append({
                "field": f"sections.{k}",
                "before": {kk: ps.get(kk) for kk in ("completed", "score", "notes", "rc", "insurance", "puc", "photo_count") if kk in ps},
                "after":  {kk: ns.get(kk) for kk in ("completed", "score", "notes", "rc", "insurance", "puc", "photo_count") if kk in ns},
            })
    return {"changes": changed, "field_count": len(changed)}


def _payload_is_empty(req: InspectionUpsertReq) -> bool:
    """Return True if the request would persist a *completely empty*
    inspection — no completed sections, no scored sections, no text
    fields. We reject these to satisfy the data-integrity rule
    "no null inspection saves" while still allowing operators to
    partially fill the form (any single completed section is enough
    to pass)."""
    if _normalise_text_field(req.accident_history): return False
    if _normalise_text_field(req.tyre_condition):   return False
    if _normalise_text_field(req.service_history):  return False
    for s in (req.sections or {}).values():
        if s.completed: return False
        if isinstance(s.score, (int, float)) and not isinstance(s.score, bool) and float(s.score) > 0: return False
        if _normalise_text_field(s.notes):  return False
    return True


@api.put("/cars/{car_id}/inspection")
async def upsert_inspection(car_id: str, req: InspectionUpsertReq, dealer = Depends(get_current_admin)):
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")

    # ── Data integrity gate: refuse to persist a fully-empty
    # inspection. Operator must explicitly mark at least one section
    # completed OR provide at least one free-text field. This stops
    # accidental wipes (e.g. mis-typed PUT) and stops bidders from
    # ever seeing a freshly-emptied record. To genuinely reset an
    # inspection the operator uses DELETE (not yet exposed; future
    # admin-console feature).
    if _payload_is_empty(req):
        raise HTTPException(status_code=422, detail={
            "code": "INSPECTION_EMPTY_NOT_ALLOWED",
            "message": "Inspection payload is empty. Set at least one completed section, score, or free-text field.",
        })

    # Whitelist + normalise sections — only accept the 6 known keys.
    incoming_sections: Dict[str, Any] = {}
    for key in INSPECTION_SECTION_KEYS:
        s = req.sections.get(key) if req.sections else None
        if s is None:
            incoming_sections[key] = {"completed": False}
            continue
        # Pydantic already validated score range; collapse to plain dict.
        section_dict: Dict[str, Any] = {
            "completed": bool(s.completed),
        }
        if s.score is not None:
            section_dict["score"] = float(s.score)
        if s.notes is not None:
            section_dict["notes"] = _normalise_text_field(s.notes)
        if key == "documents":
            section_dict["rc"] = bool(s.rc) if s.rc is not None else False
            section_dict["insurance"] = bool(s.insurance) if s.insurance is not None else False
            section_dict["puc"] = bool(s.puc) if s.puc is not None else False
        if key == "photos" and s.photo_count is not None:
            section_dict["photo_count"] = int(s.photo_count)
        incoming_sections[key] = section_dict

    derived = _aggregate_inspection(incoming_sections)
    accident = _normalise_text_field(req.accident_history)
    tyre     = _normalise_text_field(req.tyre_condition)
    service  = _normalise_text_field(req.service_history)

    now = now_utc()
    existing = await db.inspections.find_one({"car_id": car_id}, {"_id": 0})
    inspection_id = existing.get("id") if existing else str(uuid.uuid4())
    # Legacy PDF uploads stored version as a string ("v1"/"v2"). New
    # canonical records use an auto-incrementing int. Coerce safely
    # so an int-typed version field is always produced even when the
    # historical row has "v3" or no version at all.
    def _coerce_version(raw: Any) -> int:
        if isinstance(raw, bool):
            return 0
        if isinstance(raw, (int, float)):
            return int(raw)
        if isinstance(raw, str):
            digits = "".join(ch for ch in raw if ch.isdigit())
            return int(digits) if digits else 0
        return 0
    prev_version  = _coerce_version((existing or {}).get("version"))
    next_version  = prev_version + 1

    # Find the associated auction (if any) so we can flag post-launch
    # edits. Bidders see a "Inspection updated" badge on every live
    # auction whose inspection_updated_at > auction.started_at.
    auction_doc = await db.auctions.find_one({"car_id": car_id}, {"_id": 0, "id": 1, "status": 1, "started_at": 1})
    is_live_or_ended = bool(auction_doc and auction_doc.get("status") in ("live", "ended", "closed"))

    doc: Dict[str, Any] = {
        "id": inspection_id,
        "car_id": car_id,
        "sections": incoming_sections,
        "accident_history": accident,
        "tyre_condition":   tyre,
        "service_history":  service,
        # Derived (aggregation engine output)
        "inspection_score":  derived["inspection_score"],
        "condition_grade":   derived["condition_grade"],
        "liquidity_rating":  derived["liquidity_rating"],
        "completion_percentage": derived["completion_percentage"],
        "sections_completed":    derived["sections_completed"],
        # PDF metadata is preserved across upserts.
        "pdf": (existing or {}).get("pdf"),
        # ── Versioning / audit fields ──────────────────────────────
        "version":      next_version,
        "updated_by":   dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
        "updated_by_id": dealer["id"],
        # Legacy aliases kept for back-compat with older clients.
        "uploader_id":   dealer["id"],
        "uploader_name": dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
        "created_at":    (existing or {}).get("created_at") or now,
        "updated_at":    now,
    }
    await db.inspections.update_one({"car_id": car_id}, {"$set": doc}, upsert=True)
    await _mirror_inspection_to_car(car_id, doc)

    # ── History append ─────────────────────────────────────────────
    # Every PUT produces an immutable audit row. The doc carries the
    # full BEFORE snapshot, the AFTER snapshot, and a diff list so
    # the admin console can render "Operator X changed grade from
    # A to B at 14:32 on 2026-05-17" without recomputing.
    history_entry = {
        "id":             str(uuid.uuid4()),
        "car_id":         car_id,
        "inspection_id":  inspection_id,
        "version":        next_version,
        "previous_version": prev_version,
        "previous_values": {
            k: (existing or {}).get(k)
            for k in ("inspection_score", "condition_grade", "tyre_condition",
                      "accident_history", "service_history", "liquidity_rating",
                      "completion_percentage", "sections")
        } if existing else None,
        "new_values": {
            "inspection_score": derived["inspection_score"],
            "condition_grade":  derived["condition_grade"],
            "tyre_condition":   tyre,
            "accident_history": accident,
            "service_history":  service,
            "liquidity_rating": derived["liquidity_rating"],
            "completion_percentage": derived["completion_percentage"],
            "sections":         incoming_sections,
        },
        "diff":          _diff_inspection_for_history(existing, doc),
        "actor_id":      dealer["id"],
        "actor_name":    dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
        "actor_role":    dealer.get("role", "operator"),
        "auction_status_at_update": (auction_doc or {}).get("status"),
        "post_launch":   is_live_or_ended,
        "timestamp":     now,
    }
    try:
        await db.inspection_history.insert_one(history_entry)
    except Exception as exc:
        # Audit-log write failure must NOT break the operator's edit —
        # bidder trust is preserved by the inspection doc itself.
        logger.error("[inspection.history] failed to append for car=%s: %s", car_id, exc)

    # ── Mark auction as "inspection_updated_after_launch" if live ──
    # The flag drives the orange "Inspection updated" badge on the
    # bidder lot screen so dealers know to re-read the report.
    if is_live_or_ended:
        try:
            await db.auctions.update_one(
                {"car_id": car_id},
                {"$set": {
                    "inspection_updated_after_launch": True,
                    "inspection_last_updated_at": now,
                }}
            )
        except Exception as exc:
            logger.warning("[inspection.flag] post-launch flag write failed for car=%s: %s", car_id, exc)

    await _broadcast_inspection_update(car_id)

    logger.info(
        "[inspection.upsert] car=%s version=%d score=%s grade=%s liq=%s completion=%s%% post_launch=%s",
        car_id, next_version, derived["inspection_score"], derived["condition_grade"],
        derived["liquidity_rating"], derived["completion_percentage"], is_live_or_ended,
    )
    return serialize(doc)


@api.get("/cars/{car_id}/inspection")
async def get_car_inspection(car_id: str):
    """Open read endpoint — any caller (operator, seller, buyer,
    anonymous bidder) gets the SAME inspection record so the platform
    can never present different inspection outputs to different roles
    for the same listing."""
    insp = await db.inspections.find_one({"car_id": car_id}, {"_id": 0})
    if not insp:
        # Return a stable empty shape so the frontend can render
        # "Not scored" copy without null-guards everywhere.
        return {
            "car_id": car_id,
            "sections": {k: {"completed": False} for k in INSPECTION_SECTION_KEYS},
            "accident_history": None,
            "tyre_condition":   None,
            "service_history":  None,
            "inspection_score": None,
            "condition_grade":  None,
            "liquidity_rating": None,
            "completion_percentage": 0,
            "sections_completed":    [],
            "pdf": None,
            "version": 0,
            "updated_by": None,
            "updated_at": None,
        }
    return serialize(insp)


@api.get("/cars/{car_id}/inspection/history")
async def get_car_inspection_history(car_id: str, limit: int = 50):
    """Returns the append-only audit log of inspection edits for a car.
    Open read (any role) — transparency is the whole point. The list
    is newest-first so the lot screen can render a "Recently updated"
    timeline without client-side sorting."""
    limit = max(1, min(int(limit or 50), 200))
    cursor = db.inspection_history.find(
        {"car_id": car_id}, {"_id": 0}
    ).sort("timestamp", -1).limit(limit)
    rows = await cursor.to_list(length=limit)
    # `serialize()` is dict-only. The history endpoint returns a list,
    # so we map over individual entries (each is a dict with safe
    # types after the insert path normalised them).
    return {"car_id": car_id, "count": len(rows), "entries": [serialize(r) for r in rows]}


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

    # ── Merge PDF into the canonical inspection doc (do NOT replace).
    # Prior behaviour blew away the section breakdown every time an
    # operator uploaded a fresh PDF — that's the architecture bug the
    # P0 trust correction is closing. We now upsert the `pdf` sub-doc
    # and leave sections / aggregates untouched. The download endpoint
    # below resolves the PDF id via either the legacy top-level
    # `gridfs_id` (back-compat) or the new `pdf.gridfs_id`.
    now = now_utc()
    existing = await db.inspections.find_one({"car_id": car_id}, {"_id": 0})
    inspection_id = (existing or {}).get("id") or str(uuid.uuid4())
    # Preserve a stable "id" field that points at the PDF when there
    # is one — the historical /inspections/file/{id} endpoint reads
    # inspections by id and expects gridfs_id at the top level.
    pdf_sub = {
        "filename":      safe_name,
        "size_bytes":    len(contents),
        "version":       version or "v1",
        "status":        "verified",
        "gridfs_id":     str(gridfs_id),
        "uploaded_at":   now,
        "uploader_id":   dealer["id"],
        "uploader_name": dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
    }
    merged: Dict[str, Any] = dict(existing or {})
    merged.update({
        "id":            inspection_id,
        "car_id":        car_id,
        "pdf":           pdf_sub,
        # Keep top-level gridfs_id / filename / size_bytes for backward
        # compatibility with the /inspections/file/{id} streamer and
        # the InspectionPdfCard frontend component that still reads
        # the flat shape.
        "gridfs_id":     str(gridfs_id),
        "filename":      safe_name,
        "size_bytes":    len(contents),
        "version":       version or "v1",
        "status":        "verified",
        "uploader_id":   dealer["id"],
        "uploader_name": dealer.get("dealership_name") or dealer.get("full_name") or "Operator",
        "created_at":    (existing or {}).get("created_at") or now,
        "updated_at":    now,
    })
    # Default an empty section map if this is the first write for the car
    # so a stand-alone PDF upload still produces a queryable record.
    if "sections" not in merged:
        merged["sections"] = {k: {"completed": False} for k in INSPECTION_SECTION_KEYS}

    await db.inspections.update_one({"car_id": car_id}, {"$set": merged}, upsert=True)
    await _broadcast_inspection_update(car_id)

    return serialize(merged)


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
    # Reflect the new featured image into car.images[0] for ALL providers
    # (not just external). Without this, dealers reading auction.car.images
    # continue to see the previous Unsplash demo URL even after the operator
    # picks a real uploaded photo. _enrich_auction will also overwrite
    # car.images at read time, but persisting here keeps the legacy field
    # consistent for any consumer that bypasses the enricher.
    feat = await db.media.find_one({"id": media_id}, {"_id": 0})
    if feat:
        if feat.get("provider") == "external" and feat.get("external_url"):
            featured_url = feat["external_url"]
        else:
            featured_url = f"/api/media/{media_id}/file"
        await db.cars.update_one({"id": car_id}, {"$set": {"images.0": featured_url}})
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
    # Phase 2C hygiene — pulse must align with /auctions and the dealer
    # marketplace. Iterating all docs without filter previously surfaced
    # 16 archived/orphaned auctions as "live" because enrichment had no
    # explicit-state for archived. Now we both:
    #   (1) filter at DB level via marketplace_query()
    #   (2) recompute via the hardened _enrich_auction so archived /
    #       withdrawn / cancelled never resurface as live.
    visible = await db.auctions.find(marketplace_query(), {"_id": 0}).to_list(500)
    live = upcoming = ended = 0
    volume = 0
    top_makes: Dict[str, int] = {}
    for a in visible:
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



# ---------------------------------------------------------------------
# Realtime — snapshot, anomaly report, operator health
# ---------------------------------------------------------------------
@api.get("/auctions/{auction_id}/snapshot")
async def auction_snapshot(auction_id: str, dealer = Depends(get_current_dealer)):
    """Authoritative snapshot used by clients on WS reconnect.

    Returns the auction doc + the most recent N bids in (seq DESC) order
    plus `seq` (the current authoritative bid_seq) and `server_ns`
    (process-monotonic clock at snapshot time). The client MUST reset
    its local last_seq to the returned `seq` and discard any
    optimistic bid frames that disagree with the snapshot.
    """
    a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
    if not a:
        raise HTTPException(status_code=404, detail="Auction not found")
    enriched = await _enrich_auction(a)
    bids = await db.bids.find(
        {"auction_id": auction_id, "cancelled": {"$ne": True}},
        {"_id": 0},
    ).sort("created_at", -1).limit(50).to_list(50)
    seq = int(a.get("bid_seq") or 0)
    # Reserve-price privacy applies to the WS reconnect snapshot too —
    # bidders MUST NOT see the exact reserve regardless of the
    # transport (REST vs WS-reconnect-REST).
    return {
        "auction": jsonable_encoder(_strip_reserve_for_viewer(enriched, dealer)),
        "bids": [serialize(b) for b in bids],
        "seq": seq,
        "server_ns": rt.monotonic_ns(),
    }


class RealtimeReportReq(BaseModel):
    # Lightweight client-side anomaly report. The only fields the server
    # treats as authoritative are dealer_id (from JWT) and the auction_id.
    # Numeric counters are clamped to defend against malicious payloads.
    event: str
    auction_id: Optional[str] = None
    expected_seq: Optional[int] = None
    got_seq: Optional[int] = None
    detail: Optional[str] = None


@api.post("/realtime/report")
async def realtime_report(req: RealtimeReportReq, dealer = Depends(get_current_dealer)):
    allowed = {"frame_out_of_order", "ws_reconnect", "snapshot_resync", "client_error"}
    if req.event not in allowed:
        raise HTTPException(status_code=400, detail="unknown_event")
    # Cheap clamp — never store unbounded user-supplied numbers
    def clamp(x):
        try: return max(-(1 << 31), min(1 << 31, int(x))) if x is not None else None
        except Exception: return None
    asyncio.create_task(rt.emit(
        db, req.event, now_utc=now_utc,
        dealer_id=dealer["id"], auction_id=req.auction_id,
        expected_seq=clamp(req.expected_seq), got_seq=clamp(req.got_seq),
        detail=(req.detail or "")[:200],
    ))
    return {"ok": True}


@api.get("/admin/realtime/health")
async def admin_realtime_health(_op = Depends(get_current_admin)):
    """Operational reliability snapshot for the operator Reliability UI.

    Tightly scoped to auction integrity + platform reliability:
      - Live WS gauge (per-room counts).
      - Last-hour event counts for the realtime telemetry stream.
      - Active reconnect storms (dealers >5 reconnects/5min).
      - Top auctions by race-conflict count in the last hour.
      - Active live auctions + how many are ending in the next 5 minutes.
      - Operator-intervention alerts: derived flags that require human action
        (close-race spikes, reconnect storms, broadcast lag, dispute backlog).

    NOT a BI dashboard. No history, no charts, no drill-downs deeper than
    "tap to open the auction page".
    """
    one_hour_ago = now_utc() - timedelta(hours=1)
    five_min_ago = now_utc() - timedelta(minutes=5)
    five_min_from_now = now_utc() + timedelta(minutes=5)

    # ---- 1. Last-hour event histogram ----
    counts: Dict[str, int] = {}
    try:
        async for row in db.realtime_metrics.aggregate([
            {"$match": {"ts": {"$gte": one_hour_ago}}},
            {"$group": {"_id": "$event", "count": {"$sum": 1}}},
        ]):
            counts[str(row.get("_id") or "")] = int(row.get("count") or 0)
    except Exception as exc:
        logger.warning("realtime health histogram failed: %s", exc)

    # ---- 2. Active reconnect storms (last 5min, threshold > 5) ----
    storming_dealers: List[Dict[str, Any]] = []
    try:
        async for row in db.realtime_metrics.aggregate([
            {"$match": {"event": "ws_reconnect_storm", "ts": {"$gte": five_min_ago}}},
            {"$group": {"_id": "$dealer_id",
                        "count": {"$sum": 1},
                        "max_recent": {"$max": "$count_5min"},
                        "last_room": {"$last": "$room"}}},
            {"$sort": {"max_recent": -1}},
            {"$limit": 8},
        ]):
            storming_dealers.append({
                "dealer_id": row.get("_id"),
                "events_in_window": int(row.get("count") or 0),
                "reconnects_5min": int(row.get("max_recent") or 0),
                "room": row.get("last_room"),
            })
    except Exception as exc:
        logger.warning("realtime health storms failed: %s", exc)

    # ---- 3. Top race-conflict auctions (last hour) ----
    race_top: List[Dict[str, Any]] = []
    try:
        async for row in db.realtime_metrics.aggregate([
            {"$match": {"event": "bid_race_conflict", "ts": {"$gte": one_hour_ago}}},
            {"$group": {"_id": "$auction_id", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 5},
        ]):
            race_top.append({
                "auction_id": row.get("_id"),
                "conflicts_1h": int(row.get("count") or 0),
            })
    except Exception as exc:
        logger.warning("realtime health races failed: %s", exc)

    # ---- 4. Broadcast lag spikes (last hour) — quick p-numbers ----
    lag_samples: List[int] = []
    try:
        for row in await db.realtime_metrics.find(
            {"event": "broadcast_lag_spike", "ts": {"$gte": one_hour_ago}},
            {"_id": 0, "dispatch_ms": 1},
        ).limit(200).to_list(200):
            v = row.get("dispatch_ms")
            if isinstance(v, int):
                lag_samples.append(v)
    except Exception as exc:
        logger.warning("realtime health lag failed: %s", exc)
    lag_samples.sort()

    def _percentile(arr: List[int], pct: float) -> Optional[int]:
        if not arr:
            return None
        idx = max(0, min(len(arr) - 1, int(round((len(arr) - 1) * pct))))
        return int(arr[idx])

    # ---- 5. Active auction health ----
    live_count = await db.auctions.count_documents({"status": "live"})
    ending_soon = await db.auctions.count_documents(
        {"status": "live", "end_time": {"$gte": now_utc(), "$lte": five_min_from_now}},
    )
    paused_count = await db.auctions.count_documents({"status": "paused"})

    # ---- 6. Recent close-race events ----
    close_races: List[Dict[str, Any]] = []
    try:
        for row in await db.realtime_metrics.find(
            {"event": "auction_close_race", "ts": {"$gte": one_hour_ago}},
            {"_id": 0, "auction_id": 1, "ts": 1, "end_time_skew_ms": 1, "dealer_id": 1},
        ).sort("ts", -1).limit(8).to_list(8):
            close_races.append({
                "auction_id": row.get("auction_id"),
                "skew_ms": int(row.get("end_time_skew_ms") or 0),
                "dealer_id": row.get("dealer_id"),
                "ts": row.get("ts"),
            })
    except Exception as exc:
        logger.warning("realtime health close races failed: %s", exc)

    # ---- 7. Live WS gauge (in-process) ----
    rooms_summary = []
    total_live = 0
    for room_key, conns in (manager.rooms or {}).items():
        if not conns:
            continue
        total_live += len(conns)
        rooms_summary.append({
            "room": room_key,
            "count": len(conns),
            "roles": list({c.get("role") for c in conns}),
        })

    # ---- 8. Operator-intervention alerts (derived) ----
    # The UI groups these by severity. Each alert is a tight, action-oriented
    # one-liner — never a chart, never a graph. Tap → relevant page.
    alerts: List[Dict[str, Any]] = []
    if storming_dealers:
        alerts.append({
            "id": "reconnect_storm",
            "severity": "warn",
            "title": f"{len(storming_dealers)} dealer(s) in reconnect storm",
            "detail": "Repeated WS drops in the last 5 min — likely flaky network or app issue.",
            "route": None,
        })
    if counts.get("bid_race_conflict", 0) > 10:
        alerts.append({
            "id": "race_spike",
            "severity": "warn",
            "title": f"{counts['bid_race_conflict']} bid race conflicts in last hour",
            "detail": "Multiple dealers competing on the same auctions — verify integrity.",
            "route": None,
        })
    if (counts.get("broadcast_lag_spike", 0) > 5
            or (lag_samples and lag_samples[-1] > 1500)):
        alerts.append({
            "id": "broadcast_lag",
            "severity": "critical",
            "title": "Broadcast fan-out is slow",
            "detail": f"Peak {lag_samples[-1] if lag_samples else 0}ms in last hour. Bid updates may feel laggy to dealers.",
            "route": None,
        })
    if ending_soon > 0:
        alerts.append({
            "id": "auctions_ending",
            "severity": "info",
            "title": f"{ending_soon} auction(s) closing in next 5 min",
            "detail": "Watch close-race telemetry for last-second collisions.",
            "route": "/(admin)",
        })
    if paused_count > 0:
        alerts.append({
            "id": "paused_auctions",
            "severity": "info",
            "title": f"{paused_count} auction(s) currently paused",
            "detail": "Operator-paused auctions awaiting resume / cancel decision.",
            "route": "/(admin)",
        })

    return {
        "live_ws": total_live,
        "rooms": sorted(rooms_summary, key=lambda r: -r["count"])[:25],
        "events_1h": counts,
        "active_storms": storming_dealers,
        "race_top_auctions": race_top,
        "close_races_1h": close_races,
        "broadcast_lag_ms": {
            "samples": len(lag_samples),
            "p50": _percentile(lag_samples, 0.5),
            "p95": _percentile(lag_samples, 0.95),
            "max": (lag_samples[-1] if lag_samples else None),
        },
        "auctions": {
            "live": int(live_count),
            "ending_in_5m": int(ending_soon),
            "paused": int(paused_count),
        },
        "alerts": alerts,
        "thresholds": {
            "broadcast_lag_spike_ms": 500,
            "reconnect_storm": 5,
            "auction_close_race_window_ms": 2000,
            "race_spike_alert_1h": 10,
        },
        "server_ns": rt.monotonic_ns(),
        "generated_at": now_utc(),
    }



@app.websocket("/api/ws/auction/{auction_id}")
async def ws_auction(websocket: WebSocket, auction_id: str):
    """Authenticated dealer/operator WS for live auction streams.
    Token MUST be passed as a query parameter `?token=<jwt>` on connect.
    Anonymous or invalid connections are rejected with code 4401.

    Hardening (additive — wire-format fully backward compatible):
      • Heartbeat: server pings every 25s; missed pongs eventually
        close the socket so the client knows to reconnect.
      • Inbound {"type":"ping"} → server replies {"type":"pong"} so
        clients can probe liveness without re-establishing the socket.
      • Snapshot on connect now carries `seq` + `server_ns` so the
        client's sequence-aware buffer can reset cleanly.
      • Connect / disconnect / reconnect-storm telemetry written to
        db.realtime_metrics (best-effort, never blocks).
    """
    token = websocket.query_params.get("token", "")
    dealer = await _ws_authenticate(token)
    if not dealer:
        await websocket.close(code=4401)
        return

    role = dealer.get("role") or "dealer"
    tv = int(dealer.get("token_version") or 0)
    room_key = f"auction:{auction_id}"
    await manager.connect(room_key, websocket, dealer_id=dealer["id"], role=role, tv=tv)

    connect_ns = rt.monotonic_ns()
    storm_count = rt.record_reconnect(dealer["id"])
    asyncio.create_task(rt.emit(
        db, "ws_connect", now_utc=now_utc,
        dealer_id=dealer["id"], role=role, room=room_key,
        recent_reconnects=storm_count,
    ))
    if rt.is_reconnect_storm(storm_count):
        asyncio.create_task(rt.emit(
            db, "ws_reconnect_storm", now_utc=now_utc,
            dealer_id=dealer["id"], room=room_key, count_5min=storm_count,
        ))

    disconnect_reason = "normal"
    try:
        # Snapshot on connect — additive seq / server_ns fields let
        # new clients prime their sequence buffer; old clients ignore them.
        a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
        if a:
            ea = await _enrich_auction(a)
            # Reserve-price privacy — the WS snapshot is the only path
            # by which reserve could otherwise leak to a bidder via the
            # auction room subscription. The same _strip_reserve_for
            # _viewer applies to operators (no-op for them) so the
            # frame shape is uniform across roles.
            await websocket.send_json({
                "type": "snapshot",
                "auction": jsonable_encoder(_strip_reserve_for_viewer(ea, dealer)),
                "seq": int(a.get("bid_seq") or 0),
                "server_ns": rt.monotonic_ns(),
            })

        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                # Inbound heartbeat / liveness probe handling.
                # Ignore decode failures — opaque inbound traffic is fine,
                # we don't enforce a schema on what clients can send.
                try:
                    msg = json.loads(raw) if raw else {}
                except Exception:
                    msg = {}
                mtype = msg.get("type") if isinstance(msg, dict) else None
                if mtype == "ping":
                    try: await websocket.send_json({"type": "pong", "server_ns": rt.monotonic_ns()})
                    except Exception: break
                    continue
                # Periodic re-validation: if the dealer's tv has bumped server-
                # side (allow-list revoke / role change in another worker), kill
                # this socket on the next inbound message.
                fresh = await db.dealers.find_one(
                    {"id": dealer["id"]}, {"_id": 0, "token_version": 1, "suspended": 1, "role": 1},
                )
                if (not fresh
                    or int(fresh.get("token_version") or 0) != tv
                    or (fresh.get("suspended") and (fresh.get("role") or "dealer") == "dealer")):
                    try: await websocket.send_json({"type": "session_killed", "reason": "tv_drift"})
                    except Exception: pass
                    await websocket.close(code=4401)
                    disconnect_reason = "tv_drift"
                    break
            except asyncio.TimeoutError:
                # Outbound heartbeat — proves the socket is alive and
                # gives the client an idle-keepalive frame so ingress
                # doesn't 100s-idle-kill the connection.
                try:
                    await websocket.send_json({"type": "ping", "server_ns": rt.monotonic_ns()})
                except Exception:
                    disconnect_reason = "send_failed"
                    break
    except WebSocketDisconnect:
        disconnect_reason = "client_close"
    except Exception as e:
        logger.warning("WS error: %s", e)
        disconnect_reason = "exception"
    finally:
        manager.disconnect(room_key, websocket)
        duration_ms = max(0, (rt.monotonic_ns() - connect_ns) // 1_000_000)
        asyncio.create_task(rt.emit(
            db, "ws_disconnect", now_utc=now_utc,
            dealer_id=dealer["id"], role=role, room=room_key,
            reason=disconnect_reason, duration_ms=int(duration_ms),
        ))


@app.websocket("/api/ws/ops")
async def ws_ops(websocket: WebSocket):
    """Operator-only WebSocket channel — receives ops events (live grid
    updates, settlement transitions, dealer status changes) and is fully
    isolated from dealer subscribers. Dealer JWTs are rejected even if
    valid, because dealers must NEVER see internal ops chatter.

    Hardening identical to /ws/auction (heartbeat, ping/pong, telemetry).
    """
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

    connect_ns = rt.monotonic_ns()
    storm_count = rt.record_reconnect(dealer["id"])
    asyncio.create_task(rt.emit(
        db, "ws_connect", now_utc=now_utc,
        dealer_id=dealer["id"], role=role, room="ops",
        recent_reconnects=storm_count,
    ))
    if rt.is_reconnect_storm(storm_count):
        asyncio.create_task(rt.emit(
            db, "ws_reconnect_storm", now_utc=now_utc,
            dealer_id=dealer["id"], room="ops", count_5min=storm_count,
        ))

    disconnect_reason = "normal"
    try:
        await websocket.send_json({"type": "ops_connected", "role": role, "server_ns": rt.monotonic_ns()})
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                try:
                    msg = json.loads(raw) if raw else {}
                except Exception:
                    msg = {}
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    try: await websocket.send_json({"type": "pong", "server_ns": rt.monotonic_ns()})
                    except Exception: break
                    continue
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
                    disconnect_reason = "tv_drift"
                    break
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping", "server_ns": rt.monotonic_ns()})
                except Exception:
                    disconnect_reason = "send_failed"
                    break
    except WebSocketDisconnect:
        disconnect_reason = "client_close"
    except Exception as e:
        logger.warning("WS-ops error: %s", e)
        disconnect_reason = "exception"
    finally:
        manager.disconnect("ops", websocket)
        duration_ms = max(0, (rt.monotonic_ns() - connect_ns) // 1_000_000)
        asyncio.create_task(rt.emit(
            db, "ws_disconnect", now_utc=now_utc,
            dealer_id=dealer["id"], role=role, room="ops",
            reason=disconnect_reason, duration_ms=int(duration_ms),
        ))


@api.get("/")
async def root():
    return {"service": "Q Drives API", "status": "ok"}


# ═════════════════════════════════════════════════════════════════════
# REPUTATION ENGINE + DISPUTE SYSTEM (P1)
# Imports kept here (lazy) so the services package is reloaded with the
# rest of the codebase without circular-import surprises.
# ═════════════════════════════════════════════════════════════════════
from services import reputation as rep_svc           # noqa: E402
from services import disputes as disp_svc            # noqa: E402
from services import settlement as sett_svc          # noqa: E402
from services import sellers as sellers_svc          # noqa: E402


# ── Pydantic models ─────────────────────────────────────────────────
class OperatorScoreAdjustReq(BaseModel):
    delta: int = Field(..., ge=-100, le=100)
    reason: str = Field(..., min_length=3, max_length=500)


class OperatorRestrictionReq(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)
    duration_hours: Optional[int] = Field(None, ge=1, le=24 * 365)


class OperatorNoteReq(BaseModel):
    note: str = Field(..., min_length=1, max_length=2000)
    visibility: str = Field("operator", pattern="^(operator|dealer)$")


class RaiseDisputeReq(BaseModel):
    against_dealer_id: Optional[str] = None
    auction_id: Optional[str] = None
    dispute_type: str
    title: str = Field(..., min_length=3, max_length=200)
    description: str = Field(..., min_length=10, max_length=5000)


class DisputeMessageReq(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)


class DisputeEvidenceReq(BaseModel):
    kind: str = Field(..., pattern="^(image|document|note)$")
    filename: Optional[str] = Field(None, max_length=200)
    mime_type: Optional[str] = Field(None, max_length=120)
    content_base64: Optional[str] = None
    note: Optional[str] = Field(None, max_length=2000)


class DisputeRequestEvidenceReq(BaseModel):
    request: str = Field(..., min_length=3, max_length=1000)


class DisputeEscalateReq(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)


class DisputeDecideReq(BaseModel):
    outcome: str   # one of disp_svc.DECISION_OUTCOMES
    reason: str = Field(..., min_length=5, max_length=2000)


class WithdrawDisputeReq(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)


# ── Reputation: dealer self-view ────────────────────────────────────
@api.get("/reputation/me")
async def reputation_self(dealer = Depends(get_current_dealer)):
    return await rep_svc.get_dealer_reputation(db, dealer["id"])


@api.get("/reputation/me/timeline")
async def reputation_self_timeline(
    limit: int = 100,
    dealer = Depends(get_current_dealer),
):
    return await rep_svc.get_reputation_timeline(db, dealer["id"], limit=limit)


@api.get("/reputation/dealer/{dealer_id}/summary")
async def reputation_summary_public(
    dealer_id: str,
    _viewer = Depends(get_current_dealer),
):
    """Lightweight badge/tier card visible to other dealers (e.g. on auction
    cards). Does NOT expose individual signals."""
    return await rep_svc.reputation_summary(db, dealer_id)


# ── Reputation: operator views ──────────────────────────────────────
@api.get("/admin/reputation/dealers")
async def admin_reputation_list(
    limit: int = 100,
    sort: str = "score_asc",      # score_asc | score_desc | recent_action
    tier: Optional[str] = None,   # filter
    admin = Depends(require_permission("manage_reputation")),
):
    cursor = db.dealers.find(
        {"approval_status": {"$in": ["approved", "pending", "rejected"]}}
    ).limit(500)
    rows: List[Dict[str, Any]] = []
    async for d in cursor:
        rep = await rep_svc.get_dealer_reputation(db, d["id"])
        if tier and rep["tier"]["key"] != tier:
            continue
        rows.append({
            "dealer_id": d["id"],
            "name": d.get("dealership_name") or d.get("name"),
            "phone": d.get("phone"),
            "approval_status": d.get("approval_status"),
            "verification_status": d.get("verification_status"),
            "score": rep["score"],
            "tier": rep["tier"],
            "badges": rep["badges"],
            "active_restrictions": [r["kind"] for r in rep["restrictions"]],
            "total_events": rep["total_events"],
        })
    if sort == "score_asc":
        rows.sort(key=lambda r: r["score"])
    elif sort == "score_desc":
        rows.sort(key=lambda r: -r["score"])
    return rows[:limit]


@api.get("/admin/reputation/dealer/{dealer_id}")
async def admin_reputation_detail(
    dealer_id: str,
    admin = Depends(require_permission("manage_reputation")),
):
    d = await db.dealers.find_one({"id": dealer_id})
    if not d:
        raise HTTPException(status_code=404, detail="Dealer not found")
    rep = await rep_svc.get_dealer_reputation(db, dealer_id)
    timeline = await rep_svc.get_reputation_timeline(db, dealer_id, limit=200)
    notes = await rep_svc.list_operator_notes(db, dealer_id)
    audit_trail = await rep_svc.list_audit_for_dealer(db, dealer_id, limit=100)
    return {
        "dealer": {
            "id": d["id"],
            "name": d.get("dealership_name") or d.get("name"),
            "phone": d.get("phone"),
            "approval_status": d.get("approval_status"),
            "verification_status": d.get("verification_status"),
            "max_bid_limit": d.get("max_bid_limit"),
            "kyc_completed": d.get("kyc_completed"),
            "created_at": (d.get("created_at").isoformat()
                           if isinstance(d.get("created_at"), datetime)
                           else d.get("created_at")),
        },
        "reputation": rep,
        "timeline": timeline,
        "operator_notes": notes,
        "operator_audit": audit_trail,
    }


# ── Reputation: operator mutations ──────────────────────────────────
@api.post("/admin/reputation/dealer/{dealer_id}/adjust")
async def admin_reputation_adjust(
    dealer_id: str,
    req: OperatorScoreAdjustReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    await rep_svc.record_signal(
        db, dealer_id=dealer_id,
        signal_kind="operator_score_adjustment",
        value=float(req.delta),
        weight_override=float(req.delta),
        source="operator", actor_id=admin["id"], note=req.reason,
    )
    await rep_svc.record_operator_action(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        action="score_adjust", reason=req.reason,
        payload={"delta": req.delta},
    )
    return await rep_svc.get_dealer_reputation(db, dealer_id)


@api.post("/admin/reputation/dealer/{dealer_id}/suspend")
async def admin_reputation_suspend(
    dealer_id: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    expires_at = None
    if req.duration_hours:
        expires_at = now_utc() + timedelta(hours=req.duration_hours)
    await rep_svc.apply_restriction(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        kind="suspended", reason=req.reason, expires_at=expires_at,
    )
    # Also bump token version so any active session is invalidated.
    await bump_token_version(dealer_id, "suspension", actor_id=admin["id"])
    return {"ok": True, "suspended_until": expires_at.isoformat() if expires_at else None}


@api.post("/admin/reputation/dealer/{dealer_id}/cooldown")
async def admin_reputation_cooldown(
    dealer_id: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    hours = req.duration_hours or 24
    expires_at = now_utc() + timedelta(hours=hours)
    await rep_svc.apply_restriction(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        kind="bidding_cooldown", reason=req.reason, expires_at=expires_at,
    )
    return {"ok": True, "cooldown_until": expires_at.isoformat()}


@api.post("/admin/reputation/dealer/{dealer_id}/shadow-restrict")
async def admin_reputation_shadow(
    dealer_id: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    expires_at = None
    if req.duration_hours:
        expires_at = now_utc() + timedelta(hours=req.duration_hours)
    await rep_svc.apply_restriction(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        kind="shadow_restricted", reason=req.reason, expires_at=expires_at,
    )
    return {"ok": True, "expires_at": expires_at.isoformat() if expires_at else None}


@api.post("/admin/reputation/dealer/{dealer_id}/force-kyc-review")
async def admin_reputation_force_kyc(
    dealer_id: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    await rep_svc.apply_restriction(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        kind="kyc_review", reason=req.reason,
    )
    await rep_svc.record_signal(
        db, dealer_id=dealer_id, signal_kind="forced_kyc_review",
        source="operator", actor_id=admin["id"], note=req.reason,
    )
    return {"ok": True}


@api.post("/admin/reputation/dealer/{dealer_id}/flag")
async def admin_reputation_flag(
    dealer_id: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    await rep_svc.record_signal(
        db, dealer_id=dealer_id, signal_kind="operator_flag",
        source="operator", actor_id=admin["id"], note=req.reason,
    )
    await rep_svc.record_operator_action(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        action="operator_flag", reason=req.reason,
    )
    return await rep_svc.get_dealer_reputation(db, dealer_id)


@api.post("/admin/reputation/dealer/{dealer_id}/lift/{kind}")
async def admin_reputation_lift(
    dealer_id: str, kind: str,
    req: OperatorRestrictionReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if kind not in rep_svc.RESTRICTION_KINDS:
        raise HTTPException(status_code=400, detail=f"Unknown restriction: {kind}")
    res = await rep_svc.lift_restriction(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        kind=kind, reason=req.reason,
    )
    if not res:
        raise HTTPException(status_code=404, detail="No active restriction of that kind")
    return {"ok": True}


@api.post("/admin/reputation/dealer/{dealer_id}/notes")
async def admin_reputation_add_note(
    dealer_id: str,
    req: OperatorNoteReq,
    admin = Depends(require_permission("manage_reputation")),
):
    if not await db.dealers.find_one({"id": dealer_id}):
        raise HTTPException(status_code=404, detail="Dealer not found")
    return await rep_svc.add_operator_note(
        db, actor_id=admin["id"], target_dealer_id=dealer_id,
        note=req.note, visibility=req.visibility,
    )


# ═════════════════════════════════════════════════════════════════════
# DISPUTE SYSTEM
# ═════════════════════════════════════════════════════════════════════

@api.get("/disputes/types")
async def dispute_types(_dealer = Depends(get_current_dealer)):
    """Catalog of dispute types + descriptions for the raise-form UI."""
    return [
        {"key": k, **{kk: v for kk, v in v.items() if kk != "priority_base"}}
        for k, v in disp_svc.DISPUTE_TYPES.items()
    ]


@api.post("/disputes")
async def raise_dispute(
    req: RaiseDisputeReq,
    dealer = Depends(require_approved_dealer),
):
    if req.dispute_type not in disp_svc.DISPUTE_TYPES:
        raise HTTPException(status_code=400, detail="Unknown dispute_type")
    # Resolve counterparty automatically when auction is given but
    # against_dealer_id was not supplied
    against = req.against_dealer_id
    if req.auction_id and not against:
        a = await db.auctions.find_one({"id": req.auction_id})
        if a:
            seller = a.get("seller_id")
            winner = a.get("winning_bidder_id") or a.get("highest_bidder_id")
            if dealer["id"] == seller:
                against = winner
            elif dealer["id"] == winner:
                against = seller
    try:
        return await disp_svc.raise_dispute(
            db, raiser_dealer_id=dealer["id"], against_dealer_id=against,
            auction_id=req.auction_id, dispute_type=req.dispute_type,
            title=req.title, description=req.description,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.get("/disputes/me")
async def disputes_for_me(dealer = Depends(get_current_dealer)):
    return await disp_svc.list_disputes_for_dealer(db, dealer["id"])


@api.get("/disputes/{dispute_id}")
async def get_dispute_view(
    dispute_id: str,
    dealer = Depends(get_current_dealer),
):
    d = await disp_svc.get_dispute(db, dispute_id)
    if not d:
        raise HTTPException(status_code=404, detail="Dispute not found")
    is_party = dealer["id"] in (d.get("raiser_dealer_id"), d.get("against_dealer_id"))
    is_operator = has_permission(dealer, "resolve_disputes")
    if not (is_party or is_operator):
        raise HTTPException(status_code=403, detail="Access denied")
    d["evidence"] = await disp_svc.get_dispute_evidence(db, dispute_id, include_content=False)
    d["messages"] = await disp_svc.get_dispute_messages(db, dispute_id)
    if is_operator:
        d["audit"] = await disp_svc.get_dispute_audit(db, dispute_id)
    return d


@api.get("/disputes/{dispute_id}/evidence/{evidence_id}")
async def get_dispute_evidence_content(
    dispute_id: str, evidence_id: str,
    dealer = Depends(get_current_dealer),
):
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise HTTPException(status_code=404, detail="Dispute not found")
    is_party = dealer["id"] in (d.get("raiser_dealer_id"), d.get("against_dealer_id"))
    is_operator = has_permission(dealer, "resolve_disputes")
    if not (is_party or is_operator):
        raise HTTPException(status_code=403, detail="Access denied")
    e = await db.dispute_evidence.find_one({"id": evidence_id, "dispute_id": dispute_id})
    if not e:
        raise HTTPException(status_code=404, detail="Evidence not found")
    return {
        "id": e["id"],
        "kind": e["kind"],
        "filename": e.get("filename"),
        "mime_type": e.get("mime_type"),
        "content_base64": e.get("content_base64"),
        "note": e.get("note"),
        "ts": e["ts"].isoformat() if isinstance(e.get("ts"), datetime) else e.get("ts"),
    }


@api.post("/disputes/{dispute_id}/evidence")
async def post_dispute_evidence(
    dispute_id: str,
    req: DisputeEvidenceReq,
    dealer = Depends(get_current_dealer),
):
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise HTTPException(status_code=404, detail="Dispute not found")
    is_party = dealer["id"] in (d.get("raiser_dealer_id"), d.get("against_dealer_id"))
    is_operator = has_permission(dealer, "resolve_disputes")
    if not (is_party or is_operator):
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        ev = await disp_svc.add_evidence(
            db, dispute_id=dispute_id, actor_id=dealer["id"], kind=req.kind,
            filename=req.filename, content_base64=req.content_base64,
            mime_type=req.mime_type, note=req.note,
        )
        return ev
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/disputes/{dispute_id}/messages")
async def post_dispute_message(
    dispute_id: str,
    req: DisputeMessageReq,
    dealer = Depends(get_current_dealer),
):
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise HTTPException(status_code=404, detail="Dispute not found")
    role = None
    if dealer["id"] == d.get("raiser_dealer_id"):
        role = "raiser"
    elif dealer["id"] == d.get("against_dealer_id"):
        role = "counterparty"
    elif has_permission(dealer, "resolve_disputes"):
        role = "operator"
    if not role:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        return await disp_svc.add_message(
            db, dispute_id=dispute_id, actor_id=dealer["id"],
            actor_role=role, body=req.body,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/disputes/{dispute_id}/withdraw")
async def withdraw_dispute(
    dispute_id: str,
    req: WithdrawDisputeReq,
    dealer = Depends(get_current_dealer),
):
    try:
        return await disp_svc.raiser_withdraw(
            db, dispute_id=dispute_id, actor_id=dealer["id"], reason=req.reason,
        )
    except (ValueError, PermissionError) as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Operator dispute endpoints ──────────────────────────────────────
@api.get("/admin/disputes/queue")
async def admin_dispute_queue(
    state: Optional[str] = None,
    dispute_type: Optional[str] = None,
    only_open: bool = True,
    limit: int = 200,
    admin = Depends(require_permission("resolve_disputes")),
):
    items = await disp_svc.operator_queue(
        db, state=state, dispute_type=dispute_type,
        only_open=only_open, limit=limit,
    )
    # Inline reputation summary for raiser + against (mobile-first density)
    for d in items:
        if d.get("raiser_dealer_id"):
            d["raiser_reputation"] = await rep_svc.reputation_summary(db, d["raiser_dealer_id"])
        if d.get("against_dealer_id"):
            d["against_reputation"] = await rep_svc.reputation_summary(db, d["against_dealer_id"])
    return items


@api.get("/admin/disputes/summary")
async def admin_dispute_summary(
    admin = Depends(require_permission("resolve_disputes")),
):
    return await disp_svc.operator_queue_summary(db)


@api.post("/admin/disputes/{dispute_id}/take-review")
async def admin_dispute_take_review(
    dispute_id: str,
    admin = Depends(require_permission("resolve_disputes")),
):
    try:
        return await disp_svc.operator_take_review(
            db, dispute_id=dispute_id, actor_id=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/admin/disputes/{dispute_id}/request-evidence")
async def admin_dispute_request_evidence(
    dispute_id: str,
    req: DisputeRequestEvidenceReq,
    admin = Depends(require_permission("resolve_disputes")),
):
    try:
        return await disp_svc.operator_request_evidence(
            db, dispute_id=dispute_id, actor_id=admin["id"], request=req.request,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/admin/disputes/{dispute_id}/escalate")
async def admin_dispute_escalate(
    dispute_id: str,
    req: DisputeEscalateReq,
    admin = Depends(require_permission("resolve_disputes")),
):
    try:
        return await disp_svc.operator_escalate(
            db, dispute_id=dispute_id, actor_id=admin["id"], reason=req.reason,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/admin/disputes/{dispute_id}/decide")
async def admin_dispute_decide(
    dispute_id: str,
    req: DisputeDecideReq,
    admin = Depends(require_permission("resolve_disputes")),
):
    if req.outcome not in disp_svc.DECISION_OUTCOMES:
        raise HTTPException(status_code=400, detail="Invalid outcome")
    try:
        dispute_doc, rep_effect = await disp_svc.operator_decide(
            db, dispute_id=dispute_id, actor_id=admin["id"],
            outcome=req.outcome, reason=req.reason,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Apply reputation hooks
    if rep_effect.get("loser_dealer_id"):
        await rep_svc.on_dispute_resolved(
            db,
            against_dealer_id=rep_effect["loser_dealer_id"],
            in_favour_dealer_id=rep_effect.get("winner_dealer_id"),
            dispute_id=dispute_id,
            frivolous_raiser_id=None,
        )
    elif rep_effect.get("frivolous_raiser_id"):
        await rep_svc.record_signal(
            db, dealer_id=rep_effect["frivolous_raiser_id"],
            signal_kind="dispute_raised_frivolous",
            ref_id=dispute_id, ref_type="dispute",
            source="operator", actor_id=admin["id"], note=req.reason,
        )
    return dispute_doc


# =====================================================================
# Settlement & Deal Completion (16-state, operator-controlled)
# =====================================================================
class SettlementTransitionReq(BaseModel):
    action: str
    payload: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None


class SettlementNoteReq(BaseModel):
    text: str


class SettlementMessageReq(BaseModel):
    text: str


class SettlementProofReq(BaseModel):
    kind: str = "image"   # "image" | "document" | "note" | "utr"
    filename: Optional[str] = None
    mime_type: Optional[str] = None
    content_base64: Optional[str] = None
    note: Optional[str] = None


@api.get("/settlements/states")
async def settlement_states_catalog():
    """Public catalog of states + transitions for the UI to render
    contextual help. No auth required."""
    return {
        "states": list(sett_svc.STATES),
        "terminal_states": list(sett_svc.TERMINAL_STATES),
        "annotation_states": list(sett_svc.ANNOTATION_STATES),
        "transitions": {
            k: {
                "from": list(v["from"]),
                "to": v["to"],
                "operator_only": v["operator_only"],
            } for k, v in sett_svc.TRANSITIONS.items()
        },
        "dealer_allowed_actions": list(sett_svc.DEALER_ALLOWED_ACTIONS),
    }


# ---- Dealer-facing ---------------------------------------------------
@api.get("/settlements/me")
async def settlements_for_me(dealer = Depends(get_current_dealer)):
    return await sett_svc.list_for_dealer(db, dealer["id"])


@api.get("/settlements/{settlement_id}")
async def settlement_detail(settlement_id: str, dealer = Depends(get_current_dealer)):
    is_operator = has_permission(dealer, "manage_reputation") or has_permission(dealer, "resolve_disputes") or (dealer.get("role") in ("super_admin", "admin", "operations_admin"))
    if is_operator:
        out = await sett_svc.get_operator_view(db, settlement_id)
    else:
        out = await sett_svc.get_dealer_view(db, settlement_id, dealer["id"])
    if not out:
        raise HTTPException(status_code=404, detail="Settlement not found")
    return out


@api.post("/settlements/{settlement_id}/mark-payment-sent")
async def settlement_mark_payment_sent(
    settlement_id: str,
    req: SettlementProofReq,
    dealer = Depends(get_current_dealer),
):
    """Dealer uploads proof that they have sent the deposit. This is the
    ONLY dealer-driven transition. Operator must verify before any
    further progression."""
    try:
        return await sett_svc.transition(
            db, settlement_id=settlement_id, action="mark_payment_sent",
            actor_id=dealer["id"], actor_is_operator=False,
            payload=req.dict(), reason="dealer uploaded payment proof",
        )
    except sett_svc.TransitionError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.get("/settlements/{settlement_id}/proof")
async def settlement_get_own_proof(
    settlement_id: str, dealer = Depends(get_current_dealer),
):
    p = await sett_svc.get_dealer_proof_content(db, settlement_id, dealer["id"])
    if not p:
        raise HTTPException(status_code=404, detail="No proof on file")
    return p


# ---- Operator-facing -------------------------------------------------
def _require_settlement_operator(admin_user):
    """Settlements need ops/super-admin authority. Inspection admins
    cannot move payment states, but they CAN mark visit/inspection done.
    For MVP we gate everything to ops + admin + super_admin."""
    role = (admin_user.get("role") or "")
    if role not in ("super_admin", "admin", "operations_admin"):
        raise HTTPException(status_code=403, detail="Operator authority required")
    return admin_user


@api.get("/admin/settlements/queue")
async def admin_settlements_queue(
    state: Optional[str] = None,
    limit: int = 200,
    admin = Depends(get_current_admin),
):
    _require_settlement_operator(admin)
    return await sett_svc.operator_queue(db, state=state, limit=limit)


@api.get("/admin/settlements/summary")
async def admin_settlements_summary(admin = Depends(get_current_admin)):
    _require_settlement_operator(admin)
    counts = await sett_svc.operator_queue_summary(db)
    # Group into the buckets the operator dashboard cares about
    buckets = {
        "deposit_pending":      counts.get("awaiting_operator_review", 0) + counts.get("deposit_requested", 0),
        "deposit_submitted":    counts.get("deposit_under_verification", 0),
        "visit_scheduled":      counts.get("visit_scheduled", 0),
        "inspection_completed": counts.get("inspection_completed", 0),
        "payment_pending":      counts.get("full_payment_requested", 0),
        "refund_pending":       counts.get("refund_approved", 0),
        "delayed":              counts.get("settlement_delayed", 0) + counts.get("no_show_review", 0) + counts.get("dispute", 0),
        "completed":            counts.get("completed", 0) + counts.get("refund_completed", 0),
    }
    return {
        "by_state": counts,
        "buckets": buckets,
        "total_open": sum(v for k, v in counts.items() if k not in sett_svc.TERMINAL_STATES),
    }


@api.get("/admin/settlements/{settlement_id}")
async def admin_settlement_detail(
    settlement_id: str, admin = Depends(get_current_admin),
):
    _require_settlement_operator(admin)
    out = await sett_svc.get_operator_view(db, settlement_id)
    if not out:
        raise HTTPException(status_code=404, detail="Settlement not found")
    return out


@api.post("/admin/settlements/{settlement_id}/transition")
async def admin_settlement_state_transition(
    settlement_id: str,
    req: SettlementTransitionReq,
    admin = Depends(get_current_admin),
):
    """Generic operator-driven state transition. The action key drives
    target state + side-effects. EVERY transition is appended to the
    settlement_audit ledger."""
    _require_settlement_operator(admin)
    try:
        result = await sett_svc.transition(
            db, settlement_id=settlement_id, action=req.action,
            actor_id=admin["id"], actor_is_operator=True,
            payload=req.payload or {}, reason=req.reason,
        )
    except sett_svc.TransitionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # ---- Reputation hooks (system-recorded, deterministic) -----------
    try:
        if req.action == "complete_deal" and result.get("dealer_id"):
            await rep_svc.on_settlement_completed(
                db, dealer_id=result["dealer_id"],
                auction_id=result.get("auction_id"),
                amount=float(result.get("winning_amount") or 0),
            )
        elif req.action == "mark_delayed" and result.get("dealer_id"):
            await rep_svc.on_payment_delayed(
                db, dealer_id=result["dealer_id"],
                auction_id=result.get("auction_id"),
            )
        elif req.action == "flag_no_show" and result.get("dealer_id"):
            await rep_svc.on_cancellation_after_win(
                db, dealer_id=result["dealer_id"],
                auction_id=result.get("auction_id"),
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("settlement→reputation hook failed: %s", exc)

    asyncio.create_task(audit(db, "settlement_transition", admin["id"], settlement_id, {
        "action": req.action,
        "from": result.get("prior_state"),
        "to": result.get("state"),
        "reason": req.reason,
    }))
    # Notify dealer (best-effort)
    dealer_id = result.get("dealer_id")
    if dealer_id:
        try:
            label_map = {
                "deposit_requested":         ("Deposit requested", "Operator has requested the 5% refundable deposit. Tap to view instructions."),
                "deposit_verified":          ("Deposit verified", "Your deposit has been verified. Visit will be scheduled shortly."),
                "visit_scheduled":           ("Visit scheduled", "Your physical inspection visit is scheduled. Tap to view details."),
                "inspection_completed":      ("Inspection complete", "Inspection done. Operator will request next step."),
                "full_payment_requested":    ("Full payment requested", "Final payment instructions are now available."),
                "vehicle_delivered":         ("Vehicle handover", "Vehicle has been marked as delivered. Final settlement closing."),
                "completed":                 ("Deal complete", "Your purchase has been settled. Audit trail is live."),
                "refund_approved":           ("Refund approved", "Operator has approved the refund of your deposit."),
                "refund_completed":          ("Refund completed", "Your deposit has been refunded. See ledger for reference."),
                "settlement_delayed":        ("Settlement delayed", "Operator has flagged a delay. Tap to view note."),
                "no_show_review":            ("No-show review", "Operator has flagged a no-show. Please contact ops."),
                "dispute":                   ("Dispute opened", "A dispute has been opened on this settlement."),
            }
            tup = label_map.get(result.get("state"))
            if tup:
                title, body = tup
                asyncio.create_task(send_to_dealer(
                    db, dealer_id, title, body,
                    data={"type": "settlement_state", "settlement_id": settlement_id, "state": result.get("state")},
                ))
                await db.notifications.insert_one({
                    "id": str(uuid.uuid4()),
                    "dealer_id": dealer_id,
                    "type": "settlement_state",
                    "title": title, "body": body,
                    "settlement_id": settlement_id,
                    "auction_id": result.get("auction_id"),
                    "read": False, "created_at": now_utc(),
                })
        except Exception as exc:  # noqa: BLE001
            logger.warning("settlement notify failed: %s", exc)
    return result


@api.post("/admin/settlements/{settlement_id}/note")
async def admin_settlement_internal_note(
    settlement_id: str,
    req: SettlementNoteReq,
    admin = Depends(get_current_admin),
):
    """Append-only internal note (operators only)."""
    _require_settlement_operator(admin)
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="Note text required")
    try:
        return await sett_svc.add_internal_note(
            db, settlement_id=settlement_id, actor_id=admin["id"], text=req.text,
        )
    except sett_svc.TransitionError as e:
        raise HTTPException(status_code=404, detail=str(e))


@api.post("/admin/settlements/{settlement_id}/dealer-message")
async def admin_settlement_dealer_message(
    settlement_id: str,
    req: SettlementMessageReq,
    admin = Depends(get_current_admin),
):
    """Append-only dealer-visible message (visit address, payment instructions, etc.)"""
    _require_settlement_operator(admin)
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="Message text required")
    try:
        return await sett_svc.add_dealer_message(
            db, settlement_id=settlement_id, actor_id=admin["id"], text=req.text,
        )
    except sett_svc.TransitionError as e:
        raise HTTPException(status_code=404, detail=str(e))


@api.get("/admin/settlements/{settlement_id}/proof")
async def admin_settlement_get_proof(
    settlement_id: str, admin = Depends(get_current_admin),
):
    _require_settlement_operator(admin)
    p = await sett_svc.get_operator_proof_content(db, settlement_id)
    if not p:
        raise HTTPException(status_code=404, detail="No proof on file")
    return p


# =====================================================================
# Sellers — operator-controlled vehicle owner tracking
# =====================================================================
# Seller OTP is now driven by Firebase Phone Auth (same as dealers/operators).


def _create_seller_jwt(seller_id: str) -> str:
    """Issue a seller access token. Distinct `kind` ensures these tokens
    cannot be replayed against any dealer/operator endpoint."""
    payload = {
        "sub": seller_id,
        "kind": "seller_access",
        "exp": now_utc() + timedelta(hours=12),
        "iat": now_utc(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


async def get_current_seller(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        seller_id = payload["sub"]
        kind = payload.get("kind")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if kind != "seller_access":
        raise HTTPException(status_code=401, detail="Wrong token kind")
    seller = await db.sellers.find_one({"id": seller_id}, {"_id": 0})
    if not seller:
        raise HTTPException(status_code=401, detail="Seller not found")
    if seller.get("status") == "revoked":
        raise HTTPException(status_code=403, detail="Access revoked")
    return seller


# ---- Seller-side request models -------------------------------------
class SellerSendOtpReq(BaseModel):
    phone: str


class SellerVerifyOtpReq(BaseModel):
    phone: str
    firebase_id_token: Optional[str] = None
    otp: Optional[str] = None


# ---- Seller-side public auth ----------------------------------------
@api.post("/auth/seller/send-otp")
async def seller_send_otp(req: SellerSendOtpReq, request: Request):
    seller = await sellers_svc.find_seller_by_phone(db, req.phone)
    # Always 200 to avoid leaking which phones are sellers.
    # Apply same abuse-protection envelope used for dealers/operators.
    phone = (req.phone or "").strip()
    ip = _client_ip(request)
    ok, msg = check_send_rate(phone, ip=ip)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    ok, msg = check_send_cooldown(phone)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)
    if seller:
        try:
            await sellers_svc._audit(
                db, seller_id=seller["id"], action="otp_sent",
                actor_id=seller["id"], actor_role="system", meta={"channel": "firebase"},
            )
            if seller.get("status") == "pending":
                await db.sellers.update_one(
                    {"id": seller["id"]},
                    {"$set": {"status": "access_sent", "updated_at": sellers_svc.now_utc()}},
                )
        except Exception as exc:
            logger.warning("seller otp_sent audit failed: %s", exc)
    return {"ok": True, "provider": "firebase"}


@api.post("/auth/seller/verify-otp")
async def seller_verify_otp(req: SellerVerifyOtpReq, request: Request):
    seller = await sellers_svc.find_seller_by_phone(db, req.phone)
    if not seller:
        raise HTTPException(status_code=404, detail="No seller access on file. Contact Q Drives operations.")
    if seller.get("status") == "revoked":
        raise HTTPException(status_code=403, detail="Your access has been revoked.")
    # Adapt seller payload to the shared verifier shape and validate
    # the Firebase ID token (or DEV_BYPASS path). _resolve_otp_phone will
    # raise the appropriate HTTPException on any mismatch / expiry.
    bridged = VerifyOtpReq(
        phone=req.phone,
        firebase_id_token=req.firebase_id_token,
        otp=req.otp,
    )
    _resolve_otp_phone(bridged, request)
    await sellers_svc.mark_seller_login(db, seller_id=seller["id"], otp_method="firebase")
    return {
        "token": _create_seller_jwt(seller["id"]),
        "seller": await sellers_svc.get_seller_profile(db, seller_id=seller["id"]),
    }


@api.get("/seller/me")
async def seller_me(seller = Depends(get_current_seller)):
    return await sellers_svc.get_seller_profile(db, seller_id=seller["id"])


@api.get("/seller/vehicles")
async def seller_my_vehicles(seller = Depends(get_current_seller)):
    return await sellers_svc.list_my_vehicles(db, seller_id=seller["id"])


@api.get("/seller/vehicles/{vehicle_id}")
async def seller_vehicle_detail(
    vehicle_id: str, seller = Depends(get_current_seller),
):
    out = await sellers_svc.get_vehicle_for_seller(
        db, seller_id=seller["id"], vehicle_id=vehicle_id,
    )
    if not out:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return out


# ---- Operator-side request models -----------------------------------
class CreateSellerReq(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None


class LinkVehicleReq(BaseModel):
    car_id: Optional[str] = None
    registration_number: Optional[str] = None


class RevokeSellerReq(BaseModel):
    reason: Optional[str] = None


# ---- Operator-side seller console -----------------------------------
def _require_seller_operator(admin):
    role = (admin.get("role") or "")
    if role not in ("super_admin", "admin", "operations_admin"):
        raise HTTPException(status_code=403, detail="Operator authority required")
    return admin


@api.get("/admin/sellers")
async def admin_sellers_list(
    status: Optional[str] = None, limit: int = 200,
    admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    return await sellers_svc.operator_list_sellers(db, status=status, limit=limit)


@api.post("/admin/sellers")
async def admin_sellers_create(
    req: CreateSellerReq, admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    try:
        return await sellers_svc.operator_create_seller(
            db, name=req.name, phone=req.phone, email=req.email,
            operator_id=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.get("/admin/sellers/{seller_id}")
async def admin_seller_detail(
    seller_id: str, admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    out = await sellers_svc.operator_get_seller(db, seller_id=seller_id)
    if not out:
        raise HTTPException(status_code=404, detail="Seller not found")
    return out


@api.post("/admin/sellers/{seller_id}/link-vehicle")
async def admin_seller_link_vehicle(
    seller_id: str, req: LinkVehicleReq,
    admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    try:
        return await sellers_svc.operator_link_vehicle(
            db, seller_id=seller_id,
            car_id=req.car_id,
            registration_number=req.registration_number,
            operator_id=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@api.get("/admin/sellers/lookup-vehicle")
async def admin_sellers_lookup_vehicle(
    q: str, admin = Depends(get_current_admin),
):
    """Operator autocomplete: search vehicles by registration prefix."""
    _require_seller_operator(admin)
    return await sellers_svc.search_vehicle_by_registration(db, query=q, limit=8)


@api.post("/admin/sellers/{seller_id}/send-access")
async def admin_seller_send_access(
    seller_id: str, admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    try:
        return await sellers_svc.operator_send_access(
            db, seller_id=seller_id, operator_id=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@api.post("/admin/sellers/{seller_id}/revoke")
async def admin_seller_revoke(
    seller_id: str, req: RevokeSellerReq,
    admin = Depends(get_current_admin),
):
    _require_seller_operator(admin)
    try:
        return await sellers_svc.operator_revoke(
            db, seller_id=seller_id, operator_id=admin["id"], reason=req.reason,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# =====================================================================
# Operator → Dealer Broadcasts (auction lifecycle notifications)
#
# The full implementation lives in routes/admin_broadcasts.py — kept
# modular because this surface will keep growing (segmented targeting,
# auto-trigger event listeners, delivery telemetry, etc.) and we want
# to avoid bloating server.py further.
# =====================================================================
from routes import admin_broadcasts as _admin_broadcasts_routes  # noqa: E402

_admin_broadcasts_routes.register(api, {
    "db": db,
    "get_current_admin": get_current_admin,
    "send_to_dealers": send_to_dealers,
    "audit": audit,
    "now_utc": now_utc,
    "iso": iso,
    "logger": logger,
})

# Silent broadcast funnel tracking — append-only events ledger.
# Routes: POST /notifications/{id}/open, POST /auctions/{id}/track-view
from routes import broadcast_tracking as _broadcast_tracking_routes  # noqa: E402

_broadcast_tracking_routes.register(api, {
    "db": db,
    "get_current_dealer": get_current_dealer,
    "now_utc": now_utc,
    "logger": logger,
})


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
            # Seeder fleet — pre-graded by Q Drives operations. Real
            # inspection scores per car are entered by the operator
            # during draft creation; for the bootstrap catalog we use
            # explicit per-vehicle data so bidders never see randomised
            # inspection values.
            "inspection_score": c.get("inspection_score"),
            "condition_grade":  c.get("condition_grade"),
            "tyre_condition":   c.get("tyre_condition"),
            "accident_history": c.get("accident_history"),
            "service_history":  c.get("service_history"),
            # NOTE: do NOT hardcode a fallback like "Authorised Service"
            # here — that's the exact mock-data class the P0 trust fix
            # removed. Seed catalog provides explicit per-car values if
            # operations wants demo cars graded; otherwise None flows
            # through to the renderer which shows "Not specified".
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
            # Phase 2C: explicit lifecycle state. Without this the doc gets
            # auto-archived by the legacy_cleanup migration on the next
            # restart. Demo seed data is also tagged so it can be filtered
            # out of production-only views (data isolation directive).
            "status": "live",
            "status_changed_at": now,
            "status_changed_by": "system_seed",
            "data_class": "demo_seed_data",
            "legacy_seed": False,  # opt-out of legacy_cleanup_phase2c
            "hidden_from_marketplace": False,
            "hidden_from_live_ops": False,
            "hidden_from_settlement": False,
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
    # Realtime / bid reliability indexes
    # Compound unique index ensures retry of the same idempotency_key
    # by the same dealer collapses to one row. TTL 24h keeps the
    # collection bounded under sustained traffic.
    try:
        await db.bid_idempotency.create_index(
            [("key", 1), ("dealer_id", 1)], unique=True,
        )
        await db.bid_idempotency.create_index("ts", expireAfterSeconds=60 * 60 * 24)
        await db.bids.create_index([("auction_id", 1), ("seq", 1)])
    except Exception as exc:
        logger.warning("bid_idempotency index init: %s", exc)
    await seed_data()
    await seed_allow_lists()
    # ── P0 trust safeguard ────────────────────────────────────────────
    # One-time / idempotent cleanup of synth-generated inspection fields
    # left behind by an earlier random.choice() seeder. We detect synth
    # artifacts by their exact token signature — operator-created cars
    # via the new code path can NEVER produce these tokens (grade ladder
    # is locked to A/B/C/D, accident_history is free text or null,
    # service_history is null at create time). Safe to re-run on every
    # boot; once the DB is clean this matches 0 documents.
    try:
        # Match only on UNAMBIGUOUS synth markers — strings the old
        # random.choice seeder produced that no operator would ever
        # type verbatim. The previous filter included "Excellent"
        # /"Fair"/"Poor" which are perfectly valid operator tyre
        # conditions, and wiped legitimate inspection data on every
        # boot. Now restricted to: the parenthetical "Minor
        # (Repaired)" accident token, the specific "None Reported"
        # capitalization, the duplicate-key "Authorised Service"
        # service token, and the off-ladder "B+"/"C+" grades. These
        # four are pure synth fingerprints with zero false-positive
        # risk against operator-entered data.
        synth_filter = {"$or": [
            {"accident_history": {"$in": ["None Reported", "Minor (Repaired)"]}},
            {"service_history":  {"$in": ["Authorised Service"]}},
            {"condition_grade":  {"$in": ["B+", "C+"]}},
        ]}
        res = await db.cars.update_many(synth_filter, {"$set": {
            "inspection_score": None,
            "condition_grade":  None,
            "tyre_condition":   None,
            "accident_history": None,
            "service_history":  None,
            "liquidity_rating": None,
        }})
        if res.modified_count:
            logger.warning("[startup] purged synth inspection data from %d cars", res.modified_count)
    except Exception as exc:
        logger.warning("[startup] synth inspection purge failed: %s", exc)

    # ── Inspection history indexes ────────────────────────────────────
    try:
        await db.inspection_history.create_index([("car_id", 1), ("timestamp", -1)])
        await db.inspection_history.create_index([("timestamp", -1)])
    except Exception as exc:
        logger.warning("inspection_history index init failed: %s", exc)

    # ── Legacy listing backfill (single source of truth) ──────────────
    # Any car that has flat inspection_score / condition_grade /
    # accident_history baked in BUT no canonical db.inspections record
    # gets one synthesised here. The backfill is read-mostly: we never
    # overwrite an existing inspection doc, and we never invent values
    # that weren't already on the car. Idempotent — after first sweep,
    # subsequent boots match zero documents.
    try:
        backfilled = 0
        async for c in db.cars.find({
            "$or": [
                {"inspection_score": {"$ne": None, "$exists": True}},
                {"condition_grade":  {"$ne": None, "$exists": True}},
                {"accident_history": {"$ne": None, "$exists": True}},
            ]
        }, {"_id": 0, "id": 1, "inspection_score": 1, "condition_grade": 1,
            "tyre_condition": 1, "accident_history": 1, "service_history": 1,
            "liquidity_rating": 1}):
            cid = c.get("id")
            if not cid:
                continue
            existing = await db.inspections.find_one({"car_id": cid}, {"_id": 0, "id": 1})
            if existing:
                continue  # never overwrite an authentic inspection record
            score_val = c.get("inspection_score")
            seed_sections = {k: {"completed": False} for k in INSPECTION_SECTION_KEYS}
            if isinstance(score_val, (int, float)) and score_val and score_val > 0:
                seed_sections["exterior"] = {"completed": True, "score": float(score_val)}
            derived = _aggregate_inspection(seed_sections)
            now = now_utc()
            insp_doc = {
                "id":             str(uuid.uuid4()),
                "car_id":         cid,
                "sections":       seed_sections,
                "accident_history": c.get("accident_history"),
                "tyre_condition":   c.get("tyre_condition"),
                "service_history":  c.get("service_history"),
                "inspection_score": score_val if score_val is not None else derived["inspection_score"],
                "condition_grade":  c.get("condition_grade") or derived["condition_grade"],
                "liquidity_rating": c.get("liquidity_rating") or derived["liquidity_rating"],
                "completion_percentage": derived["completion_percentage"],
                "sections_completed":    derived["sections_completed"],
                "pdf":           None,
                "version":       1,
                "updated_by":    "Legacy migration",
                "updated_by_id": "system",
                "uploader_id":   "system",
                "uploader_name": "Legacy migration",
                "created_at":    now,
                "updated_at":    now,
            }
            try:
                await db.inspections.insert_one(insp_doc)
                backfilled += 1
            except Exception as ex:
                # Insert failure is non-fatal — the legacy flat fields
                # are still rendered via the mirror, so bidders still
                # see consistent data; only the audit-trail richness
                # is lost for that one car.
                logger.warning("[startup.backfill] insert failed for car=%s: %s", cid, ex)
        if backfilled:
            logger.warning("[startup] legacy inspection backfill: synthesised %d records", backfilled)
    except Exception as exc:
        logger.warning("[startup] legacy backfill failed: %s", exc)

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

    # Migration: backfill `status` on existing dealer docs (one-shot per
    # boot, idempotent). Heuristic: not-suspended → 'approved' (legacy
    # dealers were implicitly approved under the closed-network gate);
    # suspended → 'suspended'. Dealers without a status field at all are
    # the targets — touched once and then skipped on subsequent boots.
    legacy_active = await db.dealers.update_many(
        {"role": "dealer", "status": {"$exists": False}, "suspended": {"$ne": True}},
        {"$set": {
            "status": "approved",
            "approved_at": now_utc(),
            "approved_by": "system_backfill",
            "previous_status": None,
        }},
    )
    legacy_suspended = await db.dealers.update_many(
        {"role": "dealer", "status": {"$exists": False}, "suspended": True},
        {"$set": {"status": "suspended", "previous_status": None}},
    )
    if legacy_active.modified_count or legacy_suspended.modified_count:
        logger.info(
            "[migration] dealer.status backfill — approved=%s suspended=%s",
            legacy_active.modified_count, legacy_suspended.modified_count,
        )

    # CRITICAL one-shot cleanup — older builds erroneously fired a
    # "Verification approved" notification on /auth/kyc submission for any
    # dealer (regardless of operator approval). Purge those misleading
    # entries from notifications collection for any dealer who is NOT
    # currently approved. Approved dealers keep their notification (it's
    # historically correct for them). Re-running is idempotent.
    pending_or_restricted_ids = []
    async for d in db.dealers.find(
        {"role": "dealer", "status": {"$in": ["pending", "suspended", "revoked"]}},
        {"id": 1, "_id": 0},
    ):
        pending_or_restricted_ids.append(d["id"])
    if pending_or_restricted_ids:
        purged = await db.notifications.delete_many({
            "dealer_id": {"$in": pending_or_restricted_ids},
            "type": "verification",
            "title": {"$in": [
                "Verification approved", "Dealer status verified",
                "Account approved",
            ]},
        })
        if purged.deleted_count:
            logger.info(
                "[migration] purged false approval notifications for non-approved dealers: %s",
                purged.deleted_count,
            )

    # ============================================================
    # Phase 2C cleanup — Ghost / orphaned inventory migration.
    #   Identifies legacy auctions with no valid seller, no live linkage,
    #   or pre-lifecycle-version seed data and moves them to
    #   status='archived' + hidden flags. Audit-permanent. Idempotent.
    # ============================================================
    # Phase 2C ghost-inventory cleanup. Two ghost classes:
    #   (a) Truly orphaned: seller_id missing or doesn't resolve to any
    #       operator/dealer record.
    #   (b) Pre-lifecycle seed: status field never set (status=null) — these
    #       are bulk-seeded test units that predate the lifecycle system and
    #       leak into Live Ops via the legacy time-window fallback. They
    #       have no traceable lifecycle history and create fake liquidity.
    legacy_query = {
        "migration_tag": {"$ne": "legacy_cleanup_phase2c"},  # idempotent
        "status": {"$nin": ["archived", "withdrawn"]},
        "$or": [
            {"seller_id": {"$exists": False}},
            {"seller_id": None},
            {"legacy_seed": True},
            # Pre-lifecycle ghosts: the seed pipeline never assigned a
            # status — the new lifecycle system explicitly sets one on
            # creation. Anything left as null is legacy-by-definition.
            {"status": None},
            {"status": {"$exists": False}},
        ],
    }
    archived_ids: List[str] = []
    async for a in db.auctions.find(legacy_query, {"id": 1, "_id": 0, "status": 1, "seller_id": 1}):
        archived_ids.append(a["id"])
    if archived_ids:
        result = await db.auctions.update_many(
            {"id": {"$in": archived_ids}},
            {"$set": {
                "previous_status_before_archive": None,
                "status": "archived",
                "archived_at": now_utc(),
                "archived_by": "system_migration",
                "hidden_from_marketplace": True,
                "hidden_from_live_ops": True,
                "hidden_from_settlement": True,
                "migration_tag": "legacy_cleanup_phase2c",
                "archive_note": "Auto-archived: orphaned/legacy inventory (no valid seller or pre-lifecycle seed)",
                "status_changed_at": now_utc(),
                "status_changed_by": "system_migration",
            }},
        )
        for aid in archived_ids:
            asyncio.create_task(audit(db, "inventory_archived", "system_migration", aid, {
                "role": "system",
                "reason": "legacy_cleanup_phase2c",
                "before_state": {"status": "legacy"},
                "after_state": {"status": "archived",
                                "hidden_from_marketplace": True,
                                "hidden_from_live_ops": True,
                                "hidden_from_settlement": True},
            }))
        logger.info("[migration] legacy_cleanup_phase2c — archived %s ghost auctions: %s",
                    result.modified_count, archived_ids[:10])

    # Belt-and-braces: every previously-archived legacy ghost gets the
    # full set of hidden_from_* flags. This catches docs that pre-date the
    # hidden_from_settlement field. Idempotent.
    backfill_hidden = await db.auctions.update_many(
        {"migration_tag": "legacy_cleanup_phase2c",
         "$or": [
             {"hidden_from_settlement": {"$ne": True}},
             {"hidden_from_marketplace": {"$ne": True}},
             {"hidden_from_live_ops": {"$ne": True}},
         ]},
        {"$set": {
            "hidden_from_settlement": True,
            "hidden_from_marketplace": True,
            "hidden_from_live_ops": True,
        }},
    )
    if backfill_hidden.modified_count:
        logger.info("[migration] hidden_from_* backfill on legacy archives: %s",
                    backfill_hidden.modified_count)

    # ============================================================
    # Phase 2C — Dealer verification/approval state separation.
    # The new model decouples KYC verification from marketplace approval:
    #   verification_status ∈ {unverified, kyc_pending, verified, rejected}
    #   approval_status     ∈ {pending, approved, suspended, revoked}
    # Backfill from legacy fields without inventing trust:
    #   • If kyc_completed=True AND status=='approved' → verification_status=verified
    #     (operator-approved dealers with full KYC are honestly verified).
    #   • If kyc_completed=True AND status!='approved' → verification_status='kyc_pending'
    #     (KYC submitted but operator hasn't reviewed yet — never auto-verify).
    #   • Otherwise → verification_status='unverified'.
    # approval_status mirrors existing `status` field (canonical).
    # ============================================================
    backfill_verified = await db.dealers.update_many(
        {"role": "dealer", "verification_status": {"$exists": False},
         "kyc_completed": True, "status": "approved"},
        {"$set": {"verification_status": "verified",
                  "verified_at": now_utc(), "verified_by": "system_backfill"}},
    )
    backfill_kyc_pending = await db.dealers.update_many(
        {"role": "dealer", "verification_status": {"$exists": False},
         "kyc_completed": True, "status": {"$ne": "approved"}},
        {"$set": {"verification_status": "kyc_pending"}},
    )
    backfill_unverified = await db.dealers.update_many(
        {"role": "dealer", "verification_status": {"$exists": False}},
        {"$set": {"verification_status": "unverified"}},
    )
    if backfill_verified.modified_count or backfill_kyc_pending.modified_count or backfill_unverified.modified_count:
        logger.info("[migration] verification_status backfill — verified=%s kyc_pending=%s unverified=%s",
                    backfill_verified.modified_count, backfill_kyc_pending.modified_count, backfill_unverified.modified_count)


@app.on_event("shutdown")
async def on_shutdown():
    client.close()
