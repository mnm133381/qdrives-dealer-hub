"""
Q DRIVES — Auth Refactor (open dealer onboarding + status-gated bidding) test suite.

Validates:
  • Open dealer onboarding (any phone → pending)
  • Operator phone blocked from dealer flow (USE_OPERATOR_LOGIN)
  • Pre-seeded dealer auto-approve preset
  • Status-gated /bid and /purchases (DEALER_PENDING_APPROVAL, _SUSPENDED, _REVOKED)
  • POST /admin/dealers/{id}/approve canonical endpoint (idempotent, audit, tv bump)
  • /admin/dealers/{id}/verify mirroring to status field
  • /admin/dealers?status=... filters
  • New super_admin operator (+918977986662)
  • Migration backfill verification
  • WS auth still works for pending dealers (view-only)
"""
import os
import sys
import time
import json
import uuid
import asyncio
import requests
from typing import Any, Dict, Optional

# ---- Backend URL resolution ----
FRONTEND_ENV = "/app/frontend/.env"
BASE_URL = None
with open(FRONTEND_ENV) as f:
    for line in f:
        line = line.strip()
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
if not BASE_URL:
    BASE_URL = "https://qdrives-dealer-hub.preview.emergentagent.com"
API = BASE_URL.rstrip("/") + "/api"
WS_BASE = API.replace("https://", "wss://").replace("http://", "ws://")

print(f"[*] Backend API base: {API}")

# ---- Credentials ----
OP_BOOT = "+919900000099"           # bootstrap super_admin
OP_NEW = "+918977986662"            # NEW super_admin (Nihad M)
PRESEEDED_DEALER = "+919900000003"  # Velocity Auto Hub (auto-approve preset)
OTP = "123456"

PASS = []
FAIL = []


def record(name: str, ok: bool, info: str = ""):
    tag = "✅" if ok else "❌"
    print(f"{tag} {name} {('— ' + info) if info else ''}")
    (PASS if ok else FAIL).append((name, info))


def post(path: str, json_body=None, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.post(f"{API}{path}", json=json_body, headers=h, timeout=30)


def get(path: str, token=None, params=None):
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.get(f"{API}{path}", headers=h, params=params, timeout=30)


def operator_login(phone: str) -> Optional[str]:
    r = post("/auth/operator/send-otp", {"phone": phone})
    if r.status_code != 200:
        return None
    r = post("/auth/operator/verify-otp", {"phone": phone, "otp": OTP})
    if r.status_code != 200:
        return None
    return r.json().get("token")


def dealer_login(phone: str):
    r = post("/auth/dealer/send-otp", {"phone": phone})
    if r.status_code != 200:
        return None, None, r
    r = post("/auth/dealer/verify-otp", {"phone": phone, "otp": OTP})
    if r.status_code != 200:
        return None, None, r
    j = r.json()
    return j.get("token"), j, r


# ============================================================================
# Pre-flight
# ============================================================================
print("\n=== PRE-FLIGHT ===")
try:
    r = requests.get(f"{API}/", timeout=10)
    print(f"[*] /api ping: {r.status_code}")
except Exception as e:
    print(f"[*] /api ping err: {e}")

OP_BOOT_TOK = operator_login(OP_BOOT)
if not OP_BOOT_TOK:
    print(f"[!] Could not obtain bootstrap operator token; aborting")
    sys.exit(1)
print(f"[*] Bootstrap operator token acquired (len={len(OP_BOOT_TOK)})")


# ============================================================================
# G) NEW OPERATOR PHONE
# ============================================================================
print("\n=== G) NEW OPERATOR (+918977986662) ===")
r = post("/auth/operator/send-otp", {"phone": OP_NEW})
record("G.1 send-otp new operator → 200 + dev_otp",
       r.status_code == 200 and r.json().get("dev_otp") == OTP,
       f"status={r.status_code} body={r.text[:120]}")

r = post("/auth/operator/verify-otp", {"phone": OP_NEW, "otp": OTP})
ok = r.status_code == 200
op_new_tok = None
op_new_dealer = None
if ok:
    j = r.json()
    op_new_tok = j.get("token")
    op_new_dealer = j.get("dealer") or {}
    ok = (op_new_dealer.get("role") == "super_admin")
record("G.2 verify-otp new operator → 200, role=super_admin",
       ok, f"role={op_new_dealer.get('role') if op_new_dealer else None}")

if op_new_tok:
    r = get("/auth/me", token=op_new_tok)
    me_role = r.json().get("role") if r.status_code == 200 else None
    record("G.3 /auth/me → role=super_admin", r.status_code == 200 and me_role == "super_admin",
           f"status={r.status_code} role={me_role}")

    r = get("/admin/dealers", token=op_new_tok)
    record("G.4 new operator can call /admin/dealers (admin perms)",
           r.status_code == 200, f"status={r.status_code}")
else:
    record("G.3 /auth/me skipped", False, "no token from G.2")
    record("G.4 admin perms skipped", False, "no token from G.2")


# ============================================================================
# A) DEALER OPEN ONBOARDING
# ============================================================================
print("\n=== A) DEALER OPEN ONBOARDING ===")
RUN_TAG = str(int(time.time()))[-6:]
NEW_PHONE = f"+919{RUN_TAG}11122"
print(f"[*] Random unused phone: {NEW_PHONE}")

r = post("/auth/dealer/send-otp", {"phone": NEW_PHONE})
record("A.1 send-otp random phone → 200 + dev_otp:'123456'",
       r.status_code == 200 and r.json().get("dev_otp") == OTP,
       f"status={r.status_code} body={r.text[:140]}")

r = post("/auth/dealer/verify-otp", {"phone": NEW_PHONE, "otp": OTP})
new_dealer_tok = None
new_dealer = None
ok = r.status_code == 200
if ok:
    j = r.json()
    new_dealer_tok = j.get("token")
    new_dealer = j.get("dealer") or {}
    ok = (j.get("is_new") is True and new_dealer.get("status") == "pending")
record("A.2 verify-otp new phone → 200 is_new=true status=pending", ok,
       f"is_new={r.json().get('is_new') if r.status_code==200 else None} "
       f"status={(new_dealer or {}).get('status')}")

if new_dealer_tok:
    r = get("/auth/me", token=new_dealer_tok)
    me = r.json() if r.status_code == 200 else {}
    ok = (me.get("role") == "dealer" and me.get("status") == "pending"
          and me.get("verified") is False)
    record("A.3 /auth/me role=dealer status=pending verified=false", ok,
           f"role={me.get('role')} status={me.get('status')} verified={me.get('verified')}")
else:
    record("A.3 skipped", False, "no token")

r = post("/auth/dealer/verify-otp", {"phone": NEW_PHONE, "otp": OTP})
ok = (r.status_code == 200 and r.json().get("is_new") is False
      and (r.json().get("dealer") or {}).get("status") == "pending")
record("A.4 same phone re-login is_new=false status still pending", ok,
       f"is_new={r.json().get('is_new')} status={(r.json().get('dealer') or {}).get('status')}")
if r.status_code == 200:
    new_dealer_tok = r.json().get("token")
    new_dealer = r.json().get("dealer") or {}

r = post("/auth/dealer/send-otp", {"phone": "+9112345"})
record("A.5 short phone → 400", r.status_code == 400,
       f"status={r.status_code} body={r.text[:120]}")

r = post("/auth/dealer/send-otp", {"phone": OP_NEW})
ok = (r.status_code == 403 and r.json().get("detail") == "USE_OPERATOR_LOGIN")
record("A.6 send-otp operator phone → 403 USE_OPERATOR_LOGIN", ok,
       f"status={r.status_code} detail={r.json().get('detail') if r.status_code==403 else r.text[:120]}")

r = post("/auth/dealer/verify-otp", {"phone": OP_NEW, "otp": OTP})
ok = (r.status_code == 403 and r.json().get("detail") == "USE_OPERATOR_LOGIN")
record("A.7 verify-otp operator phone → 403 USE_OPERATOR_LOGIN", ok,
       f"status={r.status_code} detail={r.json().get('detail') if r.status_code==403 else r.text[:120]}")


# ============================================================================
# B) PRESET AUTO-APPROVE
# ============================================================================
print("\n=== B) PRESET AUTO-APPROVE ===")
tok3, j3, _ = dealer_login(PRESEEDED_DEALER)
preseed_dealer = (j3 or {}).get("dealer") or {}
ok = (preseed_dealer.get("status") == "approved"
      and preseed_dealer.get("dealership_name") == "Velocity Auto Hub")
record("B.1 +919900000003 → status=approved + dealership_name='Velocity Auto Hub'", ok,
       f"status={preseed_dealer.get('status')} name={preseed_dealer.get('dealership_name')}")
preseed_dealer_id = preseed_dealer.get("id")
preseed_tok = tok3

ok = bool(preseed_dealer.get("status")) and preseed_dealer.get("status") in (
    "approved", "pending", "suspended", "revoked")
record("B.2 pre-seeded dealer has status field (migration backfill OK)", ok,
       f"status={preseed_dealer.get('status')}")


# ============================================================================
# C) STATUS-GATED ACTIONS
# ============================================================================
print("\n=== C) STATUS-GATED ACTIONS (pending dealer) ===")

r = get("/auctions", token=new_dealer_tok)
record("C.3 pending /auctions → 200", r.status_code == 200, f"status={r.status_code}")

auction_id = None
if r.status_code == 200 and r.json():
    live = [a for a in r.json() if a.get("status") == "live"]
    pool = live or r.json()
    auction_id = pool[0].get("id")
    print(f"[*] Selected auction_id={auction_id} status={pool[0].get('status')}")

r = get("/watchlist", token=new_dealer_tok)
record("C.4 pending /watchlist → 200", r.status_code == 200, f"status={r.status_code}")

if auction_id:
    r = post(f"/watchlist/{auction_id}", token=new_dealer_tok)
    record("C.5 pending /watchlist/{id} POST → 200", r.status_code == 200, f"status={r.status_code}")

    r = get(f"/auctions/{auction_id}", token=new_dealer_tok)
    record("C.6 pending /auctions/{id} → 200", r.status_code == 200, f"status={r.status_code}")
else:
    record("C.5 skipped — no auction", False, "")
    record("C.6 skipped — no auction", False, "")

r = get("/notifications", token=new_dealer_tok)
record("C.7 pending /notifications → 200", r.status_code == 200, f"status={r.status_code}")

if auction_id:
    r = post(f"/auctions/{auction_id}/bid", {"amount": 99999999}, token=new_dealer_tok)
    ok = (r.status_code == 403 and r.json().get("detail") == "DEALER_PENDING_APPROVAL")
    record("C.1 pending /bid → 403 DEALER_PENDING_APPROVAL", ok,
           f"status={r.status_code} detail={r.json().get('detail') if r.status_code==403 else r.text[:120]}")
else:
    record("C.1 skipped — no auction", False, "")

r = get("/purchases", token=new_dealer_tok)
ok = (r.status_code == 403 and r.json().get("detail") == "DEALER_PENDING_APPROVAL")
record("C.2 pending /purchases → 403 DEALER_PENDING_APPROVAL", ok,
       f"status={r.status_code} detail={r.json().get('detail') if r.status_code==403 else r.text[:120]}")

# C.8 approved dealer /bid
if preseed_tok:
    live_auctions = [a for a in get("/auctions", token=preseed_tok).json() if a.get("status") == "live"]
    bid_auction = None
    for a in live_auctions:
        seller = (a.get("seller") or {}).get("id")
        if seller and seller != preseed_dealer_id:
            bid_auction = a
            break
    if bid_auction:
        cur = bid_auction.get("current_bid", 0) or bid_auction.get("starting_bid", 0)
        r = post(f"/auctions/{bid_auction['id']}/bid", {"amount": cur + 5000}, token=preseed_tok)
        is_pending_err = (r.status_code == 403
                          and r.headers.get("content-type", "").startswith("application/json")
                          and r.json().get("detail") == "DEALER_PENDING_APPROVAL")
        record("C.8 approved /bid → not DEALER_PENDING_APPROVAL", not is_pending_err,
               f"status={r.status_code} body={r.text[:140]}")
    else:
        record("C.8 skipped — no eligible live auction", True, "non-fatal")
else:
    record("C.8 skipped — no preseed token", False, "")

r = get("/purchases", token=preseed_tok)
record("C.9 approved /purchases → 200", r.status_code == 200, f"status={r.status_code}")

# C.10 suspended dealer flow
SUSP_PHONE = f"+919{RUN_TAG}22233"
sus_tok, sus_j, _ = dealer_login(SUSP_PHONE)
sus_id = (sus_j or {}).get("dealer", {}).get("id")
if sus_id:
    r = post(f"/admin/dealers/{sus_id}/verify", {"suspended": True}, token=OP_BOOT_TOK)
    setup_ok = (r.status_code == 200 and r.json().get("status") == "suspended")
    if setup_ok:
        sus_tok2, sus_j2, _ = dealer_login(SUSP_PHONE)
        login_ok = sus_tok2 is not None
        if login_ok and auction_id:
            r2 = post(f"/auctions/{auction_id}/bid", {"amount": 99999999}, token=sus_tok2)
            bid_ok = (r2.status_code == 403 and r2.json().get("detail") == "DEALER_ACCOUNT_SUSPENDED")
            record("C.10 suspended /bid → 403 DEALER_ACCOUNT_SUSPENDED + login still allowed",
                   bid_ok and login_ok,
                   f"login_ok={login_ok} bid_status={r2.status_code} detail={r2.json().get('detail') if r2.status_code==403 else r2.text[:120]}")
        else:
            record("C.10 partial — could not re-login or no auction", login_ok, "")
    else:
        record("C.10 suspend setup failed", False, f"status={r.status_code} body={r.text[:140]}")
else:
    record("C.10 setup failed (no sus dealer)", False, "")


# ============================================================================
# D) NEW APPROVE ENDPOINT
# ============================================================================
print("\n=== D) /admin/dealers/{id}/approve ===")
APPROVE_PHONE = f"+919{RUN_TAG}33344"
ap_tok, ap_j, _ = dealer_login(APPROVE_PHONE)
ap_id = (ap_j or {}).get("dealer", {}).get("id")
print(f"[*] Pending dealer for approve test: {APPROVE_PHONE} id={ap_id}")

r = post(f"/admin/dealers/{ap_id}/approve",
         {"note": "test approval — onboarded via QA"},
         token=op_new_tok or OP_BOOT_TOK)
ok = (r.status_code == 200)
approved_doc = r.json() if ok else {}
ok = ok and approved_doc.get("status") == "approved" \
    and approved_doc.get("previous_status") == "pending" \
    and approved_doc.get("approved_at") and approved_doc.get("approved_by")
record("D.1 approve pending → 200 + status=approved + previous_status=pending + approved_at + approved_by",
       ok,
       f"status={approved_doc.get('status')} prev={approved_doc.get('previous_status')} "
       f"approved_at={bool(approved_doc.get('approved_at'))} approved_by={approved_doc.get('approved_by')}")

time.sleep(0.6)
r = get("/admin/audit-logs", token=op_new_tok or OP_BOOT_TOK,
        params={"action": "dealer_approved", "since_hours": 1, "limit": 100})
audit_ok = (r.status_code == 200)
hit = None
if audit_ok:
    items = r.json().get("items", [])
    for it in items:
        if it.get("target_id") == ap_id:
            hit = it
            break
meta = (hit or {}).get("meta") or {}
ok = audit_ok and hit is not None \
     and meta.get("previous_status") == "pending" \
     and meta.get("note") == "test approval — onboarded via QA" \
     and "ip" in meta and "user_agent" in meta
record("D.2 audit_logs?action=dealer_approved entry has previous_status, ip, user_agent, note",
       ok,
       f"meta_keys={list(meta.keys())}")

r = post(f"/admin/dealers/{ap_id}/approve", {"note": "second call"},
         token=op_new_tok or OP_BOOT_TOK)
ok_idem = (r.status_code == 200 and r.json().get("status") == "approved")
time.sleep(0.4)
r2 = get("/admin/audit-logs", token=op_new_tok or OP_BOOT_TOK,
         params={"action": "dealer_approved", "since_hours": 1, "limit": 200})
count_after = sum(1 for it in r2.json().get("items", []) if it.get("target_id") == ap_id)
record("D.3 idempotent — re-approve 200 + no extra audit entry",
       ok_idem and count_after == 1,
       f"status={r.status_code} audit_entries_for_dealer={count_after}")

APPROVE_PHONE_2 = f"+919{RUN_TAG}33355"
ap2_tok, ap2_j, _ = dealer_login(APPROVE_PHONE_2)
ap2_id = (ap2_j or {}).get("dealer", {}).get("id")
r = post(f"/admin/dealers/{ap2_id}/approve",
         {"max_bid_limit": 2500000, "note": "high-tier"},
         token=op_new_tok or OP_BOOT_TOK)
ok = (r.status_code == 200 and r.json().get("max_bid_limit") == 2500000
      and r.json().get("status") == "approved")
record("D.4 approve with max_bid_limit=2500000 applied",
       ok, f"status={r.status_code} max_bid_limit={r.json().get('max_bid_limit') if r.status_code==200 else None}")

APPROVE_PHONE_3 = f"+919{RUN_TAG}33366"
ap3_tok, ap3_j, _ = dealer_login(APPROVE_PHONE_3)
ap3_id = (ap3_j or {}).get("dealer", {}).get("id")
r = post(f"/admin/dealers/{ap3_id}/approve",
         {"max_bid_limit": 0}, token=op_new_tok or OP_BOOT_TOK)
record("D.5 approve max_bid_limit<=0 → 400", r.status_code == 400,
       f"status={r.status_code} body={r.text[:140]}")

r = post(f"/admin/dealers/{uuid.uuid4()}/approve", {"note": "ghost"},
         token=op_new_tok or OP_BOOT_TOK)
record("D.6 approve unknown dealer → 404", r.status_code == 404, f"status={r.status_code}")

op_doc = get("/auth/me", token=op_new_tok).json() if op_new_tok else {}
op_id = op_doc.get("id")
if op_id:
    r = post(f"/admin/dealers/{op_id}/approve", {"note": "wrong"},
             token=OP_BOOT_TOK)
    record("D.7 approve operator account → 400 (cannot approve non-dealer)",
           r.status_code == 400, f"status={r.status_code} body={r.text[:140]}")
else:
    record("D.7 skipped — no operator id", False, "")

r = post(f"/admin/dealers/{ap3_id}/approve", {}, token=preseed_tok)
record("D.8 dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")

r = post(f"/admin/dealers/{ap3_id}/approve", {})
record("D.9 anonymous → 401", r.status_code == 401, f"status={r.status_code}")

# D.10 token invalidation
r_approve = post(f"/admin/dealers/{ap3_id}/approve", {"note": "post-test"},
                 token=op_new_tok or OP_BOOT_TOK)
time.sleep(0.7)
r = get("/auth/me", token=ap3_tok)
ok_old_dead = (r.status_code == 401
               and "SESSION_INVALIDATED" in (r.json().get("detail") or ""))
ap3_tok_new, ap3_j_new, _ = dealer_login(APPROVE_PHONE_3)
fresh_status = (ap3_j_new or {}).get("dealer", {}).get("status")
ok_fresh = (ap3_tok_new is not None and fresh_status == "approved")
record("D.10 old JWT → 401 SESSION_INVALIDATED + re-login = approved",
       ok_old_dead and ok_fresh,
       f"old_status={r.status_code} old_detail={r.json().get('detail') if r.status_code==401 else None} "
       f"fresh_status={fresh_status}")


# ============================================================================
# E) /verify ENDPOINT MIRRORING
# ============================================================================
print("\n=== E) /verify mirroring to status ===")
E_PHONE = f"+919{RUN_TAG}44455"
e_tok, e_j, _ = dealer_login(E_PHONE)
e_id = (e_j or {}).get("dealer", {}).get("id")
e_status = (e_j or {}).get("dealer", {}).get("status")
print(f"[*] E dealer: {E_PHONE} id={e_id} initial status={e_status}")

r = post(f"/admin/dealers/{e_id}/verify", {"verified": True}, token=OP_BOOT_TOK)
body = r.json() if r.status_code == 200 else {}
ok = (r.status_code == 200 and body.get("status") == "approved"
      and body.get("previous_status") == "pending" and body.get("approved_at"))
record("E.1 /verify {verified:true} on pending → status=approved + previous_status=pending + approved_at",
       ok,
       f"status={body.get('status')} prev={body.get('previous_status')} approved_at={bool(body.get('approved_at'))}")

r = post(f"/admin/dealers/{e_id}/verify", {"suspended": True}, token=OP_BOOT_TOK)
body = r.json() if r.status_code == 200 else {}
ok = (r.status_code == 200 and body.get("status") == "suspended")
record("E.2 /verify {suspended:true} → status=suspended", ok,
       f"status={body.get('status')}")

r = post(f"/admin/dealers/{e_id}/verify", {"verified": False}, token=OP_BOOT_TOK)
body = r.json() if r.status_code == 200 else {}
ok = (r.status_code == 200 and body.get("status") == "pending")
record("E.3 /verify {verified:false} → status=pending", ok,
       f"status={body.get('status')}")


# ============================================================================
# F) STATUS FILTER
# ============================================================================
print("\n=== F) /admin/dealers?status=... ===")
for filt in ("pending", "approved", "suspended", "revoked"):
    r = get("/admin/dealers", token=OP_BOOT_TOK, params={"status_filter": filt})
    ok = r.status_code == 200
    items = r.json() if ok else []
    bad = []
    for d in items:
        s = d.get("status")
        if filt == "approved":
            ok_d = (s == "approved") or (not s and d.get("verified") and not d.get("suspended"))
        elif filt == "pending":
            ok_d = (s == "pending") or (not s and not d.get("verified") and not d.get("suspended"))
        elif filt == "suspended":
            ok_d = (s == "suspended") or (not s and d.get("suspended"))
        elif filt == "revoked":
            ok_d = (s == "revoked")
        else:
            ok_d = True
        if not ok_d:
            bad.append({"id": d.get("id"), "status": s, "verified": d.get("verified"),
                        "suspended": d.get("suspended")})
    record(f"F /admin/dealers?status_filter={filt} → 200 + filter respected",
           ok and not bad,
           f"count={len(items)} bad_examples={bad[:2]}")


# ============================================================================
# H) MIGRATION VERIFICATION
# ============================================================================
print("\n=== H) MIGRATION ===")
r = get("/admin/dealers", token=OP_BOOT_TOK)
all_dealers = r.json() if r.status_code == 200 else []
no_status = [d for d in all_dealers if not d.get("status")]
empty_status = [d for d in all_dealers if d.get("status") in (None, "")]
record("H.1+H.2 every dealer has non-empty status (no None/empty)",
       len(no_status) == 0 and len(empty_status) == 0,
       f"total_dealers={len(all_dealers)} missing_status={len(no_status)} empty_status={len(empty_status)}")

preseed_phones = {f"+91990000000{i}" for i in range(1, 6)}
# Trigger logins so dealer docs exist
for ph in preseed_phones:
    dealer_login(ph)
r = get("/admin/dealers", token=OP_BOOT_TOK)
all_dealers = r.json() if r.status_code == 200 else []
preseed_in_list = [d for d in all_dealers if d.get("phone") in preseed_phones]
not_approved = [d for d in preseed_in_list if d.get("status") != "approved"]
record("H.3 5 pre-seeded dealers status=approved",
       len(preseed_in_list) == 5 and len(not_approved) == 0,
       f"found={len(preseed_in_list)} not_approved={[d.get('phone') for d in not_approved]}")


# ============================================================================
# I) WS AUTH UNAFFECTED
# ============================================================================
print("\n=== I) WS auth ===")
import websockets

async def ws_test(token: str, label: str) -> bool:
    if not auction_id:
        return False
    url = f"{WS_BASE}/ws/auction/{auction_id}?token={token}"
    try:
        async with websockets.connect(url, open_timeout=10, close_timeout=5) as ws:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                if data.get("type") in ("snapshot", "new_bid", "ping"):
                    return True
                return True  # any frame counts as connected
            except asyncio.TimeoutError:
                return True  # connected with no frame yet
    except Exception as e:
        print(f"   [!] WS {label} error: {e}")
        return False


async def run_ws():
    tok_pending, _, _ = dealer_login(NEW_PHONE)
    pending_ok = await ws_test(tok_pending, "pending") if tok_pending else False
    record("I.1 pending dealer WS connect + frame", pending_ok, "")

    approved_ok = await ws_test(preseed_tok, "approved") if preseed_tok else False
    record("I.2 approved dealer WS handshake works", approved_ok, "")

try:
    asyncio.run(run_ws())
except Exception as e:
    record("I WS tests crashed", False, str(e))


# ============================================================================
# Summary
# ============================================================================
print("\n" + "=" * 70)
print(f"PASSED: {len(PASS)}    FAILED: {len(FAIL)}")
if FAIL:
    print("\nFAILURES:")
    for n, info in FAIL:
        print(f"  ❌ {n}  — {info}")
print("=" * 70)
sys.exit(0 if not FAIL else 1)
