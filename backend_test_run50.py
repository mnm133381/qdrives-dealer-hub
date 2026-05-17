#!/usr/bin/env python3
"""
RUN 50 — Regression test for the 500 -> 200 fix on
PUT /api/cars/{car_id}/inspection.

Verifies the _coerce_version() helper handles legacy string-typed
"version" values (e.g. "v1") without raising ValueError.
"""
import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, Dict, Optional

import httpx
import websockets
from motor.motor_asyncio import AsyncIOMotorClient

BASE = os.environ.get("QDRIVES_API", "http://localhost:8001/api")
WS_BASE = BASE.replace("http://", "ws://").replace("https://", "wss://")
OPERATOR_PHONE = "+918977986662"
DEALER_PHONE = "+919900000002"
LEGACY_CAR_ID = "3d392121-a4b0-4556-814d-166fdcf43d0b"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "qdrives_db")

PASS = 0
FAIL = 0
FAILURES = []

def check(cond, label, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        FAILURES.append(f"{label} :: {detail}")
        print(f"  ❌ {label} :: {detail}")
    return cond


async def login_operator(client: httpx.AsyncClient) -> str:
    # Skip send-otp to avoid per-phone cooldown. DEV_BYPASS_OTP=true lets
    # verify-otp accept 123456 directly.
    r = await client.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": OPERATOR_PHONE, "otp": "123456"},
    )
    assert r.status_code == 200, f"verify-otp failed: {r.status_code} {r.text}"
    return r.json()["token"]


async def login_dealer(client: httpx.AsyncClient, phone: str) -> str:
    r = await client.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": phone, "otp": "123456"},
    )
    if r.status_code != 200:
        print(f"  [warn] dealer verify-otp {phone} status={r.status_code} body={r.text[:200]}")
        return None
    return r.json()["token"]


def std_payload():
    return {
        "sections": {
            "exterior":   {"completed": True, "score": 6},
            "interior":   {"completed": True, "score": 6},
            "mechanical": {"completed": True, "score": 6},
            "tyres":      {"completed": True, "score": 6},
            "documents":  {"completed": True, "rc": True, "insurance": True, "puc": True},
            "photos":     {"completed": True, "photo_count": 4},
        },
        "accident_history": "No accidents",
        "tyre_condition":   "Excellent",
        "service_history":  "Authorized Dealer",
    }


async def main():
    db_client = AsyncIOMotorClient(MONGO_URL)
    db = db_client[DB_NAME]

    async with httpx.AsyncClient(timeout=30.0) as client:
        print("\n=== §0 Auth (operator + dealer) ===")
        op_token = await login_operator(client)
        op_h = {"Authorization": f"Bearer {op_token}"}
        check(bool(op_token), "operator login ok")

        dealer_token = await login_dealer(client, DEALER_PHONE)
        # dealer may or may not log in successfully (suspended in prior runs).
        # Reactivate via approved_dealers if needed.
        if not dealer_token:
            # Try to reactivate by writing to approved_dealers
            await db.approved_dealers.update_one(
                {"phone": DEALER_PHONE}, {"$set": {"status": "active"}}, upsert=False
            )
            await db.dealers.update_one(
                {"phone": DEALER_PHONE}, {"$set": {"suspended": False}}
            )
            dealer_token = await login_dealer(client, DEALER_PHONE)
        dealer_h = {"Authorization": f"Bearer {dealer_token}"} if dealer_token else None

        # ─────────────────────────────────────────────────────────────
        print("\n=== §1 Legacy-version PUT (the actual bug) ===")
        # Ensure legacy "v1" is in place
        await db.inspections.update_one(
            {"car_id": LEGACY_CAR_ID},
            {"$set": {"version": "v1"}},
        )
        legacy = await db.inspections.find_one({"car_id": LEGACY_CAR_ID}, {"_id": 0, "version": 1})
        check(legacy and legacy.get("version") == "v1", "Legacy version='v1' set on car 3d392121", str(legacy))

        r = await client.put(
            f"{BASE}/cars/{LEGACY_CAR_ID}/inspection",
            json=std_payload(),
            headers=op_h,
        )
        check(r.status_code == 200, f"PUT /cars/{LEGACY_CAR_ID[:8]}.../inspection → 200 (not 500)",
              f"got {r.status_code} body={r.text[:300]}")
        body = r.json() if r.status_code == 200 else {}
        check(body.get("version") == 2, "Response version == 2 (v1 coerced to 1, +1)",
              f"version={body.get('version')!r}")
        check(isinstance(body.get("version"), int), "Response version is INTEGER",
              f"type={type(body.get('version')).__name__}")

        r = await client.get(f"{BASE}/cars/{LEGACY_CAR_ID}/inspection")
        check(r.status_code == 200, "GET inspection returns 200")
        g = r.json()
        check(g.get("version") == 2 and isinstance(g["version"], int),
              "GET shows version=2 as INT", f"got {g.get('version')!r} ({type(g.get('version')).__name__})")
        check(g.get("accident_history") == "No accidents", "GET reflects new accident_history")
        check(g.get("tyre_condition") == "Excellent", "GET reflects new tyre_condition")
        check(g.get("service_history") == "Authorized Dealer", "GET reflects new service_history")

        # ─────────────────────────────────────────────────────────────
        print("\n=== §2 Numeric-version round-trip (RUN 48 regression) ===")
        # Create a fresh car owned by operator
        car_payload = {
            "make": "Toyota",
            "model": "Camry",
            "year": 2022,
            "registration_number": f"MH99TEST{int(time.time()) % 10000}",
            "kms_driven": 35000,
            "km_driven": 35000,
            "fuel_type": "Petrol",
            "transmission": "Automatic",
            "owners": 1,
            "color": "White",
            "city": "Mumbai",
            "starting_bid": 800000,
            "reserve_price": 900000,
            "auction_duration_hours": 24,
        }
        r = await client.post(f"{BASE}/cars", json=car_payload, headers=op_h)
        check(r.status_code == 200, "Create fresh car for §2", f"got {r.status_code} body={r.text[:200]}")
        fresh_car_id = r.json()["car"]["id"]
        print(f"  → fresh_car_id={fresh_car_id}")

        for expected in (1, 2, 3):
            r = await client.put(
                f"{BASE}/cars/{fresh_car_id}/inspection",
                json=std_payload(),
                headers=op_h,
            )
            check(r.status_code == 200, f"PUT #{expected} → 200", f"got {r.status_code} {r.text[:200]}")
            v = r.json().get("version")
            check(v == expected and isinstance(v, int), f"version == {expected} as INT",
                  f"got {v!r} ({type(v).__name__})")

        # ─────────────────────────────────────────────────────────────
        print("\n=== §3 String-version edge cases ===")
        edge_car_payload = dict(car_payload, registration_number=f"MH88EDGE{int(time.time()) % 10000}")
        r = await client.post(f"{BASE}/cars", json=edge_car_payload, headers=op_h)
        check(r.status_code == 200, "Create fresh car for §3")
        edge_car = r.json()["car"]["id"]

        # Get/initialise the inspection doc first so we can manipulate its version
        await client.put(f"{BASE}/cars/{edge_car}/inspection", json=std_payload(), headers=op_h)

        edge_cases = [
            ("v999", 1000, "v999 → 1000"),
            ("abc",  1,    "abc (no digits) → 1"),
            (None,   1,    "null → 1"),
            (5.7,    6,    "5.7 (float) → 6"),
        ]
        for raw, expected, label in edge_cases:
            await db.inspections.update_one(
                {"car_id": edge_car}, {"$set": {"version": raw}}
            )
            r = await client.put(
                f"{BASE}/cars/{edge_car}/inspection",
                json=std_payload(),
                headers=op_h,
            )
            ok_status = r.status_code == 200
            v = r.json().get("version") if ok_status else None
            check(ok_status and v == expected and isinstance(v, int),
                  f"§3 edge {label}",
                  f"status={r.status_code} version={v!r} body={r.text[:200]}")

        # ─────────────────────────────────────────────────────────────
        print("\n=== §4 History endpoint regression (legacy car) ===")
        r = await client.get(f"{BASE}/cars/{LEGACY_CAR_ID}/inspection/history")
        check(r.status_code == 200, "GET /inspection/history on legacy car → 200",
              f"got {r.status_code} {r.text[:200]}")
        hist = r.json()
        check("entries" in hist and isinstance(hist["entries"], list),
              "history has entries[] list", str(type(hist.get("entries"))))
        check(len(hist["entries"]) >= 1, "history has at least 1 row (from §1 PUT)",
              f"count={hist.get('count')}")
        if hist["entries"]:
            top = hist["entries"][0]
            check(isinstance(top.get("version"), int) and top["version"] == 2,
                  "Top history entry has version=2 (int)",
                  f"version={top.get('version')!r} ({type(top.get('version')).__name__})")
            check(isinstance(top.get("previous_version"), int) and top["previous_version"] == 1,
                  "Top history entry has previous_version=1 (coerced from 'v1')",
                  f"previous_version={top.get('previous_version')!r}")

        # ─────────────────────────────────────────────────────────────
        print("\n=== §5 Cross-role parity & WS ===")
        # Anonymous
        async with httpx.AsyncClient(timeout=10.0) as anon:
            r_anon = await anon.get(f"{BASE}/cars/{LEGACY_CAR_ID}/inspection")
        r_op   = await client.get(f"{BASE}/cars/{LEGACY_CAR_ID}/inspection", headers=op_h)
        check(r_anon.status_code == 200, "anon GET 200")
        check(r_op.status_code == 200, "operator GET 200")
        # Compare bodies (json equality, since updated_at could differ if we
        # didn't PUT in between — but we just did §1 PUT, then §1 GET also reads,
        # so both reads should see the same version).
        check(r_anon.json().get("version") == r_op.json().get("version") == 2,
              "anon == operator version", f"anon={r_anon.json().get('version')} op={r_op.json().get('version')}")
        check(r_anon.json().get("inspection_score") == r_op.json().get("inspection_score"),
              "anon == operator inspection_score")
        check(r_anon.json().get("condition_grade") == r_op.json().get("condition_grade"),
              "anon == operator condition_grade")
        if dealer_h:
            r_d = await client.get(f"{BASE}/cars/{LEGACY_CAR_ID}/inspection", headers=dealer_h)
            check(r_d.status_code == 200, "dealer GET 200")
            check(r_d.json().get("version") == 2, "dealer sees same version")

        # WS broadcast — find the auction for legacy car
        auction = await db.auctions.find_one({"car_id": LEGACY_CAR_ID}, {"_id": 0, "id": 1, "status": 1})
        if auction and dealer_token:
            aid = auction["id"]
            ws_url = f"{WS_BASE}/ws/auction/{aid}?token={dealer_token}"
            received_insp_update = False
            try:
                async with websockets.connect(ws_url) as ws:
                    # Consume the snapshot
                    try:
                        snap = await asyncio.wait_for(ws.recv(), timeout=3.0)
                        print(f"  [ws] snapshot received (len={len(snap)})")
                    except asyncio.TimeoutError:
                        print("  [ws] no snapshot in 3s")

                    # Trigger another PUT (will broadcast inspection_updated)
                    async def trigger():
                        await asyncio.sleep(0.5)
                        await client.put(
                            f"{BASE}/cars/{LEGACY_CAR_ID}/inspection",
                            json=std_payload(),
                            headers=op_h,
                        )

                    trig_task = asyncio.create_task(trigger())

                    end = time.time() + 5.0
                    while time.time() < end:
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
                            data = json.loads(msg)
                            if data.get("type") == "inspection_updated":
                                received_insp_update = True
                                print(f"  [ws] inspection_updated frame received: {data}")
                                break
                        except (asyncio.TimeoutError, json.JSONDecodeError):
                            break
                        except Exception as exc:
                            print(f"  [ws] recv error: {exc}")
                            break
                    await trig_task
            except Exception as exc:
                print(f"  [ws] connect error: {exc}")
            check(received_insp_update,
                  "WS inspection_updated frame received within 5s",
                  "no inspection_updated frame seen")
        else:
            print(f"  [ws] skipped (auction={bool(auction)} dealer_token={bool(dealer_token)})")

        # ─────────────────────────────────────────────────────────────
        print("\n=== §6 Sanity: empty payload → 422 ===")
        r = await client.put(
            f"{BASE}/cars/{LEGACY_CAR_ID}/inspection",
            json={},
            headers=op_h,
        )
        check(r.status_code == 422, f"empty body → 422 (got {r.status_code})",
              f"body={r.text[:200]}")
        detail = r.json().get("detail") if r.status_code == 422 else {}
        # detail may be a dict (custom) or a list (pydantic). Accept either as
        # long as INSPECTION_EMPTY_NOT_ALLOWED appears somewhere.
        as_str = json.dumps(detail)
        check("INSPECTION_EMPTY_NOT_ALLOWED" in as_str,
              "detail mentions INSPECTION_EMPTY_NOT_ALLOWED", f"detail={as_str[:300]}")

    db_client.close()

    print("\n" + "=" * 60)
    print(f"RUN 50 RESULT: {PASS} PASS / {FAIL} FAIL")
    print("=" * 60)
    if FAILURES:
        print("FAILURES:")
        for f in FAILURES:
            print(f"  ❌ {f}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
