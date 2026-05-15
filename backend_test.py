"""
End-to-end test: Operator Draft -> Launch pipeline (13 steps).
Target: http://localhost:8001/api (per review request).
Operator: +918977986662 (super_admin, ADMIN_PHONES bootstrap).
DEV_BYPASS_OTP=true; OTP=123456.
"""
import io
import json
import sys
from typing import Any

import httpx

BASE_URL = "http://localhost:8001/api"
OPERATOR_PHONE = "+918977986662"
OTP = "123456"


def _make_jpeg() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (200, 100, 50)).save(buf, format="JPEG", quality=70)
    return buf.getvalue()


JPEG_BYTES = _make_jpeg()
print(f"JPEG sample: {len(JPEG_BYTES)} bytes, starts {JPEG_BYTES[:3]!r}")

results: list = []


def record(step: str, status: int, verdict: str, body: Any = None):
    results.append({"step": step, "http": status, "verdict": verdict})
    print(f"\n[{verdict}] {step} → HTTP {status}")
    if isinstance(body, (dict, list)):
        try:
            print("    body:", json.dumps(body, default=str)[:700])
        except Exception:
            print("    body (repr):", repr(body)[:700])


def fatal(msg: str):
    print(f"\n!! FATAL: {msg}")
    sys.exit(1)


with httpx.Client(base_url=BASE_URL, timeout=30.0) as c:
    # 1
    r = c.post("/auth/operator/send-otp", json={"phone": OPERATOR_PHONE})
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    ok = r.status_code == 200 and j.get("success") is True
    record("1. POST /auth/operator/send-otp", r.status_code, "PASS" if ok else "FAIL", j)
    if not ok:
        fatal("send-otp failed")

    # 2
    r = c.post("/auth/operator/verify-otp", json={"phone": OPERATOR_PHONE, "otp": OTP})
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    token = j.get("token") or j.get("access_token")
    dealer = j.get("dealer") or {}
    role = dealer.get("role")
    ok = r.status_code == 200 and bool(token) and role in ("admin", "super_admin", "operations_admin", "inspection_admin")
    record("2. POST /auth/operator/verify-otp", r.status_code, "PASS" if ok else "FAIL",
           {"role": role, "dealer_id": dealer.get("id"), "token_present": bool(token)})
    if not ok:
        fatal("verify-otp failed")
    auth = {"Authorization": f"Bearer {token}"}

    # 3
    payload = {
        "registration_number": "MH04XY5678",
        "make": "Toyota",
        "model": "Innova",
        "variant": "ZX",
        "year": 2021,
        "manufacturing_year": 2021,
        "registration_year": 2021,
        "fuel_type": "Diesel",
        "transmission": "Automatic",
        "km_driven": 38000,
        "color": "Silver",
        "owners": 2,
        "insurance_validity": "12/2026",
        "rto_details": "MH04 Pune Rural",
        "notes": "End-to-end launch test",
        "starting_bid": 900000,
        "reserve_price": 1100000,
        "duration_minutes": 60,
        "images": [],
        "description": "E2E launch test",
    }
    r = c.post("/cars", json=payload, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    car_id = (j.get("car") or {}).get("id")
    auction = j.get("auction") or {}
    auction_id = auction.get("id")
    auction_status = auction.get("status")
    ok = r.status_code == 200 and bool(car_id) and bool(auction_id) and auction_status == "draft"
    record("3. POST /cars (no launch_immediately)", r.status_code, "PASS" if ok else "FAIL",
           {"car_id": car_id, "auction_id": auction_id, "auction.status": auction_status})
    if not ok:
        fatal("POST /cars failed")

    # 4
    r = c.get("/auctions", params={"seller_id": "me"}, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else []
    items = j if isinstance(j, list) else []
    ids = [a.get("id") for a in items if isinstance(a, dict)]
    present = auction_id in ids
    ok = r.status_code == 200 and present
    record("4. GET /auctions?seller_id=me", r.status_code, "PASS" if ok else "FAIL",
           {"items_count": len(ids), "draft_present": present})

    # 5
    r = c.get(f"/admin/auctions/{auction_id}/launch-readiness", headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    ok = r.status_code == 200 and j.get("ready") is False and j.get("media_count") == 0 and isinstance(j.get("issues"), list) and len(j.get("issues")) > 0
    record("5. GET launch-readiness (empty)", r.status_code, "PASS" if ok else "FAIL", j)

    # 6
    r = c.post(f"/admin/auctions/{auction_id}/launch", json={}, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    detail = j.get("detail") or {}
    code = detail.get("code") if isinstance(detail, dict) else None
    issues_422 = detail.get("issues") if isinstance(detail, dict) else None
    ok = r.status_code == 422 and code == "LAUNCH_NOT_READY" and isinstance(issues_422, list) and len(issues_422) > 0
    record("6. POST /launch unready → 422", r.status_code, "PASS" if ok else "FAIL",
           {"code": code, "issues": issues_422})

    # 7 (×3)
    media_ids: list = []
    for i in range(3):
        files = {"file": (f"exterior_{i}.jpg", JPEG_BYTES, "image/jpeg")}
        data = {"car_id": car_id, "section": "exterior", "width": "32", "height": "32"}
        r = c.post("/media/upload", data=data, files=files, headers=auth)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        mid = j.get("media_id") or j.get("id")
        ok = r.status_code == 200 and bool(mid)
        record(f"7.{i+1} POST /media/upload", r.status_code, "PASS" if ok else "FAIL", j)
        if mid:
            media_ids.append(mid)
    if len(media_ids) < 3:
        fatal(f"only {len(media_ids)} media uploaded")

    # 8
    first_mid = media_ids[0]
    r = c.post(f"/cars/{car_id}/media/featured/{first_mid}", headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text
    ok = r.status_code == 200
    record("8. POST featured", r.status_code, "PASS" if ok else "FAIL", j if isinstance(j, dict) else {"raw": str(j)[:200]})

    # 9
    r = c.get(f"/admin/auctions/{auction_id}/launch-readiness", headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    ok = r.status_code == 200 and j.get("ready") is True
    record("9. GET launch-readiness (ready)", r.status_code, "PASS" if ok else "FAIL", j)

    # 10
    r = c.post(f"/admin/auctions/{auction_id}/launch", json={}, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    success = j.get("success")
    a = j.get("auction") or {}
    launched_at = j.get("launched_at") or a.get("launched_at")
    start_time = a.get("start_time")
    end_time = a.get("end_time")
    ok = (r.status_code == 200 and success is True and a.get("status") == "live"
          and bool(launched_at) and bool(start_time) and bool(end_time))
    record("10. POST /launch on ready → 200 live", r.status_code, "PASS" if ok else "FAIL",
           {"success": success, "auction.status": a.get("status"), "launched_at": launched_at,
            "start_time": start_time, "end_time": end_time})

    # 11
    r = c.post(f"/admin/auctions/{auction_id}/launch", json={}, headers=auth)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    detail = j.get("detail")
    detail_text = detail if isinstance(detail, str) else json.dumps(detail, default=str) if detail else ""
    ok = r.status_code == 409 and "no longer in draft" in detail_text.lower()
    record("11. POST /launch double → 409", r.status_code, "PASS" if ok else "FAIL", j)

# 12 + 13 anon
with httpx.Client(base_url=BASE_URL, timeout=30.0) as anon:
    r = anon.get("/auctions")
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else []
    items = j if isinstance(j, list) else []
    ids = [a.get("id") for a in items if isinstance(a, dict)]
    present = auction_id in ids
    ok = r.status_code == 200 and present
    record("12. GET /auctions (anon)", r.status_code, "PASS" if ok else "FAIL",
           {"items_count": len(ids), "launched_present": present})

    r = anon.get(f"/auctions/{auction_id}")
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    car = (j.get("car") or {}) if isinstance(j, dict) else {}
    media = car.get("media") or []
    images = car.get("images") or []
    ok = (r.status_code == 200 and j.get("status") == "live"
          and isinstance(media, list) and len(media) >= 1)
    record("13. GET /auctions/{id} (anon)", r.status_code, "PASS" if ok else "FAIL",
           {"status": j.get("status"), "car.media_count": len(media), "car.images_count": len(images)})

print("\n" + "=" * 70)
print("FINAL SUMMARY")
print("=" * 70)
passes = sum(1 for r in results if r["verdict"] == "PASS")
fails = sum(1 for r in results if r["verdict"] == "FAIL")
for r in results:
    print(f"  {r['verdict']:4} | HTTP {r['http']:>3} | {r['step']}")
print(f"\nTOTAL: {passes} PASS / {fails} FAIL out of {len(results)}")
sys.exit(0 if fails == 0 else 1)
