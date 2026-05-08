"""
Backend tests for the modular Operator Broadcasts module.

Covers:
  * GET  /api/admin/broadcasts/templates
  * GET  /api/admin/broadcasts/auctions
  * GET  /api/admin/broadcasts/recent?limit=
  * POST /api/admin/broadcasts (BroadcastReq)
  * Regression: legacy POST /api/admin/notifications/broadcast still works
  * Regression: GET /api/admin/auctions/live-grid still 200 for super_admin
  * Regression: operator + dealer login still work

Target URL: EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env, suffixed /api.
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

import requests

# ---------------------------------------------------------------- env
def _read_env_var(path: str, key: str) -> Optional[str]:
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                v = v.strip().strip('"').strip("'")
                return v
    return None


BASE = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or _read_env_var("/app/frontend/.env", "EXPO_PUBLIC_BACKEND_URL")
    or "http://localhost:8001"
)
API = BASE.rstrip("/") + "/api"
print(f"[setup] API base: {API}")

# Test phones (per review)
OPERATOR_PHONE = "+918977986662"
OPERATOR_PHONE_FALLBACK = "+919900000099"
DEALER_PHONE_A = "+919900000001"
DEALER_PHONE_B = "+919900000002"
OTP = "123456"

PASS: List[str] = []
FAIL: List[str] = []


def ok(name: str, cond: bool, info: str = "") -> bool:
    if cond:
        PASS.append(name)
        print(f"  ✅ {name}")
    else:
        FAIL.append(f"{name} :: {info}")
        print(f"  ❌ {name} :: {info}")
    return cond


def login(phone: str, kind: str) -> Dict[str, Any]:
    """kind: 'operator' or 'dealer' — returns {token, dealer}"""
    base_path = f"/auth/{kind}"
    r = requests.post(f"{API}{base_path}/send-otp", json={"phone": phone}, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"send-otp {kind} {phone} → {r.status_code} {r.text}")
    r = requests.post(
        f"{API}{base_path}/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"verify-otp {kind} {phone} → {r.status_code} {r.text}")
    data = r.json()
    return {"token": data["token"], "dealer": data["dealer"]}


def H(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# =============================================================
# Setup: tokens
# =============================================================
print("\n=== AUTH SETUP ===")
try:
    op_phone = OPERATOR_PHONE
    try:
        op = login(op_phone, "operator")
    except Exception:
        # Fallback to bootstrap operator phone
        op_phone = OPERATOR_PHONE_FALLBACK
        op = login(op_phone, "operator")
    OP_TOKEN = op["token"]
    OP_ID = op["dealer"]["id"]
    OP_ROLE = op["dealer"].get("role")
    ok("operator login", OP_ROLE in ("super_admin", "admin"),
       f"phone={op_phone} role={OP_ROLE}")
except Exception as exc:
    FAIL.append(f"operator login fatal: {exc}")
    print(f"  ❌ operator login fatal: {exc}")
    OP_TOKEN = None

try:
    d1 = login(DEALER_PHONE_A, "dealer")
    DA_TOKEN = d1["token"]
    DA_ID = d1["dealer"]["id"]
    ok("dealer A login", d1["dealer"].get("role") == "dealer")
except Exception as exc:
    FAIL.append(f"dealer A login fatal: {exc}")
    print(f"  ❌ dealer A login fatal: {exc}")
    DA_TOKEN = None
    DA_ID = None

try:
    d2 = login(DEALER_PHONE_B, "dealer")
    DB_TOKEN = d2["token"]
    DB_ID = d2["dealer"]["id"]
    ok("dealer B login", d2["dealer"].get("role") == "dealer")
except Exception as exc:
    FAIL.append(f"dealer B login fatal: {exc}")
    DB_TOKEN = None
    DB_ID = None

if not OP_TOKEN:
    print("Cannot continue without operator token")
    sys.exit(1)


# =============================================================
# 1. GET /admin/broadcasts/templates
# =============================================================
print("\n=== 1. GET /admin/broadcasts/templates ===")
r = requests.get(f"{API}/admin/broadcasts/templates", headers=H(OP_TOKEN), timeout=15)
ok("templates 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
templates: List[Dict[str, Any]] = r.json() if r.status_code == 200 else []
ok("templates is list", isinstance(templates, list))
ok("templates length == 6", len(templates) == 6, f"got {len(templates)}")

types_present = [t.get("type") for t in templates]
expected_types = ["new_listing", "auction_live", "reserve_met", "ending_soon",
                  "settlement_completed", "custom"]
for et in expected_types:
    ok(f"templates contains type={et}", et in types_present)

required_keys = {"type", "label", "default_title", "default_body", "audience",
                 "needs_auction", "tone", "cta_hint"}
for t in templates:
    missing = required_keys - set(t.keys())
    ok(f"template {t.get('type')} has all required keys",
       not missing, f"missing={missing}")
    ok(f"template {t.get('type')} needs_auction is bool",
       isinstance(t.get("needs_auction"), bool))

# needs_auction expectations
exp = {"new_listing": False, "custom": False, "auction_live": True,
       "reserve_met": True, "ending_soon": True, "settlement_completed": True}
for t in templates:
    typ = t.get("type")
    if typ in exp:
        ok(f"needs_auction[{typ}] == {exp[typ]}",
           t.get("needs_auction") == exp[typ],
           f"got {t.get('needs_auction')}")

# 401 / 403 gating
r_anon = requests.get(f"{API}/admin/broadcasts/templates", timeout=15)
ok("templates 401 without auth", r_anon.status_code == 401,
   f"got {r_anon.status_code}")
if DA_TOKEN:
    r_dealer = requests.get(f"{API}/admin/broadcasts/templates",
                            headers=H(DA_TOKEN), timeout=15)
    ok("templates 403 with dealer token", r_dealer.status_code == 403,
       f"got {r_dealer.status_code}")


# =============================================================
# 2. GET /admin/broadcasts/auctions
# =============================================================
print("\n=== 2. GET /admin/broadcasts/auctions ===")
r = requests.get(f"{API}/admin/broadcasts/auctions", headers=H(OP_TOKEN), timeout=20)
ok("auctions 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
auctions = r.json() if r.status_code == 200 else []
ok("auctions is list", isinstance(auctions, list))

# Inspect rows
required_auction_keys = {"auction_id", "status", "current_bid", "reserve_price",
                         "reserve_met", "end_time", "label", "registration_number",
                         "city", "fuel_type"}
sample_auction_id: Optional[str] = None
sample_live_id: Optional[str] = None
for a in auctions[:5]:
    miss = required_auction_keys - set(a.keys())
    ok(f"auction row keys (status={a.get('status')})", not miss,
       f"missing={miss}")
    et = a.get("end_time")
    ok(f"auction row end_time ISO-or-None (status={a.get('status')})",
       et is None or (isinstance(et, str) and "T" in et),
       f"got={et!r}")

if auctions:
    sample_auction_id = auctions[0].get("auction_id")
    for a in auctions:
        if a.get("status") == "live":
            sample_live_id = a.get("auction_id")
            break

# Ordering: live first, then ended_pending_payment, etc.
status_seq = [a.get("status") for a in auctions]
status_order = ["live", "ended_pending_payment", "payment_received", "upcoming",
                "scheduled", "vehicle_released", "settled"]
rank = {s: i for i, s in enumerate(status_order)}
positions = [rank.get(s, 99) for s in status_seq]
ok("auctions ordered (live first then ended_pending then ...)",
   positions == sorted(positions),
   f"positions={positions[:10]} statuses={status_seq[:10]}")

# 401 / 403
r_anon = requests.get(f"{API}/admin/broadcasts/auctions", timeout=15)
ok("auctions 401 without auth", r_anon.status_code == 401,
   f"got {r_anon.status_code}")
if DA_TOKEN:
    r_dealer = requests.get(f"{API}/admin/broadcasts/auctions",
                            headers=H(DA_TOKEN), timeout=15)
    ok("auctions 403 with dealer token", r_dealer.status_code == 403,
       f"got {r_dealer.status_code}")


# =============================================================
# 4. POST /admin/broadcasts — extensively covers features
# (we test 4 before 3 so /recent has rows to inspect)
# =============================================================
print("\n=== 4. POST /admin/broadcasts ===")

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def post_broadcast(payload: Dict[str, Any], token: str = OP_TOKEN
                   ) -> requests.Response:
    return requests.post(f"{API}/admin/broadcasts", json=payload,
                         headers=H(token), timeout=20)


# (a) type=new_listing, audience=all_verified — title/body from template,
#     no auction_id required; recipient_count > 0 if any verified dealers.
r = post_broadcast({"type": "new_listing", "audience": "all_verified"})
ok("(a) new_listing all_verified 200",
   r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    ok("(a) returns id", bool(body.get("id")))
    ok("(a) returns ts (ISO)",
       isinstance(body.get("ts"), str) and bool(ISO_RE.match(body["ts"])),
       f"ts={body.get('ts')!r}")
    ok("(a) recipient_count >= 1 (assumes verified dealers exist)",
       isinstance(body.get("recipient_count"), int)
       and body["recipient_count"] >= 1,
       f"recipient_count={body.get('recipient_count')}")
    ok("(a) audience persisted == all_verified",
       body.get("audience") == "all_verified")
    ok("(a) sent_by == operator id", body.get("sent_by") == OP_ID)
    ok("(a) sent_by_name set", bool(body.get("sent_by_name")))
    new_listing_id = body.get("id")
    new_listing_recipients = body.get("recipient_count", 0)
else:
    new_listing_id = None
    new_listing_recipients = 0


# (b) type=auction_live without auction_id → 400
r = post_broadcast({"type": "auction_live"})
ok("(b) auction_live no auction_id → 400",
   r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 400:
    detail = (r.json() or {}).get("detail", "")
    ok("(b) detail mentions auction_id required",
       "auction_id" in detail and "required" in detail.lower(),
       f"detail={detail!r}")


# (c) type=auction_live with valid auction_id (live one if available)
target_aid = sample_live_id or sample_auction_id
auction_live_body = None
if target_aid:
    r = post_broadcast({"type": "auction_live", "auction_id": target_aid})
    ok("(c) auction_live with valid auction_id 200",
       r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        auction_live_body = body
        # body should auto-inject "(year make model)" — check for parens
        body_text = body.get("body", "")
        ok("(c) body auto-injects vehicle context",
           "(" in body_text and ")" in body_text,
           f"body={body_text!r}")
        # vehicle dict present
        v = body.get("vehicle")
        ok("(c) vehicle dict present",
           isinstance(v, dict) and v.get("make"),
           f"vehicle={v}")
else:
    print("  (skipped c) no live/sample auction available")


# (d) type=settlement_completed with auction_id → success
if target_aid:
    r = post_broadcast({"type": "settlement_completed", "auction_id": target_aid})
    ok("(d) settlement_completed 200",
       r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")


# (e) type=custom with title+body → success without auction_id
r = post_broadcast({
    "type": "custom",
    "title": "Network notice",
    "body": "Inspection desk closed for Diwali.",
    "audience": "all_verified",
})
ok("(e) custom with title+body 200",
   r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
custom_body = r.json() if r.status_code == 200 else {}


# (f) type=custom without title or body → 400
r = post_broadcast({"type": "custom", "audience": "all_verified"})
ok("(f) custom missing title+body → 400",
   r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 400:
    detail = (r.json() or {}).get("detail", "")
    ok("(f) detail says title/body required",
       "title" in detail.lower() and "body" in detail.lower(),
       f"detail={detail!r}")


# (g) audience=specific with dealer_ids=[real id] → success, recipient_count=1
if DA_ID:
    r = post_broadcast({
        "type": "custom",
        "audience": "specific",
        "title": "Direct line",
        "body": "Hi from operator desk.",
        "dealer_ids": [DA_ID],
    })
    ok("(g) audience=specific [dealer_a] 200",
       r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        body = r.json()
        ok("(g) recipient_count == 1",
           body.get("recipient_count") == 1,
           f"recipient_count={body.get('recipient_count')}")


# (h) audience=specific without dealer_ids → 200 but recipient_count=0
r = post_broadcast({
    "type": "custom",
    "audience": "specific",
    "title": "noop",
    "body": "noop body",
})
ok("(h) audience=specific no dealer_ids → 200",
   r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    ok("(h) recipient_count == 0",
       body.get("recipient_count") == 0,
       f"recipient_count={body.get('recipient_count')}")


# (i) Non-existent auction_id → 404
r = post_broadcast({
    "type": "auction_live",
    "auction_id": "00000000-0000-0000-0000-000000000000",
})
ok("(i) bogus auction_id → 404",
   r.status_code == 404, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 404:
    detail = (r.json() or {}).get("detail", "")
    ok("(i) detail says Auction not found",
       "Auction" in detail and "not found" in detail.lower(),
       f"detail={detail!r}")


# (j) Unknown type → 400
r = post_broadcast({"type": "totally_made_up"})
ok("(j) unknown type → 400",
   r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 400:
    detail = (r.json() or {}).get("detail", "")
    ok("(j) detail says Unknown broadcast type",
       "Unknown broadcast type" in detail,
       f"detail={detail!r}")


# (k) audience=bidders_and_watchers without auction_id → 400
r = post_broadcast({
    "type": "custom",
    "title": "x",
    "body": "y",
    "audience": "bidders_and_watchers",
})
ok("(k) bidders_and_watchers no auction_id → 400",
   r.status_code == 400, f"status={r.status_code} body={r.text[:200]}")


# Auth gating on POST
r_anon = requests.post(f"{API}/admin/broadcasts",
                       json={"type": "new_listing"}, timeout=15)
ok("POST broadcasts 401 without auth", r_anon.status_code == 401,
   f"got {r_anon.status_code}")
if DA_TOKEN:
    r_dealer = requests.post(f"{API}/admin/broadcasts",
                             json={"type": "new_listing"},
                             headers=H(DA_TOKEN), timeout=15)
    ok("POST broadcasts 403 with dealer token", r_dealer.status_code == 403,
       f"got {r_dealer.status_code}")


# =============================================================
# 3. GET /admin/broadcasts/recent (after we've populated rows)
# =============================================================
print("\n=== 3. GET /admin/broadcasts/recent ===")
r = requests.get(f"{API}/admin/broadcasts/recent?limit=20",
                 headers=H(OP_TOKEN), timeout=15)
ok("recent 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
recent = r.json() if r.status_code == 200 else []
ok("recent is list", isinstance(recent, list))
ok("recent has at least 1 row (we just inserted several)", len(recent) >= 1,
   f"len={len(recent)}")

required_recent_keys = {"id", "type", "title", "body", "audience",
                        "recipient_count", "sent_by", "sent_by_name", "ts"}
for r0 in recent[:5]:
    miss = required_recent_keys - set(r0.keys())
    ok(f"recent row {r0.get('id','?')[:8]} keys", not miss, f"missing={miss}")
    ts = r0.get("ts")
    ok(f"recent row ts is ISO string (not raw datetime)",
       isinstance(ts, str) and bool(ISO_RE.match(ts)),
       f"ts={ts!r}")

# Find the auction_live row we just sent and verify "vehicle" was hydrated
found_with_vehicle = False
for r0 in recent:
    if r0.get("auction_id") and r0.get("vehicle"):
        v = r0["vehicle"]
        if isinstance(v, dict) and v.get("make"):
            found_with_vehicle = True
            ok("recent row with auction_id has hydrated vehicle dict",
               {"year", "make", "model", "registration_number"} <= set(v.keys()),
               f"vehicle keys={list(v.keys())}")
            break
if not found_with_vehicle and target_aid:
    ok("recent has at least one auction-scoped row with vehicle hydration",
       False, "no row with both auction_id and vehicle dict found")

# Recent gating
r_anon = requests.get(f"{API}/admin/broadcasts/recent", timeout=15)
ok("recent 401 without auth", r_anon.status_code == 401,
   f"got {r_anon.status_code}")
if DA_TOKEN:
    r_dealer = requests.get(f"{API}/admin/broadcasts/recent",
                            headers=H(DA_TOKEN), timeout=15)
    ok("recent 403 with dealer token", r_dealer.status_code == 403,
       f"got {r_dealer.status_code}")


# =============================================================
# Verify dealer notifications inbox got fanned out
# (for the audience=specific [DA_ID] broadcast in step g)
# =============================================================
print("\n=== Inbox fanout check (dealer notifications) ===")
if DA_TOKEN:
    r = requests.get(f"{API}/notifications", headers=H(DA_TOKEN), timeout=15)
    ok("dealer A GET /notifications 200", r.status_code == 200,
       f"status={r.status_code}")
    notifs = r.json() if r.status_code == 200 else []
    # FastAPI may wrap; allow both shapes
    if isinstance(notifs, dict) and "items" in notifs:
        notifs = notifs["items"]
    has_broadcast = any(
        n.get("type") == "broadcast" and "Direct line" in (n.get("title") or "")
        for n in notifs
    )
    ok("dealer A inbox contains the targeted broadcast",
       has_broadcast,
       f"found {sum(1 for n in notifs if n.get('type')=='broadcast')} broadcast(s)"
       f" out of {len(notifs)} total")


# =============================================================
# Verify audit log captures broadcast_sent
# =============================================================
print("\n=== Audit log check (broadcast_sent) ===")
r = requests.get(f"{API}/admin/audit-logs?action=broadcast_sent&since_hours=1",
                 headers=H(OP_TOKEN), timeout=15)
if r.status_code == 200:
    payload = r.json()
    items = payload.get("items") if isinstance(payload, dict) else payload
    items = items or []
    found = any(it.get("action") == "broadcast_sent" for it in items)
    ok("audit-logs returns broadcast_sent rows",
       found, f"items={len(items)} action filter may be whitelisted")
else:
    # action may not be in the SECURITY_AUDIT_ACTIONS whitelist;
    # fall back to fetching without the action filter
    r2 = requests.get(f"{API}/admin/audit-logs?since_hours=1",
                      headers=H(OP_TOKEN), timeout=15)
    if r2.status_code == 200:
        payload = r2.json()
        items = payload.get("items") if isinstance(payload, dict) else payload
        items = items or []
        actions = {it.get("action") for it in items}
        ok("audit-logs reachable (may not whitelist broadcast_sent)",
           True, f"actions seen={actions}")
        if "broadcast_sent" not in actions:
            FAIL.append("audit broadcast_sent not surfaced :: missing from "
                        "SECURITY_AUDIT_ACTIONS whitelist (similar to "
                        "settlement_note_add)")
            print("  ⚠️  audit broadcast_sent missing from whitelist")


# =============================================================
# REGRESSION 1: legacy /admin/notifications/broadcast still works
# =============================================================
print("\n=== REGRESSION: legacy /admin/notifications/broadcast ===")
r = requests.post(f"{API}/admin/notifications/broadcast",
                  json={"title": "Legacy ping",
                        "body": "Legacy broadcast still alive",
                        "audience": "verified"},
                  headers=H(OP_TOKEN), timeout=15)
ok("legacy /admin/notifications/broadcast 200",
   r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
if r.status_code == 200:
    body = r.json()
    ok("legacy returns {sent: int}",
       isinstance(body.get("sent"), int) and body["sent"] >= 0,
       f"body={body}")

# 403 dealer
if DA_TOKEN:
    r_d = requests.post(f"{API}/admin/notifications/broadcast",
                        json={"title": "x", "body": "y"},
                        headers=H(DA_TOKEN), timeout=15)
    ok("legacy broadcast 403 with dealer token", r_d.status_code == 403,
       f"got {r_d.status_code}")


# =============================================================
# REGRESSION 2: /admin/auctions/live-grid still 200 for super_admin
# =============================================================
print("\n=== REGRESSION: /admin/auctions/live-grid ===")
r = requests.get(f"{API}/admin/auctions/live-grid",
                 headers=H(OP_TOKEN), timeout=15)
ok("live-grid 200 for super_admin",
   r.status_code == 200, f"status={r.status_code} body={r.text[:300]}")


# =============================================================
# Final summary
# =============================================================
print("\n" + "=" * 60)
print(f"PASSED: {len(PASS)}")
print(f"FAILED: {len(FAIL)}")
if FAIL:
    print("\nFAILED ASSERTIONS:")
    for f in FAIL:
        print(f"  - {f}")
sys.exit(0 if not FAIL else 1)
