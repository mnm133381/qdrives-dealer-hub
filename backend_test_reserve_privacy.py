"""
P0 SECURITY TEST — Reserve-price privacy across all roles + transports.

Validates that the exact `reserve_price` is never leaked to bidders or
anonymous viewers. Operators and the SELLER OF A LISTING can still see
their own reserve. Tests run against the public ingress URL.

Pre-req: DEV_BYPASS_OTP=true in /app/backend/.env (caller restores
afterwards). Operator +918977986662 OTP 123456.
"""
import os
import sys
import json
import asyncio
import uuid
from typing import Any, Dict, List, Optional, Tuple

import requests
import websockets

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
WS_BASE = "wss://qdrives-dealer-hub.preview.emergentagent.com/api/ws/auction"

OPERATOR_PHONE = "+918977986662"
BUYER_PHONE = "+919900000001"   # Rahul / approved dealer
SELLER_PHONE = "+919900000002"  # Arjun / approved dealer  → we'll mint an auction with seller_id == this dealer.id


PASS: List[str] = []
FAIL: List[str] = []


def _record(ok: bool, label: str, detail: str = "") -> bool:
    if ok:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(f"{label} — {detail}")
        print(f"  FAIL  {label} — {detail}")
    return ok


# ─────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────
def login_dealer(phone: str) -> Optional[str]:
    r = requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": phone}, timeout=15)
    if r.status_code != 200:
        print(f"   ! dealer send-otp {phone} → {r.status_code} {r.text[:200]}")
        return None
    r = requests.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": phone, "otp": "123456"},
        timeout=15,
    )
    if r.status_code != 200:
        print(f"   ! dealer verify-otp {phone} → {r.status_code} {r.text[:200]}")
        return None
    return r.json()["token"]


def login_operator(phone: str) -> Optional[str]:
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=15)
    if r.status_code != 200:
        print(f"   ! operator send-otp {phone} → {r.status_code} {r.text[:200]}")
        return None
    r = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": phone, "otp": "123456"},
        timeout=15,
    )
    if r.status_code != 200:
        print(f"   ! operator verify-otp {phone} → {r.status_code} {r.text[:200]}")
        return None
    return r.json()["token"]


def H(token: Optional[str]) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


# ─────────────────────────────────────────────────────────────────────
# Recursive reserve_price scanner (§9)
# ─────────────────────────────────────────────────────────────────────
def find_reserve_keys(obj: Any, path: str = "") -> List[str]:
    """Return list of dotted paths where a key named EXACTLY
    'reserve_price' appears anywhere in the JSON tree."""
    hits: List[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            here = f"{path}.{k}" if path else k
            if k == "reserve_price":
                hits.append(here)
            hits.extend(find_reserve_keys(v, here))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits.extend(find_reserve_keys(v, f"{path}[{i}]"))
    return hits


def assert_no_reserve_leak(auction: Dict[str, Any], label: str) -> bool:
    ok = True
    if "reserve_price" in auction:
        _record(False, label, f"reserve_price key present in top-level")
        ok = False
    car = auction.get("car") or {}
    if isinstance(car, dict) and "reserve_price" in car:
        _record(False, label + " car", "car.reserve_price key present")
        ok = False
    if "has_reserve" not in auction:
        _record(False, label + " has_reserve", "has_reserve missing")
        ok = False
    else:
        hr = auction["has_reserve"]
        if not isinstance(hr, bool):
            _record(False, label + " has_reserve type", f"got {type(hr).__name__}")
            ok = False
    if "reserve_met" not in auction:
        _record(False, label + " reserve_met", "reserve_met missing")
        ok = False
    else:
        rm = auction["reserve_met"]
        hr = auction.get("has_reserve")
        if hr is False:
            # reserve_met must be None when no reserve
            if rm is not None:
                _record(False, label + " reserve_met=None when no reserve", f"got {rm!r}")
                ok = False
        else:
            if not isinstance(rm, bool):
                _record(False, label + " reserve_met type", f"got {type(rm).__name__}")
                ok = False
    return ok


# ─────────────────────────────────────────────────────────────────────
# Section runners
# ─────────────────────────────────────────────────────────────────────
def section1_anonymous(buyer_token: Optional[str] = None) -> Tuple[List[Dict], Optional[str]]:
    """§1 anonymous OR §2 buyer (same assertions). Returns auctions list + a sample id."""
    headers = H(buyer_token) if buyer_token else {}
    label_role = "buyer" if buyer_token else "anon"

    r = requests.get(f"{BASE}/auctions?limit=10", headers=headers, timeout=15)
    _record(r.status_code == 200, f"§1[{label_role}] GET /auctions 200", f"got {r.status_code}")
    auctions = r.json() if r.status_code == 200 else []

    per_listing_ok = True
    for a in auctions:
        ok = assert_no_reserve_leak(a, f"§1[{label_role}] list[{a.get('id','?')[:8]}]")
        per_listing_ok = per_listing_ok and ok
    if auctions:
        _record(per_listing_ok, f"§1[{label_role}] /auctions list — all entries clean ({len(auctions)} items)")

    # Multiple ids — live + ended
    live_ids = [a["id"] for a in auctions if a.get("status") == "live"][:3]
    ended_ids = []
    # Try fetching ended ones via status_filter
    r2 = requests.get(f"{BASE}/auctions?status_filter=ended&limit=5", headers=headers, timeout=15)
    if r2.status_code == 200:
        ended_ids = [a["id"] for a in r2.json()][:2]

    sample = None
    for aid in (live_ids + ended_ids):
        rd = requests.get(f"{BASE}/auctions/{aid}", headers=headers, timeout=15)
        if rd.status_code != 200:
            _record(False, f"§1[{label_role}] GET /auctions/{aid[:8]}", f"got {rd.status_code}")
            continue
        body = rd.json()
        ok = assert_no_reserve_leak(body, f"§1[{label_role}] detail[{aid[:8]}]")
        # recent_bids should also be free of reserve_price
        rb = body.get("recent_bids") or []
        for i, b in enumerate(rb):
            if "reserve_price" in b:
                ok = _record(False, f"§1[{label_role}] detail[{aid[:8]}].recent_bids[{i}].reserve_price", "leaked")
        _record(ok, f"§1[{label_role}] detail[{aid[:8]}] clean")
        if sample is None:
            sample = aid

    return auctions, sample


def section3_seller(seller_token: str, my_auction_id: str, other_auction_id: str):
    """§3 Seller: own auction → reserve visible. Someone else's → stripped."""
    # Own
    r = requests.get(f"{BASE}/auctions/{my_auction_id}", headers=H(seller_token), timeout=15)
    if r.status_code != 200:
        _record(False, "§3 seller GET own /auctions/{id}", f"{r.status_code} {r.text[:120]}")
        return
    body = r.json()
    _record(
        "reserve_price" in body and isinstance(body["reserve_price"], int) and body["reserve_price"] > 0,
        "§3 seller sees own reserve_price (int>0)",
        f"got {body.get('reserve_price')!r}",
    )
    _record("has_reserve" in body and "reserve_met" in body, "§3 seller still has has_reserve+reserve_met flags")

    # Other
    r2 = requests.get(f"{BASE}/auctions/{other_auction_id}", headers=H(seller_token), timeout=15)
    if r2.status_code != 200:
        _record(False, "§3 seller GET other /auctions/{id}", f"{r2.status_code}")
        return
    other = r2.json()
    _record("reserve_price" not in other, "§3 seller DOES NOT see other seller's reserve_price")
    _record("has_reserve" in other and "reserve_met" in other, "§3 seller has flags on other auction too")


def section4_operator(operator_token: str, any_auction_id: str):
    r = requests.get(f"{BASE}/auctions/{any_auction_id}", headers=H(operator_token), timeout=15)
    _record(r.status_code == 200, "§4 operator GET /auctions/{id} 200", f"got {r.status_code}")
    if r.status_code == 200:
        body = r.json()
        _record(
            "reserve_price" in body and isinstance(body["reserve_price"], int),
            "§4 operator sees reserve_price (int)",
            f"got {body.get('reserve_price')!r}",
        )

    r2 = requests.get(f"{BASE}/auctions?limit=10", headers=H(operator_token), timeout=15)
    _record(r2.status_code == 200, "§4 operator GET /auctions list 200")
    if r2.status_code == 200:
        all_have = all("reserve_price" in a for a in r2.json())
        _record(all_have, "§4 operator — every auction has reserve_price")


def section5_ws_snapshot(buyer_token: str, live_auction_id: str):
    """§5 WS snapshot frame must not contain reserve_price (twice — connect + reconnect)."""
    async def run():
        url = f"{WS_BASE}/{live_auction_id}?token={buyer_token}"
        for attempt in (1, 2):
            try:
                async with websockets.connect(url, open_timeout=10) as ws:
                    raw = await asyncio.wait_for(ws.recv(), timeout=10)
                    frame = json.loads(raw)
                    label = f"§5 WS snapshot attempt#{attempt}"
                    if frame.get("type") != "snapshot":
                        _record(False, label + " type=snapshot", f"got {frame.get('type')}")
                        continue
                    auc = frame.get("auction") or {}
                    ok = _record("reserve_price" not in auc, label + " auction.reserve_price ABSENT")
                    ok2 = _record(
                        "has_reserve" in auc and "reserve_met" in auc,
                        label + " auction.has_reserve+reserve_met present",
                    )
                    # also recursively scan
                    leaks = find_reserve_keys(frame)
                    _record(not leaks, label + " no reserve_price anywhere in frame", f"leaks={leaks}")
            except Exception as e:
                _record(False, f"§5 WS attempt#{attempt}", repr(e))
    asyncio.run(run())


def section6_ws_new_bid(buyer1_token: str, buyer2_token: str, live_auction_id: str):
    """Buyer2 subscribes via WS, buyer1 places a bid. new_bid frame must
    NOT contain reserve_price."""
    async def run():
        url = f"{WS_BASE}/{live_auction_id}?token={buyer2_token}"
        try:
            async with websockets.connect(url, open_timeout=10) as ws:
                # consume snapshot
                _ = await asyncio.wait_for(ws.recv(), timeout=10)
                # Fetch current bid to compute next bid
                rr = requests.get(f"{BASE}/auctions/{live_auction_id}", headers=H(buyer1_token), timeout=15)
                cur = (rr.json() or {}).get("current_bid", 0) if rr.status_code == 200 else 0
                next_amt = int(cur) + 5000
                # place bid as buyer1
                pb = requests.post(
                    f"{BASE}/auctions/{live_auction_id}/bid",
                    headers=H(buyer1_token),
                    json={"amount": next_amt},
                    timeout=15,
                )
                if pb.status_code != 200:
                    _record(False, "§6 buyer1 place_bid", f"{pb.status_code} {pb.text[:200]}")
                    return
                # Wait up to a few seconds for new_bid frame
                got = False
                for _ in range(10):
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    try:
                        f = json.loads(raw)
                    except Exception:
                        continue
                    if f.get("type") == "new_bid":
                        got = True
                        leaks = find_reserve_keys(f)
                        _record(not leaks, "§6 new_bid frame has NO reserve_price anywhere", f"leaks={leaks}")
                        break
                if not got:
                    _record(False, "§6 received new_bid frame", "timeout / not received")
        except Exception as e:
            _record(False, "§6 WS new_bid test", repr(e))
    asyncio.run(run())


def section7_reconnect_rest_snapshot(buyer_token: str, operator_token: str, auction_id: str):
    # Buyer
    r = requests.get(f"{BASE}/auctions/{auction_id}/snapshot", headers=H(buyer_token), timeout=15)
    if r.status_code != 200:
        _record(False, "§7 buyer /snapshot 200", f"{r.status_code} {r.text[:150]}")
    else:
        auc = (r.json() or {}).get("auction") or {}
        _record("reserve_price" not in auc, "§7 buyer /snapshot auction.reserve_price ABSENT")
        _record("has_reserve" in auc and "reserve_met" in auc, "§7 buyer /snapshot flags present")

    # Operator
    r2 = requests.get(f"{BASE}/auctions/{auction_id}/snapshot", headers=H(operator_token), timeout=15)
    if r2.status_code != 200:
        _record(False, "§7 operator /snapshot 200", f"{r2.status_code}")
    else:
        auc = (r2.json() or {}).get("auction") or {}
        _record("reserve_price" in auc and isinstance(auc["reserve_price"], int), "§7 operator /snapshot reserve_price PRESENT")


def section2_purchases(buyer_token: str):
    """§2 GET /api/purchases (review references /api/dealers/me/purchases
    but actual route is /api/purchases — both checked)."""
    paths = ["/purchases", "/dealers/me/purchases"]
    for p in paths:
        r = requests.get(f"{BASE}{p}", headers=H(buyer_token), timeout=15)
        if r.status_code == 404:
            continue
        if r.status_code != 200:
            _record(False, f"§2 GET {p}", f"{r.status_code} {r.text[:120]}")
            continue
        body = r.json() or {}
        won = body.get("won") or []
        active = body.get("active") or []
        all_items = won + active
        leak_total = 0
        flag_ok_total = 0
        for it in all_items:
            if "reserve_price" in it:
                leak_total += 1
            if "reserve_met" in it:
                flag_ok_total += 1
        _record(leak_total == 0, f"§2 {p} — no reserve_price in {len(all_items)} won/active items", f"leaks={leak_total}")
        if all_items:
            _record(flag_ok_total == len(all_items), f"§2 {p} — every entry has reserve_met flag")
        else:
            _record(True, f"§2 {p} — empty purchases (vacuously safe)")


def section8_regression_flags(operator_token: str):
    """Compute correctness: for chosen auctions, validate reserve_met logic.
    We use operator view to read reserve_price + current_bid, then check
    anonymous view's flag for that same auction."""
    r = requests.get(f"{BASE}/auctions?limit=20", headers=H(operator_token), timeout=15)
    if r.status_code != 200:
        _record(False, "§8 operator list", f"{r.status_code}")
        return
    ops_list = r.json() or []
    # Anonymous view of same list
    r2 = requests.get(f"{BASE}/auctions?limit=20", timeout=15)
    anon_list = {a["id"]: a for a in (r2.json() or [])} if r2.status_code == 200 else {}

    checked = 0
    correct = 0
    for a in ops_list:
        if a["id"] not in anon_list:
            continue
        cur = int(a.get("current_bid") or 0)
        res = int(a.get("reserve_price") or 0)
        expect_has = res > 0
        expect_met = (cur >= res) if expect_has else None
        anon = anon_list[a["id"]]
        if anon.get("has_reserve") == expect_has and anon.get("reserve_met") == expect_met:
            correct += 1
        else:
            print(
                f"   §8 mismatch on {a['id'][:8]}: cur={cur} res={res} "
                f"expect has={expect_has} met={expect_met}, "
                f"got has={anon.get('has_reserve')} met={anon.get('reserve_met')}"
            )
        checked += 1
    _record(checked > 0 and correct == checked, f"§8 has_reserve/reserve_met correct for {correct}/{checked} auctions")


def section9_deep_scan(buyer_token: Optional[str]):
    headers = H(buyer_token) if buyer_token else {}
    r = requests.get(f"{BASE}/auctions?limit=10", headers=headers, timeout=15)
    if r.status_code != 200:
        _record(False, "§9 list for deep scan", f"{r.status_code}")
        return
    ids = [a["id"] for a in (r.json() or [])][:3]
    for aid in ids:
        rd = requests.get(f"{BASE}/auctions/{aid}", headers=headers, timeout=15)
        if rd.status_code != 200:
            _record(False, f"§9 GET /auctions/{aid[:8]}", f"{rd.status_code}")
            continue
        leaks = find_reserve_keys(rd.json())
        _record(not leaks, f"§9 deep-scan /auctions/{aid[:8]} — NO 'reserve_price' anywhere", f"leaks={leaks}")


# ─────────────────────────────────────────────────────────────────────
# Seller auction setup (review explicitly asks for an auction owned by
# +919900000002). Stock seed has all auctions owned by the operator
# dealer. We use a direct mongo update to flip seller_id on ONE auction
# so we can prove per-listing seller-only visibility.
# ─────────────────────────────────────────────────────────────────────
async def prepare_seller_auction(seller_phone: str) -> Tuple[Optional[str], Optional[str]]:
    """Returns (seller_owned_auction_id, other_seller_auction_id)."""
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "qdrives_db")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    seller_doc = await db.dealers.find_one({"phone": seller_phone}, {"_id": 0, "id": 1})
    if not seller_doc:
        client.close()
        return None, None
    # Pick a live auction and flip ownership for it; pick another to leave alone.
    auctions = await db.auctions.find({"status": "live"}, {"_id": 0, "id": 1, "seller_id": 1}).limit(5).to_list(5)
    if len(auctions) < 2:
        client.close()
        return None, None
    target = auctions[0]
    other = auctions[1]
    # Remember original to restore later
    original_seller = target["seller_id"]
    await db.auctions.update_one({"id": target["id"]}, {"$set": {"seller_id": seller_doc["id"]}})
    # Stash original so we can restore
    globals()["_RESTORE_SELLER"] = (target["id"], original_seller)
    client.close()
    return target["id"], other["id"]


async def restore_seller_auction():
    info = globals().get("_RESTORE_SELLER")
    if not info:
        return
    auction_id, original = info
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "qdrives_db")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    await db.auctions.update_one({"id": auction_id}, {"$set": {"seller_id": original}})
    client.close()


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────
def main() -> int:
    print("=" * 70)
    print("P0 RESERVE-PRICE PRIVACY TEST")
    print("=" * 70)

    print("\n[setup] Logging in operator + buyer + seller...")
    op_token = login_operator(OPERATOR_PHONE)
    if not op_token:
        print("FATAL — operator login failed; cannot continue")
        return 2
    buyer_token = login_dealer(BUYER_PHONE)
    if not buyer_token:
        print("FATAL — buyer login failed")
        return 2
    seller_token = login_dealer(SELLER_PHONE)
    if not seller_token:
        print("FATAL — seller login failed")
        return 2
    print("  operator, buyer, seller tokens acquired")

    print("\n[setup] Prepping seller-owned auction (mongo seller_id flip)...")
    seller_aid, other_aid = asyncio.run(prepare_seller_auction(SELLER_PHONE))
    if not seller_aid or not other_aid:
        print("WARN — could not prepare seller-owned auction; §3 will be skipped")

    try:
        # §1 Anonymous
        print("\n[§1 Anonymous]")
        anon_list, anon_sample = section1_anonymous(buyer_token=None)

        # §2 Authenticated bidder
        print("\n[§2 Authenticated bidder]")
        section1_anonymous(buyer_token=buyer_token)
        section2_purchases(buyer_token)

        # §3 Seller
        if seller_aid and other_aid:
            print("\n[§3 Authenticated seller]")
            section3_seller(seller_token, seller_aid, other_aid)
        else:
            FAIL.append("§3 seller setup unavailable")

        # §4 Operator
        print("\n[§4 Authenticated operator]")
        if anon_sample:
            section4_operator(op_token, anon_sample)
        else:
            _record(False, "§4 — no sample auction id to use")

        # §5 WS snapshot frame
        print("\n[§5 WS snapshot frame (per-connect)]")
        # Find a live auction id
        live_id = None
        r_list = requests.get(f"{BASE}/auctions?status_filter=live&limit=5", timeout=15).json() or []
        if r_list:
            live_id = r_list[0]["id"]
        if live_id:
            section5_ws_snapshot(buyer_token, live_id)
        else:
            _record(False, "§5 no live auction available")

        # §6 WS new_bid frame
        print("\n[§6 WS new_bid frame]")
        # buyer2 = seller_token? we want a different dealer subscribed.
        # Use seller as the listener (it's a different dealer to buyer1).
        if live_id:
            section6_ws_new_bid(buyer1_token=buyer_token, buyer2_token=seller_token, live_auction_id=live_id)
        else:
            _record(False, "§6 no live auction available")

        # §7 Reconnect REST snapshot
        print("\n[§7 Reconnect REST snapshot]")
        if anon_sample:
            section7_reconnect_rest_snapshot(buyer_token, op_token, anon_sample)
        else:
            _record(False, "§7 no sample auction id")

        # §8 Regression — flag correctness
        print("\n[§8 Regression — has_reserve/reserve_met correctness]")
        section8_regression_flags(op_token)

        # §9 Deep scan
        print("\n[§9 Deep recursive scan — anonymous]")
        section9_deep_scan(buyer_token=None)

    finally:
        # Restore seller_id flip
        asyncio.run(restore_seller_auction())

    # ── Summary ──
    print("\n" + "=" * 70)
    print(f"RESULT: PASS={len(PASS)} FAIL={len(FAIL)}")
    print("=" * 70)
    if FAIL:
        print("\nFailed checks:")
        for f in FAIL:
            print(f"  - {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
