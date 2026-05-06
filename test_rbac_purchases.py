"""
Backend tests for:
  (1) Role-based access control — admin vs dealer
  (2) GET /api/purchases endpoint

Runs against the public ingress URL (/api/*).
"""
import os
import io
import time
import uuid
import requests

BASE = os.environ.get("BACKEND_URL", "https://qdrives-dealer-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

OTP = "123456"
ADMIN_PHONE = "+919900000099"
DEALER_PHONE = "+919900000002"   # seeded dealer (Royal Drives Co.)
RANDOM_NEW_PHONE = f"+91987650{str(uuid.uuid4().int)[:4]}"  # unseeded phone

FAKE_EXPO_TOKEN = f"ExponentPushToken[regression{str(uuid.uuid4().int)[:6]}]"

results = []


def record(name: str, ok: bool, msg: str = "") -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {msg}")
    results.append((name, ok, msg))
    return ok


def login(phone: str):
    r = requests.post(f"{API}/auth/send-otp", json={"phone": phone}, timeout=15)
    assert r.status_code == 200, f"send-otp {r.status_code} {r.text}"
    r = requests.post(f"{API}/auth/verify-otp", json={"phone": phone, "otp": OTP}, timeout=15)
    assert r.status_code == 200, f"verify-otp {r.status_code} {r.text}"
    body = r.json()
    return body["token"], body["dealer"]


def auth_h(tok):
    return {"Authorization": f"Bearer {tok}"}


# --------------------------- Test 1: roles ---------------------------
def t_admin_bootstrap():
    tok_a, dealer_a = login(ADMIN_PHONE)
    record("admin phone returns role=admin",
           dealer_a.get("role") == "admin",
           f"got role={dealer_a.get('role')}")

    tok_d, dealer_d = login(DEALER_PHONE)
    record("seeded dealer phone returns role=dealer",
           dealer_d.get("role") == "dealer",
           f"got role={dealer_d.get('role')}")

    tok_new, dealer_new = login(RANDOM_NEW_PHONE)
    record("brand new phone auto-creates dealer (role=dealer)",
           dealer_new.get("role") == "dealer" and dealer_new.get("phone") == RANDOM_NEW_PHONE,
           f"got role={dealer_new.get('role')} phone={dealer_new.get('phone')}")

    return tok_a, dealer_a, tok_d, dealer_d


# --------------------------- Test 2: POST /api/cars admin-only ---------------------------
def t_cars_admin_only(tok_admin, admin_dealer, tok_dealer):
    payload = {
        "registration_number": f"MH02ZZ{str(uuid.uuid4().int)[:4]}",
        "make": "Hyundai",
        "model": "Verna",
        "year": 2023,
        "fuel_type": "Petrol",
        "transmission": "Automatic",
        "km_driven": 12000,
        "color": "Black",
        "owners": 1,
        "starting_bid": 1000000,
        "reserve_price": 1100000,
    }

    # Admin → 200 OK
    r_adm = requests.post(f"{API}/cars", json=payload, headers=auth_h(tok_admin), timeout=20)
    ok = r_adm.status_code == 200 and "car" in r_adm.json() and "auction" in r_adm.json()
    record("POST /api/cars (admin) -> 200", ok, f"{r_adm.status_code} {r_adm.text[:160]}")
    created_car_id = None
    if ok:
        body = r_adm.json()
        created_car_id = body["car"]["id"]
        record("POST /api/cars seller_id == admin.id",
               body["car"].get("seller_id") == admin_dealer["id"],
               f"car.seller_id={body['car'].get('seller_id')} admin.id={admin_dealer['id']}")

    # Dealer → 403 "Admin access required"
    payload["registration_number"] = f"MH02ZZ{str(uuid.uuid4().int)[:4]}"
    r_d = requests.post(f"{API}/cars", json=payload, headers=auth_h(tok_dealer), timeout=20)
    body_d = {}
    try:
        body_d = r_d.json()
    except Exception:
        pass
    record("POST /api/cars (dealer) -> 403",
           r_d.status_code == 403,
           f"{r_d.status_code} {body_d}")
    record("POST /api/cars dealer error detail is 'Admin access required'",
           (body_d.get("detail") == "Admin access required"),
           f"detail={body_d.get('detail')}")

    # No token → 401
    r_n = requests.post(f"{API}/cars", json=payload, timeout=20)
    record("POST /api/cars (no token) -> 401/403",
           r_n.status_code in (401, 403),
           f"{r_n.status_code} {r_n.text[:120]}")

    return created_car_id


# --------------------------- Test 3: inspections upload admin-only ---------------------------
def _make_dummy_pdf_bytes():
    header = b"%PDF-1.4\n"
    # Minimal-ish structure padded with comment
    body = b"% dummy inspection report\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n"
    padding = b"% pad " + (b"A" * 300) + b"\n"
    return header + body + padding


def t_inspections_admin_only(tok_admin, tok_dealer):
    # Pick any existing car
    cars = requests.get(f"{API}/cars", timeout=15).json()
    if not cars:
        record("inspections: have a car to upload for", False, "no cars")
        return
    car_id = cars[0]["id"]
    pdf_bytes = _make_dummy_pdf_bytes()

    # Dealer upload → 403
    files = {"file": ("insp.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
    data = {"car_id": car_id, "version": "v1"}
    r_d = requests.post(f"{API}/inspections/upload",
                        data=data, files=files,
                        headers=auth_h(tok_dealer), timeout=20)
    body_d = {}
    try:
        body_d = r_d.json()
    except Exception:
        pass
    record("POST /inspections/upload (dealer) -> 403",
           r_d.status_code == 403, f"{r_d.status_code} {body_d}")
    record("POST /inspections/upload dealer detail",
           body_d.get("detail") == "Admin access required",
           f"detail={body_d.get('detail')}")

    # Admin upload → 200
    files2 = {"file": ("insp.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
    r_a = requests.post(f"{API}/inspections/upload",
                        data=data, files=files2,
                        headers=auth_h(tok_admin), timeout=30)
    ok = r_a.status_code == 200 and r_a.json().get("car_id") == car_id
    record("POST /inspections/upload (admin) -> 200", ok,
           f"{r_a.status_code} {r_a.text[:160]}")

    # Confirm via endpoint (inspections/by-car instead of "inspection-pdf" which doesn't exist;
    # original request mentions GET /api/cars/{car_id}/inspection-pdf but actual endpoint is
    # /api/inspections/by-car/{car_id}).
    r_b = requests.get(f"{API}/inspections/by-car/{car_id}", timeout=15)
    j = r_b.json() if r_b.status_code == 200 else None
    record("GET /inspections/by-car returns record after admin upload",
           isinstance(j, dict) and j.get("car_id") == car_id and j.get("size_bytes", 0) >= 200,
           f"{r_b.status_code} body={str(j)[:160]}")


# --------------------------- Test 4: GET /api/purchases ---------------------------
def t_purchases(tok_dealer, dealer_obj):
    # Step 1: baseline — may be empty or may have previous active bids (from other tests).
    r0 = requests.get(f"{API}/purchases", headers=auth_h(tok_dealer), timeout=15)
    ok0 = r0.status_code == 200 and isinstance(r0.json(), dict) and "won" in r0.json() and "active" in r0.json()
    record("GET /purchases (shape has won+active)", ok0, f"{r0.status_code} keys={list(r0.json().keys()) if ok0 else ''}")
    if not ok0:
        return
    baseline_active_ids = {a["id"] for a in r0.json().get("active", [])}
    record("GET /purchases initial won is list", isinstance(r0.json().get("won"), list),
           f"won_len={len(r0.json().get('won', []))}")

    # Step 2: place a bid on any live auction NOT owned by this dealer & where dealer isn't already top
    auctions = requests.get(f"{API}/auctions?status_filter=live", timeout=15).json()
    chosen = None
    for a in auctions:
        seller = a.get("seller") or {}
        if seller.get("id") == dealer_obj["id"]:
            continue
        # pick one where this dealer isn't already top bidder (to observe a state transition)
        if a.get("id") in baseline_active_ids:
            continue
        chosen = a
        break
    if not chosen:
        # fallback — accept any with different seller
        for a in auctions:
            if (a.get("seller") or {}).get("id") != dealer_obj["id"]:
                chosen = a
                break
    if not chosen:
        record("purchases: found a live auction to bid on", False, "no eligible auction")
        return

    cur_bid = chosen.get("current_bid") or chosen.get("starting_bid") or 0
    new_amt = cur_bid + 5000
    r_bid = requests.post(f"{API}/auctions/{chosen['id']}/bid",
                          json={"amount": new_amt},
                          headers=auth_h(tok_dealer), timeout=20)
    record("purchases: bid succeeds",
           r_bid.status_code == 200,
           f"{r_bid.status_code} {r_bid.text[:160]}")

    time.sleep(0.8)

    r1 = requests.get(f"{API}/purchases", headers=auth_h(tok_dealer), timeout=15)
    ok1 = r1.status_code == 200
    record("GET /purchases after bid returns 200", ok1, f"{r1.status_code}")
    if not ok1:
        return
    body1 = r1.json()
    active_ids = {a["id"] for a in body1.get("active", [])}
    record("GET /purchases active includes bid auction",
           chosen["id"] in active_ids,
           f"bid_auction={chosen['id']} active_ids={list(active_ids)[:5]}")

    # Verify shape of active items
    matching = next((a for a in body1.get("active", []) if a["id"] == chosen["id"]), None)
    if matching is not None:
        has_fields = all(k in matching for k in ("car", "current_bid", "seconds_remaining", "status"))
        record("active item has car / current_bid / seconds_remaining / status",
               has_fields and matching.get("status") == "live",
               f"keys={list(matching.keys())[:10]} status={matching.get('status')}")
        record("active item current_bid reflects our latest bid",
               matching.get("current_bid") == new_amt,
               f"cur={matching.get('current_bid')} expected={new_amt}")


# --------------------------- Test 5: Regression ---------------------------
def t_regression(tok_dealer):
    # All auctions show seller.dealership_name == Q Drives Inventory
    r = requests.get(f"{API}/auctions", timeout=15)
    ok = r.status_code == 200 and isinstance(r.json(), list) and len(r.json()) > 0
    if not ok:
        record("regression: GET /auctions", False, str(r.status_code))
        return
    sellers = {(a.get("seller") or {}).get("dealership_name") for a in r.json()}
    record("all auctions seller.dealership_name == 'Q Drives Inventory'",
           sellers == {"Q Drives Inventory"},
           f"sellers={sellers}")

    # Dashboard stats works
    r = requests.get(f"{API}/dashboard/stats", headers=auth_h(tok_dealer), timeout=20)
    record("dashboard/stats (dealer)", r.status_code == 200 and "live_auctions" in r.json(), str(r.status_code))

    # Register-token still works
    r = requests.post(f"{API}/notifications/register-token",
                      json={"token": FAKE_EXPO_TOKEN, "platform": "ios"},
                      headers=auth_h(tok_dealer), timeout=15)
    record("notifications/register-token still works",
           r.status_code == 200 and r.json().get("success") is True,
           f"{r.status_code} {r.text[:160]}")


def main():
    print(f"BASE: {API}")
    tok_admin, admin_dealer, tok_dealer, dealer_obj = t_admin_bootstrap()
    t_cars_admin_only(tok_admin, admin_dealer, tok_dealer)
    t_inspections_admin_only(tok_admin, tok_dealer)
    t_purchases(tok_dealer, dealer_obj)
    t_regression(tok_dealer)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, m) for n, ok, m in results if not ok]
    print("\n========== SUMMARY ==========")
    print(f"Total: {len(results)}  Passed: {passed}  Failed: {len(failed)}")
    for n, m in failed:
        print(f"  - FAIL {n} :: {m}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
