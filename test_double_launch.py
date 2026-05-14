"""Focused retest: double-launch idempotency for /api/admin/auctions/{id}/launch."""
import io
import os
import sys
import json
import time
import random
import string
import requests

BASE = "http://localhost:8001/api"
OPERATOR_PHONE = "+919900000099"


def rand_reg():
    return "MH" + "".join(random.choices(string.digits, k=2)) + "".join(random.choices(string.ascii_uppercase, k=2)) + "".join(random.choices(string.digits, k=4))


def login_operator(phone=OPERATOR_PHONE):
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=15)
    assert r.status_code == 200, f"send-otp failed: {r.status_code} {r.text}"
    r = requests.post(f"{BASE}/auth/operator/verify-otp", json={"phone": phone, "otp": "123456"}, timeout=15)
    assert r.status_code == 200, f"verify-otp failed: {r.status_code} {r.text}"
    data = r.json()
    return data["token"]


def make_jpeg_bytes():
    # Minimal real JPEG (1x1 white)
    # Use a tiny generated JPEG using stored bytes (precomputed)
    import base64
    b64 = ("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh"
           "0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIy"
           "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAA"
           "EDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIE"
           "AwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJi"
           "coKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWW"
           "l5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09f"
           "b3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQA"
           "AQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKj"
           "U2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJma"
           "oqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9"
           "oADAMBAAIRAxEAPwD3+iiigD//2Q==")
    return base64.b64decode(b64)


def main():
    print("== Double-launch idempotency retest ==")
    print(f"Backend: {BASE}")

    token = login_operator()
    print(f"[1] Operator authenticated: {OPERATOR_PHONE}")
    H = {"Authorization": f"Bearer {token}"}

    # 2) Create draft auction (launch_immediately=False)
    payload = {
        "registration_number": rand_reg(),
        "make": "Hyundai",
        "model": "Creta",
        "variant": "SX(O) Turbo",
        "year": 2023,
        "manufacturing_year": 2022,
        "registration_year": 2023,
        "fuel_type": "Petrol",
        "transmission": "Automatic",
        "km_driven": 24500,
        "color": "Phantom Black",
        "owners": 1,
        "insurance_validity": "08/2026",
        "rto_details": "MH02 - Mumbai West",
        "notes": "Single owner, comprehensive insurance valid.",
        "reserve_price": 1450000,
        "starting_bid": 1200000,
        "duration_minutes": 60,
        "launch_immediately": False,
    }
    r = requests.post(f"{BASE}/cars", json=payload, headers=H, timeout=20)
    assert r.status_code == 200, f"POST /cars failed: {r.status_code} {r.text}"
    body = r.json()
    car_id = body["car"]["id"]
    auction = body["auction"]
    auction_id = auction["id"]
    print(f"[2] Draft created: auction_id={auction_id} car_id={car_id} status={auction.get('status')}")

    # 3) Upload 3 media
    jpeg = make_jpeg_bytes()
    media_ids = []
    for i in range(3):
        files = {
            "file": (f"img{i}.jpg", io.BytesIO(jpeg), "image/jpeg"),
        }
        data = {
            "car_id": car_id,
            "section": "exterior",
        }
        r = requests.post(f"{BASE}/media/upload", data=data, files=files, headers=H, timeout=30)
        assert r.status_code == 200, f"media upload #{i} failed: {r.status_code} {r.text}"
        media_ids.append(r.json()["id"])
    print(f"[3] Uploaded {len(media_ids)} media items.")

    # 4) Set featured
    r = requests.post(f"{BASE}/cars/{car_id}/media/featured/{media_ids[0]}", headers=H, timeout=15)
    assert r.status_code == 200, f"set featured failed: {r.status_code} {r.text}"
    print(f"[4] Featured set: {media_ids[0]}")

    # 5) First launch — expect 200
    r1 = requests.post(f"{BASE}/admin/auctions/{auction_id}/launch", json={}, headers=H, timeout=15)
    print(f"[5] First launch: HTTP {r1.status_code} body={r1.text[:300]}")
    assert r1.status_code == 200, "First launch should be 200"
    j1 = r1.json()
    assert j1.get("success") is True
    assert j1.get("auction", {}).get("status") == "live", f"Expected live, got {j1.get('auction',{}).get('status')}"

    # 6) ** CRITICAL ASSERTION ** Second launch on now-live auction → 409
    r2 = requests.post(f"{BASE}/admin/auctions/{auction_id}/launch", json={}, headers=H, timeout=15)
    print(f"[6] Second launch: HTTP {r2.status_code} body={r2.text}")
    pass_409 = r2.status_code == 409
    detail_ok = False
    try:
        detail_ok = (r2.json().get("detail") == "Auction is no longer in draft state.")
    except Exception:
        pass

    # 7) 404 on non-existent auction
    bogus_id = "00000000-0000-0000-0000-000000000000"
    r3 = requests.post(f"{BASE}/admin/auctions/{bogus_id}/launch", json={}, headers=H, timeout=15)
    print(f"[7] Launch on bogus id: HTTP {r3.status_code} body={r3.text}")
    pass_404 = r3.status_code == 404

    print("\n===== RESULT =====")
    print(f"  Double-launch returns 409:           {'PASS' if pass_409 else 'FAIL'} (got {r2.status_code})")
    print(f"  Detail == expected message:          {'PASS' if detail_ok else 'FAIL'}")
    print(f"  Non-existent id returns 404:         {'PASS' if pass_404 else 'FAIL'} (got {r3.status_code})")

    overall = pass_409 and detail_ok and pass_404
    print(f"\n  OVERALL: {'PASS' if overall else 'FAIL'}")
    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
