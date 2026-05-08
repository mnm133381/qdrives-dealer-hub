"""
Backend test for Sellers (Vehicle Owner) controlled-visibility module.
Hits the public ingress URL.
"""
import json
import os
import sys
import time
import uuid

import requests

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"

OPERATOR_PHONE = "+918977986662"
DEALER_PHONE = "+919900000002"
OTP = "123456"

NEW_SELLER_PHONE = f"+919999900{int(time.time()) % 1000:03d}"  # unique-ish phone
NEW_SELLER_NAME = "Aarav Sharma"

passed = []
failed = []


def chk(name, cond, info=""):
    if cond:
        passed.append(name)
        print(f"  ✅ {name}")
    else:
        failed.append((name, info))
        print(f"  ❌ {name}: {info}")


def hd(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def operator_login():
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": OPERATOR_PHONE})
    print(f"[operator send-otp] {r.status_code} {r.text[:120]}")
    r = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": OPERATOR_PHONE, "otp": OTP},
    )
    print(f"[operator verify] {r.status_code}")
    assert r.status_code == 200, r.text
    return r.json()["token"]


def dealer_login():
    requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": DEALER_PHONE})
    r = requests.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": DEALER_PHONE, "otp": OTP},
    )
    print(f"[dealer verify] {r.status_code}")
    assert r.status_code == 200, r.text
    return r.json()["token"]


def main():
    print("\n=== HAPPY PATH ===")
    op_tok = operator_login()
    de_tok = dealer_login()

    # 1. Create seller
    print("\n--- 1. Create seller ---")
    r = requests.post(
        f"{BASE}/admin/sellers",
        headers=hd(op_tok),
        json={"name": NEW_SELLER_NAME, "phone": NEW_SELLER_PHONE, "email": "aarav@example.com"},
    )
    chk("1. create seller 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    seller = r.json() if r.ok else {}
    if not seller:
        # Real bug: 500 on first insert (ObjectId leak). Force idempotent retry
        # to grab the persisted doc so the rest of the suite can run.
        r_retry = requests.post(
            f"{BASE}/admin/sellers",
            headers=hd(op_tok),
            json={"name": NEW_SELLER_NAME, "phone": NEW_SELLER_PHONE},
        )
        if r_retry.ok:
            seller = r_retry.json()
            print(f"   [recover] using idempotent retry result, id={seller.get('id')}")
    chk("1. seller has id", "id" in seller, str(seller)[:200])
    chk("1. status == pending", seller.get("status") == "pending", str(seller.get("status")))
    chk("1. linked_vehicles is list (empty)", seller.get("linked_vehicles") == [], str(seller.get("linked_vehicles")))
    seller_id = seller.get("id")

    # 1b. Idempotency: calling create twice with same phone returns same seller
    r2 = requests.post(
        f"{BASE}/admin/sellers",
        headers=hd(op_tok),
        json={"name": "Different Name", "phone": NEW_SELLER_PHONE},
    )
    chk("1b. idempotent create on phone", r2.status_code == 200 and r2.json().get("id") == seller_id,
        f"{r2.status_code} got id={r2.json().get('id') if r2.ok else None} expect {seller_id}")

    # 2. Pick a car_id from auctions
    print("\n--- 2. Link vehicle ---")
    rA = requests.get(f"{BASE}/auctions?status_filter=all")
    if rA.status_code != 200:
        rA = requests.get(f"{BASE}/auctions")
    chk("2. /auctions reachable", rA.status_code == 200, f"{rA.status_code}")
    auctions = rA.json() if rA.ok else []
    # Try expanding by also including upcoming
    if isinstance(auctions, list) and len(auctions) < 2:
        for sf in ("upcoming", "ended"):
            extra = requests.get(f"{BASE}/auctions?status_filter={sf}")
            if extra.ok and isinstance(extra.json(), list):
                auctions = auctions + extra.json()
    car_id = None
    other_car_id = None
    for a in auctions:
        c = (a.get("car") or {})
        cid = c.get("id")
        if cid:
            if not car_id:
                car_id = cid
            elif not other_car_id:
                other_car_id = cid
                break
    chk("2. found a car_id", bool(car_id), f"car_id={car_id}")
    chk("2. found a 2nd car_id", bool(other_car_id), f"other_car_id={other_car_id}")

    rL = requests.post(
        f"{BASE}/admin/sellers/{seller_id}/link-vehicle",
        headers=hd(op_tok),
        json={"car_id": car_id},
    )
    chk("2. link-vehicle 200", rL.status_code == 200, f"{rL.status_code} {rL.text[:200]}")

    # GET to verify linked_vehicles
    rG = requests.get(f"{BASE}/admin/sellers/{seller_id}", headers=hd(op_tok))
    chk("2. seller detail 200", rG.status_code == 200, f"{rG.status_code}")
    sd = rG.json() if rG.ok else {}
    chk("2. linked_vehicles contains car_id",
        car_id in (sd.get("linked_vehicles") or []),
        f"linked={sd.get('linked_vehicles')}")

    # Verify car.seller_id is denormalised in cars collection (proxied via /cars/{id})
    rC = requests.get(f"{BASE}/cars/{car_id}")
    if rC.status_code == 200:
        car_doc = rC.json()
        chk("2. car.seller_id denormalised",
            car_doc.get("seller_id") == seller_id,
            f"seller_id={car_doc.get('seller_id')} expect {seller_id}")
    else:
        # Fallback: re-fetch auction and check seller_id
        rA2 = requests.get(f"{BASE}/auctions")
        a_match = next((a for a in rA2.json() if (a.get("car") or {}).get("id") == car_id), None)
        chk("2. car.seller_id denormalised (via auction.car)",
            (a_match or {}).get("car", {}).get("seller_id") == seller_id,
            f"got={a_match.get('car', {}).get('seller_id') if a_match else None}")

    # 3. send-access
    print("\n--- 3. send-access ---")
    rS = requests.post(f"{BASE}/admin/sellers/{seller_id}/send-access", headers=hd(op_tok))
    chk("3. send-access 200", rS.status_code == 200, f"{rS.status_code} {rS.text[:200]}")
    rGd = requests.get(f"{BASE}/admin/sellers/{seller_id}", headers=hd(op_tok))
    chk("3. status now access_sent",
        (rGd.json() if rGd.ok else {}).get("status") == "access_sent",
        f"status={rGd.json().get('status') if rGd.ok else 'N/A'}")

    # 4. seller send-otp
    print("\n--- 4. seller send-otp ---")
    rSO = requests.post(f"{BASE}/auth/seller/send-otp", json={"phone": NEW_SELLER_PHONE})
    chk("4. seller send-otp 200", rSO.status_code == 200, f"{rSO.status_code} {rSO.text[:200]}")
    chk("4. mocked_otp_hint key present",
        "mocked_otp_hint" in (rSO.json() if rSO.ok else {}),
        str(rSO.json() if rSO.ok else "")[:120])

    # 5. seller verify-otp
    print("\n--- 5. seller verify-otp ---")
    rV = requests.post(
        f"{BASE}/auth/seller/verify-otp",
        json={"phone": NEW_SELLER_PHONE, "otp": OTP},
    )
    chk("5. seller verify-otp 200", rV.status_code == 200, f"{rV.status_code} {rV.text[:200]}")
    body = rV.json() if rV.ok else {}
    chk("5. verify returned token", isinstance(body.get("token"), str) and len(body.get("token", "")) > 20)
    chk("5. verify returned seller", isinstance(body.get("seller"), dict))
    seller_token = body.get("token")
    chk("5. seller status is viewed",
        body.get("seller", {}).get("status") == "viewed",
        f"status={body.get('seller', {}).get('status')}")

    # 6. seller /me
    print("\n--- 6. /seller/me ---")
    r6 = requests.get(f"{BASE}/seller/me", headers=hd(seller_token))
    chk("6. /seller/me 200", r6.status_code == 200, f"{r6.status_code} {r6.text[:200]}")
    me = r6.json() if r6.ok else {}
    chk("6. me has id/name/phone/status/linked_vehicles_count",
        all(k in me for k in ("id", "name", "phone", "status", "linked_vehicles_count")),
        str(me))

    # 7. seller /vehicles
    print("\n--- 7. /seller/vehicles ---")
    r7 = requests.get(f"{BASE}/seller/vehicles", headers=hd(seller_token))
    chk("7. /seller/vehicles 200", r7.status_code == 200, f"{r7.status_code} {r7.text[:200]}")
    veh = r7.json() if r7.ok else []
    chk("7. vehicles is list with entry", isinstance(veh, list) and len(veh) >= 1, str(veh)[:200])
    if veh:
        v0 = veh[0]
        chk("7. vehicle has linked car_id",
            v0.get("vehicle_id") == car_id, f"got={v0.get('vehicle_id')} expect={car_id}")
        a0 = v0.get("auction") or {}
        for k in ("current_bid", "bid_count", "active_bidder_count", "reserve_met", "reserve_progress"):
            chk(f"7. auction.{k} present", k in a0, f"keys={list(a0.keys())}")
        # Sanitisation: no dealer fields
        forbidden = ("dealer_id", "bidder_name", "dealer_phone", "dealer_trust",
                     "top_bidder", "top_bidder_id")
        leak_str = json.dumps(v0).lower()
        leaked = [f for f in forbidden if f.lower() in leak_str]
        chk("7. no dealer fields leaked in vehicle list", not leaked, f"leaked={leaked}")

    # 8. seller /vehicles/{car_id}
    print("\n--- 8. /seller/vehicles/{id} ---")
    r8 = requests.get(f"{BASE}/seller/vehicles/{car_id}", headers=hd(seller_token))
    chk("8. /seller/vehicles/{id} 200", r8.status_code == 200, f"{r8.status_code} {r8.text[:200]}")
    detail = r8.json() if r8.ok else {}
    chk("8. detail is sanitized", "auction" in detail and "vehicle_id" in detail, str(list(detail.keys()) if detail else None))
    forbidden = ("dealer_id", "bidder_name", "dealer_phone", "dealer_trust", "top_bidder", "top_bidder_id")
    detail_dump = json.dumps(detail).lower()
    leaked2 = [f for f in forbidden if f.lower() in detail_dump]
    chk("8. no dealer fields in detail", not leaked2, f"leaked={leaked2}")

    # Status now active
    rMe2 = requests.get(f"{BASE}/seller/me", headers=hd(seller_token))
    chk("8. seller status now 'active' after detail view",
        (rMe2.json() if rMe2.ok else {}).get("status") == "active",
        f"status={rMe2.json().get('status') if rMe2.ok else None}")

    # 9. /admin/sellers/{id} audit list
    print("\n--- 9. operator audit ---")
    rDet = requests.get(f"{BASE}/admin/sellers/{seller_id}", headers=hd(op_tok))
    chk("9. admin seller detail 200", rDet.status_code == 200, f"{rDet.status_code}")
    sd2 = rDet.json() if rDet.ok else {}
    audit = sd2.get("audit") or []
    actions = [a.get("action") for a in audit]
    print(f"   audit actions seen: {actions}")
    expected_actions = [
        "seller_created", "vehicle_linked", "access_sent",
        "otp_sent", "otp_verified", "vehicle_viewed",
    ]
    for ea in expected_actions:
        chk(f"9. audit contains {ea}", ea in actions, f"actions={actions}")

    # ─────────── NEGATIVE CASES ───────────
    print("\n=== NEGATIVES ===")

    # A. wrong OTP
    rA1 = requests.post(
        f"{BASE}/auth/seller/verify-otp",
        json={"phone": NEW_SELLER_PHONE, "otp": "000000"},
    )
    chk("A. wrong OTP → 400 Invalid OTP",
        rA1.status_code == 400 and "invalid otp" in rA1.text.lower(),
        f"{rA1.status_code} {rA1.text[:200]}")

    # B. non-seller phone verify
    rB = requests.post(
        f"{BASE}/auth/seller/verify-otp",
        json={"phone": "+919876500000", "otp": OTP},
    )
    chk("B. non-seller phone → 404 No seller access on file",
        rB.status_code == 404 and "no seller access" in rB.text.lower(),
        f"{rB.status_code} {rB.text[:200]}")

    # C. seller token, vehicle they don't own → 404
    if other_car_id:
        rC1 = requests.get(f"{BASE}/seller/vehicles/{other_car_id}", headers=hd(seller_token))
        chk("C. seller can't see other vehicle → 404",
            rC1.status_code == 404,
            f"{rC1.status_code} {rC1.text[:200]}")

    # D. seller token on dealer endpoint → 401 Wrong token kind
    rD1 = requests.get(f"{BASE}/auctions", headers=hd(seller_token))
    # /auctions might be public; check authenticated endpoints instead
    rD2 = requests.get(f"{BASE}/dashboard/stats", headers=hd(seller_token))
    chk("D. seller token on /dashboard/stats → 401 Wrong token kind",
        rD2.status_code == 401 and "wrong token kind" in rD2.text.lower(),
        f"{rD2.status_code} {rD2.text[:200]}")
    rD3 = requests.get(f"{BASE}/auth/me", headers=hd(seller_token))
    chk("D. seller token on /auth/me → 401 Wrong token kind",
        rD3.status_code == 401 and "wrong token kind" in rD3.text.lower(),
        f"{rD3.status_code} {rD3.text[:200]}")

    # E. dealer token on seller endpoint → 401 Wrong token kind
    rE = requests.get(f"{BASE}/seller/me", headers=hd(de_tok))
    chk("E. dealer token on /seller/me → 401 Wrong token kind",
        rE.status_code == 401 and "wrong token kind" in rE.text.lower(),
        f"{rE.status_code} {rE.text[:200]}")

    # F. dealer token on /admin/sellers → 403
    rF = requests.get(f"{BASE}/admin/sellers", headers=hd(de_tok))
    chk("F. dealer token on /admin/sellers → 403",
        rF.status_code == 403,
        f"{rF.status_code} {rF.text[:200]}")

    # G. operator revoke
    print("\n--- G. revoke ---")
    rG1 = requests.post(
        f"{BASE}/admin/sellers/{seller_id}/revoke",
        headers=hd(op_tok),
        json={"reason": "test cleanup"},
    )
    chk("G. revoke 200", rG1.status_code == 200, f"{rG1.status_code} {rG1.text[:200]}")
    rG2 = requests.get(f"{BASE}/admin/sellers/{seller_id}", headers=hd(op_tok))
    chk("G. status now revoked",
        (rG2.json() if rG2.ok else {}).get("status") == "revoked",
        f"status={rG2.json().get('status') if rG2.ok else None}")
    # Re-verify-otp now fails
    rG3 = requests.post(
        f"{BASE}/auth/seller/verify-otp",
        json={"phone": NEW_SELLER_PHONE, "otp": OTP},
    )
    chk("G. verify-otp on revoked → 403",
        rG3.status_code == 403 and "revoked" in rG3.text.lower(),
        f"{rG3.status_code} {rG3.text[:200]}")
    # Existing seller token now 403
    rG4 = requests.get(f"{BASE}/seller/me", headers=hd(seller_token))
    chk("G. previously issued seller token → 403 Access revoked",
        rG4.status_code == 403 and "revoked" in rG4.text.lower(),
        f"{rG4.status_code} {rG4.text[:200]}")
    # Audit gains access_revoked
    rG5 = requests.get(f"{BASE}/admin/sellers/{seller_id}", headers=hd(op_tok))
    actions2 = [a.get("action") for a in (rG5.json().get("audit") or [])] if rG5.ok else []
    chk("G. audit contains access_revoked", "access_revoked" in actions2, f"actions={actions2}")

    # H. invalid phone create
    rH = requests.post(
        f"{BASE}/admin/sellers",
        headers=hd(op_tok),
        json={"name": "Bad Phone", "phone": "invalid"},
    )
    chk("H. invalid phone → 400",
        rH.status_code == 400,
        f"{rH.status_code} {rH.text[:200]}")

    # I. link to nonexistent seller_id → 404
    fake_id = str(uuid.uuid4())
    rI = requests.post(
        f"{BASE}/admin/sellers/{fake_id}/link-vehicle",
        headers=hd(op_tok),
        json={"car_id": car_id or "x"},
    )
    chk("I. link-vehicle on nonexistent seller → 404",
        rI.status_code == 404,
        f"{rI.status_code} {rI.text[:200]}")

    # ─────────── INVARIANT: no dealer fields anywhere across /seller/* ───────────
    # Already covered in 7 and 8.

    print("\n\n========================================")
    print(f"PASSED: {len(passed)}")
    print(f"FAILED: {len(failed)}")
    if failed:
        print("\nFAILURES:")
        for n, info in failed:
            print(f"  ❌ {n}: {info}")
    print("========================================")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
