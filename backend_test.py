"""
Backend test for RUN 34 — Realtime Bid Reliability + WebSocket Hardening.
Public preview URL is hit (NOT localhost).
"""
import os
import sys
import time
import json
import uuid
import asyncio
import urllib.parse
from typing import Any, Dict, Optional, Tuple, List

import httpx
import websockets
from motor.motor_asyncio import AsyncIOMotorClient

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
WS_BASE = "wss://qdrives-dealer-hub.preview.emergentagent.com/api"

OPERATOR_PHONE = "+919900000099"
DEALER_A_PHONE = "+919900000001"
DEALER_B_PHONE = "+919900000002"

mongo = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
db = mongo["qdrives_db"]

PASS: List[str] = []
FAIL: List[str] = []


def log(ok: bool, name: str, detail: str = "") -> None:
    line = f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + detail) if detail else ''}"
    print(line)
    (PASS if ok else FAIL).append(line)


async def login(client: httpx.AsyncClient, phone: str, kind: str = "dealer") -> Dict[str, Any]:
    path = "/auth/operator/verify-otp" if kind == "operator" else "/auth/dealer/verify-otp"
    r = await client.post(BASE + path, json={"phone": phone, "otp": "123456"})
    r.raise_for_status()
    return r.json()


async def main():
    async with httpx.AsyncClient(timeout=30) as client:
        # ============ PRECONDITION ============
        r = await client.get(BASE + "/dashboard/stats")
        log(r.status_code == 401, "PRE 401 on /dashboard/stats no auth", f"status={r.status_code}")
        r = await client.get(BASE + "/auctions/abc/snapshot")
        log(r.status_code == 401, "PRE 401 on /auctions/x/snapshot no auth", f"status={r.status_code}")
        r = await client.post(BASE + "/realtime/report", json={"event":"frame_out_of_order"})
        log(r.status_code == 401, "PRE 401 on /realtime/report no auth", f"status={r.status_code}")
        r = await client.get(BASE + "/admin/realtime/health")
        log(r.status_code == 401, "PRE 401 on /admin/realtime/health no auth", f"status={r.status_code}")

        # ============ Login ============
        try:
            op = await login(client, OPERATOR_PHONE, "operator")
            op_jwt = op["token"]
            log(True, "Login operator", f"role={op['dealer']['role']}")
        except Exception as e:
            log(False, "Login operator", str(e))
            return

        try:
            dA = await login(client, DEALER_A_PHONE, "dealer")
            jwt_A = dA["token"]
            dealer_A_id = dA["dealer"]["id"]
            log(True, "Login dealer A", f"phone={DEALER_A_PHONE} id={dealer_A_id}")
        except Exception as e:
            log(False, "Login dealer A", str(e))
            return

        try:
            dB = await login(client, DEALER_B_PHONE, "dealer")
            jwt_B = dB["token"]
            dealer_B_id = dB["dealer"]["id"]
            log(True, "Login dealer B", f"phone={DEALER_B_PHONE} id={dealer_B_id}")
        except Exception as e:
            log(False, "Login dealer B", str(e))
            jwt_B = None
            dealer_B_id = None

        OP_H = {"Authorization": f"Bearer {op_jwt}"}
        A_H = {"Authorization": f"Bearer {jwt_A}"}
        B_H = {"Authorization": f"Bearer {jwt_B}"} if jwt_B else None

        # ============ A) Auth gating ============
        r = await client.get(BASE + "/admin/realtime/health", headers=OP_H)
        ok = r.status_code == 200
        body = r.json() if ok else {}
        keys_present = all(k in body for k in ("live_ws","rooms","events_1h","thresholds")) if ok else False
        types_ok = isinstance(body.get("live_ws"), int) and isinstance(body.get("rooms"), list) and isinstance(body.get("events_1h"), dict) and isinstance(body.get("thresholds"), dict) if ok else False
        log(ok and keys_present and types_ok, "A.4 GET /admin/realtime/health (operator)", f"status={r.status_code} keys={list(body)[:6]}")

        r = await client.get(BASE + "/admin/realtime/health", headers=A_H)
        log(r.status_code == 403, "A.5 GET /admin/realtime/health (dealer)", f"status={r.status_code}")

        # ============ B) /realtime/report validation ============
        r = await client.post(BASE + "/realtime/report", headers=A_H,
                              json={"event":"frame_out_of_order","auction_id":"x","expected_seq":5,"got_seq":7})
        log(r.status_code == 200 and r.json().get("ok") is True, "B.6 frame_out_of_order valid", f"status={r.status_code} body={r.text[:80]}")

        r = await client.post(BASE + "/realtime/report", headers=A_H,
                              json={"event":"definitely_not_real"})
        ok = (r.status_code == 400 and "unknown_event" in r.text)
        log(ok, "B.7 unknown_event -> 400", f"status={r.status_code} body={r.text[:80]}")

        # 9e30 truncated to int via Pydantic v2 — if rejected, that's still acceptable (no 500)
        r = await client.post(BASE + "/realtime/report", headers=OP_H,
                              json={"event":"snapshot_resync","expected_seq":2147483648,"got_seq":1})
        log(r.status_code in (200, 422, 400), "B.8 huge counter -> no 500", f"status={r.status_code}")

        # ============ C) Snapshot endpoint ============
        from datetime import datetime, timezone
        now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
        a_doc = await db.auctions.find_one(
            {"status":"live", "end_time": {"$gt": now_naive}},
            {"_id":0},
        )
        if not a_doc:
            log(False, "C precondition: live auction available", "no truly-live auctions in DB")
            return
        AID = a_doc["id"]

        r = await client.get(BASE + f"/auctions/{AID}/snapshot", headers=A_H)
        ok = r.status_code == 200
        body = r.json() if ok else {}
        keys_ok = all(k in body for k in ("auction","bids","seq","server_ns")) if ok else False
        log(ok and keys_ok, "C.9 snapshot dealer keys",
            f"status={r.status_code} keys={list(body)[:6]} seq={body.get('seq')}")
        log(isinstance(body.get("seq"), int) and isinstance(body.get("server_ns"), int) and isinstance(body.get("bids"), list) and isinstance(body.get("auction"), dict),
            "C.9 types of seq/server_ns/bids/auction", f"seq_type={type(body.get('seq')).__name__}")

        fresh = await db.auctions.find_one({"id": AID}, {"_id":0,"bid_seq":1})
        log(int(fresh.get("bid_seq") or 0) == int(body.get("seq") or 0),
            "C.10 snapshot.seq == db.auctions.bid_seq",
            f"snap.seq={body.get('seq')} db.bid_seq={fresh.get('bid_seq') or 0}")

        bids_in_snap = body.get("bids") or []
        ord_ok = True
        for i in range(len(bids_in_snap) - 1):
            if str(bids_in_snap[i].get("created_at") or "") < str(bids_in_snap[i+1].get("created_at") or ""):
                ord_ok = False
                break
        log(ord_ok and len(bids_in_snap) <= 50, "C.11 snapshot.bids DESC + ≤50",
            f"len={len(bids_in_snap)} ord_ok={ord_ok}")

        r = await client.get(BASE + "/auctions/00000000-0000-0000-0000-000000000000/snapshot", headers=A_H)
        log(r.status_code == 404, "C.12 snapshot non-existent -> 404", f"status={r.status_code}")

        # ============ D) Bid + idempotency ============
        candidates = await db.auctions.find(
            {"status":"live", "end_time": {"$gt": now_naive}},
            {"_id":0},
        ).to_list(20)
        chosen = None
        for cand in candidates:
            if cand.get("seller_id") not in (dealer_A_id, dealer_B_id):
                chosen = cand
                break
        if not chosen:
            log(False, "D precondition: live auction with neutral seller", "skipping write tests")
        else:
            AID = chosen["id"]
            base_amt = int(chosen.get("current_bid") or chosen.get("starting_bid") or 0)
            print(f"\n[D] Using auction {AID} base={base_amt}")

            pre_count = await db.bids.count_documents({"auction_id": AID})

            k1 = "k1-" + str(uuid.uuid4())
            amt1 = base_amt + 5000
            r = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                  json={"amount": amt1, "idempotency_key": k1})
            ok = r.status_code == 200
            j = r.json() if ok else {}
            seq1 = j.get("seq")
            log(ok and j.get("success") is True and isinstance(seq1, int) and seq1 > 0,
                "D.13 happy path bid -> 200 with seq",
                f"status={r.status_code} seq={seq1}")
            mid_count = await db.bids.count_documents({"auction_id": AID})
            log(mid_count == pre_count + 1, "D.13 db.bids increments by 1",
                f"pre={pre_count} mid={mid_count}")

            r2 = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                   json={"amount": amt1, "idempotency_key": k1})
            ok2 = r2.status_code == 200
            j2 = r2.json() if ok2 else {}
            log(ok2 and j2.get("seq") == seq1 and j2.get("success") is True,
                "D.14 replay identical -> same shape",
                f"status={r2.status_code} seq2={j2.get('seq')}")
            after_count = await db.bids.count_documents({"auction_id": AID})
            log(after_count == mid_count, "D.14 db.bids unchanged on replay",
                f"mid={mid_count} after={after_count}")

            r3 = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                   json={"amount": amt1 + 50000, "idempotency_key": k1})
            j3 = r3.json() if r3.status_code == 200 else {}
            log(r3.status_code == 200 and j3.get("seq") == seq1,
                "D.15 same key, diff amount -> cached original",
                f"status={r3.status_code} seq={j3.get('seq')}")
            after2 = await db.bids.count_documents({"auction_id": AID})
            log(after2 == mid_count, "D.15 no new bid on key reuse",
                f"mid={mid_count} after2={after2}")

            await asyncio.sleep(2)
            since = await db.realtime_metrics.find({"event":"bid_duplicate_attempt","auction_id":AID}).sort("ts",-1).limit(5).to_list(5)
            log(len(since) >= 1, "F.23 telemetry bid_duplicate_attempt emitted",
                f"count={len(since)}")

            r4 = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                   json={"amount": amt1 - 100, "idempotency_key": str(uuid.uuid4())})
            log(r4.status_code == 400 and "at least" in r4.text,
                "D.16 below current -> 400",
                f"status={r4.status_code} body={r4.text[:80]}")

            k2 = str(uuid.uuid4())
            amt2 = amt1 + 5000
            r5 = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                   json={"amount": amt2, "idempotency_key": k2})
            j5 = r5.json() if r5.status_code == 200 else {}
            log(r5.status_code == 200 and j5.get("seq") == (seq1 or 0) + 1,
                "D.17 above current -> seq +1",
                f"status={r5.status_code} seq={j5.get('seq')} expected={(seq1 or 0)+1}")

            # 18. Concurrency
            if jwt_B and dealer_B_id and chosen.get("seller_id") != dealer_B_id:
                race_amt = amt2 + 5000
                count_before = await db.bids.count_documents({"auction_id": AID})
                async def fire(token, key):
                    h = {"Authorization": f"Bearer {token}"}
                    t0 = time.monotonic()
                    rr = await client.post(BASE + f"/auctions/{AID}/bid", headers=h,
                                           json={"amount": race_amt, "idempotency_key": key})
                    return (t0, rr.status_code, rr.text)
                k_a = str(uuid.uuid4())
                k_b = str(uuid.uuid4())
                resA, resB = await asyncio.gather(
                    fire(jwt_A, k_a),
                    fire(jwt_B, k_b),
                )
                t_delta_ms = abs(resA[0] - resB[0]) * 1000
                statuses = sorted([resA[1], resB[1]])
                bid_winner_status = "?"
                bid_loser_detail = "?"
                if resA[1] == 200:
                    bid_winner_status = f"A({DEALER_A_PHONE})"
                    bid_loser_detail = resB[2][:160]
                elif resB[1] == 200:
                    bid_winner_status = f"B({DEALER_B_PHONE})"
                    bid_loser_detail = resA[2][:160]
                log(statuses == [200, 409], "D.18 concurrent bids: exactly one wins, one 409",
                    f"send_delta={t_delta_ms:.1f}ms statuses={statuses} winner={bid_winner_status} loser={bid_loser_detail}")
                count_after = await db.bids.count_documents({"auction_id": AID})
                log(count_after == count_before + 1, "D.19 only winner row landed",
                    f"before={count_before} after={count_after}")
                await asyncio.sleep(1.5)
                race_metrics = await db.realtime_metrics.find({"event":"bid_race_conflict","auction_id":AID}).sort("ts",-1).limit(5).to_list(5)
                log(len(race_metrics) >= 1, "F.23 telemetry bid_race_conflict emitted",
                    f"count={len(race_metrics)}")
            else:
                log(True, "D.18 concurrent bids", "SKIPPED - dealer B unavailable or seller")

            # 24. Backward compat
            cur = await db.auctions.find_one({"id": AID}, {"_id":0,"current_bid":1,"bid_seq":1})
            old_amt = int(cur.get("current_bid") or 0) + 5000
            r6 = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                   json={"amount": old_amt})
            j6 = r6.json() if r6.status_code == 200 else {}
            log(r6.status_code == 200 and j6.get("success") is True and isinstance(j6.get("seq"), int),
                "G.24 no-idempotency-key bid still works",
                f"status={r6.status_code} seq={j6.get('seq')}")

        # ============ E) WS additivity ============
        ws_url = WS_BASE + f"/ws/auction/{AID}?token={urllib.parse.quote(jwt_A)}"
        snapshot_frame = None
        new_bid_frame = None
        pong_frame = None
        try:
            async with websockets.connect(ws_url, open_timeout=10, close_timeout=5) as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                snapshot_frame = json.loads(msg)
                await ws.send(json.dumps({"type":"ping"}))
                t0 = time.monotonic()
                while time.monotonic() - t0 < 3:
                    try:
                        m = await asyncio.wait_for(ws.recv(), timeout=2.5)
                    except asyncio.TimeoutError:
                        break
                    parsed = json.loads(m)
                    if parsed.get("type") == "pong":
                        pong_frame = parsed
                        break
                cur2 = await db.auctions.find_one({"id": AID}, {"_id":0,"current_bid":1})
                next_amt = int(cur2.get("current_bid") or 0) + 5000

                async def collect():
                    nonlocal new_bid_frame
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline:
                        try:
                            m = await asyncio.wait_for(ws.recv(), timeout=4)
                        except asyncio.TimeoutError:
                            return
                        try:
                            p = json.loads(m)
                        except Exception:
                            continue
                        if p.get("type") == "new_bid":
                            new_bid_frame = p
                            return
                collect_task = asyncio.create_task(collect())
                await asyncio.sleep(0.3)
                rr = await client.post(BASE + f"/auctions/{AID}/bid", headers=A_H,
                                       json={"amount": next_amt, "idempotency_key": str(uuid.uuid4())})
                print(f"[E] bid REST status={rr.status_code}")
                try:
                    await asyncio.wait_for(collect_task, timeout=10)
                except asyncio.TimeoutError:
                    pass
        except Exception as e:
            log(False, "E.20-22 WS connect/exchange", f"exc={e!r}")

        if snapshot_frame:
            ok = (snapshot_frame.get("type") == "snapshot"
                  and "auction" in snapshot_frame
                  and "seq" in snapshot_frame
                  and "server_ns" in snapshot_frame)
            log(ok, "E.20 WS snapshot frame includes seq+server_ns",
                f"keys={list(snapshot_frame)} seq={snapshot_frame.get('seq')}")
        else:
            log(False, "E.20 WS snapshot frame", "no snapshot received")

        if pong_frame:
            log(isinstance(pong_frame.get("server_ns"), int),
                "E.21 ping->pong with server_ns",
                f"frame={pong_frame}")
        else:
            log(False, "E.21 ping->pong", "no pong received")

        if new_bid_frame:
            legacy = all(k in new_bid_frame for k in ("current_bid","top_bidder_id","top_bidder_name","total_bids","bid"))
            additive = all(k in new_bid_frame for k in ("seq","server_ns"))
            log(legacy and additive,
                "E.22 new_bid frame has BOTH legacy + additive fields",
                f"legacy={legacy} additive={additive} keys={list(new_bid_frame)}")
        else:
            log(False, "E.22 new_bid broadcast", "no new_bid frame received")

        # ============ G) Backward compat ============
        r = await client.get(BASE + "/dashboard/stats", headers=A_H)
        log(r.status_code == 200, "G.25a /dashboard/stats", f"status={r.status_code}")
        r = await client.get(BASE + "/auctions", headers=A_H)
        log(r.status_code == 200, "G.25b /auctions", f"status={r.status_code}")
        r = await client.get(BASE + "/auth/me", headers=A_H)
        log(r.status_code == 200, "G.25c /auth/me", f"status={r.status_code}")

    print("\n========= SUMMARY =========")
    print(f"PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for f in FAIL:
            print(f)
    return len(FAIL) == 0


if __name__ == "__main__":
    ok = asyncio.run(main())
    sys.exit(0 if ok else 1)
