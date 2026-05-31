"""
PWA Web Push Backend Verification — focused test.

Covers:
 1) POST /api/notifications/register-token — 6 cases (Expo, FCM web, reject FCM w/o web, malformed, empty, idempotency)
 2) POST /api/notifications/unregister-token — pulls token from dealer doc + db.push_tokens
 3) push.is_valid_expo_token / push.is_likely_fcm_web_token sanity
 4) GET /api/  and  GET /api/auctions (anonymous, reserve_price stripped)

Uses buyer test credentials: +919900000001 / OTP 123456.
"""
from __future__ import annotations

import os
import sys
import secrets
import string
import asyncio
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load frontend .env to obtain the public backend URL
ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / "frontend" / ".env")
load_dotenv(ROOT / "backend" / ".env")

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("REACT_APP_BACKEND_URL")
    or ""
).rstrip("/")
if not BASE_URL:
    print("FATAL: no public backend URL in env"); sys.exit(2)
API = f"{BASE_URL}/api"

DEALER_PHONE = "+919900000001"

results: list[tuple[str, bool, str]] = []

def record(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    sym = "PASS" if ok else "FAIL"
    print(f"  [{sym}] {name}" + (f" — {detail}" if detail else ""))


def rand_token(n: int) -> str:
    """A random url-safe-ish string of length n (looks like an FCM token)."""
    alphabet = string.ascii_letters + string.digits + "-_:"
    return "".join(secrets.choice(alphabet) for _ in range(n))


def login_dealer() -> tuple[str, str]:
    r = requests.post(
        f"{API}/auth/dealer/verify-otp",
        json={"phone": DEALER_PHONE, "otp": "123456"},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"dealer login failed: {r.status_code} {r.text[:300]}")
    js = r.json()
    return js["token"], js["dealer"]["id"]


def get_dealer_doc(dealer_id: str) -> dict:
    """Fetch dealer's push_tokens via direct mongo (since there's no GET endpoint)."""
    from pymongo import MongoClient
    client = MongoClient(os.environ.get("MONGO_URL"))
    dbname = os.environ.get("DB_NAME", "qdrives")
    return client[dbname].dealers.find_one({"id": dealer_id}, {"_id": 0, "push_tokens": 1}) or {}


def get_push_token_doc(token: str) -> dict | None:
    from pymongo import MongoClient
    client = MongoClient(os.environ.get("MONGO_URL"))
    dbname = os.environ.get("DB_NAME", "qdrives")
    return client[dbname].push_tokens.find_one({"token": token}, {"_id": 0})


# --------------------------------------------------------------------------- #
# 0. Setup — login dealer
# --------------------------------------------------------------------------- #
print("\n=== Setup ===")
try:
    JWT, DEALER_ID = login_dealer()
    record("dealer login (+919900000001 / OTP 123456)", True, f"dealer_id={DEALER_ID[:8]}…")
except Exception as e:
    record("dealer login", False, str(e))
    print("\nAborting — cannot continue without auth.")
    sys.exit(1)

HDRS = {"Authorization": f"Bearer {JWT}", "Content-Type": "application/json"}

# Best-effort: clear any prior test tokens for a clean baseline
EXPO_TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
FCM_TOKEN = rand_token(200)
FCM_TOKEN_2 = rand_token(200)  # for case (c)

for t in (EXPO_TOKEN, FCM_TOKEN, FCM_TOKEN_2):
    try:
        requests.post(f"{API}/notifications/unregister-token",
                      headers=HDRS, json={"token": t}, timeout=10)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# 1. Register-token endpoint — 6 cases
# --------------------------------------------------------------------------- #
print("\n=== 1. POST /api/notifications/register-token ===")

# (a) Expo native token — regression
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": EXPO_TOKEN, "platform": "android"}, timeout=15)
ok_a = (r.status_code == 200 and r.json().get("success") is True)
detail_a = f"status={r.status_code} body={r.text[:120]}"
if ok_a:
    doc = get_dealer_doc(DEALER_ID)
    tok_doc = get_push_token_doc(EXPO_TOKEN)
    in_dealer = EXPO_TOKEN in (doc.get("push_tokens") or [])
    in_pt = tok_doc and tok_doc.get("channel") == "expo" and tok_doc.get("platform") == "android"
    ok_a = in_dealer and bool(in_pt)
    detail_a = f"in_dealer_push_tokens={in_dealer} push_tokens.channel='expo' platform='android' → {bool(in_pt)}"
record("(a) Expo token + platform=android → 200 + persisted (channel=expo)", ok_a, detail_a)

# (b) FCM web token — NEW
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": FCM_TOKEN, "platform": "web"}, timeout=15)
ok_b = (r.status_code == 200 and r.json().get("success") is True)
detail_b = f"status={r.status_code}"
if ok_b:
    doc = get_dealer_doc(DEALER_ID)
    push_tokens = doc.get("push_tokens") or []
    has_both = (EXPO_TOKEN in push_tokens) and (FCM_TOKEN in push_tokens)
    tok_doc = get_push_token_doc(FCM_TOKEN)
    in_pt = tok_doc and tok_doc.get("channel") == "fcm_web" and tok_doc.get("platform") == "web"
    ok_b = has_both and bool(in_pt)
    detail_b = f"dealer has BOTH tokens={has_both}; push_tokens row channel='fcm_web' platform='web' → {bool(in_pt)}"
record("(b) FCM web token + platform=web → 200 + persisted (channel=fcm_web)", ok_b, detail_b)

# (c) FCM-shaped token without platform=web → 400
fcm_no_web = rand_token(200)
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": fcm_no_web, "platform": "android"}, timeout=15)
ok_c = (r.status_code == 400)
record("(c) FCM-shaped token w/ platform=android → 400", ok_c,
       f"status={r.status_code} body={r.text[:120]}")

# (d) Malformed/short web token → 400
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": "tooshort", "platform": "web"}, timeout=15)
ok_d = (r.status_code == 400)
record("(d) Malformed short web token → 400", ok_d,
       f"status={r.status_code} body={r.text[:120]}")

# (e) Empty token → 400
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": "", "platform": "web"}, timeout=15)
ok_e = (r.status_code == 400)
record("(e) Empty token → 400", ok_e,
       f"status={r.status_code} body={r.text[:120]}")

# (f) Idempotency — resend FCM web token, expect no duplicates
r = requests.post(f"{API}/notifications/register-token",
                  headers=HDRS,
                  json={"token": FCM_TOKEN, "platform": "web"}, timeout=15)
ok_f1 = (r.status_code == 200 and r.json().get("success") is True)
doc = get_dealer_doc(DEALER_ID)
push_tokens = doc.get("push_tokens") or []
dup_count = sum(1 for t in push_tokens if t == FCM_TOKEN)
ok_f = ok_f1 and dup_count == 1
record("(f) Idempotency — resend FCM token, no duplicate", ok_f,
       f"status={r.status_code} duplicate_count={dup_count}")


# --------------------------------------------------------------------------- #
# 2. Unregister-token regression
# --------------------------------------------------------------------------- #
print("\n=== 2. POST /api/notifications/unregister-token ===")

r = requests.post(f"{API}/notifications/unregister-token",
                  headers=HDRS,
                  json={"token": FCM_TOKEN, "platform": "web"}, timeout=15)
ok2_status = (r.status_code == 200)
doc = get_dealer_doc(DEALER_ID)
push_tokens = doc.get("push_tokens") or []
not_in_dealer = FCM_TOKEN not in push_tokens
tok_doc = get_push_token_doc(FCM_TOKEN)
not_in_pt = tok_doc is None
ok_unreg = ok2_status and not_in_dealer and not_in_pt
record("Unregister FCM token → pulled from dealer + removed from push_tokens", ok_unreg,
       f"status={r.status_code} removed_from_dealer={not_in_dealer} removed_from_push_tokens={not_in_pt}")


# --------------------------------------------------------------------------- #
# 3. Module-level validator sanity (no HTTP)
# --------------------------------------------------------------------------- #
print("\n=== 3. push.is_valid_expo_token / push.is_likely_fcm_web_token ===")
sys.path.insert(0, str(ROOT / "backend"))
try:
    import push as push_mod  # noqa: E402

    e1 = push_mod.is_valid_expo_token("ExponentPushToken[abc]") is True
    record("is_valid_expo_token('ExponentPushToken[abc]') → True", e1, "")

    long_fake = rand_token(200)
    e2 = push_mod.is_valid_expo_token(long_fake) is False
    record("is_valid_expo_token('<200-char-fcm>') → False", e2, "")

    e3 = push_mod.is_likely_fcm_web_token(long_fake) is True
    record("is_likely_fcm_web_token('<200-char-fcm>') → True", e3, "")

    e4 = push_mod.is_likely_fcm_web_token("ExponentPushToken[abc]") is False
    record("is_likely_fcm_web_token('ExponentPushToken[abc]') → False", e4, "")

    e5 = push_mod.is_likely_fcm_web_token("tooshort") is False
    record("is_likely_fcm_web_token('tooshort') → False", e5, "")
except Exception as e:
    record("push module sanity", False, repr(e))


# --------------------------------------------------------------------------- #
# 4. Health + auctions reserve_price-stripped spot-check
# --------------------------------------------------------------------------- #
print("\n=== 4. Health + anonymous /api/auctions reserve_price stripped ===")

r = requests.get(f"{API}/", timeout=10)
ok_health = (r.status_code == 200)
record("GET /api/ → 200", ok_health, f"status={r.status_code}")

r = requests.get(f"{API}/auctions", timeout=15)
ok_anon = (r.status_code == 200 and isinstance(r.json(), list))
items = r.json() if ok_anon else []
leaked = [a for a in items if "reserve_price" in a]
ok_priv = ok_anon and len(leaked) == 0
detail = f"status={r.status_code} count={len(items)} leaked_reserve_price={len(leaked)}"
record("GET /api/auctions anonymous → list, every entry reserve_price stripped", ok_priv, detail)


# --------------------------------------------------------------------------- #
# Cleanup — unregister Expo token to restore baseline
# --------------------------------------------------------------------------- #
print("\n=== Cleanup ===")
try:
    r = requests.post(f"{API}/notifications/unregister-token",
                      headers=HDRS, json={"token": EXPO_TOKEN, "platform": "android"}, timeout=10)
    print(f"  cleanup unregister Expo token → {r.status_code}")
    # FCM already unregistered in §2
except Exception as e:
    print(f"  cleanup error: {e}")


# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
print("\n" + "=" * 70)
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"Total: {passed}/{total} passed")
print("=" * 70)
for name, ok, detail in results:
    sym = "PASS" if ok else "FAIL"
    print(f"  [{sym}] {name}")
    if not ok and detail:
        print(f"         → {detail}")

sys.exit(0 if passed == total else 1)
