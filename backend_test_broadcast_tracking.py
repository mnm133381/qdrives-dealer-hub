"""
Backend tests for the silent broadcast funnel-tracking layer.

Targets:
  • POST /api/notifications/{id}/open
  • POST /api/auctions/{id}/track-view
  • Automatic emissions on /api/admin/broadcasts and /api/auctions/{id}/bid
  • Reads against db.broadcast_events to verify event ledger growth
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
OTP = "123456"

# Test phones
DEALER_A = "+919900000001"   # Apex Premium Motors
DEALER_B = "+919900000002"   # Royal Drives Co.
OP1 = "+919900000099"
OP2 = "+918977986662"

# ANSI
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
RESET = "\033[0m"

PASS = []
FAIL = []


def log_ok(msg: str) -> None:
    print(f"{GREEN}PASS{RESET} {msg}")
    PASS.append(msg)


def log_fail(msg: str, ctx: Any = "") -> None:
    print(f"{RED}FAIL{RESET} {msg}")
    if ctx:
        print(f"      {ctx}")
    FAIL.append((msg, ctx))


# --------------------------------------------------------------------- auth
def dealer_login(phone: str) -> dict:
    requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": phone}, timeout=20)
    r = requests.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def operator_login(phone: str) -> dict:
    requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=20)
    r = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def H(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


# --------------------------------------------------------------------- mongo
def get_mongo():
    """Direct Mongo access for ledger inspection."""
    from pymongo import MongoClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "qdrives_db")
    client = MongoClient(mongo_url)
    return client[db_name]


def count_events(db, **q) -> int:
    return db.broadcast_events.count_documents(q)


def find_events(db, limit=50, **q):
    return list(db.broadcast_events.find(q, {"_id": 0}).sort("ts", -1).limit(limit))


# ===================================================================== TESTS
def main() -> int:
    db = get_mongo()
    print(f"\n[INFO] BASE = {BASE}")
    print(f"[INFO] Mongo broadcast_events count (start) = "
          f"{db.broadcast_events.count_documents({})}\n")

    # ---------------- AUTH SETUP --------------------------------------
    print("=== AUTH ===")
    op = operator_login(OP2)
    op_tok = op["token"]
    op_id = op["dealer"]["id"]
    log_ok(f"Operator login {OP2} → role={op['dealer']['role']}, id={op_id}")

    da = dealer_login(DEALER_A)
    da_tok = da["token"]
    da_id = da["dealer"]["id"]
    log_ok(f"Dealer A login {DEALER_A} → role={da['dealer']['role']}, id={da_id}")

    db_2 = dealer_login(DEALER_B)
    db_tok = db_2["token"]
    db_id = db_2["dealer"]["id"]
    log_ok(f"Dealer B login {DEALER_B} → role={db_2['dealer']['role']}, id={db_id}")

    # Pick a live auction
    rs = requests.get(f"{BASE}/auctions", timeout=20)
    rs.raise_for_status()
    auctions = rs.json()
    live_auctions = [a for a in auctions
                     if a.get("status") in ("live",) and a.get("seller_id") != da_id]
    if not live_auctions:
        # Create a fresh auction as operator
        print("[INFO] No live auction available — creating one via POST /api/cars")
        suffix = uuid.uuid4().hex[:4].upper()
        car_payload = {
            "registration_number": f"MH02XY{suffix[:4]}",
            "make": "Hyundai",
            "model": "Creta",
            "variant": "SX",
            "year": 2023,
            "manufacturing_year": 2022,
            "registration_year": 2023,
            "fuel_type": "Petrol",
            "transmission": "Automatic",
            "km_driven": 18000,
            "color": "White",
            "owners": 1,
            "insurance_validity": "08/2026",
            "rto_details": "MH02 - Mumbai West",
            "notes": "Funnel tracker test auction",
            "reserve_price": 1100000,
            "starting_bid": 950000,
            "images": [],
            "description": "Test",
            "duration_minutes": 90,
        }
        cr = requests.post(f"{BASE}/cars", json=car_payload,
                           headers=H(op_tok), timeout=30)
        if cr.status_code != 200:
            log_fail(f"POST /cars failed status={cr.status_code}", cr.text[:300])
            return 2
        auction = cr.json()["auction"]
        aid = auction["id"]
        log_ok(f"Created fresh auction id={aid} for testing")
    else:
        auction = live_auctions[0]
        aid = auction["id"]
    print(f"[INFO] Using live auction id={aid} "
          f"car={auction.get('car',{}).get('make')} {auction.get('car',{}).get('model')}\n")

    # ----------------- 1) AUTH GATING --------------------------------
    print("=== 1) AUTH GATING ===")
    # Anonymous on /notifications/{nid}/open
    r = requests.post(f"{BASE}/notifications/{uuid.uuid4()}/open", timeout=20)
    if r.status_code == 401:
        log_ok("Anon POST /notifications/{id}/open → 401")
    else:
        log_fail(f"Anon POST /notifications/{{id}}/open expected 401 got {r.status_code}",
                 r.text[:200])

    r = requests.post(f"{BASE}/auctions/{aid}/track-view", json={}, timeout=20)
    if r.status_code == 401:
        log_ok("Anon POST /auctions/{id}/track-view → 401")
    else:
        log_fail(f"Anon POST /auctions/{{id}}/track-view expected 401 got {r.status_code}",
                 r.text[:200])

    # ---- 2) Operator sends a broadcast type=auction_live ------------
    print("\n=== 2) BROADCAST SEND (sent rows) ===")
    pre_sent = count_events(db, event="sent", dealer_id=da_id, auction_id=aid)
    payload = {
        "type": "auction_live",
        "auction_id": aid,
        "audience": "specific",
        "dealer_ids": [da_id],
    }
    r = requests.post(f"{BASE}/admin/broadcasts", json=payload, headers=H(op_tok), timeout=30)
    if r.status_code != 200:
        log_fail(f"POST /admin/broadcasts expected 200 got {r.status_code}", r.text[:300])
        return 3
    bres = r.json()
    bid_ = bres["id"]
    rcount = bres.get("recipient_count", 0)
    if rcount == 1:
        log_ok(f"Broadcast sent: id={bid_} recipients={rcount}")
    else:
        log_fail(f"Broadcast recipient_count expected 1 got {rcount}", bres)

    # Wait for fanout (background task)
    time.sleep(1.5)

    post_sent = count_events(db, event="sent", dealer_id=da_id,
                             auction_id=aid, broadcast_id=bid_)
    if post_sent == 1:
        log_ok(f"db.broadcast_events 'sent' row written for (dealer A, broadcast, auction): {post_sent}")
    else:
        log_fail(f"Expected exactly 1 'sent' row for dealer_a + broadcast + auction, got {post_sent}",
                 find_events(db, dealer_id=da_id, broadcast_id=bid_, limit=5))

    # ---- 3) Dealer GET /notifications --> notification with broadcast_id
    print("\n=== 3) Dealer notifications ===")
    r = requests.get(f"{BASE}/notifications", headers=H(da_tok), timeout=20)
    if r.status_code != 200:
        log_fail(f"GET /notifications expected 200 got {r.status_code}", r.text[:200])
        return 4
    notifs = r.json()
    nb = next((n for n in notifs
               if n.get("type") == "broadcast" and n.get("broadcast_id") == bid_), None)
    if nb:
        log_ok(f"Dealer A has broadcast notification with broadcast_id={bid_} (id={nb['id']}, read={nb.get('read')})")
    else:
        log_fail("Could not find the broadcast notification for dealer A",
                 [{"type": n.get("type"), "broadcast_id": n.get("broadcast_id")}
                  for n in notifs[:5]])
        return 4
    nid = nb["id"]

    # ---- 4) POST /notifications/{id}/open ---------------------------
    print("\n=== 4) Notification open (broadcast type) ===")
    pre_open = count_events(db, event="opened", dealer_id=da_id, broadcast_id=bid_)
    r = requests.post(f"{BASE}/notifications/{nid}/open",
                      headers=H(da_tok), timeout=20)
    if r.status_code == 200 and r.json().get("ok"):
        log_ok("POST /notifications/{id}/open → 200 ok=True")
    else:
        log_fail(f"POST /notifications/{{id}}/open expected 200 got {r.status_code}", r.text[:200])

    # Re-fetch to confirm read=True
    r = requests.get(f"{BASE}/notifications", headers=H(da_tok), timeout=20)
    notif_now = next((n for n in r.json() if n["id"] == nid), None)
    if notif_now and notif_now.get("read") is True:
        log_ok("Notification.read = True after open")
    else:
        log_fail("Notification.read is not True after open", notif_now)

    time.sleep(0.7)
    post_open = count_events(db, event="opened", dealer_id=da_id, broadcast_id=bid_)
    if post_open == pre_open + 1:
        log_ok(f"'opened' row written for broadcast notification (count {pre_open}→{post_open})")
    else:
        log_fail(f"'opened' row not written: count {pre_open}→{post_open}",
                 find_events(db, dealer_id=da_id, broadcast_id=bid_))

    # 4b) 404 on unknown notification id
    r = requests.post(f"{BASE}/notifications/{uuid.uuid4()}/open",
                      headers=H(da_tok), timeout=20)
    if r.status_code == 404:
        log_ok("POST /notifications/{unknown}/open → 404")
    else:
        log_fail(f"Unknown notification id expected 404 got {r.status_code}", r.text[:200])

    # 4c) Cross-dealer 404 — dealer B opens dealer A's notification
    r = requests.post(f"{BASE}/notifications/{nid}/open",
                      headers=H(db_tok), timeout=20)
    if r.status_code == 404:
        log_ok("POST /notifications/{otherUser_nid}/open by another dealer → 404")
    else:
        log_fail(f"Cross-dealer notification open expected 404 got {r.status_code}", r.text[:200])

    # 4d) Non-broadcast notification — should still 200 + mark read, NO event row
    print("\n=== 4d) Non-broadcast notification open does NOT write events ===")
    # Insert a fake outbid notification directly via Mongo for dealer A
    fake_nid = str(uuid.uuid4())
    db.notifications.insert_one({
        "id": fake_nid,
        "dealer_id": da_id,
        "type": "outbid",
        "title": "You were outbid",
        "body": "Place a higher bid to reclaim the lead.",
        "auction_id": aid,
        "read": False,
        "created_at": datetime.now(timezone.utc),
    })
    pre_total = db.broadcast_events.count_documents({})
    r = requests.post(f"{BASE}/notifications/{fake_nid}/open",
                      headers=H(da_tok), timeout=20)
    if r.status_code == 200:
        log_ok("Non-broadcast 'outbid' notification open → 200")
    else:
        log_fail(f"Non-broadcast open expected 200 got {r.status_code}", r.text[:200])
    post_total = db.broadcast_events.count_documents({})
    if post_total == pre_total:
        log_ok(f"No broadcast_events row written for non-broadcast open (total stayed {pre_total})")
    else:
        log_fail(f"broadcast_events grew on non-broadcast open: {pre_total}→{post_total}")

    # confirm read
    fake = db.notifications.find_one({"id": fake_nid}, {"_id": 0})
    if fake and fake.get("read") is True:
        log_ok("Non-broadcast notification marked read=True")
    else:
        log_fail("Non-broadcast notification not marked read", fake)

    # ---- 5) POST /auctions/{id}/track-view (fallback path) ----------
    print("\n=== 5) track-view fallback (no from_broadcast_id) ===")
    pre_view = count_events(db, event="auction_viewed", dealer_id=da_id, auction_id=aid,
                            broadcast_id=bid_)
    r = requests.post(f"{BASE}/auctions/{aid}/track-view",
                      json={}, headers=H(da_tok), timeout=20)
    if r.status_code == 200:
        body = r.json()
        if body.get("ok") and body.get("tracked") is True:
            log_ok(f"track-view {{}} (fallback) → 200 tracked=True body={body}")
        else:
            log_fail(f"track-view fallback should track via recent 'sent' row, body={body}", body)
    else:
        log_fail(f"track-view fallback expected 200 got {r.status_code}", r.text[:200])

    time.sleep(0.5)
    post_view = count_events(db, event="auction_viewed", dealer_id=da_id, auction_id=aid,
                             broadcast_id=bid_)
    if post_view == pre_view + 1:
        log_ok(f"'auction_viewed' row written via fallback (count {pre_view}→{post_view})")
    else:
        log_fail(f"'auction_viewed' fallback row not written: {pre_view}→{post_view}",
                 find_events(db, dealer_id=da_id, auction_id=aid))

    # ---- 6) explicit from_broadcast_id ------------------------------
    print("\n=== 6) track-view explicit from_broadcast_id ===")
    r = requests.post(f"{BASE}/auctions/{aid}/track-view",
                      json={"from_broadcast_id": bid_},
                      headers=H(da_tok), timeout=20)
    if r.status_code == 200:
        body = r.json()
        if body.get("ok") and body.get("tracked") is True:
            log_ok(f"track-view from_broadcast_id={bid_} → 200 tracked=True")
        else:
            log_fail(f"track-view explicit should be tracked=True, body={body}", body)
    else:
        log_fail(f"track-view explicit expected 200 got {r.status_code}", r.text[:200])

    time.sleep(0.5)
    new_view = count_events(db, event="auction_viewed", dealer_id=da_id, auction_id=aid,
                            broadcast_id=bid_)
    if new_view == post_view + 1:
        log_ok(f"Second 'auction_viewed' row written for explicit broadcast (count {post_view}→{new_view})")
    else:
        log_fail(f"Second 'auction_viewed' row missing: {post_view}→{new_view}")

    # ---- 6b) bogus from_broadcast_id (should still write the row) --
    print("\n=== 6b) track-view with non-existent from_broadcast_id (trust deep-link) ===")
    fake_bid = str(uuid.uuid4())
    pre_bogus = count_events(db, event="auction_viewed", dealer_id=da_id,
                             auction_id=aid, broadcast_id=fake_bid)
    r = requests.post(f"{BASE}/auctions/{aid}/track-view",
                      json={"from_broadcast_id": fake_bid},
                      headers=H(da_tok), timeout=20)
    if r.status_code == 200 and r.json().get("tracked") is True:
        log_ok(f"track-view bogus from_broadcast_id → 200 tracked=True (deep-link trusted)")
    else:
        log_fail(f"track-view bogus broadcast_id expected 200 tracked=True, got {r.status_code} {r.text[:200]}")
    time.sleep(0.4)
    post_bogus = count_events(db, event="auction_viewed", dealer_id=da_id,
                              auction_id=aid, broadcast_id=fake_bid)
    if post_bogus == pre_bogus + 1:
        log_ok(f"Row written for bogus broadcast_id (deep-link policy honored)")
    else:
        log_fail(f"Row not written for bogus from_broadcast_id: {pre_bogus}→{post_bogus}")

    # ---- 7) BID PLACED → bid_placed event ---------------------------
    print("\n=== 7) Bid placement attribution ===")
    # Refetch auction to know current_bid
    ar = requests.get(f"{BASE}/auctions/{aid}", timeout=20).json()
    cb = ar.get("current_bid") or ar.get("starting_bid") or 0
    bid_amount = int(cb) + 5000
    pre_bp = count_events(db, event="bid_placed", dealer_id=da_id,
                          auction_id=aid, broadcast_id=bid_)
    r = requests.post(f"{BASE}/auctions/{aid}/bid",
                      json={"amount": bid_amount},
                      headers=H(da_tok), timeout=20)
    if r.status_code == 200:
        rb = r.json()
        if rb.get("success") and rb.get("bid", {}).get("id"):
            placed_bid_id = rb["bid"]["id"]
            log_ok(f"POST /auctions/{{id}}/bid amount={bid_amount} → 200 bid_id={placed_bid_id}")
        else:
            log_fail(f"Bid response shape unexpected", rb)
            placed_bid_id = None
    else:
        log_fail(f"POST /auctions/{{id}}/bid expected 200 got {r.status_code}", r.text[:200])
        placed_bid_id = None

    time.sleep(1.5)
    post_bp = count_events(db, event="bid_placed", dealer_id=da_id,
                           auction_id=aid, broadcast_id=bid_)
    if post_bp == pre_bp + 1:
        log_ok(f"'bid_placed' row written attributing bid to broadcast (count {pre_bp}→{post_bp})")
    else:
        log_fail(f"'bid_placed' row not written: {pre_bp}→{post_bp}",
                 find_events(db, event="bid_placed", dealer_id=da_id, auction_id=aid))

    if placed_bid_id:
        bp_row = db.broadcast_events.find_one(
            {"event": "bid_placed", "dealer_id": da_id, "auction_id": aid,
             "bid_id": placed_bid_id, "broadcast_id": bid_}, {"_id": 0}
        )
        if bp_row:
            log_ok("'bid_placed' row references the placed bid_id")
        else:
            log_fail("'bid_placed' row missing bid_id reference", placed_bid_id)

    # ---- 8) Dealer who never received a broadcast → tracked=false ---
    print("\n=== 8) Dealer B never received broadcast → tracked=false, no row ===")
    pre_b_total = count_events(db, event="auction_viewed", dealer_id=db_id, auction_id=aid)
    r = requests.post(f"{BASE}/auctions/{aid}/track-view",
                      json={}, headers=H(db_tok), timeout=20)
    if r.status_code == 200:
        body = r.json()
        if body.get("ok") and body.get("tracked") is False:
            log_ok(f"Dealer B track-view {{}} → 200 tracked=False (no attribution source)")
        else:
            log_fail(f"Expected tracked=False, body={body}", body)
    else:
        log_fail(f"Dealer B track-view expected 200 got {r.status_code}", r.text[:200])
    time.sleep(0.4)
    post_b_total = count_events(db, event="auction_viewed", dealer_id=db_id, auction_id=aid)
    if post_b_total == pre_b_total:
        log_ok(f"No 'auction_viewed' row written for unattributed dealer (count stays {pre_b_total})")
    else:
        log_fail(f"Unattributed track-view wrote a row: {pre_b_total}→{post_b_total}")

    # ---- 9) track-view 404 on unknown auction -----------------------
    print("\n=== 9) track-view non-existent auction ===")
    r = requests.post(f"{BASE}/auctions/{uuid.uuid4()}/track-view",
                      json={}, headers=H(da_tok), timeout=20)
    if r.status_code == 404:
        log_ok("track-view non-existent auction → 404")
    else:
        log_fail(f"track-view non-existent auction expected 404 got {r.status_code}", r.text[:200])

    # ---- 10) track-view default body (no body sent) -----------------
    # Some HTTP clients omit body. Backend should treat as from_broadcast_id=null.
    print("\n=== 10) track-view with NO body ===")
    r = requests.post(f"{BASE}/auctions/{aid}/track-view",
                      headers=H(da_tok), timeout=20)
    # FastAPI usually requires JSON body for a Pydantic model. If 422 we note;
    # the spec calls for "missing body should default". Try to send empty body.
    if r.status_code == 200:
        body = r.json()
        log_ok(f"track-view without body → 200 (tracked={body.get('tracked')})")
    elif r.status_code == 422:
        log_fail("track-view without body returned 422 — spec wants default to null",
                 r.text[:200])
    else:
        log_fail(f"track-view without body unexpected status {r.status_code}", r.text[:200])

    # Try with explicit empty json body separately
    r2 = requests.post(f"{BASE}/auctions/{aid}/track-view",
                       json={}, headers=H(da_tok), timeout=20)
    if r2.status_code == 200:
        log_ok("track-view with body={} → 200 (covered)")

    # ---- 11) Regression: existing endpoints still functional --------
    print("\n=== 11) Regression checks ===")
    r = requests.get(f"{BASE}/admin/broadcasts/recent", headers=H(op_tok), timeout=20)
    if r.status_code == 200 and isinstance(r.json(), list):
        log_ok(f"GET /admin/broadcasts/recent → 200 with {len(r.json())} entries")
    else:
        log_fail(f"GET /admin/broadcasts/recent expected 200 list got {r.status_code}",
                 r.text[:200])

    # Operator can still send broadcast (basic regression already covered above)
    log_ok("POST /admin/broadcasts regression confirmed in step 2")
    log_ok("POST /auctions/{id}/bid regression confirmed in step 7")

    # ---- 12) Tracking writes never fail user path -------------------
    # Place another bid for dealer A even when there's NO recent broadcast
    # left for the auction (we didn't delete; just verifying it still works)
    print("\n=== 12) Tracking failure can never block bid path (light) ===")
    ar2 = requests.get(f"{BASE}/auctions/{aid}", timeout=20).json()
    cb2 = ar2.get("current_bid") or 0
    # Need to outbid — but dealer A is currently top. Use dealer B to outbid.
    r = requests.post(f"{BASE}/auctions/{aid}/bid",
                      json={"amount": int(cb2) + 5000},
                      headers=H(db_tok), timeout=20)
    if r.status_code == 200 and r.json().get("success"):
        log_ok(f"Dealer B bid placed successfully (regression OK, amount={int(cb2)+5000})")
    else:
        log_fail(f"Dealer B bid expected 200 got {r.status_code}", r.text[:200])

    # ---- summary ----------------------------------------------------
    print("\n" + "=" * 60)
    print(f"RESULTS: {GREEN}{len(PASS)} pass{RESET} / {RED}{len(FAIL)} fail{RESET}")
    print(f"db.broadcast_events total at end = "
          f"{db.broadcast_events.count_documents({})}")
    print(f"Sample tail (latest 8 rows for dealer A):")
    for e in find_events(db, limit=8, dealer_id=da_id):
        print(f"  • event={e['event']:<14} broadcast_id={e['broadcast_id'][:8]}…  "
              f"auction={str(e.get('auction_id'))[:8] if e.get('auction_id') else 'None':<8}  "
              f"bid_id={str(e.get('bid_id'))[:8] if e.get('bid_id') else 'None':<8}  "
              f"ts={e['ts']}")

    if FAIL:
        print("\nFAILURES:")
        for m, c in FAIL:
            print(f"  ✗ {m}")
            if c:
                print(f"    {c}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
