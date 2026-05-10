"""Targeted backend test for GET /api/admin/realtime/health expanded shape.

Covers H1..H7 from the targeted review request.
Uses DEV_BYPASS_OTP=true to mint dealer + operator JWTs.
"""
import os
import sys
import time
import json
from datetime import datetime, timezone

import requests
from pymongo import MongoClient

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
DEALER_PHONE = "+919900000001"  # pre-seeded approved dealer
OPERATOR_PHONE = "+918977986662"  # operator (Nihad M)

PASS = "PASS"
FAIL = "FAIL"
results = []


def record(name, ok, detail=""):
    results.append((name, PASS if ok else FAIL, detail))
    print(f"[{PASS if ok else FAIL}] {name} :: {detail}")


def verify_otp(role, phone):
    url = f"{BASE}/auth/{role}/verify-otp"
    r = requests.post(url, json={"phone": phone, "otp": "123456"}, timeout=15)
    if r.status_code != 200:
        print(f"verify-otp({role},{phone}) -> {r.status_code}: {r.text}")
        return None
    return r.json().get("token")


def main():
    # Acquire JWTs
    dealer_token = verify_otp("dealer", DEALER_PHONE)
    operator_token = verify_otp("operator", OPERATOR_PHONE)
    if not operator_token:
        print("FATAL: cannot obtain operator JWT — DEV_BYPASS_OTP probably still false")
        sys.exit(1)
    if not dealer_token:
        print("FATAL: cannot obtain dealer JWT")
        sys.exit(1)

    health_url = f"{BASE}/admin/realtime/health"

    # H1: no auth -> 401
    r = requests.get(health_url, timeout=15)
    record("H1 anon -> 401", r.status_code == 401, f"got {r.status_code}: {r.text[:120]}")

    # H2: dealer JWT -> 403
    r = requests.get(health_url, headers={"Authorization": f"Bearer {dealer_token}"}, timeout=15)
    record("H2 dealer -> 403", r.status_code == 403, f"got {r.status_code}: {r.text[:120]}")

    # H3: operator JWT -> 200 + full shape
    t0 = time.time()
    r = requests.get(health_url, headers={"Authorization": f"Bearer {operator_token}"}, timeout=15)
    elapsed = time.time() - t0
    if r.status_code != 200:
        record("H3 operator -> 200", False, f"got {r.status_code}: {r.text[:200]}")
        return summarize()
    payload = r.json()
    expected_keys = {
        "live_ws", "rooms", "events_1h", "active_storms",
        "race_top_auctions", "close_races_1h", "broadcast_lag_ms",
        "auctions", "alerts", "thresholds", "server_ns", "generated_at",
    }
    missing = expected_keys - set(payload.keys())
    record("H3 operator -> 200 + all keys present", not missing,
           f"missing={missing} keys_observed={sorted(payload.keys())}")

    # Type checks
    ok_live = isinstance(payload.get("live_ws"), int) and payload["live_ws"] >= 0
    record("H3 live_ws non-negative int", ok_live, f"live_ws={payload.get('live_ws')!r}")

    ok_rooms = isinstance(payload.get("rooms"), list)
    record("H3 rooms is array", ok_rooms, f"type={type(payload.get('rooms')).__name__}")
    if ok_rooms and payload["rooms"]:
        sample = payload["rooms"][0]
        ok_room_shape = isinstance(sample.get("room"), str) and isinstance(sample.get("count"), int) and isinstance(sample.get("roles"), list)
        record("H3 rooms[*] shape", ok_room_shape, f"sample={sample}")

    ok_events = isinstance(payload.get("events_1h"), dict) and all(isinstance(v, int) for v in payload["events_1h"].values())
    record("H3 events_1h dict<str,int>", ok_events, f"events_1h={payload.get('events_1h')}")

    ok_storms = isinstance(payload.get("active_storms"), list)
    record("H3 active_storms is array", ok_storms, f"len={len(payload.get('active_storms', []))}")

    ok_race = isinstance(payload.get("race_top_auctions"), list)
    record("H3 race_top_auctions is array", ok_race, f"len={len(payload.get('race_top_auctions', []))}")

    ok_close = isinstance(payload.get("close_races_1h"), list)
    record("H3 close_races_1h is array", ok_close, f"len={len(payload.get('close_races_1h', []))}")

    blm = payload.get("broadcast_lag_ms")
    ok_blm = (isinstance(blm, dict) and isinstance(blm.get("samples"), int)
              and (blm.get("p50") is None or isinstance(blm.get("p50"), int))
              and (blm.get("p95") is None or isinstance(blm.get("p95"), int))
              and (blm.get("max") is None or isinstance(blm.get("max"), int)))
    record("H3 broadcast_lag_ms object (not null)", isinstance(blm, dict), f"broadcast_lag_ms={blm}")
    record("H3 broadcast_lag_ms shape", ok_blm, f"broadcast_lag_ms={blm}")

    auctions = payload.get("auctions")
    ok_auctions = (isinstance(auctions, dict)
                   and isinstance(auctions.get("live"), int) and auctions["live"] >= 0
                   and isinstance(auctions.get("ending_in_5m"), int) and auctions["ending_in_5m"] >= 0
                   and isinstance(auctions.get("paused"), int) and auctions["paused"] >= 0)
    record("H3 auctions object (not null) + non-neg ints", ok_auctions, f"auctions={auctions}")

    alerts = payload.get("alerts")
    ok_alerts = isinstance(alerts, list)
    record("H3 alerts is array (may be empty)", ok_alerts, f"alerts_len={len(alerts) if ok_alerts else 'NA'}")
    if ok_alerts:
        for a in alerts:
            if not (isinstance(a, dict) and isinstance(a.get("id"), str)
                    and a.get("severity") in ("critical", "warn", "info")
                    and isinstance(a.get("title"), str) and isinstance(a.get("detail"), str)
                    and (a.get("route") is None or isinstance(a.get("route"), str))):
                record("H3 alert item shape", False, f"bad item={a}")
                break
        else:
            record("H3 alert items shape (each)", True, f"all {len(alerts)} alerts well-typed")

    th = payload.get("thresholds")
    ok_th = (isinstance(th, dict)
             and isinstance(th.get("broadcast_lag_spike_ms"), int)
             and isinstance(th.get("reconnect_storm"), int)
             and isinstance(th.get("auction_close_race_window_ms"), int)
             and isinstance(th.get("race_spike_alert_1h"), int))
    record("H3 thresholds object (not null) + ints", ok_th, f"thresholds={th}")

    ok_ns = isinstance(payload.get("server_ns"), int) and payload["server_ns"] > 0
    record("H3 server_ns positive int", ok_ns, f"server_ns={payload.get('server_ns')}")

    ga = payload.get("generated_at")
    ok_ga = False
    if isinstance(ga, str):
        try:
            datetime.fromisoformat(ga.replace("Z", "+00:00"))
            ok_ga = True
        except Exception:
            ok_ga = False
    record("H3 generated_at is ISO-ish string", ok_ga, f"generated_at={ga!r}")

    # H4: live count >= 1 and ending_in_5m / paused are non-negative ints (already checked)
    # Verify there's at least one live auction in DB for sanity
    live_count = auctions.get("live") if isinstance(auctions, dict) else 0
    record("H4 auctions.live >= 1 (active live auction in DB)", live_count >= 1,
           f"live={live_count} (if 0, no live auctions are seeded)")
    record("H4 ending_in_5m non-neg int", isinstance(auctions.get("ending_in_5m"), int) and auctions["ending_in_5m"] >= 0,
           f"ending_in_5m={auctions.get('ending_in_5m')}")
    record("H4 paused non-neg int", isinstance(auctions.get("paused"), int) and auctions["paused"] >= 0,
           f"paused={auctions.get('paused')}")

    # H5: insert 12 bid_race_conflict events directly into db.realtime_metrics → expect race_spike alert
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "qdrives_db")
    client = MongoClient(mongo_url)
    rt_coll = client[db_name]["realtime_metrics"]
    now = datetime.now(timezone.utc)
    docs = [
        {"event": "bid_race_conflict", "ts": now, "auction_id": f"test_auction_{i}", "dealer_id": f"test_dealer_{i}"}
        for i in range(12)
    ]
    inserted = rt_coll.insert_many(docs)
    inserted_ids = inserted.inserted_ids
    try:
        # re-fetch health
        r2 = requests.get(health_url, headers={"Authorization": f"Bearer {operator_token}"}, timeout=15)
        if r2.status_code != 200:
            record("H5 race_spike alert", False, f"health 2nd call status={r2.status_code}")
        else:
            p2 = r2.json()
            events = p2.get("events_1h", {})
            race_count = events.get("bid_race_conflict", 0)
            alerts2 = p2.get("alerts", [])
            race_alert = next((a for a in alerts2 if a.get("id") == "race_spike"), None)
            ok = race_alert is not None and race_alert.get("severity") == "warn"
            record("H5 race_spike alert with severity=warn (after 12 conflicts)", ok,
                   f"events_1h.bid_race_conflict={race_count}, race_alert={race_alert}")
    finally:
        # Cleanup test docs
        rt_coll.delete_many({"_id": {"$in": inserted_ids}})

    # H6: <2s on warm cache
    t0 = time.time()
    r3 = requests.get(health_url, headers={"Authorization": f"Bearer {operator_token}"}, timeout=15)
    elapsed3 = time.time() - t0
    record("H6 endpoint completes < 2s warm", elapsed3 < 2.0 and r3.status_code == 200,
           f"elapsed={elapsed3:.3f}s status={r3.status_code}")

    # H7: legacy keys present
    p3 = r3.json() if r3.status_code == 200 else {}
    legacy_keys = {"live_ws", "rooms", "events_1h", "thresholds"}
    missing_legacy = legacy_keys - set(p3.keys())
    record("H7 legacy keys still present", not missing_legacy,
           f"missing={missing_legacy}")

    summarize()


def summarize():
    print("\n===== SUMMARY =====")
    fails = [r for r in results if r[1] == FAIL]
    print(f"Total: {len(results)} | Pass: {len(results)-len(fails)} | Fail: {len(fails)}")
    if fails:
        print("\nFailures:")
        for n, _, d in fails:
            print(f"  - {n} :: {d}")
    return len(fails) == 0


if __name__ == "__main__":
    main()
