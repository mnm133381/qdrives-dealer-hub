"""
Backend test suite for Q Drives push-notifications additions + regression of
existing endpoints. Hits the public ingress URL via /api/* prefix.
"""
import os
import time
import uuid
import requests

BASE = os.environ.get("BACKEND_URL", "https://qdrives-dealer-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

PRIMARY_PHONE = "+919900000002"   # Arjun (Royal Drives Co.)
SECONDARY_PHONE = "+919900000001"  # Rahul (Apex Premium Motors) — used to outbid
NEW_DEALER_PHONE = f"+9198765{str(uuid.uuid4().int)[:5]}"  # fresh phone for KYC test

OTP = "123456"
FAKE_TOKEN = "ExponentPushToken[fakeAbcXYZ123]"

results = []  # (name, ok, msg)


def record(name: str, ok: bool, msg: str = "") -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {msg}")
    results.append((name, ok, msg))
    return ok


def login(phone: str) -> str:
    r = requests.post(f"{API}/auth/send-otp", json={"phone": phone}, timeout=15)
    assert r.status_code == 200, f"send-otp failed: {r.status_code} {r.text}"
    r = requests.post(f"{API}/auth/verify-otp", json={"phone": phone, "otp": OTP}, timeout=15)
    assert r.status_code == 200, f"verify-otp failed: {r.status_code} {r.text}"
    return r.json()["token"]


def auth_h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


# ----------------- Tests -----------------
def t_root_health():
    r = requests.get(f"{API}/", timeout=10)
    record("GET /api/ root health", r.status_code == 200 and r.json().get("status") == "ok", str(r.status_code))


def t_register_token(tok):
    # Valid
    r = requests.post(f"{API}/notifications/register-token",
                      json={"token": FAKE_TOKEN, "platform": "ios"},
                      headers=auth_h(tok), timeout=15)
    record("register-token (valid)", r.status_code == 200 and r.json().get("success") is True, f"{r.status_code} {r.text[:120]}")

    # Invalid
    r2 = requests.post(f"{API}/notifications/register-token",
                       json={"token": "BadToken"}, headers=auth_h(tok), timeout=15)
    record("register-token (invalid -> 400)", r2.status_code == 400, f"{r2.status_code} {r2.text[:120]}")

    # No auth
    r3 = requests.post(f"{API}/notifications/register-token",
                       json={"token": FAKE_TOKEN}, timeout=15)
    record("register-token (no auth -> 401/403)", r3.status_code in (401, 403), f"{r3.status_code}")


def t_unregister_token(tok):
    r = requests.post(f"{API}/notifications/unregister-token",
                      json={"token": FAKE_TOKEN}, headers=auth_h(tok), timeout=15)
    record("unregister-token (existing)", r.status_code == 200 and r.json().get("success") is True, str(r.status_code))

    r2 = requests.post(f"{API}/notifications/unregister-token",
                       json={"token": ""}, headers=auth_h(tok), timeout=15)
    record("unregister-token (empty idempotent)", r2.status_code == 200, str(r2.status_code))


def t_unread_count(tok):
    r = requests.get(f"{API}/notifications/unread-count", headers=auth_h(tok), timeout=15)
    ok = r.status_code == 200 and isinstance(r.json().get("unread"), int) and r.json()["unread"] >= 0
    record("unread-count", ok, f"{r.status_code} {r.text[:120]}")


def t_test_push(tok):
    # Re-register token first so dispatch has a target (still fire-and-forget; expect 200 either way)
    requests.post(f"{API}/notifications/register-token",
                  json={"token": FAKE_TOKEN, "platform": "ios"},
                  headers=auth_h(tok), timeout=15)
    r = requests.post(f"{API}/notifications/test",
                      json={"title": "hi", "body": "world"},
                      headers=auth_h(tok), timeout=15)
    record("test-push", r.status_code == 200 and r.json().get("success") is True, f"{r.status_code} {r.text[:120]}")


def t_outbid_flow():
    """Place a bid as Arjun (PRIMARY) then have Rahul (SECONDARY) outbid him,
    check Arjun's unread count increases (because outbid notification was created)."""
    tok_primary = login(PRIMARY_PHONE)
    tok_secondary = login(SECONDARY_PHONE)

    # Find a live auction not seller-owned by primary
    auctions = requests.get(f"{API}/auctions?status_filter=live", timeout=15).json()
    if not isinstance(auctions, list) or len(auctions) == 0:
        record("outbid: live auction available", False, "no live auctions")
        return
    me_p = requests.get(f"{API}/auth/me", headers=auth_h(tok_primary), timeout=15).json()
    me_s = requests.get(f"{API}/auth/me", headers=auth_h(tok_secondary), timeout=15).json()
    primary_id = me_p["id"]
    secondary_id = me_s["id"]

    chosen = None
    for a in auctions:
        seller_id = (a.get("seller") or {}).get("id")
        if seller_id not in (primary_id, secondary_id):
            chosen = a
            break
    if not chosen:
        record("outbid: pick auction", False, "no auction with seller != either dealer")
        return

    auction_id = chosen["id"]
    cur = chosen.get("current_bid") or chosen.get("starting_bid") or 0
    amt1 = cur + 5000

    r1 = requests.post(f"{API}/auctions/{auction_id}/bid",
                       json={"amount": amt1}, headers=auth_h(tok_primary), timeout=15)
    if r1.status_code != 200:
        record("outbid: primary places bid", False, f"{r1.status_code} {r1.text[:160]}")
        return
    record("outbid: primary places bid", True, f"amt={amt1}")

    # Capture primary's unread count before being outbid
    pre = requests.get(f"{API}/notifications/unread-count",
                       headers=auth_h(tok_primary), timeout=15).json().get("unread", 0)

    amt2 = amt1 + 5000
    r2 = requests.post(f"{API}/auctions/{auction_id}/bid",
                       json={"amount": amt2}, headers=auth_h(tok_secondary), timeout=15)
    if r2.status_code != 200:
        record("outbid: secondary outbids primary", False, f"{r2.status_code} {r2.text[:160]}")
        return
    record("outbid: secondary outbids primary", True, f"amt={amt2}")

    # Give DB write a moment
    time.sleep(1.0)
    post = requests.get(f"{API}/notifications/unread-count",
                        headers=auth_h(tok_primary), timeout=15).json().get("unread", 0)
    record("outbid: primary unread increased", post >= pre + 1, f"pre={pre} post={post}")

    # Also check via /notifications listing
    notifs = requests.get(f"{API}/notifications", headers=auth_h(tok_primary), timeout=15).json()
    has_outbid = any(n.get("type") == "outbid" and n.get("auction_id") == auction_id for n in notifs)
    record("outbid: outbid notification present in /notifications", has_outbid, f"count={len(notifs)}")


def t_kyc_flow():
    tok = login(NEW_DEALER_PHONE)
    me = requests.get(f"{API}/auth/me", headers=auth_h(tok), timeout=15).json()
    record("kyc: new dealer created", me.get("phone") == NEW_DEALER_PHONE and not me.get("kyc_completed"), f"phone={me.get('phone')}")

    payload = {
        "full_name": "Anika Reddy",
        "dealership_name": "Coastal Premium Motors",
        "city": "Chennai",
        "gst_number": "33ABCDE1234F1Z5",
        "pan_number": "ABCDE1234F",
    }
    r = requests.post(f"{API}/auth/kyc", json=payload, headers=auth_h(tok), timeout=15)
    record("kyc: submit kyc", r.status_code == 200 and r.json().get("kyc_completed") is True,
           f"{r.status_code} {r.text[:160]}")

    time.sleep(0.5)
    notifs = requests.get(f"{API}/notifications", headers=auth_h(tok), timeout=15).json()
    has_v = any(n.get("type") == "verification" for n in notifs)
    record("kyc: verification notification created", has_v, f"notif_count={len(notifs)}")


def t_smoke(tok):
    car_id = None
    auction_id = None

    r = requests.get(f"{API}/auctions", timeout=15)
    if r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) > 0:
        record("smoke: GET /auctions", True, f"n={len(r.json())}")
        auction_id = r.json()[0]["id"]
        car_id = r.json()[0]["car"]["id"] if r.json()[0].get("car") else None
    else:
        record("smoke: GET /auctions", False, f"{r.status_code}")

    if auction_id:
        r = requests.get(f"{API}/auctions/{auction_id}", timeout=15)
        record("smoke: GET /auctions/{id}", r.status_code == 200, str(r.status_code))

    r = requests.get(f"{API}/dashboard/stats", headers=auth_h(tok), timeout=20)
    record("smoke: GET /dashboard/stats", r.status_code == 200 and "live_auctions" in r.json(), str(r.status_code))

    r = requests.get(f"{API}/market/pulse", timeout=20)
    record("smoke: GET /market/pulse", r.status_code == 200 and "live" in r.json(), str(r.status_code))

    r = requests.get(f"{API}/network/activity", timeout=20)
    record("smoke: GET /network/activity", r.status_code == 200 and isinstance(r.json(), list), str(r.status_code))

    r = requests.get(f"{API}/cars", timeout=20)
    record("smoke: GET /cars", r.status_code == 200 and isinstance(r.json(), list), str(r.status_code))

    r = requests.get(f"{API}/watchlist", headers=auth_h(tok), timeout=15)
    record("smoke: GET /watchlist", r.status_code == 200 and isinstance(r.json(), list), str(r.status_code))

    if car_id:
        r = requests.get(f"{API}/inspections/by-car/{car_id}", timeout=15)
        record("smoke: GET /inspections/by-car/{id}", r.status_code == 200, str(r.status_code))

    r = requests.post(f"{API}/ai/price-estimate",
                      json={"make": "Honda", "model": "City", "year": 2020,
                            "km_driven": 45000, "fuel_type": "Petrol",
                            "owners": 1, "condition_score": 8.5},
                      timeout=60)
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    record("smoke: POST /ai/price-estimate", r.status_code == 200 and "estimated_price_inr" in body,
           f"{r.status_code} keys={list(body.keys())[:5]}")


def main():
    print(f"BASE: {API}")
    t_root_health()
    tok = login(PRIMARY_PHONE)
    t_register_token(tok)
    t_unregister_token(tok)
    t_unread_count(tok)
    t_test_push(tok)
    t_outbid_flow()
    t_kyc_flow()
    t_smoke(tok)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, m) for n, ok, m in results if not ok]
    print("\n========== SUMMARY ==========")
    print(f"Total: {len(results)}  Passed: {passed}  Failed: {len(failed)}")
    for n, m in failed:
        print(f"  - FAIL {n} :: {m}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
