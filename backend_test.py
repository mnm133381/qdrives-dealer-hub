"""Phase 1 Operator Console backend test suite.

Covers:
  A. Multi-tier roles (super_admin)
  B. Allow-list management CRUD
  C. Hard max-bid-limit enforcement
  D. Dealer detail view
  E. Audit log + denied-login feed
  F. Regression (legacy 404, off-list denial, RBAC on /cars)
"""
from __future__ import annotations
import os
import sys
import json
import time
import urllib.parse
import requests

BASE = os.environ.get(
    "PUBLIC_API",
    "https://qdrives-dealer-hub.preview.emergentagent.com/api",
).rstrip("/")

OPERATOR_PHONE = "+919900000099"
DEALER_PHONE = "+919900000002"  # Arjun / Royal Drives
DEALER2_PHONE = "+919900000005"
OFF_LIST = ["+919876543210", "+918888888888", "+911111222233"]
NEW_ALLOW_PHONE = "+919876543200"
DENIED_SPAM_PHONE = "+919999888877"

results: list[tuple[str, bool, str]] = []


def rec(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name}{(' — ' + detail) if detail else ''}")


def post(path, body=None, token=None, expected=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = requests.post(f"{BASE}{path}", headers=h, data=json.dumps(body or {}), timeout=30)
    return r


def get(path, token=None):
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.get(f"{BASE}{path}", headers=h, timeout=30)


def patch(path, body=None, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.patch(f"{BASE}{path}", headers=h, data=json.dumps(body or {}), timeout=30)


def delete(path, token=None):
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.delete(f"{BASE}{path}", headers=h, timeout=30)


def login_operator(phone=OPERATOR_PHONE):
    r = post("/auth/operator/send-otp", {"phone": phone})
    if r.status_code != 200:
        return None, r
    r = post("/auth/operator/verify-otp", {"phone": phone, "otp": "123456"})
    if r.status_code != 200:
        return None, r
    return r.json(), r


def login_dealer(phone):
    s = post("/auth/dealer/send-otp", {"phone": phone})
    if s.status_code != 200:
        return None, s
    r = post("/auth/dealer/verify-otp", {"phone": phone, "otp": "123456"})
    if r.status_code != 200:
        return None, r
    return r.json(), r


# ---------- A. Multi-tier roles ----------
def test_section_A():
    print("\n=== A. Multi-tier roles ===")
    # A.1 operator verify returns super_admin
    op, raw = login_operator()
    if not op:
        rec("A.1 operator verify-otp 200", False, f"status={raw.status_code} body={raw.text[:200]}")
        return None, None
    rec("A.1 operator verify-otp 200", True)
    role = op["dealer"].get("role")
    rec("A.1 dealer.role == 'super_admin' (NOT 'admin')", role == "super_admin",
        f"got role={role!r}")
    op_token = op["token"]
    op_id = op["dealer"]["id"]

    # A.2 /auth/me returns super_admin
    r = get("/auth/me", token=op_token)
    rec("A.2 GET /auth/me 200 with operator token", r.status_code == 200,
        f"status={r.status_code}")
    if r.status_code == 200:
        rec("A.2 /auth/me role == 'super_admin'", r.json().get("role") == "super_admin",
            f"got {r.json().get('role')!r}")

    # Login dealer to get dealer token
    de, raw = login_dealer(DEALER_PHONE)
    if not de:
        rec("A.4 dealer verify-otp +919900000002 200", False, f"status={raw.status_code} body={raw.text[:200]}")
        return op_token, None
    rec("A.4 dealer verify-otp +919900000002 200", True)
    dealer_token = de["token"]
    dealer_role = de["dealer"].get("role")
    rec("A.4 dealer.role hard-pinned to 'dealer'", dealer_role == "dealer",
        f"got {dealer_role!r}")

    # A.3 /admin/dashboard with super_admin → 200, with dealer → 403
    r = get("/admin/dashboard", token=op_token)
    rec("A.3 /admin/dashboard with super_admin → 200", r.status_code == 200,
        f"status={r.status_code}")
    r = get("/admin/dashboard", token=dealer_token)
    rec("A.3 /admin/dashboard with dealer → 403", r.status_code == 403,
        f"status={r.status_code} body={r.text[:120]}")

    return op_token, dealer_token, op_id, de["dealer"]["id"]


# ---------- B. Allow-list management ----------
def test_section_B(op_token, dealer_token):
    print("\n=== B. Allow-list management ===")
    # B.1 GET approved-dealers
    r = get("/admin/approved-dealers", token=op_token)
    rec("B.1 GET /admin/approved-dealers operator → 200", r.status_code == 200,
        f"status={r.status_code}")
    if r.status_code == 200:
        items = r.json()
        ok_list = isinstance(items, list) and len(items) > 0
        rec("B.1 returns non-empty list", ok_list, f"len={len(items) if isinstance(items, list) else 'N/A'}")
        if items:
            has_onb = all("onboarding" in it for it in items)
            rec("B.1 each entry has 'onboarding' field", has_onb)

    # Cleanup any prior test pollution
    delete(f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}", token=op_token)
    # forcibly delete from collection? we'll re-fetch and detect 'revoked' state.

    # B.2 POST new approved dealer
    body = {
        "phone": NEW_ALLOW_PHONE,
        "full_name": "Aman Test",
        "dealership_name": "Aman Motors",
        "city": "Chennai",
        "trust_score": 4.2,
        "max_bid_limit": 750000,
        "notes": "Risk A",
    }
    # First check whether phone already on list (from prior runs - revoked/active).
    # If exists, we PATCH back to active+seed values; else POST.
    list_r = get("/admin/approved-dealers", token=op_token)
    existing_entry = None
    if list_r.status_code == 200:
        for it in list_r.json():
            if it.get("phone") == NEW_ALLOW_PHONE:
                existing_entry = it
                break

    if existing_entry:
        # POST should still 409
        r = post("/admin/approved-dealers", body=body, token=op_token)
        rec("B.2/B.3 POST allow-list duplicate → 409 (carry-over from prior run)",
            r.status_code == 409, f"status={r.status_code}")
        # Reset the entry to our seed values + active
        pr = patch(
            f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
            body={
                "full_name": body["full_name"],
                "dealership_name": body["dealership_name"],
                "city": body["city"],
                "trust_score": body["trust_score"],
                "max_bid_limit": body["max_bid_limit"],
                "notes": body["notes"],
                "status": "active",
            },
            token=op_token,
        )
        rec("B.2 reset existing entry via PATCH → 200", pr.status_code == 200,
            f"status={pr.status_code}")
        # Also clear suspended on the dealer doc if it exists.
        det = get("/admin/dealers", token=op_token)
    else:
        r = post("/admin/approved-dealers", body=body, token=op_token)
        rec("B.2 POST new allow-list entry → 200", r.status_code == 200,
            f"status={r.status_code} body={r.text[:200]}")
        if r.status_code == 200:
            doc = r.json()
            ok = (
                doc.get("phone") == NEW_ALLOW_PHONE
                and doc.get("seed_full_name") == "Aman Test"
                and doc.get("seed_dealership_name") == "Aman Motors"
                and doc.get("max_bid_limit") == 750000
            )
            rec("B.2 POST returns seeded doc", ok, json.dumps(doc)[:200])
        # B.3 duplicate
        r2 = post("/admin/approved-dealers", body=body, token=op_token)
        rec("B.3 duplicate POST → 409", r2.status_code == 409, f"status={r2.status_code}")

    # B.4 collide with operator phone
    r = post("/admin/approved-dealers", body={"phone": OPERATOR_PHONE, "full_name": "x"}, token=op_token)
    rec("B.4 POST with operator phone → 409", r.status_code == 409, f"status={r.status_code}")

    # B.5 invalid short phone → 400
    r = post("/admin/approved-dealers", body={"phone": "+91"}, token=op_token)
    rec("B.5 POST with short phone → 400", r.status_code == 400, f"status={r.status_code}")

    # Need to ensure dealer doc for NEW_ALLOW_PHONE doesn't have suspended=True from prior run.
    # If exists, login won't succeed if status was revoked then we just patched to active,
    # but live dealer doc may still be suspended. Let's PATCH to clear suspended via
    # admin/dealers/.../verify if needed.
    # Simpler: try send-otp first; if 403, we'll diagnose.
    so = post("/auth/dealer/send-otp", {"phone": NEW_ALLOW_PHONE})
    if so.status_code != 200:
        rec("B.6 send-otp newly allow-listed → 200", False,
            f"status={so.status_code} body={so.text[:200]}")
    else:
        rec("B.6 send-otp newly allow-listed → 200", True)
    # Even if send-otp fails (e.g. due to status=paused mid-run), try verify-otp directly
    vr = post("/auth/dealer/verify-otp", {"phone": NEW_ALLOW_PHONE, "otp": "123456"})
    if vr.status_code != 200:
        # Try to clear suspended state on dealer doc via verify endpoint
        # Find dealer id via admin list
        ad = get(f"/admin/dealers?q={urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}", token=op_token)
        if ad.status_code == 200 and ad.json():
            did = ad.json()[0]["id"]
            post(f"/admin/dealers/{did}/verify", body={"suspended": False, "verified": True}, token=op_token)
            vr = post("/auth/dealer/verify-otp", {"phone": NEW_ALLOW_PHONE, "otp": "123456"})

    if vr.status_code == 200:
        rec("B.6 verify-otp +919876543200 → 200", True)
        d = vr.json()["dealer"]
        rec("B.6 dealer.role=='dealer'", d.get("role") == "dealer", f"got {d.get('role')!r}")
        rec("B.6 dealership inherited 'Aman Motors'",
            d.get("dealership_name") == "Aman Motors",
            f"got {d.get('dealership_name')!r}")
        rec("B.6 max_bid_limit==750000",
            d.get("max_bid_limit") == 750000, f"got {d.get('max_bid_limit')!r}")
        rec("B.6 trust_score==4.2", d.get("trust_score") == 4.2,
            f"got {d.get('trust_score')!r}")
        new_dealer_id = d["id"]
        new_dealer_token = vr.json()["token"]
    else:
        rec("B.6 verify-otp +919876543200 → 200", False,
            f"status={vr.status_code} body={vr.text[:200]}")
        new_dealer_id = None
        new_dealer_token = None

    # B.7 PATCH max_bid_limit to 300000
    pr = patch(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        body={"max_bid_limit": 300000},
        token=op_token,
    )
    rec("B.7 PATCH max_bid_limit=300000 → 200", pr.status_code == 200,
        f"status={pr.status_code}")
    # Re-login dealer
    re_v = post("/auth/dealer/verify-otp", {"phone": NEW_ALLOW_PHONE, "otp": "123456"})
    if re_v.status_code == 200:
        rec("B.7 re-login propagated max_bid_limit==300000",
            re_v.json()["dealer"].get("max_bid_limit") == 300000,
            f"got {re_v.json()['dealer'].get('max_bid_limit')!r}")
    else:
        rec("B.7 re-login → 200", False, f"status={re_v.status_code}")

    # B.8 PATCH status=paused → then send-otp blocked
    pr = patch(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        body={"status": "paused"},
        token=op_token,
    )
    rec("B.8 PATCH status=paused → 200", pr.status_code == 200, f"status={pr.status_code}")
    so = post("/auth/dealer/send-otp", {"phone": NEW_ALLOW_PHONE})
    ok = so.status_code == 403 and "DEALER_ACCESS_NOT_APPROVED" in so.text
    rec("B.8 send-otp paused → 403 DEALER_ACCESS_NOT_APPROVED", ok,
        f"status={so.status_code} body={so.text[:200]}")

    # B.9 PATCH status=active → login works
    pr = patch(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        body={"status": "active"},
        token=op_token,
    )
    rec("B.9 PATCH status=active → 200", pr.status_code == 200, f"status={pr.status_code}")
    so = post("/auth/dealer/send-otp", {"phone": NEW_ALLOW_PHONE})
    rec("B.9 send-otp after re-activation → 200", so.status_code == 200,
        f"status={so.status_code}")

    # B.10 DELETE soft-revoke
    dr = delete(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        token=op_token,
    )
    rec("B.10 DELETE allow-list → 200", dr.status_code == 200, f"status={dr.status_code}")
    # Confirm still in list with status=revoked
    al = get("/admin/approved-dealers", token=op_token)
    if al.status_code == 200:
        match = [it for it in al.json() if it.get("phone") == NEW_ALLOW_PHONE]
        rec("B.10 entry still present (soft delete)", len(match) == 1,
            f"matches={len(match)}")
        if match:
            rec("B.10 status=='revoked'", match[0].get("status") == "revoked",
                f"got {match[0].get('status')!r}")
    so = post("/auth/dealer/send-otp", {"phone": NEW_ALLOW_PHONE})
    rec("B.10 send-otp after revoke → 403", so.status_code == 403,
        f"status={so.status_code}")
    # Live dealer doc has suspended=true
    if new_dealer_id:
        det = get(f"/admin/dealers/{new_dealer_id}", token=op_token)
        if det.status_code == 200:
            rec("B.10 live dealer.suspended==true",
                det.json()["dealer"].get("suspended") is True,
                f"got {det.json()['dealer'].get('suspended')!r}")
        else:
            rec("B.10 fetch dealer detail post-revoke", False, f"status={det.status_code}")

    # B.11 dealer JWT cannot mutate allow-list
    rA = post("/admin/approved-dealers", body={"phone": "+919000000000"}, token=dealer_token)
    rec("B.11 POST allow-list as dealer → 403", rA.status_code == 403, f"status={rA.status_code}")
    rB = patch(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        body={"notes": "x"}, token=dealer_token,
    )
    rec("B.11 PATCH allow-list as dealer → 403", rB.status_code == 403, f"status={rB.status_code}")
    rC = delete(
        f"/admin/approved-dealers/{urllib.parse.quote(NEW_ALLOW_PHONE, safe='')}",
        token=dealer_token,
    )
    rec("B.11 DELETE allow-list as dealer → 403", rC.status_code == 403, f"status={rC.status_code}")


# ---------- C. Hard max-bid-limit enforcement ----------
def test_section_C(op_token, dealer_token, op_id, dealer_id):
    print("\n=== C. Hard max-bid-limit enforcement ===")
    # C.1 set max-bid 900000 on +919900000002
    r = post(f"/admin/dealers/{dealer_id}/max-bid", body={"max_bid_limit": 900000}, token=op_token)
    rec("C.1 set max_bid 900000 → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")

    # C.2 re-login dealer, confirm 900000
    de, _ = login_dealer(DEALER_PHONE)
    if not de:
        rec("C.2 re-login dealer → 200", False)
        return
    rec("C.2 dealer.max_bid_limit==900000 after re-login",
        de["dealer"].get("max_bid_limit") == 900000,
        f"got {de['dealer'].get('max_bid_limit')!r}")
    dealer_token = de["token"]

    # C.3 find a live auction NOT seeded by this dealer where bidding > 900000 will fire
    auctions = get("/auctions?status_filter=live").json()
    target = None
    for a in auctions:
        if a.get("seller", {}).get("id") == de["dealer"]["id"]:
            continue
        # need a live one
        target = a
        break
    if not target:
        rec("C.3 found live auction", False, "no live auction available")
        return
    auction_id = target["id"]
    cur = target.get("current_bid") or target.get("starting_bid") or 0
    high_bid = max(cur + 5000, 1100000)  # well above 900000
    rb = post(f"/auctions/{auction_id}/bid", body={"amount": high_bid}, token=dealer_token)
    ok = rb.status_code == 403 and "BID_EXCEEDS_DEALER_LIMIT" in rb.text
    rec("C.3 bid above cap → 403 BID_EXCEEDS_DEALER_LIMIT", ok,
        f"status={rb.status_code} body={rb.text[:200]}")

    # C.4 try a bid at/below cap
    low_bid = cur + 5000
    if low_bid <= 900000:
        rb = post(f"/auctions/{auction_id}/bid", body={"amount": low_bid}, token=dealer_token)
        rec("C.4 bid below cap → 200", rb.status_code == 200,
            f"status={rb.status_code} body={rb.text[:200]}")
    else:
        # Find an auction with low enough current_bid
        chosen = None
        for a in auctions:
            if a.get("seller", {}).get("id") == de["dealer"]["id"]:
                continue
            cb = a.get("current_bid") or a.get("starting_bid") or 0
            if cb + 5000 <= 900000:
                chosen = a
                break
        if chosen:
            cb = chosen.get("current_bid") or chosen.get("starting_bid") or 0
            rb = post(f"/auctions/{chosen['id']}/bid", body={"amount": cb + 5000}, token=dealer_token)
            rec("C.4 bid below cap (alt auction) → 200", rb.status_code == 200,
                f"status={rb.status_code} body={rb.text[:200]}")
            auction_id = chosen["id"]
            cur = cb
        else:
            rec("C.4 bid below cap → 200", False, "no auction with cur+5000 <= 900000")

    # C.5 clear cap then bid above old cap
    r = post(f"/admin/dealers/{dealer_id}/max-bid", body={"max_bid_limit": None}, token=op_token)
    rec("C.5 clear cap (None) → 200", r.status_code == 200, f"status={r.status_code}")
    de2, _ = login_dealer(DEALER_PHONE)
    rec("C.5 re-login: max_bid_limit cleared",
        de2 and de2["dealer"].get("max_bid_limit") in (None, 0),
        f"got {de2['dealer'].get('max_bid_limit')!r}" if de2 else "no relogin")
    if de2:
        dealer_token = de2["token"]
    # Pick a fresh auction so cur reflects latest after our previous bids
    auctions2 = get("/auctions?status_filter=live").json()
    chosen = None
    for a in auctions2:
        if a.get("seller", {}).get("id") == de["dealer"]["id"]:
            continue
        chosen = a
        break
    if chosen:
        cb = chosen.get("current_bid") or chosen.get("starting_bid") or 0
        amt = max(cb + 5000, 1100000)
        rb = post(f"/auctions/{chosen['id']}/bid", body={"amount": amt}, token=dealer_token)
        rec("C.5 bid above previous cap (no limit) → 200", rb.status_code == 200,
            f"status={rb.status_code} body={rb.text[:200]}")

    # C.6 dealer JWT cannot call max-bid endpoint
    r = post(f"/admin/dealers/{dealer_id}/max-bid", body={"max_bid_limit": 100000}, token=dealer_token)
    rec("C.6 max-bid as dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")

    # C.7 cannot set limit on operator
    r = post(f"/admin/dealers/{op_id}/max-bid", body={"max_bid_limit": 1000000}, token=op_token)
    ok = r.status_code in (400, 403, 404)
    rec("C.7 set limit on operator id → non-200", ok and r.status_code != 200,
        f"status={r.status_code} body={r.text[:200]}")


# ---------- D. Dealer detail ----------
def test_section_D(op_token, dealer_token, op_id, dealer_id):
    print("\n=== D. Dealer detail ===")
    r = get(f"/admin/dealers/{dealer_id}", token=op_token)
    rec("D.1 GET /admin/dealers/{id} operator → 200", r.status_code == 200,
        f"status={r.status_code}")
    if r.status_code == 200:
        body = r.json()
        keys = {"dealer", "bids_count", "wins_count", "recent_bids", "recent_logins", "allow_list"}
        missing = keys - set(body.keys())
        rec("D.1 response has all expected keys", not missing, f"missing={missing}")

    # D.2 unknown id
    r = get("/admin/dealers/00000000-0000-0000-0000-000000000000", token=op_token)
    rec("D.2 unknown id → 404", r.status_code == 404, f"status={r.status_code}")

    # D.3 operator id → 403
    r = get(f"/admin/dealers/{op_id}", token=op_token)
    rec("D.3 operator id → 403", r.status_code == 403, f"status={r.status_code} body={r.text[:120]}")

    # D.4 dealer JWT
    r = get(f"/admin/dealers/{dealer_id}", token=dealer_token)
    rec("D.4 dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")


# ---------- E. Audit log + denied-login feed ----------
ALLOWED_AUDIT_ACTIONS = {
    "dealer_login", "operator_login",
    "dealer_access_denied", "operator_access_denied",
    "allow_list_add", "allow_list_update", "allow_list_revoke",
    "dealer_status_change", "max_bid_change",
    "auction_pause", "auction_cancel", "auction_extend",
    "bid_cancel", "admin_broadcast", "operator_promotion",
}


def test_section_E(op_token, dealer_token):
    print("\n=== E. Audit log + denied-login feed ===")
    r = get("/admin/audit-logs?since_hours=24&limit=50", token=op_token)
    rec("E.1 GET /admin/audit-logs operator → 200", r.status_code == 200,
        f"status={r.status_code}")
    if r.status_code == 200:
        body = r.json()
        rec("E.1 has items+total", "items" in body and "total" in body)
        actions = {it.get("action") for it in body.get("items", [])}
        leak = actions - ALLOWED_AUDIT_ACTIONS
        rec("E.1 only whitelisted actions present", not leak, f"leak={leak}")

    # E.2 filter action=allow_list_add
    r = get("/admin/audit-logs?since_hours=24&action=allow_list_add", token=op_token)
    if r.status_code == 200:
        items = r.json().get("items", [])
        only_one = all(it.get("action") == "allow_list_add" for it in items)
        rec("E.2 ?action=allow_list_add filter holds", only_one and len(items) > 0,
            f"len={len(items)}")
    else:
        rec("E.2 filter request 200", False, f"status={r.status_code}")

    # E.3 q=+919876
    r = get("/admin/audit-logs?since_hours=24&q=" + urllib.parse.quote("+919876"), token=op_token)
    if r.status_code == 200:
        items = r.json().get("items", [])
        hit = any("+919876" in (it.get("meta") or {}).get("phone", "") for it in items)
        rec("E.3 q=+919876 search returns matching items", hit, f"len={len(items)}")
    else:
        rec("E.3 q-search 200", False, f"status={r.status_code}")

    # E.4 denied-logins endpoint
    r = get("/admin/security/denied-logins?since_hours=24", token=op_token)
    rec("E.4 GET denied-logins → 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code == 200:
        body = r.json()
        ok = all(k in body for k in ("items", "total_attempts", "repeat_offenders"))
        rec("E.4 has items/total_attempts/repeat_offenders", ok)

    # E.5 trigger 3 denied attempts then check repeat_offenders
    for _ in range(3):
        post("/auth/dealer/send-otp", {"phone": DENIED_SPAM_PHONE})
    time.sleep(1.0)
    r = get("/admin/security/denied-logins?since_hours=24", token=op_token)
    if r.status_code == 200:
        body = r.json()
        match = [ro for ro in body.get("repeat_offenders", []) if ro.get("phone") == DENIED_SPAM_PHONE]
        ok = len(match) == 1 and match[0].get("attempts", 0) >= 3
        rec("E.5 repeat_offenders includes spam phone with attempts>=3", ok,
            f"match={match}")
    else:
        rec("E.5 denied-logins 200", False, f"status={r.status_code}")

    # E.6 dealer JWT 403 on both
    r = get("/admin/audit-logs", token=dealer_token)
    rec("E.6 audit-logs dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")
    r = get("/admin/security/denied-logins", token=dealer_token)
    rec("E.6 denied-logins dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")


# ---------- F. Regression ----------
def test_section_F(op_token, dealer_token):
    print("\n=== F. Regression ===")
    r = post("/auth/send-otp", {"phone": OPERATOR_PHONE})
    rec("F.1 legacy /auth/send-otp → 404", r.status_code == 404, f"status={r.status_code}")
    r = post("/auth/verify-otp", {"phone": OPERATOR_PHONE, "otp": "123456"})
    rec("F.1 legacy /auth/verify-otp → 404", r.status_code == 404, f"status={r.status_code}")

    # F.2 dealer off-list
    r = post("/auth/dealer/send-otp", {"phone": OFF_LIST[0]})
    rec("F.2 dealer off-list send-otp → 403 DEALER_ACCESS_NOT_APPROVED",
        r.status_code == 403 and "DEALER_ACCESS_NOT_APPROVED" in r.text,
        f"status={r.status_code} body={r.text[:120]}")

    # F.3 operator off-list (use dealer phone +919900000002)
    r = post("/auth/operator/send-otp", {"phone": DEALER_PHONE})
    rec("F.3 operator off-list (+919900000002) → 403 OPERATOR_ACCESS_DENIED",
        r.status_code == 403 and "OPERATOR_ACCESS_DENIED" in r.text,
        f"status={r.status_code} body={r.text[:120]}")

    # F.4 POST /api/cars: dealer 403, operator 200
    car_payload = {
        "registration_number": f"TEST{int(time.time()) % 100000}",
        "make": "Maruti", "model": "Swift", "variant": "ZXI",
        "year": 2022, "fuel_type": "Petrol", "transmission": "Manual",
        "km_driven": 25000, "color": "Red", "owners": 1,
        "reserve_price": 600000, "starting_bid": 500000,
        "duration_minutes": 60,
    }
    r = post("/cars", body=car_payload, token=dealer_token)
    rec("F.4 POST /cars dealer JWT → 403", r.status_code == 403, f"status={r.status_code}")
    r = post("/cars", body=car_payload, token=op_token)
    rec("F.4 POST /cars operator JWT → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")


# ---------- main ----------
def main():
    print(f"Testing against: {BASE}")
    res = test_section_A()
    if not res or len(res) < 4:
        print("[FATAL] section A failed; aborting")
        sys.exit(1)
    op_token, dealer_token, op_id, dealer_id = res
    test_section_B(op_token, dealer_token)
    test_section_C(op_token, dealer_token, op_id, dealer_id)
    test_section_D(op_token, dealer_token, op_id, dealer_id)
    test_section_E(op_token, dealer_token)
    test_section_F(op_token, dealer_token)

    print("\n========== SUMMARY ==========")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    print(f"PASS: {passed}/{len(results)}")
    if failed:
        print(f"FAIL: {len(failed)}")
        for n, d in failed:
            print(f"  - {n} :: {d}")
    sys.exit(0 if not failed else 2)


if __name__ == "__main__":
    main()
