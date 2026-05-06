from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import jwt
import uuid
import json
import asyncio
import logging
import random
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, status, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket
from pydantic import BaseModel, Field

from push import send_to_dealer, send_to_dealers, is_valid_expo_token

# ---------- Setup ----------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
inspections_bucket = AsyncIOMotorGridFSBucket(db, bucket_name="inspections")

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGO = "HS256"
MOCK_OTP = "123456"

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


def create_jwt(dealer_id: str) -> str:
    payload = {
        "sub": dealer_id,
        "exp": now_utc() + timedelta(days=30),
        "iat": now_utc(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


async def get_current_dealer(creds: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Dict[str, Any]:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        dealer_id = payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0})
    if not dealer:
        raise HTTPException(status_code=401, detail="Dealer not found")
    return dealer


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


# ---------- WebSocket Manager ----------
class ConnectionManager:
    def __init__(self):
        self.rooms: Dict[str, List[WebSocket]] = {}

    async def connect(self, auction_id: str, ws: WebSocket):
        await ws.accept()
        self.rooms.setdefault(auction_id, []).append(ws)

    def disconnect(self, auction_id: str, ws: WebSocket):
        if auction_id in self.rooms and ws in self.rooms[auction_id]:
            self.rooms[auction_id].remove(ws)

    async def broadcast(self, auction_id: str, payload: dict):
        if auction_id not in self.rooms:
            return
        dead = []
        for ws in self.rooms[auction_id]:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.rooms[auction_id].remove(ws)

manager = ConnectionManager()


# ---------- Auth Endpoints ----------
@api.post("/auth/send-otp")
async def send_otp(req: SendOtpReq):
    phone = req.phone.strip()
    if len(phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    # Mocked OTP - in dev we return it for convenience
    return {"success": True, "message": "OTP sent", "dev_otp": MOCK_OTP}


@api.post("/auth/verify-otp")
async def verify_otp(req: VerifyOtpReq):
    phone = req.phone.strip()
    if req.otp != MOCK_OTP:
        raise HTTPException(status_code=400, detail="Invalid OTP. Use 123456 for dev.")

    dealer = await db.dealers.find_one({"phone": phone}, {"_id": 0})
    is_new = False
    if not dealer:
        is_new = True
        dealer = {
            "id": str(uuid.uuid4()),
            "phone": phone,
            "full_name": "",
            "dealership_name": "",
            "city": "",
            "gst_number": "",
            "pan_number": "",
            "kyc_completed": False,
            "verified": False,
            "trust_score": 4.5,
            "bid_success_rate": 0,
            "total_purchases": 0,
            "total_listed": 0,
            "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80",
            "created_at": now_utc(),
        }
        await db.dealers.insert_one(dict(dealer))
    token = create_jwt(dealer["id"])
    return {
        "token": token,
        "is_new": is_new,
        "dealer": serialize(dealer),
    }


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
    return serialize(updated)


# ---------- Auctions ----------
async def _enrich_auction(a: dict) -> dict:
    car = await db.cars.find_one({"id": a["car_id"]}, {"_id": 0}) or {}
    seller = await db.dealers.find_one({"id": a.get("seller_id")}, {"_id": 0}) or {}
    insp = await db.inspections.find_one({"car_id": a["car_id"]}, {"_id": 0})
    a = serialize(a)
    a["car"] = serialize(car) if car else None
    a["seller"] = {"id": seller.get("id"), "dealership_name": seller.get("dealership_name", ""), "city": seller.get("city", ""), "verified": seller.get("verified", False)} if seller else None
    a["inspection_pdf"] = serialize(insp) if insp else None
    # compute live state
    end = a.get("end_time")
    if isinstance(end, str):
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        end_dt = end
    now = now_utc()
    start = a.get("start_time")
    if isinstance(start, str):
        start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    else:
        start_dt = start
    if now < start_dt:
        a["status"] = "upcoming"
    elif now > end_dt:
        a["status"] = "ended"
    else:
        a["status"] = "live"
    a["seconds_remaining"] = max(0, int((end_dt - now).total_seconds()))
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

    bid = {
        "id": str(uuid.uuid4()),
        "auction_id": auction_id,
        "dealer_id": dealer["id"],
        "dealer_name": dealer.get("dealership_name") or dealer.get("full_name") or "Dealer",
        "amount": req.amount,
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
async def create_car(req: CarCreateReq, dealer = Depends(get_current_dealer)):
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
    dealer = Depends(get_current_dealer),
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

    # Validate associated car + ownership
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    if car.get("seller_id") != dealer["id"]:
        raise HTTPException(status_code=403, detail="Only the seller can attach an inspection PDF")

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
@app.websocket("/api/ws/auction/{auction_id}")
async def ws_auction(websocket: WebSocket, auction_id: str):
    await manager.connect(auction_id, websocket)
    try:
        # On connect, send latest snapshot
        a = await db.auctions.find_one({"id": auction_id}, {"_id": 0})
        if a:
            ea = await _enrich_auction(a)
            await websocket.send_json({"type": "snapshot", "auction": ea})
        while True:
            # keepalive: receive ping, ignore content
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
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
        manager.disconnect(auction_id, websocket)


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
    {"phone": "+919900000001", "full_name": "Rahul Mehta", "dealership_name": "Apex Premium Motors", "city": "Mumbai", "verified": True, "trust_score": 4.9, "bid_success_rate": 78.0, "total_purchases": 142, "total_listed": 38, "kyc_completed": True, "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000002", "full_name": "Arjun Singh", "dealership_name": "Royal Drives Co.", "city": "Delhi", "verified": True, "trust_score": 4.7, "bid_success_rate": 65.0, "total_purchases": 88, "total_listed": 22, "kyc_completed": True, "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000003", "full_name": "Vikram Patel", "dealership_name": "Velocity Wheels", "city": "Bangalore", "verified": True, "trust_score": 4.6, "bid_success_rate": 71.0, "total_purchases": 64, "total_listed": 19, "kyc_completed": True, "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000004", "full_name": "Karan Kapoor", "dealership_name": "Drive Republic", "city": "Pune", "verified": True, "trust_score": 4.5, "bid_success_rate": 58.0, "total_purchases": 41, "total_listed": 15, "kyc_completed": True, "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
    {"phone": "+919900000005", "full_name": "Sameer Joshi", "dealership_name": "Nexus AutoTrade", "city": "Hyderabad", "verified": True, "trust_score": 4.8, "bid_success_rate": 73.0, "total_purchases": 102, "total_listed": 27, "kyc_completed": True, "avatar_url": "https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80"},
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
        return
    logger.info("Seeding Q Drives demo data...")
    dealer_ids = []
    for d in SEED_DEALERS:
        doc = {
            "id": str(uuid.uuid4()),
            **d,
            "gst_number": "29ABCDE1234F1Z" + str(random.randint(0, 9)),
            "pan_number": "ABCDE" + str(random.randint(1000, 9999)) + "F",
            "created_at": now_utc(),
        }
        await db.dealers.insert_one(doc)
        dealer_ids.append(doc["id"])

    now = now_utc()
    for i, c in enumerate(CAR_CATALOG):
        car_id = str(uuid.uuid4())
        seller_id = random.choice(dealer_ids)
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
    await db.dealers.create_index("phone", unique=True)
    await db.cars.create_index("id", unique=True)
    await db.auctions.create_index("id", unique=True)
    await db.bids.create_index([("auction_id", 1), ("created_at", -1)])
    await db.inspections.create_index("car_id")
    await db.inspections.create_index("id", unique=True)
    await db.notifications.create_index([("dealer_id", 1), ("created_at", -1)])
    await db.push_tokens.create_index("token", unique=True)
    await seed_data()
    # background loops
    asyncio.create_task(auction_scheduler())


@app.on_event("shutdown")
async def on_shutdown():
    client.close()
