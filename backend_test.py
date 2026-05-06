"""
Backend tests for Q Drives admin endpoints + role-based UX.

Targets the public ingress URL (EXPO_PUBLIC_BACKEND_URL) at /api.
"""
import sys
import requests
from typing import Dict, Any, Tuple

# Resolve base URL from frontend env (preserves the contract)
FRONTEND_ENV = "/app/frontend/.env"
BASE = None
with open(FRONTEND_ENV) as f:
    for line in f:
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE = line.strip().split("=", 1)[1].strip('"')
            break
if not BASE:
    print("ERROR: missing EXPO_PUBLIC_BACKEND_URL")
    sys.exit(1)
API = f"{BASE}/api"
print(f"[INFO] API base: {API}")

ADMIN_PHONE = "+919900000099"
DEALER_PHONE = "+919900000002"
OTP = "123456"

failures = []
passes = []


def check(cond: bool, label: str, detail: str = ""):
    if cond:
        passes.append(label)
        print(f"  PASS {label}")
    else:
        failures.append((label, detail))
        print(f"  FAIL {label} :: {detail}")


def login(phone: str) -> Tuple[str, Dict[str, Any]]:
    r = requests.post(f"{API}/auth/send-otp", json={"phone": phone}, timeout=20)
    r.raise_for_status()
    r = requests.post(f"{API}/auth/verify-otp", json={"phone": phone, "otp": OTP}, timeout=20)
    r.raise_for_status()
    data = r.json()
    return data["token"], data["dealer"]


def auth(tok: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


# =========================================================================
print("\n[1] Login admin + dealer")
admin_token, admin_d = login(ADMIN_PHONE)
dealer_token, dealer_d = login(DEALER_PHONE)
check(admin_d.get("role") == "admin", "admin login -> role=admin",
      f"got role={admin_d.get('role')}")
check(dealer_d.get("role") == "dealer", "dealer login -> role=dealer",
      f"got role={dealer_d.get('role')}")

# =========================================================================
print("\n[2] GET /api/admin/dashboard")
r = requests.get(f"{API}/admin/dashboard", headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "admin/dashboard 200", f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 200:
    d = r.json()
    auctions = d.get("auctions", {})
    dealers = d.get("dealers", {})
    inventory = d.get("inventory", {})
    activity = d.get("activity", {})
    for k in ("live", "upcoming", "ended_today"):
        v = auctions.get(k)
        check(isinstance(v, int) and v >= 0, f"auctions.{k} non-neg int", f"{k}={v}")
    for k in ("total", "verified", "suspended", "pending_verification"):
        v = dealers.get(k)
        check(isinstance(v, int) and v >= 0, f"dealers.{k} non-neg int", f"{k}={v}")
    check(dealers.get("total", 0) >= 5, "dealers.total >= 5", f"total={dealers.get('total')}")
    for k in ("total", "listings_today"):
        v = inventory.get(k)
        check(isinstance(v, int) and v >= 0, f"inventory.{k} non-neg int", f"{k}={v}")
    check(inventory.get("total", 0) >= 12, "inventory.total >= 12",
          f"total={inventory.get('total')}")
    for k in ("bids_today", "deals_today", "gmv_today_inr"):
        v = activity.get(k)
        check(isinstance(v, int) and v >= 0, f"activity.{k} non-neg int", f"{k}={v}")
    check(isinstance(d.get("top_dealers"), list), "top_dealers is list")
    check(isinstance(d.get("recent_outcomes"), list), "recent_outcomes is list")

# Dealer 403
r = requests.get(f"{API}/admin/dashboard", headers=auth(dealer_token), timeout=20)
check(r.status_code == 403, "admin/dashboard dealer 403", f"status={r.status_code}")
check("Admin access required" in r.text, "dealer error detail mentions admin",
      f"body={r.text[:200]}")

# No token 401
r = requests.get(f"{API}/admin/dashboard", timeout=20)
check(r.status_code in (401, 403), "admin/dashboard no token -> 401/403",
      f"status={r.status_code}")

# =========================================================================
print("\n[3] GET /api/admin/dealers")
r = requests.get(f"{API}/admin/dealers", headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "admin/dealers 200", f"status={r.status_code}")
dealers_list = r.json() if r.status_code == 200 else []
check(isinstance(dealers_list, list), "admin/dealers returns list")
required = {"id", "dealership_name", "phone", "verified", "kyc_completed",
            "bids_count", "wins_count"}
if dealers_list:
    sample = dealers_list[0]
    missing = required - set(sample.keys())
    check(not missing, "admin/dealers item has required fields",
          f"missing={missing} sample_keys={list(sample.keys())}")
    bad_bid = [d for d in dealers_list if not isinstance(d.get("bids_count"), int)]
    bad_win = [d for d in dealers_list if not isinstance(d.get("wins_count"), int)]
    check(not bad_bid, "all dealers have int bids_count", f"bad={bad_bid[:1]}")
    check(not bad_win, "all dealers have int wins_count", f"bad={bad_win[:1]}")

# Admin must be excluded
admin_phones_in_list = [d for d in dealers_list if d.get("phone") == ADMIN_PHONE]
check(len(admin_phones_in_list) == 0, "admin account excluded from /admin/dealers",
      f"found admin={admin_phones_in_list}")
roles = [d.get("role") for d in dealers_list]
check(all(rr != "admin" for rr in roles), "no role=admin entries",
      f"roles={set(roles)}")

# Status filter pending
r = requests.get(f"{API}/admin/dealers", params={"status_filter": "pending"},
                 headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "admin/dealers status_filter=pending 200")
pending = r.json() if r.status_code == 200 else []
all_pending_unverified = all(not d.get("verified") for d in pending)
check(all_pending_unverified, "all pending have verified=false",
      f"counter-examples={[d for d in pending if d.get('verified')]}")

# Status filter verified
r = requests.get(f"{API}/admin/dealers", params={"status_filter": "verified"},
                 headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "admin/dealers status_filter=verified 200")
verified = r.json() if r.status_code == 200 else []
all_verified = all(d.get("verified") and not d.get("suspended") for d in verified)
check(all_verified, "verified filter -> verified=true and not suspended",
      f"len={len(verified)}")

# q=Royal
r = requests.get(f"{API}/admin/dealers", params={"q": "Royal"},
                 headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "admin/dealers q=Royal 200")
royal = r.json() if r.status_code == 200 else []
check(any("Royal" in (d.get("dealership_name") or "") for d in royal),
      "q=Royal returns at least one Royal Drives Co.", f"len={len(royal)}")

# Dealer 403
r = requests.get(f"{API}/admin/dealers", headers=auth(dealer_token), timeout=20)
check(r.status_code == 403, "admin/dealers dealer 403", f"status={r.status_code}")

# =========================================================================
print("\n[4] POST /api/admin/dealers/{id}/verify")
target = None
for d in dealers_list:
    if d.get("phone") != DEALER_PHONE and d.get("role") != "admin":
        target = d
        break
if not target and dealers_list:
    target = dealers_list[0]
check(target is not None, "found a non-admin dealer to mutate")
target_id = target["id"]
print(f"  target dealer: {target.get('phone')} id={target_id}")

# Verify true
r = requests.post(f"{API}/admin/dealers/{target_id}/verify",
                  json={"verified": True}, headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "verify {verified:true} -> 200",
      f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    check(body.get("verified") is True, "response.verified=true",
          f"got={body.get('verified')}")
    check(body.get("suspended") is False, "response.suspended=false after verify",
          f"got={body.get('suspended')}")

# Suspend true
r = requests.post(f"{API}/admin/dealers/{target_id}/verify",
                  json={"suspended": True}, headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "verify {suspended:true} -> 200")
if r.status_code == 200:
    body = r.json()
    check(body.get("suspended") is True, "response.suspended=true",
          f"got={body.get('suspended')}")

# Reinstate
r = requests.post(f"{API}/admin/dealers/{target_id}/verify",
                  json={"suspended": False}, headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "verify {suspended:false} -> 200")
if r.status_code == 200:
    body = r.json()
    check(body.get("suspended") is False, "reinstated suspended=false",
          f"got={body.get('suspended')}")

# Dealer caller 403
r = requests.post(f"{API}/admin/dealers/{target_id}/verify",
                  json={"verified": True}, headers=auth(dealer_token), timeout=20)
check(r.status_code == 403, "dealer cannot verify others (403)",
      f"status={r.status_code}")

# Invalid id 404
r = requests.post(f"{API}/admin/dealers/does-not-exist-xyz/verify",
                  json={"verified": True}, headers=auth(admin_token), timeout=20)
check(r.status_code == 404, "invalid dealer id 404", f"status={r.status_code}")

# Try to mutate admin -> 400
admin_id = admin_d["id"]
r = requests.post(f"{API}/admin/dealers/{admin_id}/verify",
                  json={"suspended": True}, headers=auth(admin_token), timeout=20)
check(r.status_code == 400, "mutate admin account -> 400", f"status={r.status_code}")
check("Cannot mutate admin" in r.text, "400 detail mentions 'Cannot mutate admin'",
      f"body={r.text[:200]}")

# Verify the verification notification was inserted for target
target_token, _ = login(target["phone"])
r = requests.get(f"{API}/notifications", headers=auth(target_token), timeout=20)
if r.status_code == 200:
    notifs = r.json()
    has_verif = any(n.get("type") == "verification" for n in notifs)
    check(has_verif, "verification notification inserted for target",
          f"types={[n.get('type') for n in notifs[:5]]}")

# =========================================================================
print("\n[5] POST /api/admin/notifications/broadcast")
# Capture target dealer's unread count before broadcast (target is verified above)
r = requests.get(f"{API}/notifications/unread-count", headers=auth(target_token), timeout=20)
before_unread = r.json().get("unread", 0) if r.status_code == 200 else 0
print(f"  target unread before: {before_unread}")

# audience=verified
r = requests.post(f"{API}/admin/notifications/broadcast",
                  json={"title": "Test broadcast", "body": "Hello dealers",
                        "audience": "verified"},
                  headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "broadcast verified -> 200",
      f"status={r.status_code} body={r.text[:200]}")
sent_verified = 0
if r.status_code == 200:
    sent_verified = r.json().get("sent", 0)
    check(isinstance(sent_verified, int) and sent_verified >= 1,
          "broadcast verified sent >= 1", f"sent={sent_verified}")

# Confirm side-effect: target unread incremented (target was reinstated to verified=true)
r = requests.get(f"{API}/notifications/unread-count", headers=auth(target_token), timeout=20)
after_unread = r.json().get("unread", 0) if r.status_code == 200 else 0
print(f"  target unread after verified broadcast: {after_unread}")
check(after_unread >= before_unread + 1,
      "target dealer unread count incremented after verified broadcast",
      f"before={before_unread} after={after_unread}")

# audience=all
r = requests.post(f"{API}/admin/notifications/broadcast",
                  json={"title": "All hands", "body": "Heads up",
                        "audience": "all"},
                  headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "broadcast all -> 200")
sent_all = r.json().get("sent", 0) if r.status_code == 200 else 0
check(sent_all >= sent_verified, "broadcast all >= verified count",
      f"all={sent_all} verified={sent_verified}")

# Dealer 403
r = requests.post(f"{API}/admin/notifications/broadcast",
                  json={"title": "x", "body": "y", "audience": "all"},
                  headers=auth(dealer_token), timeout=20)
check(r.status_code == 403, "broadcast dealer 403", f"status={r.status_code}")

# =========================================================================
print("\n[6] Regression smoke")
endpoints = [
    ("GET", "/auctions", None, dealer_token, 200),
    ("GET", "/dashboard/stats", None, dealer_token, 200),
    ("GET", "/notifications", None, dealer_token, 200),
    ("GET", "/cars", None, dealer_token, 200),
    ("GET", "/purchases", None, dealer_token, 200),
    ("GET", "/auth/me", None, dealer_token, 200),
]
for method, path, body, tok, expected in endpoints:
    if method == "GET":
        rr = requests.get(f"{API}{path}", headers=auth(tok) if tok else {}, timeout=20)
    else:
        rr = requests.post(f"{API}{path}", json=body, headers=auth(tok) if tok else {}, timeout=20)
    check(rr.status_code == expected, f"{method} {path} -> {expected}",
          f"status={rr.status_code}")

# POST /api/cars admin guard
car_payload = {
    "registration_number": "MH99TT0001",
    "make": "Hyundai",
    "model": "Verna",
    "year": 2023,
    "fuel_type": "Petrol",
    "transmission": "Automatic",
    "km_driven": 18000,
    "owners": 1,
    "reserve_price": 1500000,
    "starting_bid": 1300000,
}
r = requests.post(f"{API}/cars", json=car_payload, headers=auth(dealer_token), timeout=20)
check(r.status_code == 403, "POST /cars dealer 403", f"status={r.status_code}")
r = requests.post(f"{API}/cars", json=car_payload, headers=auth(admin_token), timeout=20)
check(r.status_code == 200, "POST /cars admin 200", f"status={r.status_code} body={r.text[:200]}")

# Media GET (public)
auctions = requests.get(f"{API}/auctions", timeout=20).json()
if auctions:
    car_id = auctions[0].get("car_id")
    if car_id:
        r = requests.get(f"{API}/cars/{car_id}/media", timeout=20)
        check(r.status_code == 200, "GET /cars/{id}/media 200 (public)",
              f"status={r.status_code}")

# =========================================================================
print("\n========== SUMMARY ==========")
print(f"Passed: {len(passes)}")
print(f"Failed: {len(failures)}")
if failures:
    print("\nFailures:")
    for label, detail in failures:
        print(f"  - {label} :: {detail}")
sys.exit(0 if not failures else 1)
