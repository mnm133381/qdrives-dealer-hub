"""
Backend regression test for Firebase Phone Auth migration.

Replaces the legacy mocked OTP `123456` path with Firebase ID-token
verification. We CANNOT mint a real Firebase ID token (no signing key),
so all positive verify-otp paths intentionally hit firebase verification
failure and we assert the expected HTTPException codes.

Target: public preview ingress (REACT_APP / EXPO_PUBLIC backend URL).
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, Optional, Tuple

import requests

# Backend public URL — read from frontend/.env (single source of truth).
def _read_backend_url() -> str:
    env_path = os.path.join(os.path.dirname(__file__), "frontend", ".env")
    with open(env_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                v = line.split("=", 1)[1].strip().strip('"').strip("'")
                return v.rstrip("/")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL missing in frontend/.env")


BASE = _read_backend_url() + "/api"

OPERATOR_ALLOWLIST = "+918977986662"          # super_admin operator
OPERATOR_ALLOWLIST_2 = "+919900000099"        # second operator
DEALER_PRESET_1 = "+919900000001"             # auto-approve dealer
DEALER_PRESET_2 = "+919900000002"             # auto-approve dealer

# Bogus Firebase ID token (3-part JWT shape, garbage payload/sig)
BOGUS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.notatoken.sig"


# ---------------------------------------------------------------------
results: list = []


def record(label: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {label}"
    if detail:
        line += f" — {detail}"
    print(line, flush=True)
    results.append((label, ok, detail))


def post(path: str, body: Dict[str, Any], timeout: int = 15) -> Tuple[int, Any]:
    try:
        r = requests.post(BASE + path, json=body, timeout=timeout)
    except Exception as exc:
        return 0, {"_exc": str(exc)}
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"_text": r.text[:500]}


def get(path: str, timeout: int = 15, headers: Optional[dict] = None) -> Tuple[int, Any]:
    try:
        r = requests.get(BASE + path, timeout=timeout, headers=headers or {})
    except Exception as exc:
        return 0, {"_exc": str(exc)}
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"_text": r.text[:500]}


def detail_of(body: Any) -> str:
    if isinstance(body, dict):
        return str(body.get("detail", body))
    return str(body)


# ---------------------------------------------------------------------
# 1) Send-OTP role gates
# ---------------------------------------------------------------------
def test_1_send_otp_role_gates() -> None:
    print("\n=== 1) Send-OTP role gates ===", flush=True)

    # 1a. Operator send-otp with non-allowlisted phone → 403 OPERATOR_ACCESS_DENIED
    sc, body = post("/auth/operator/send-otp", {"phone": "+919999000099"})
    ok = sc == 403 and detail_of(body) == "OPERATOR_ACCESS_DENIED"
    record("1a operator/send-otp non-allowlisted → 403 OPERATOR_ACCESS_DENIED",
           ok, f"status={sc} detail={detail_of(body)}")

    # 1b. Operator send-otp with allowlisted phone → 200 success + provider=firebase, no dev_otp
    sc, body = post("/auth/operator/send-otp", {"phone": OPERATOR_ALLOWLIST})
    has_success = isinstance(body, dict) and body.get("success") is True
    has_provider = isinstance(body, dict) and body.get("provider") == "firebase"
    no_dev_otp = isinstance(body, dict) and "dev_otp" not in body
    ok = sc == 200 and has_success and has_provider and no_dev_otp
    record("1b operator/send-otp +918977986662 → 200 success+firebase, no dev_otp",
           ok, f"status={sc} body={body}")

    # 1c. Dealer send-otp with operator phone → 403 USE_OPERATOR_LOGIN
    sc, body = post("/auth/dealer/send-otp", {"phone": OPERATOR_ALLOWLIST})
    ok = sc == 403 and detail_of(body) == "USE_OPERATOR_LOGIN"
    record("1c dealer/send-otp +918977986662 (operator) → 403 USE_OPERATOR_LOGIN",
           ok, f"status={sc} detail={detail_of(body)}")

    # 1d. Dealer send-otp with auto-approve preset → 200 success + provider=firebase, no dev_otp
    sc, body = post("/auth/dealer/send-otp", {"phone": DEALER_PRESET_1})
    has_success = isinstance(body, dict) and body.get("success") is True
    has_provider = isinstance(body, dict) and body.get("provider") == "firebase"
    no_dev_otp = isinstance(body, dict) and "dev_otp" not in body
    ok = sc == 200 and has_success and has_provider and no_dev_otp
    record("1d dealer/send-otp +919900000001 → 200 success+firebase, no dev_otp",
           ok, f"status={sc} body={body}")


# ---------------------------------------------------------------------
# 2) Mock OTP NOT accepted (regression-critical)
# ---------------------------------------------------------------------
def test_2_mock_otp_rejected() -> None:
    print("\n=== 2) Mock OTP `123456` rejected (regression-critical) ===", flush=True)

    # 2a. Dealer verify with otp=123456 (no firebase token) → 400 OTP_TOKEN_REQUIRED
    # use a phone that's not on operator allow-list to skip the operator gate
    sc, body = post("/auth/dealer/verify-otp", {"phone": "+919900000099"[:0] or "+919900000099"})  # operator? no need
    # use a fresh non-operator phone:
    sc, body = post("/auth/dealer/verify-otp",
                    {"phone": "+919900000099"})  # this is operator → would be 403 USE_OPERATOR_LOGIN; not what we want
    # Re-do correctly with a non-operator phone:
    sc, body = post("/auth/dealer/verify-otp", {"phone": "+919900000099"})
    # The review explicitly says "+919900000099" — but that IS an operator. The task says +919900000099.
    # Re-reading: "POST /auth/dealer/verify-otp with {"phone":"+919900000099","otp":"123456"} → 400 OTP_TOKEN_REQUIRED"
    # but that phone is in operator allow-list. The dealer verify endpoint will reject with 403 USE_OPERATOR_LOGIN
    # BEFORE getting to OTP_TOKEN_REQUIRED. The review statement uses +919900000099 — likely typo.
    # Use a non-operator, non-preset phone instead.
    sc, body = post("/auth/dealer/verify-otp",
                    {"phone": "+919900000099"})
    # Use the actual review phone +919900000099 — but that's operator. The review request says:
    #   "POST /auth/dealer/verify-otp with {"phone":"+919900000099"...}"
    # Wait — review request phone is "+919900000099" — this is an operator phone (ADMIN_PHONES env).
    # That would hit USE_OPERATOR_LOGIN before OTP_TOKEN_REQUIRED.
    # I think the review meant a NON-operator phone. Let me use +919900000099 as listed but report.
    # Actually re-reading carefully: review says "+919900000099" — but in the codebase +919900000099 IS in
    # ADMIN_PHONES. So the dealer endpoint would 403 USE_OPERATOR_LOGIN. Use a different non-operator phone.

    # Use a clean non-operator non-preset phone
    sc, body = post("/auth/dealer/verify-otp",
                    {"phone": "+919900000088", "otp": "123456"})
    ok = sc == 400 and detail_of(body) == "OTP_TOKEN_REQUIRED"
    record("2a dealer/verify-otp {otp:123456} → 400 OTP_TOKEN_REQUIRED",
           ok, f"status={sc} detail={detail_of(body)}")

    # 2b. Operator verify with otp=123456 → 400 OTP_TOKEN_REQUIRED
    sc, body = post("/auth/operator/verify-otp",
                    {"phone": OPERATOR_ALLOWLIST, "otp": "123456"})
    ok = sc == 400 and detail_of(body) == "OTP_TOKEN_REQUIRED"
    record("2b operator/verify-otp +918977986662 {otp:123456} → 400 OTP_TOKEN_REQUIRED",
           ok, f"status={sc} detail={detail_of(body)}")

    # 2c. Seller verify with otp=123456 (no token) and unknown phone → 404 (no seller)
    sc, body = post("/auth/seller/verify-otp",
                    {"phone": "+919999000088", "otp": "123456"})
    # 404 (no seller) OR 400 OTP_TOKEN_REQUIRED if seller exists. Both acceptable.
    not_200 = sc != 200
    ok_status = sc in (404, 400)
    ok = not_200 and ok_status
    record("2c seller/verify-otp {otp:123456} unknown phone → 404 or 400 (NEVER 200/JWT)",
           ok, f"status={sc} detail={detail_of(body)}")
    # Critical: confirm 123456 NEVER mints a token
    has_token = isinstance(body, dict) and ("token" in body or "access_token" in body)
    record("2c-critical: legacy 123456 must NEVER produce a JWT",
           not has_token, f"token-in-body={has_token}")


# ---------------------------------------------------------------------
# 3) Bogus Firebase token rejection
# ---------------------------------------------------------------------
def test_3_bogus_token_rejected() -> None:
    print("\n=== 3) Bogus Firebase token rejection ===", flush=True)

    # 3a. Dealer verify with bogus token → 400 OTP_INVALID
    sc, body = post("/auth/dealer/verify-otp",
                    {"phone": DEALER_PRESET_1, "firebase_id_token": BOGUS_TOKEN})
    ok = sc == 400 and detail_of(body) == "OTP_INVALID"
    record("3a dealer/verify-otp +919900000001 {bogus token} → 400 OTP_INVALID",
           ok, f"status={sc} detail={detail_of(body)}")

    # 3b. Operator verify with bogus token (allowlisted phone) → 400 OTP_INVALID
    sc, body = post("/auth/operator/verify-otp",
                    {"phone": OPERATOR_ALLOWLIST, "firebase_id_token": BOGUS_TOKEN})
    ok = sc == 400 and detail_of(body) == "OTP_INVALID"
    record("3b operator/verify-otp +918977986662 {bogus token} → 400 OTP_INVALID",
           ok, f"status={sc} detail={detail_of(body)}")

    # 3c. Order check: non-operator phone with bogus token → 403 OPERATOR_ACCESS_DENIED
    # (gate runs BEFORE token verify)
    sc, body = post("/auth/operator/verify-otp",
                    {"phone": "+919876500000", "firebase_id_token": BOGUS_TOKEN})
    ok = sc == 403 and detail_of(body) == "OPERATOR_ACCESS_DENIED"
    record("3c operator/verify-otp non-allowlisted {bogus token} → 403 (gate before token verify)",
           ok, f"status={sc} detail={detail_of(body)}")


# ---------------------------------------------------------------------
# 4) Operator allow-list still enforced at verify
# ---------------------------------------------------------------------
def test_4_operator_allowlist_at_verify() -> None:
    print("\n=== 4) Operator allow-list enforced at verify ===", flush=True)

    sc, body = post("/auth/operator/verify-otp",
                    {"phone": DEALER_PRESET_1, "firebase_id_token": "x.y.z"})
    ok = sc == 403 and detail_of(body) == "OPERATOR_ACCESS_DENIED"
    record("4a operator/verify-otp +919900000001 (dealer phone) → 403 OPERATOR_ACCESS_DENIED",
           ok, f"status={sc} detail={detail_of(body)}")


# ---------------------------------------------------------------------
# 5) Dealer-vs-operator mutual exclusion at verify
# ---------------------------------------------------------------------
def test_5_dealer_vs_operator_exclusion() -> None:
    print("\n=== 5) Dealer-vs-operator mutual exclusion at verify ===", flush=True)

    sc, body = post("/auth/dealer/verify-otp",
                    {"phone": OPERATOR_ALLOWLIST, "firebase_id_token": "x.y.z"})
    ok = sc == 403 and detail_of(body) == "USE_OPERATOR_LOGIN"
    record("5a dealer/verify-otp +918977986662 (operator) → 403 USE_OPERATOR_LOGIN",
           ok, f"status={sc} detail={detail_of(body)}")


# ---------------------------------------------------------------------
# 6) Rate limiting
# ---------------------------------------------------------------------
def test_6_rate_limiting() -> None:
    """Use a unique phone per sub-test to avoid cross-pollution."""
    print("\n=== 6) Rate limiting (cooldown + per-phone hour cap) ===", flush=True)

    rl_phone = "+919876543299"

    # 6a. First send → 200
    sc, body = post("/auth/dealer/send-otp", {"phone": rl_phone})
    ok = sc == 200
    record("6a 1st send-otp → 200", ok, f"status={sc} body={body}")

    # 6b. Immediate 2nd send within cooldown → 429
    sc2, body2 = post("/auth/dealer/send-otp", {"phone": rl_phone})
    detail_lower = detail_of(body2).lower()
    has_wait_word = ("wait" in detail_lower) or ("seconds" in detail_lower) or ("slow" in detail_lower) or ("cool" in detail_lower)
    ok = sc2 == 429 and has_wait_word
    record("6b immediate 2nd send within 20s → 429 (cooldown)",
           ok, f"status={sc2} detail={detail_of(body2)}")

    # 6c. Slow succession to hit 5/hour cap. Use a different phone to keep
    # this scoped. Sleep 21s between attempts to clear cooldown.
    rl_phone_b = "+919876543298"
    print("    [6c] Testing per-phone hourly cap (5/hour). This will take ~2 minutes.", flush=True)
    statuses_6c: list = []
    for i in range(6):
        sc, body = post("/auth/dealer/send-otp", {"phone": rl_phone_b})
        statuses_6c.append((sc, detail_of(body)))
        print(f"    [6c-{i+1}] status={sc} detail={detail_of(body)}", flush=True)
        if i < 5:  # don't sleep after final attempt
            time.sleep(22)
    # Expect first 5 → 200, 6th → 429 (per-phone hourly cap of 5)
    first_five_ok = sum(1 for sc, _ in statuses_6c[:5] if sc == 200) == 5
    sixth_capped = statuses_6c[5][0] == 429
    record("6c first 5 sends 200 + 6th send 429 (per-phone hourly cap)",
           first_five_ok and sixth_capped,
           f"statuses={statuses_6c}")

    # 6d. Verify-otp rate limit: 11 bogus tokens for same phone. First 10 → 400 OTP_INVALID; 11th → 429.
    rl_phone_v = "+919876543297"
    print("    [6d] Testing verify-otp rate limit (10/hour). 11 tight requests.", flush=True)
    verify_results: list = []
    for i in range(11):
        sc, body = post("/auth/dealer/verify-otp",
                        {"phone": rl_phone_v, "firebase_id_token": BOGUS_TOKEN})
        verify_results.append((sc, detail_of(body)))
    print(f"    [6d results] {verify_results}", flush=True)
    first_ten_invalid = sum(1 for sc, d in verify_results[:10]
                            if sc == 400 and d == "OTP_INVALID") == 10
    eleventh_429 = verify_results[10][0] == 429
    record("6d first 10 verify→400 OTP_INVALID + 11th→429",
           first_ten_invalid and eleventh_429,
           f"results={verify_results}")


# ---------------------------------------------------------------------
# 7) Seller send-otp silent gate (anti-enumeration)
# ---------------------------------------------------------------------
def test_7_seller_silent_gate() -> None:
    print("\n=== 7) Seller send-otp silent gate ===", flush=True)

    seller_phone = "+919999000077"
    sc, body = post("/auth/seller/send-otp", {"phone": seller_phone})
    has_ok = isinstance(body, dict) and body.get("ok") is True
    has_provider = isinstance(body, dict) and body.get("provider") == "firebase"
    ok = sc == 200 and has_ok and has_provider
    record("7a seller/send-otp unknown phone → 200 {ok:true, provider:firebase}",
           ok, f"status={sc} body={body}")

    # 7b. Repeat — should be 429 due to cooldown actually. The review
    # says "repeat to confirm same shape" — but cooldown will trigger.
    # Use a different phone to confirm the shape repeats.
    seller_phone_2 = "+919999000076"
    sc, body = post("/auth/seller/send-otp", {"phone": seller_phone_2})
    has_ok = isinstance(body, dict) and body.get("ok") is True
    has_provider = isinstance(body, dict) and body.get("provider") == "firebase"
    ok = sc == 200 and has_ok and has_provider
    record("7b seller/send-otp 2nd unknown phone → same shape",
           ok, f"status={sc} body={body}")


# ---------------------------------------------------------------------
# 8) Audit logs preserved (best-effort via direct mongo)
# ---------------------------------------------------------------------
def test_8_audit_logs() -> None:
    print("\n=== 8) Audit logs preserved ===", flush=True)

    try:
        from pymongo import MongoClient  # type: ignore
        # Backend uses MONGO_URL from /app/backend/.env
        mongo_url = "mongodb://localhost:27017"
        db_name = "qdrives_db"
        # parse from .env
        with open("/app/backend/.env", "r") as fh:
            for line in fh:
                if line.strip().startswith("MONGO_URL="):
                    mongo_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                if line.strip().startswith("DB_NAME="):
                    db_name = line.split("=", 1)[1].strip().strip('"').strip("'")
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=4000)
        db = client[db_name]

        # 8a: dealer_send_otp_blocked_operator from step 1c
        doc = db.audit_logs.find_one({
            "action": "dealer_send_otp_blocked_operator",
            "meta.phone": OPERATOR_ALLOWLIST,
        })
        ok = doc is not None
        record("8a audit_logs has dealer_send_otp_blocked_operator for +918977986662",
               ok, f"doc={'found' if doc else 'missing'}")

        # 8b: operator_access_denied with stage='verify' from step 4a
        doc = db.audit_logs.find_one({
            "action": "operator_access_denied",
            "meta.stage": "verify",
        })
        ok = doc is not None
        record("8b audit_logs has operator_access_denied stage=verify",
               ok, f"doc={'found' if doc else 'missing'}")
    except Exception as exc:
        record("8 audit logs (mongo direct check)", False, f"exc={exc}")


# ---------------------------------------------------------------------
# 9) Health regression
# ---------------------------------------------------------------------
def test_9_health() -> None:
    print("\n=== 9) Health regression ===", flush=True)
    sc, body = get("/")
    ok = sc == 200 and isinstance(body, dict) and body.get("status") == "ok"
    record("9a GET /api/ → 200 {status:ok}", ok, f"status={sc} body={body}")

    # /api/auth/me without a token (should be 401, route still mounted)
    sc, body = get("/auth/me")
    ok = sc == 401  # route still exists, just unauthenticated
    record("9b GET /api/auth/me (no token) → 401 (route still mounted)",
           ok, f"status={sc} detail={detail_of(body)}")


# ---------------------------------------------------------------------
def main() -> int:
    print(f"BASE = {BASE}", flush=True)
    test_1_send_otp_role_gates()
    test_2_mock_otp_rejected()
    test_3_bogus_token_rejected()
    test_4_operator_allowlist_at_verify()
    test_5_dealer_vs_operator_exclusion()
    # Rate limiting last so cooldowns don't break earlier role-gate tests
    test_7_seller_silent_gate()
    test_8_audit_logs()
    test_9_health()
    test_6_rate_limiting()  # ~2-3 minutes

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n=== RESULT: {passed}/{total} PASS ===", flush=True)
    failed = [(l, d) for l, ok, d in results if not ok]
    if failed:
        print("FAILURES:", flush=True)
        for l, d in failed:
            print(f"  - {l} :: {d}", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
