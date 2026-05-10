#!/usr/bin/env python3
"""
PRODUCTION RELEASE VALIDATION — Q Drives Dealer Hub
Final go/no-go check. DEV_BYPASS_OTP MUST be FALSE.

Gates G1..G6 + environment sanity checks. Single one-line GO / NO-GO
verdict at the top of the report.
"""
from __future__ import annotations
import asyncio
import json
import os
import time
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import httpx
import websockets
from dotenv import load_dotenv

# Load backend env to see DEV_BYPASS_OTP
load_dotenv("/app/backend/.env")

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com"
API = f"{BASE}/api"
WS_BASE = "wss://qdrives-dealer-hub.preview.emergentagent.com"

# Test phones
DEALER_PHONE_ALLOWED = "+919900000001"  # in approved_dealers.active
OPERATOR_PHONE = "+918977986662"        # in operators
SELLER_PHONE_NOT_ON_FILE = "+919999000099"
RANDOM_DEALER_PHONE = "+919876543210"   # off-list, used only for rate limit

results: List[Tuple[str, str, str]] = []  # (gate_id, PASS/FAIL/SKIP, detail)

def record(gate: str, status: str, detail: str = ""):
    results.append((gate, status, detail))
    icon = "✅" if status == "PASS" else ("❌" if status == "FAIL" else "⚠️")
    print(f"{icon} {gate}: {status} — {detail}")

async def http_post(client: httpx.AsyncClient, path: str, body: dict, headers: dict = None):
    return await client.post(f"{API}{path}", json=body, headers=headers or {})

async def http_get(client: httpx.AsyncClient, path: str, headers: dict = None):
    return await client.get(f"{API}{path}", headers=headers or {})

def detail_of(r: httpx.Response) -> str:
    try:
        d = r.json()
        return f"HTTP {r.status_code} detail={d.get('detail') if isinstance(d, dict) else d!r}"
    except Exception:
        return f"HTTP {r.status_code} body={r.text[:120]!r}"

# ---------------- GATE G1 ----------------
async def gate_g1(client):
    # G1.1 dealer/verify-otp + 123456 → 400 OTP_TOKEN_REQUIRED
    r = await http_post(client, "/auth/dealer/verify-otp",
                        {"phone": DEALER_PHONE_ALLOWED, "otp": "123456"})
    ok = (r.status_code == 400 and r.json().get("detail") == "OTP_TOKEN_REQUIRED")
    record("G1.1 mocked OTP rejected on /auth/dealer/verify-otp",
           "PASS" if ok else "FAIL", detail_of(r))

    # G1.2 operator/verify-otp + 123456 → 400 OTP_TOKEN_REQUIRED
    r = await http_post(client, "/auth/operator/verify-otp",
                        {"phone": OPERATOR_PHONE, "otp": "123456"})
    ok = (r.status_code == 400 and r.json().get("detail") == "OTP_TOKEN_REQUIRED")
    record("G1.2 mocked OTP rejected on /auth/operator/verify-otp",
           "PASS" if ok else "FAIL", detail_of(r))

    # G1.3 seller/verify-otp + 123456 → 404 OR 400 (any non-200/non-token-issuing)
    r = await http_post(client, "/auth/seller/verify-otp",
                        {"phone": SELLER_PHONE_NOT_ON_FILE, "otp": "123456"})
    ok = (r.status_code in (400, 404) and "token" not in (r.json() if r.headers.get("content-type","").startswith("application/json") else {}))
    record("G1.3 seller verify-otp non-200/non-token",
           "PASS" if ok else "FAIL", detail_of(r))

    # G1.4 dealer/verify-otp with bogus firebase_id_token → 400 OTP_INVALID
    r = await http_post(client, "/auth/dealer/verify-otp",
                        {"phone": DEALER_PHONE_ALLOWED,
                         "firebase_id_token": "not.a.real.token"})
    ok = (r.status_code == 400 and r.json().get("detail") == "OTP_INVALID")
    record("G1.4 bogus firebase token → 400 OTP_INVALID",
           "PASS" if ok else "FAIL", detail_of(r))

    # G1.5 No endpoint returns dev_otp anywhere we just hit
    found_dev_otp = False
    # also probe send-otp surfaces
    for path, body in [
        ("/auth/dealer/send-otp", {"phone": DEALER_PHONE_ALLOWED}),
        ("/auth/operator/send-otp", {"phone": OPERATOR_PHONE}),
        ("/auth/seller/send-otp", {"phone": SELLER_PHONE_NOT_ON_FILE}),
    ]:
        rr = await http_post(client, path, body)
        try:
            jb = rr.json()
            if isinstance(jb, dict) and "dev_otp" in jb:
                found_dev_otp = True
                break
        except Exception:
            pass
    record("G1.5 no endpoint returns dev_otp",
           "PASS" if not found_dev_otp else "FAIL",
           "no dev_otp surfaced" if not found_dev_otp else "dev_otp leaked")

# ---------------- GATE G2 ----------------
async def gate_g2(client):
    # G2.6 dealer/send-otp on operator phone → 403 USE_OPERATOR_LOGIN
    r = await http_post(client, "/auth/dealer/send-otp", {"phone": OPERATOR_PHONE})
    ok = (r.status_code == 403 and r.json().get("detail") == "USE_OPERATOR_LOGIN")
    record("G2.6 dealer/send-otp w/ operator phone → 403 USE_OPERATOR_LOGIN",
           "PASS" if ok else "FAIL", detail_of(r))

    # G2.7 operator/send-otp on dealer phone → 403 OPERATOR_ACCESS_DENIED
    r = await http_post(client, "/auth/operator/send-otp",
                        {"phone": DEALER_PHONE_ALLOWED})
    ok = (r.status_code == 403 and r.json().get("detail") == "OPERATOR_ACCESS_DENIED")
    record("G2.7 operator/send-otp w/ dealer phone → 403 OPERATOR_ACCESS_DENIED",
           "PASS" if ok else "FAIL", detail_of(r))

    # G2.8 dealer/verify-otp + operator phone + bogus token → 403 USE_OPERATOR_LOGIN
    r = await http_post(client, "/auth/dealer/verify-otp",
                        {"phone": OPERATOR_PHONE, "firebase_id_token": "x.y.z"})
    ok = (r.status_code == 403 and r.json().get("detail") == "USE_OPERATOR_LOGIN")
    record("G2.8 dealer/verify-otp w/ operator phone → 403 USE_OPERATOR_LOGIN (gate before token verify)",
           "PASS" if ok else "FAIL", detail_of(r))

    # G2.9 operator/verify-otp + dealer phone + bogus token → 403 OPERATOR_ACCESS_DENIED
    r = await http_post(client, "/auth/operator/verify-otp",
                        {"phone": DEALER_PHONE_ALLOWED, "firebase_id_token": "x.y.z"})
    ok = (r.status_code == 403 and r.json().get("detail") == "OPERATOR_ACCESS_DENIED")
    record("G2.9 operator/verify-otp w/ dealer phone → 403 OPERATOR_ACCESS_DENIED",
           "PASS" if ok else "FAIL", detail_of(r))

# ---------------- GATE G3 ----------------
async def gate_g3(client):
    # G3.10 secrets file
    r = await http_get(client, "/secrets/firebase-service-account.json")
    record("G3.10 /api/secrets/firebase-service-account.json → 404",
           "PASS" if r.status_code == 404 else "FAIL", detail_of(r))

    # G3.11 GET / returns SPA shell (no directory listing)
    r = await client.get(f"{BASE}/", follow_redirects=True)
    body_head = r.text[:600] if isinstance(r.text, str) else ""
    is_html = "<!DOCTYPE html" in body_head.lower() or "<html" in body_head.lower()
    is_listing = "Index of /" in body_head or "<title>Index of" in body_head
    record("G3.11 GET / returns SPA shell (no directory listing)",
           "PASS" if (r.status_code == 200 and is_html and not is_listing) else "FAIL",
           f"HTTP {r.status_code} html={is_html} listing={is_listing}")

    # G3.12 admin endpoints without auth → 401
    admin_paths = [
        "/admin/dashboard", "/admin/dealers", "/admin/audit-logs",
        "/admin/risk/dealers", "/admin/realtime/health",
        "/admin/auctions/live-grid", "/admin/security/denied-logins",
        "/admin/settlements/pipeline", "/admin/approved-dealers",
    ]
    bad = []
    for p in admin_paths:
        rr = await http_get(client, p)
        if rr.status_code != 401:
            bad.append(f"{p}={rr.status_code}")
    record("G3.12 all /admin/* without auth → 401",
           "PASS" if not bad else "FAIL",
           f"{len(admin_paths)} endpoints; mismatches: {bad or 'none'}")

    # G3.13 seller endpoints without auth → 401
    seller_paths = ["/seller/me", "/seller/vehicles", "/seller/vehicles/abc"]
    bad_s = []
    for p in seller_paths:
        rr = await http_get(client, p)
        if rr.status_code != 401:
            bad_s.append(f"{p}={rr.status_code}")
    record("G3.13 all /seller/* without auth → 401",
           "PASS" if not bad_s else "FAIL",
           f"mismatches: {bad_s or 'none'}")

    # G3.14 CORS sanity — preflight
    rr = await client.options(f"{API}/auctions",
                              headers={
                                  "Origin": "https://attacker.example.com",
                                  "Access-Control-Request-Method": "GET",
                                  "Access-Control-Request-Headers": "authorization",
                              })
    aco = rr.headers.get("access-control-allow-origin", "")
    acc = rr.headers.get("access-control-allow-credentials", "")
    # Spec: not paired '*' + 'true'. Starlette echoes the origin instead of '*' when credentials=True.
    star_with_creds = (aco == "*" and acc.lower() == "true")
    record("G3.14 CORS not '*' + credentials true",
           "PASS" if not star_with_creds else "FAIL",
           f"ACAO={aco!r} ACAC={acc!r} status={rr.status_code}")

# ---------------- GATE G4 ----------------
async def gate_g4(client):
    # G4.15 snapshot without auth → 401
    # any auction id (real or not). use 'sample-id'
    r = await http_get(client, "/auctions/any_real_id/snapshot")
    record("G4.15 /auctions/{id}/snapshot anon → 401",
           "PASS" if r.status_code == 401 else "FAIL", detail_of(r))

    # G4.16 admin/realtime/health anon → 401
    r = await http_get(client, "/admin/realtime/health")
    record("G4.16 /admin/realtime/health anon → 401",
           "PASS" if r.status_code == 401 else "FAIL", detail_of(r))

    # G4.17 anon WS auction → close 4401
    try:
        async with websockets.connect(f"{WS_BASE}/api/ws/auction/anything",
                                       open_timeout=10, close_timeout=5) as ws:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                # If we receive anything before close, that's a fail
                record("G4.17 anon WS /ws/auction/anything → close 4401",
                       "FAIL", f"received frame instead of close: {msg[:200]}")
                return
            except websockets.ConnectionClosed as cc:
                code = cc.rcvd.code if cc.rcvd else cc.code
                record("G4.17 anon WS /ws/auction/anything → close 4401",
                       "PASS" if code == 4401 else "FAIL",
                       f"close code={code}")
            except asyncio.TimeoutError:
                # no frame and connection still open → fail (should have closed)
                record("G4.17 anon WS /ws/auction/anything → close 4401",
                       "FAIL", "no close received within 5s; connection still open")
    except websockets.InvalidStatusCode as e:
        record("G4.17 anon WS /ws/auction/anything → close 4401",
               "FAIL", f"handshake rejected with HTTP {e.status_code}")
    except websockets.ConnectionClosed as cc:
        code = cc.rcvd.code if cc.rcvd else cc.code
        record("G4.17 anon WS /ws/auction/anything → close 4401",
               "PASS" if code == 4401 else "FAIL",
               f"close code={code}")
    except Exception as e:
        record("G4.17 anon WS /ws/auction/anything → close 4401",
               "FAIL", f"unexpected: {e!r}")

    # G4.18 anon WS ops → close 4401
    try:
        async with websockets.connect(f"{WS_BASE}/api/ws/ops",
                                       open_timeout=10, close_timeout=5) as ws:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                record("G4.18 anon WS /ws/ops → close 4401",
                       "FAIL", f"received frame: {msg[:200]}")
            except websockets.ConnectionClosed as cc:
                code = cc.rcvd.code if cc.rcvd else cc.code
                record("G4.18 anon WS /ws/ops → close 4401",
                       "PASS" if code == 4401 else "FAIL",
                       f"close code={code}")
            except asyncio.TimeoutError:
                record("G4.18 anon WS /ws/ops → close 4401",
                       "FAIL", "no close received within 5s")
    except websockets.InvalidStatusCode as e:
        record("G4.18 anon WS /ws/ops → close 4401",
               "FAIL", f"handshake rejected with HTTP {e.status_code}")
    except websockets.ConnectionClosed as cc:
        code = cc.rcvd.code if cc.rcvd else cc.code
        record("G4.18 anon WS /ws/ops → close 4401",
               "PASS" if code == 4401 else "FAIL", f"close code={code}")
    except Exception as e:
        record("G4.18 anon WS /ws/ops → close 4401",
               "FAIL", f"unexpected: {e!r}")

# ---------------- GATE G5 ----------------
async def gate_g5(client, run_g5: bool = True):
    if not run_g5:
        record("G5.19 rate-limit tight loop", "SKIP", "skipped per CLI flag")
        record("G5.20 rate-limit slow succession", "SKIP", "skipped per CLI flag")
        return

    # The rate-limit buckets are in-memory on the backend. To get a clean
    # baseline we use a phone that we expect to NOT have been hit recently.
    # We pick a fresh one, but if any other test used it the result varies.
    target_phone = RANDOM_DEALER_PHONE

    # Fire 7 in tight loop
    codes = []
    for i in range(7):
        rr = await http_post(client, "/auth/dealer/send-otp", {"phone": target_phone})
        codes.append(rr.status_code)
    twos = sum(1 for c in codes if c == 200)
    twentysix = sum(1 for c in codes if c == 429)
    g5_19_ok = (twos == 1 and twentysix == 6)
    record("G5.19 7-in-tight-loop → 1×200 + 6×429",
           "PASS" if g5_19_ok else "FAIL",
           f"got {twos}×200 + {twentysix}×429 (sequence={codes})")

    # Wait 25s for cooldown to lapse, then 6 slow >20s apart
    print("   ...waiting 25s for cooldown window to clear...", flush=True)
    await asyncio.sleep(25)

    slow_codes = []
    for i in range(6):
        rr = await http_post(client, "/auth/dealer/send-otp", {"phone": target_phone})
        slow_codes.append(rr.status_code)
        if i < 5:
            await asyncio.sleep(21)  # >20s cooldown
    twos2 = sum(1 for c in slow_codes if c == 200)
    fourtwos = sum(1 for c in slow_codes if c == 429)
    # Per-hour cap = 5; first tight-loop run already used 1 slot,
    # so we have 4 more 200s before per-hour cap kicks in. Then 2×429.
    g5_20_ok = (twos2 == 4 and fourtwos == 2)
    record("G5.20 6-slow-succession → 4×200 + 2×429 (per-phone hourly cap)",
           "PASS" if g5_20_ok else "FAIL",
           f"got {twos2}×200 + {fourtwos}×429 (sequence={slow_codes})")

# ---------------- GATE G6 ----------------
async def gate_g6(client):
    # G6.21 /dashboard/stats no auth → 401
    r = await http_get(client, "/dashboard/stats")
    record("G6.21 /dashboard/stats anon → 401",
           "PASS" if r.status_code == 401 else "FAIL", detail_of(r))

    # G6.22 /auctions no auth — historic: returns 200 list (public marketplace)
    r = await http_get(client, "/auctions")
    if r.status_code == 401:
        record("G6.22 /auctions anon",
               "PASS", "401 (auth-required, hardened)")
    elif r.status_code == 200:
        try:
            jb = r.json()
            n = len(jb) if isinstance(jb, list) else "?"
            record("G6.22 /auctions anon",
                   "PASS",
                   f"200 with list of {n} (public marketplace — historic behaviour)")
        except Exception:
            record("G6.22 /auctions anon", "FAIL", detail_of(r))
    else:
        record("G6.22 /auctions anon",
               "FAIL", detail_of(r))

    # G6.23 /cars no auth — historic: returns 200 list
    r = await http_get(client, "/cars")
    if r.status_code == 401:
        record("G6.23 /cars anon", "PASS", "401 (auth-required)")
    elif r.status_code == 200:
        try:
            jb = r.json()
            n = len(jb) if isinstance(jb, list) else "?"
            record("G6.23 /cars anon",
                   "PASS",
                   f"200 with list of {n} (public — historic behaviour)")
        except Exception:
            record("G6.23 /cars anon", "FAIL", detail_of(r))
    else:
        record("G6.23 /cars anon", "FAIL", detail_of(r))

    # G6.24 healthz / root respond
    r = await http_get(client, "/")
    record("G6.24 /api/ root responds",
           "PASS" if r.status_code == 200 else "FAIL", detail_of(r))

# ---------------- ENVIRONMENT SANITY ----------------
def env_sanity():
    # 25. DEV_BYPASS_OTP=false
    val = os.getenv("DEV_BYPASS_OTP", "").strip().lower()
    record("ENV.25 DEV_BYPASS_OTP false in /app/backend/.env",
           "PASS" if val in ("false", "", "0", "no") else "FAIL", f"value={val!r}")

    # 26. firebase service account exists & owned by root
    sa = Path("/app/backend/secrets/firebase-service-account.json")
    if not sa.exists():
        record("ENV.26 firebase-service-account.json exists",
               "FAIL", f"missing at {sa}")
    else:
        st = sa.stat()
        import pwd
        owner = pwd.getpwuid(st.st_uid).pw_name
        record("ENV.26 firebase-service-account.json exists & owned by root",
               "PASS" if owner == "root" else "FAIL",
               f"present, owner={owner}, mode={oct(st.st_mode)[-3:]}")

    # 27. google-services.json project_id + package
    gs = Path("/app/frontend/google-services.json")
    try:
        gj = json.loads(gs.read_text())
        proj = gj["project_info"]["project_id"]
        pkg = gj["client"][0]["client_info"]["android_client_info"]["package_name"]
        ok = (proj == "autobid-platform" and pkg == "app.emergent.qdrivesdealerhub32bd13b5")
        record("ENV.27 google-services.json project_id + package",
               "PASS" if ok else "FAIL",
               f"project_id={proj!r} package={pkg!r}")
    except Exception as e:
        record("ENV.27 google-services.json parse",
               "FAIL", f"error: {e!r}")

    # 28. app.json versionCode 8, version 1.0.2, googleServicesFile set, blockedPermissions includes CAMERA + RECORD_AUDIO
    aj = Path("/app/frontend/app.json")
    try:
        a = json.loads(aj.read_text())
        ex = a.get("expo", {})
        and_ = ex.get("android", {})
        vc = and_.get("versionCode")
        ver = ex.get("version")
        gsf = and_.get("googleServicesFile")
        bp = and_.get("blockedPermissions", [])
        ok = (vc == 8 and ver == "1.0.2" and bool(gsf)
              and "android.permission.CAMERA" in bp
              and "android.permission.RECORD_AUDIO" in bp)
        record("ENV.28 app.json versionCode=8 version=1.0.2 + googleServicesFile + blockedPermissions",
               "PASS" if ok else "FAIL",
               f"versionCode={vc} version={ver!r} googleServicesFile={gsf!r} blockedPermissions={bp}")
    except Exception as e:
        record("ENV.28 app.json parse", "FAIL", f"error: {e!r}")

# ---------------- MAIN ----------------
async def main():
    run_g5 = "--no-g5" not in sys.argv
    print(f"\n=== Q Drives Dealer Hub PRODUCTION RELEASE VALIDATION ===")
    print(f"Target: {API}")
    print(f"DEV_BYPASS_OTP={os.getenv('DEV_BYPASS_OTP','')!r}")
    print()

    async with httpx.AsyncClient(timeout=30) as client:
        await gate_g1(client)
        await gate_g2(client)
        await gate_g3(client)
        await gate_g4(client)
        await gate_g5(client, run_g5=run_g5)
        await gate_g6(client)

    env_sanity()

    # Verdict
    fails = [r for r in results if r[1] == "FAIL"]
    skips = [r for r in results if r[1] == "SKIP"]
    print()
    print("=" * 72)
    if fails:
        print(f"VERDICT: NO-GO — {len(fails)} gate(s) failed")
    elif skips:
        print(f"VERDICT: GO (with {len(skips)} skipped check(s)) — review skips manually")
    else:
        print("VERDICT: GO — all release gates passed")
    print("=" * 72)
    print(f"Total: {len(results)}  PASS={sum(1 for r in results if r[1]=='PASS')}  "
          f"FAIL={len(fails)}  SKIP={len(skips)}")
    if fails:
        print("\nFAILED gates:")
        for g, _, d in fails:
            print(f"  • {g}: {d}")
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
