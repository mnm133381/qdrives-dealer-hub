"""
Backend test suite for Q Drives strict allow-list authentication.

Covers:
  A. Dealer auth (closed network — db.approved_dealers allow-list)
  B. Operator auth (closed network — db.operators allow-list)
  C. Legacy generic routes removed
  D. Audit log entries
  E. KYC response shape
  F. RBAC regression
  G. Suspended dealer block

Hits the public ingress URL from frontend/.env (EXPO_PUBLIC_BACKEND_URL).
Uses MongoDB directly (MONGO_URL from backend/.env) for audit log assertions.
"""
import os
import sys
import time
import asyncio
import json
import uuid
from pathlib import Path
import requests
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import dotenv_values

# ---------- Config ----------
ROOT = Path("/app")
fe_env = dotenv_values(ROOT / "frontend" / ".env")
be_env = dotenv_values(ROOT / "backend" / ".env")

BASE = (fe_env.get("EXPO_PUBLIC_BACKEND_URL") or fe_env.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
API = f"{BASE}/api"
MONGO_URL = be_env.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = be_env.get("DB_NAME", "qdrives_db")

print(f"[CONFIG] API base    = {API}")
print(f"[CONFIG] Mongo       = {MONGO_URL}  db={DB_NAME}")

OTP = "123456"
DEALER_ALLOWED = "+919900000002"
DEALER_ALLOWED_2 = "+919900000001"
DEALER_VIKRAM = "+919900000003"
OPERATOR_ALLOWED = "+919900000099"
OFFLIST_PHONE_DEALER = "+919876543210"
OFFLIST_PHONE_OPERATOR = "+918888888888"

results = []
def record(name, ok, detail=""):
    icon = "OK " if ok else "FAIL"
    print(f"[{icon}] {name}{(' :: ' + detail) if detail else ''}")
    results.append((name, ok, detail))


def post(path, json_body=None, headers=None, timeout=20):
    return requests.post(f"{API}{path}", json=json_body or {}, headers=headers or {}, timeout=timeout)

def get(path, headers=None, timeout=20):
    return requests.get(f"{API}{path}", headers=headers or {}, timeout=timeout)


# ---------- A. Dealer auth ----------
def section_A():
    print("\n=== A. Strict allow-list DEALER auth ===")

    r = post("/auth/dealer/send-otp", {"phone": DEALER_ALLOWED})
    ok = r.status_code == 200 and r.json().get("success") is True and r.json().get("dev_otp") == OTP
    record("A.1 dealer send-otp allow-listed -> 200 + success + dev_otp=123456", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/dealer/verify-otp", {"phone": DEALER_ALLOWED, "otp": OTP})
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    dealer_token = body.get("token")
    dealer = body.get("dealer") or {}
    ok = (
        r.status_code == 200 and
        isinstance(dealer_token, str) and len(dealer_token) > 20 and
        "is_new" in body and
        dealer.get("role") == "dealer"
    )
    record("A.2 dealer verify-otp allow-listed -> 200 + JWT + role=dealer", ok,
           f"status={r.status_code} role={dealer.get('role')}")

    r = post("/auth/dealer/send-otp", {"phone": OFFLIST_PHONE_DEALER})
    ok = r.status_code == 403 and r.json().get("detail") == "DEALER_ACCESS_NOT_APPROVED"
    record("A.3 dealer send-otp off-list -> 403 DEALER_ACCESS_NOT_APPROVED", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/dealer/verify-otp", {"phone": OFFLIST_PHONE_DEALER, "otp": OTP})
    ok = r.status_code == 403 and r.json().get("detail") == "DEALER_ACCESS_NOT_APPROVED"
    record("A.4 dealer verify-otp off-list -> 403 DEALER_ACCESS_NOT_APPROVED", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/dealer/verify-otp", {"phone": DEALER_ALLOWED, "otp": "000000"})
    ok = r.status_code == 400
    record("A.5 dealer verify-otp wrong OTP -> 400", ok, f"status={r.status_code} body={r.text[:160]}")

    return dealer_token, dealer


# ---------- B. Operator auth ----------
def section_B():
    print("\n=== B. Strict allow-list OPERATOR auth ===")

    r = post("/auth/operator/send-otp", {"phone": OPERATOR_ALLOWED})
    ok = r.status_code == 200 and r.json().get("success") is True
    record("B.1 operator send-otp allow-listed -> 200", ok, f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/operator/verify-otp", {"phone": OPERATOR_ALLOWED, "otp": OTP})
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    op_token = body.get("token")
    dealer = body.get("dealer") or {}
    ok = (
        r.status_code == 200 and
        isinstance(op_token, str) and
        dealer.get("role") == "admin" and
        dealer.get("kyc_completed") is True and
        dealer.get("verified") is True
    )
    record("B.2 operator verify-otp -> 200 role=admin kyc_completed=true verified=true", ok,
           f"status={r.status_code} role={dealer.get('role')} kyc={dealer.get('kyc_completed')} verified={dealer.get('verified')}")

    r = post("/auth/operator/send-otp", {"phone": DEALER_ALLOWED})
    ok = r.status_code == 403 and r.json().get("detail") == "OPERATOR_ACCESS_DENIED"
    record("B.3 dealer phone on operator/send-otp -> 403 OPERATOR_ACCESS_DENIED [CROSS-CHANNEL]", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/operator/send-otp", {"phone": OFFLIST_PHONE_OPERATOR})
    ok = r.status_code == 403 and r.json().get("detail") == "OPERATOR_ACCESS_DENIED"
    record("B.4 random unapproved on operator/send-otp -> 403 OPERATOR_ACCESS_DENIED", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/operator/verify-otp", {"phone": DEALER_ALLOWED, "otp": OTP})
    ok = r.status_code == 403 and r.json().get("detail") == "OPERATOR_ACCESS_DENIED"
    record("B.4b dealer phone on operator/verify-otp -> 403 (no admin token minted)", ok,
           f"status={r.status_code} body={r.text[:160]}")

    return op_token, dealer


# ---------- C. Legacy generic routes removed ----------
def section_C():
    print("\n=== C. Legacy /api/auth/send-otp + /verify-otp removed ===")

    r = post("/auth/send-otp", {"phone": DEALER_ALLOWED})
    ok = r.status_code == 404
    record("C.1 POST /api/auth/send-otp -> 404", ok, f"status={r.status_code}")

    r = post("/auth/verify-otp", {"phone": DEALER_ALLOWED, "otp": OTP})
    ok = r.status_code == 404
    record("C.2 POST /api/auth/verify-otp -> 404", ok, f"status={r.status_code}")

    record("C.3 cross-channel block (covered by B.3 / B.4b)", True, "asserted above")


# ---------- D. Audit log ----------
async def section_D():
    print("\n=== D. Audit logs ===")
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    await asyncio.sleep(1.5)  # let fire-and-forget audit tasks flush

    cnt_dealer_denied = await db.audit_logs.count_documents({
        "action": "dealer_access_denied",
        "meta.phone": OFFLIST_PHONE_DEALER,
    })
    record("D.1 audit_logs has action=dealer_access_denied for off-list dealer phone",
           cnt_dealer_denied >= 1, f"count={cnt_dealer_denied}")

    cnt_op_denied = await db.audit_logs.count_documents({
        "action": "operator_access_denied",
        "meta.phone": {"$in": [OFFLIST_PHONE_OPERATOR, DEALER_ALLOWED]},
    })
    record("D.1b audit_logs has action=operator_access_denied for off-list / cross-channel phone",
           cnt_op_denied >= 1, f"count={cnt_op_denied}")

    cnt_dealer_login = await db.audit_logs.count_documents({
        "action": "dealer_login",
        "meta.phone": DEALER_ALLOWED,
    })
    record("D.2a audit_logs has action=dealer_login for successful dealer",
           cnt_dealer_login >= 1, f"count={cnt_dealer_login}")

    cnt_op_login = await db.audit_logs.count_documents({
        "action": "operator_login",
        "meta.phone": OPERATOR_ALLOWED,
    })
    record("D.2b audit_logs has action=operator_login for successful operator",
           cnt_op_login >= 1, f"count={cnt_op_login}")

    client.close()


# ---------- E. KYC response shape ----------
def section_E():
    print("\n=== E. KYC response shape ===")

    target = "+919900000005"  # Sameer
    r = post("/auth/dealer/verify-otp", {"phone": target, "otp": OTP})
    if r.status_code != 200:
        record("E.0 dealer verify-otp for Sameer -> 200", False,
               f"status={r.status_code} body={r.text[:160]}")
        return
    body = r.json()
    token = body["token"]
    is_new = body.get("is_new", False)

    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "full_name": "Sameer Joshi",
        "dealership_name": "Nexus AutoTrade",
        "city": "Hyderabad",
    }
    r = post("/auth/kyc", payload, headers=headers)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    dealer = body.get("dealer") or {}
    keys = set(body.keys())
    ok_shape = keys == {"success", "updated", "dealer"} and body.get("success") is True and body.get("updated") is True
    ok_dealer = dealer.get("kyc_completed") is True and dealer.get("verified") is True
    ok = r.status_code == 200 and ok_shape and ok_dealer
    record(
        "E.1 POST /auth/kyc -> 200 strict {success,updated,dealer} + kyc_completed=true + verified=true",
        ok,
        f"status={r.status_code} keys={sorted(keys)} kyc={dealer.get('kyc_completed')} verified={dealer.get('verified')} is_new_was={is_new}"
    )


# ---------- F. RBAC regression ----------
def section_F(dealer_token, op_token):
    print("\n=== F. RBAC regression ===")

    car_payload = {
        "registration_number": f"MH02XY{int(time.time())%10000:04d}",
        "make": "Hyundai", "model": "Creta", "variant": "SX(O)",
        "year": 2023, "manufacturing_year": 2022, "registration_year": 2023,
        "fuel_type": "Petrol", "transmission": "Automatic",
        "km_driven": 18000, "color": "White", "owners": 1,
        "insurance_validity": "08/2026", "rto_details": "MH02 - Mumbai West",
        "notes": "Single owner, full service history.",
        "starting_bid": 850000, "reserve_price": 950000,
        "duration_minutes": 60, "images": [],
    }
    r = post("/cars", car_payload, headers={"Authorization": f"Bearer {dealer_token}"})
    ok = r.status_code == 403 and "Admin" in r.text
    record("F.1 POST /cars (dealer JWT) -> 403 Admin access required", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/cars", car_payload, headers={"Authorization": f"Bearer {op_token}"})
    try:
        rbody = r.json()
    except Exception:
        rbody = {}
    ok_f2 = r.status_code == 200 and "car" in rbody and rbody.get("car", {}).get("id")
    record("F.2 POST /cars (operator JWT) -> 200 + {car,auction}", ok_f2,
           f"status={r.status_code} body={r.text[:200]}")

    r = get("/admin/dashboard", headers={"Authorization": f"Bearer {op_token}"})
    ok = r.status_code == 200 and "auctions" in r.json() and "dealers" in r.json()
    record("F.3 GET /admin/dashboard (operator) -> 200", ok, f"status={r.status_code}")

    r = get("/admin/dashboard", headers={"Authorization": f"Bearer {dealer_token}"})
    ok = r.status_code == 403
    record("F.4 GET /admin/dashboard (dealer) -> 403", ok, f"status={r.status_code}")

    r1 = get("/auth/me", headers={"Authorization": f"Bearer {dealer_token}"})
    ok1 = r1.status_code == 200 and r1.json().get("role") == "dealer"
    record("F.5a /auth/me (dealer) -> 200 role=dealer", ok1,
           f"status={r1.status_code} role={r1.json().get('role') if r1.status_code==200 else None}")

    r2 = get("/auth/me", headers={"Authorization": f"Bearer {op_token}"})
    ok2 = r2.status_code == 200 and r2.json().get("role") == "admin"
    record("F.5b /auth/me (operator) -> 200 role=admin", ok2,
           f"status={r2.status_code} role={r2.json().get('role') if r2.status_code==200 else None}")

    r = get("/purchases", headers={"Authorization": f"Bearer {dealer_token}"})
    body = r.json() if r.status_code == 200 else {}
    ok = (r.status_code == 200 and "won" in body and "active" in body and
          isinstance(body["won"], list) and isinstance(body["active"], list))
    record("F.6 GET /purchases (dealer) -> 200 {won,active}", ok,
           f"status={r.status_code} keys={list(body.keys()) if isinstance(body, dict) else None}")


# ---------- G. Suspended dealer block ----------
def section_G(op_token):
    print("\n=== G. Suspended dealer block ===")

    r = post("/auth/dealer/verify-otp", {"phone": DEALER_VIKRAM, "otp": OTP})
    if r.status_code != 200:
        record("G.0 ensure Vikram dealer doc exists (verify-otp pre-suspend) -> 200", False,
               f"status={r.status_code} body={r.text[:160]}")
        return
    vikram_id = r.json()["dealer"]["id"]

    r = post(f"/admin/dealers/{vikram_id}/verify",
             {"suspended": True},
             headers={"Authorization": f"Bearer {op_token}"})
    body = r.json() if r.status_code == 200 else {}
    ok = r.status_code == 200 and body.get("suspended") is True
    record("G.1 admin POST /admin/dealers/{id}/verify {suspended:true} -> 200", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/dealer/verify-otp", {"phone": DEALER_VIKRAM, "otp": OTP})
    ok = r.status_code == 403 and r.json().get("detail") == "DEALER_ACCOUNT_SUSPENDED"
    record("G.2 dealer/verify-otp for suspended dealer -> 403 DEALER_ACCOUNT_SUSPENDED", ok,
           f"status={r.status_code} body={r.text[:160]}")

    r = post(f"/admin/dealers/{vikram_id}/verify",
             {"suspended": False},
             headers={"Authorization": f"Bearer {op_token}"})
    body = r.json() if r.status_code == 200 else {}
    ok = r.status_code == 200 and body.get("suspended") is False
    record("G.3 reinstate {suspended:false} -> 200", ok, f"status={r.status_code} body={r.text[:160]}")

    r = post("/auth/dealer/verify-otp", {"phone": DEALER_VIKRAM, "otp": OTP})
    ok = r.status_code == 200
    record("G.4 dealer/verify-otp after reinstate -> 200", ok, f"status={r.status_code}")


# ---------- main ----------
def main():
    if not BASE:
        print("ERROR: EXPO_PUBLIC_BACKEND_URL not set")
        sys.exit(1)

    try:
        r = get("/")
        print(f"[PREFLIGHT] GET /api/ status={r.status_code} body={r.text[:120]}")
    except Exception as e:
        print(f"[PREFLIGHT] FAILED to reach API: {e}")
        sys.exit(1)

    dealer_token, _ = section_A()
    op_token, _ = section_B()
    section_C()
    asyncio.run(section_D())
    section_E()

    if dealer_token and op_token:
        section_F(dealer_token, op_token)
        section_G(op_token)
    else:
        print("Skipping F/G — missing tokens")

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [r for r in results if not r[1]]
    print("\n" + "=" * 70)
    print(f"RESULT: {passed}/{len(results)} passed")
    if failed:
        print("FAILED:")
        for name, _, detail in failed:
            print(f"  FAIL  {name} :: {detail}")
    print("=" * 70)
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
