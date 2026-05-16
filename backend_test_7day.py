"""
End-to-end test: 7-day auction duration option.
Target: http://localhost:8001/api
Operator: +918977986662 (super_admin via ADMIN_PHONES bootstrap)
DEV_BYPASS_OTP=true · OTP=123456
"""
import io
import json
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

BASE_URL = "http://localhost:8001/api"
OPERATOR_PHONE = "+918977986662"
OTP = "123456"

# 7 days = 7 * 24 * 60 = 10080 minutes
# 14 days = 20160 minutes
SEVEN_DAYS_MIN = 7 * 24 * 60
FOURTEEN_DAYS_MIN = 14 * 24 * 60


def _make_jpeg() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (200, 100, 50)).save(buf, format="JPEG", quality=70)
    return buf.getvalue()


JPEG_BYTES = _make_jpeg()


results: list = []


def record(step: str, status: int, verdict: str, body: Any = None, notes: str = ""):
    results.append({"step": step, "http": status, "verdict": verdict, "notes": notes})
    icon = "✅" if verdict == "PASS" else "❌"
    print(f"\n{icon} [{verdict}] {step} → HTTP {status}")
    if notes:
        print(f"    {notes}")
    if isinstance(body, (dict, list)):
        try:
            print("    body:", json.dumps(body, default=str)[:600])
        except Exception:
            print("    body (repr):", repr(body)[:600])


def parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def make_car_payload(reg: str, duration: int) -> Dict[str, Any]:
    return {
        "registration_number": reg,
        "make": "Hyundai",
        "model": "Creta",
        "variant": "SX(O)",
        "year": 2022,
        "manufacturing_year": 2022,
        "registration_year": 2022,
        "fuel_type": "Diesel",
        "transmission": "Automatic",
        "km_driven": 45000,
        "color": "Phantom Black",
        "owners": 1,
        "insurance_validity": "10/2026",
        "rto_details": "MH02 Mumbai West",
        "notes": "7-day duration test",
        "starting_bid": 850000,
        "reserve_price": 1050000,
        "duration_minutes": duration,
        "images": [],
        "description": "7-day duration QA test listing",
    }


def upload_three_media_and_feature(c: httpx.Client, car_id: str, auth: Dict[str, str]) -> bool:
    mids = []
    for i in range(3):
        files = {"file": (f"exterior_{i}.jpg", JPEG_BYTES, "image/jpeg")}
        data = {"car_id": car_id, "section": "exterior", "width": "32", "height": "32"}
        r = c.post("/media/upload", data=data, files=files, headers=auth)
        if r.status_code != 200:
            print(f"   media upload {i} failed: {r.status_code} {r.text[:200]}")
            return False
        j = r.json()
        mid = j.get("media_id") or j.get("id")
        if not mid:
            return False
        mids.append(mid)
    r = c.post(f"/cars/{car_id}/media/featured/{mids[0]}", headers=auth)
    return r.status_code == 200


# ── Step 0: operator login ───────────────────────────────────────────
with httpx.Client(base_url=BASE_URL, timeout=30.0) as c:
    r = c.post("/auth/operator/send-otp", json={"phone": OPERATOR_PHONE})
    if r.status_code != 200:
        print("FATAL: operator send-otp failed:", r.status_code, r.text[:300])
        sys.exit(1)
    r = c.post("/auth/operator/verify-otp", json={"phone": OPERATOR_PHONE, "otp": OTP})
    if r.status_code != 200:
        print("FATAL: operator verify-otp failed:", r.status_code, r.text[:300])
        sys.exit(1)
    j = r.json()
    token = j.get("token") or j.get("access_token")
    dealer = j.get("dealer") or {}
    if not token or dealer.get("role") not in ("super_admin", "admin"):
        print("FATAL: no operator token. dealer:", dealer)
        sys.exit(1)
    auth = {"Authorization": f"Bearer {token}"}
    print(f"✅ Operator login OK  · dealer.id={dealer.get('id')}  role={dealer.get('role')}")

    # ──── TEST 1: 7-day draft creation ────────────────────────────────
    payload = make_car_payload(f"MH02DR{uuid.uuid4().hex[:4].upper()}", SEVEN_DAYS_MIN)
    r = c.post("/cars", json=payload, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    car = j.get("car") or {}
    auction = j.get("auction") or {}
    seven_day_car_id = car.get("id")
    seven_day_auction_id = auction.get("id")
    a_status = auction.get("status")
    a_start = parse_iso(auction.get("start_time"))
    a_end = parse_iso(auction.get("end_time"))
    delta_days = (a_end - a_start).total_seconds() / 86400 if (a_start and a_end) else None
    ok = (r.status_code == 200 and bool(seven_day_auction_id) and a_status == "draft"
          and delta_days is not None and abs(delta_days - 7.0) < 0.01)
    record("TEST 1 · POST /cars duration_minutes=10080 → draft, ~7d window",
           r.status_code, "PASS" if ok else "FAIL",
           {"auction_id": seven_day_auction_id, "status": a_status,
            "delta_days_from_payload": delta_days},
           notes=f"draft auction created, end-start={delta_days}d")
    if not seven_day_auction_id:
        print("FATAL: cannot continue — no draft auction created")
        sys.exit(1)

    # ──── TEST 2: Duration bounds enforcement ─────────────────────────
    # 2a: 4 → 422 (below ge=5)
    r = c.post("/cars", json=make_car_payload("MH02LO0001", 4), headers=auth)
    ok = r.status_code == 422
    record("TEST 2a · duration_minutes=4 → 422 (below min=5)",
           r.status_code, "PASS" if ok else "FAIL",
           {"detail": r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]})

    # 2b: 20161 → 422 (above le=20160)
    r = c.post("/cars", json=make_car_payload("MH02HI0001", FOURTEEN_DAYS_MIN + 1), headers=auth)
    ok = r.status_code == 422
    record("TEST 2b · duration_minutes=20161 → 422 (above max=20160)",
           r.status_code, "PASS" if ok else "FAIL",
           {"detail": r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]})

    # 2c: 20160 → 200 (boundary exact)
    payload2c = make_car_payload(f"MH02BD{uuid.uuid4().hex[:4].upper()}", FOURTEEN_DAYS_MIN)
    r = c.post("/cars", json=payload2c, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    auction2c = j.get("auction") or {}
    a_start = parse_iso(auction2c.get("start_time"))
    a_end = parse_iso(auction2c.get("end_time"))
    delta_days_2c = (a_end - a_start).total_seconds() / 86400 if (a_start and a_end) else None
    ok = (r.status_code == 200 and auction2c.get("status") == "draft"
          and delta_days_2c is not None and abs(delta_days_2c - 14.0) < 0.01)
    record("TEST 2c · duration_minutes=20160 → 200 (boundary, 14d window)",
           r.status_code, "PASS" if ok else "FAIL",
           {"auction_id": auction2c.get("id"), "status": auction2c.get("status"), "delta_days": delta_days_2c})

    # ──── TEST 3: Launch the 7-day auction ────────────────────────────
    if not upload_three_media_and_feature(c, seven_day_car_id, auth):
        print("FATAL: media upload for 7-day auction failed")
        sys.exit(1)
    pre_launch_t = datetime.now(timezone.utc)
    r = c.post(f"/admin/auctions/{seven_day_auction_id}/launch", json={}, headers=auth)
    post_launch_t = datetime.now(timezone.utc)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    a3 = j.get("auction") or {}
    s3 = parse_iso(a3.get("start_time"))
    e3 = parse_iso(a3.get("end_time"))
    delta_sec = (e3 - s3).total_seconds() if (s3 and e3) else None
    delta_days_3 = delta_sec / 86400 if delta_sec else None
    expected_sec = 7 * 86400  # 604800
    # tolerance 60 seconds for launch round-trip
    ok = (r.status_code == 200 and a3.get("status") == "live"
          and delta_sec is not None and abs(delta_sec - expected_sec) <= 60)
    record("TEST 3 · POST /launch {} on 7-day draft → live, ~7d window",
           r.status_code, "PASS" if ok else "FAIL",
           {"status": a3.get("status"), "delta_sec": delta_sec,
            "delta_days": delta_days_3, "expected_sec": expected_sec},
           notes=f"|delta-7d|={abs(delta_sec - expected_sec) if delta_sec else 'N/A'}s (≤60s tol)")

    # ──── TEST 4: Launch with duration_minutes override ──────────────
    # Create another 60-min draft → launch with override 10080 → expect ~7d
    payload4 = make_car_payload(f"MH02OV{uuid.uuid4().hex[:4].upper()}", 60)
    r = c.post("/cars", json=payload4, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    car4 = j.get("car") or {}
    aux4 = j.get("auction") or {}
    car4_id = car4.get("id")
    a4_id = aux4.get("id")
    if not a4_id or not upload_three_media_and_feature(c, car4_id, auth):
        print("FATAL: setup for override launch failed")
        sys.exit(1)

    r = c.post(f"/admin/auctions/{a4_id}/launch", json={"duration_minutes": SEVEN_DAYS_MIN}, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    a4 = j.get("auction") or {}
    s4 = parse_iso(a4.get("start_time"))
    e4 = parse_iso(a4.get("end_time"))
    delta_sec_4 = (e4 - s4).total_seconds() if (s4 and e4) else None
    ok = (r.status_code == 200 and a4.get("status") == "live"
          and delta_sec_4 is not None and abs(delta_sec_4 - expected_sec) <= 60)
    record("TEST 4a · /launch {duration_minutes:10080} override 60-min draft → ~7d",
           r.status_code, "PASS" if ok else "FAIL",
           {"status": a4.get("status"), "delta_sec": delta_sec_4})

    # 4b: override below min → 422 (need a fresh draft for unready check; but the
    # bound is on the request body Pydantic Field, so it should 422 BEFORE state-checks).
    # Create a fresh draft to call with bad override.
    payload4b = make_car_payload(f"MH02LB{uuid.uuid4().hex[:4].upper()}", 60)
    r_make = c.post("/cars", json=payload4b, headers=auth)
    a4b_id = (r_make.json().get("auction") or {}).get("id")
    car4b_id = (r_make.json().get("car") or {}).get("id")
    # Need media+featured otherwise readiness check runs first;
    # but Pydantic validation on body runs before any handler logic, so it should still 422 immediately.
    r = c.post(f"/admin/auctions/{a4b_id}/launch", json={"duration_minutes": 1}, headers=auth)
    ok = r.status_code == 422
    record("TEST 4b · /launch {duration_minutes:1} → 422 (below min)",
           r.status_code, "PASS" if ok else "FAIL",
           {"detail": r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]})

    # 4c: override above max → 422
    r = c.post(f"/admin/auctions/{a4b_id}/launch", json={"duration_minutes": 30000}, headers=auth)
    ok = r.status_code == 422
    record("TEST 4c · /launch {duration_minutes:30000} → 422 (above max)",
           r.status_code, "PASS" if ok else "FAIL",
           {"detail": r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]})

    # ──── TEST 5: seconds_remaining exposes long window ──────────────
    r = c.get(f"/auctions/{seven_day_auction_id}")
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    sec_rem = j.get("seconds_remaining")
    expected = 7 * 86400  # 604800
    ok = (r.status_code == 200 and isinstance(sec_rem, int)
          and sec_rem > 0 and abs(sec_rem - expected) <= 60)
    record("TEST 5 · GET /auctions/{7day_id} seconds_remaining ≈ 604,800",
           r.status_code, "PASS" if ok else "FAIL",
           {"seconds_remaining": sec_rem, "expected": expected,
            "diff_sec": (sec_rem - expected) if isinstance(sec_rem, int) else None})

    # ──── TEST 6: Snapshot still works for long auctions ─────────────
    # /auctions/{id}/snapshot requires dealer auth (any authenticated user)
    r = c.get(f"/auctions/{seven_day_auction_id}/snapshot", headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    snap_auction = j.get("auction") or {}
    end_t = snap_auction.get("end_time")
    seq = j.get("seq")
    bid_seq_present = seq is not None  # may be 0 for no bids
    ok = (r.status_code == 200 and bool(end_t) and bid_seq_present)
    record("TEST 6 · GET /auctions/{7day_id}/snapshot → 200 with end_time + bid_seq",
           r.status_code, "PASS" if ok else "FAIL",
           {"end_time": end_t, "seq": seq, "snap_keys": list(j.keys()) if isinstance(j, dict) else None})

    # ──── TEST 7: 7-day auction visible in dealer marketplace + sortable ──
    r_anon = httpx.get(f"{BASE_URL}/auctions", timeout=30.0)
    j = r_anon.json() if r_anon.headers.get("content-type", "").startswith("application/json") else []
    items = j if isinstance(j, list) else []
    ids = [a.get("id") for a in items if isinstance(a, dict)]
    present = seven_day_auction_id in ids
    # Verify sorted by start_time desc (allow ties)
    start_times = []
    for a in items:
        if isinstance(a, dict):
            st = parse_iso(a.get("start_time"))
            if st:
                start_times.append(st)
    sorted_desc = all(start_times[i] >= start_times[i + 1] for i in range(len(start_times) - 1)) if start_times else True
    ok = r_anon.status_code == 200 and present and sorted_desc
    record("TEST 7 · GET /auctions anon → 7-day auction present + sorted start_time DESC",
           r_anon.status_code, "PASS" if ok else "FAIL",
           {"items_count": len(ids), "7day_present": present, "sorted_desc": sorted_desc})

    # ──── TEST 8: regression — short-duration (30-min) auction still works ──
    payload8 = make_car_payload(f"MH02SH{uuid.uuid4().hex[:4].upper()}", 30)
    r = c.post("/cars", json=payload8, headers=auth)
    j = r.json()
    car8_id = (j.get("car") or {}).get("id")
    a8_id = (j.get("auction") or {}).get("id")
    if not a8_id or not upload_three_media_and_feature(c, car8_id, auth):
        record("TEST 8 · 30-min regression setup", 0, "FAIL", notes="couldn't prep media")
    else:
        r = c.post(f"/admin/auctions/{a8_id}/launch", json={}, headers=auth)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        a8 = j.get("auction") or {}
        s8 = parse_iso(a8.get("start_time"))
        e8 = parse_iso(a8.get("end_time"))
        d8 = (e8 - s8).total_seconds() if (s8 and e8) else None
        expected_30 = 30 * 60
        ok = (r.status_code == 200 and a8.get("status") == "live"
              and d8 is not None and abs(d8 - expected_30) <= 60)
        record("TEST 8 · 30-min auction regression: launched live, ~30-min window",
               r.status_code, "PASS" if ok else "FAIL",
               {"status": a8.get("status"), "delta_sec": d8, "expected": expected_30})


print("\n" + "=" * 72)
print("FINAL SUMMARY — 7-day auction duration option")
print("=" * 72)
passes = sum(1 for r in results if r["verdict"] == "PASS")
fails = sum(1 for r in results if r["verdict"] == "FAIL")
for r in results:
    print(f"  {r['verdict']:4} | HTTP {r['http']:>3} | {r['step']}")
print(f"\nTOTAL: {passes} PASS / {fails} FAIL out of {len(results)}")
sys.exit(0 if fails == 0 else 1)
