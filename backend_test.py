"""
Retest of 3 ObjectId-leak fixes + B.10 bid-restriction enforcement
+ reputation snapshot integrity.

Run: python /app/backend_test.py
"""
import json
import time
import uuid
import requests
from datetime import datetime
from typing import Any, Dict, Optional

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
OTP = "123456"

OPERATOR_PHONE = "+918977986662"
DEALER_A_PHONE = "+919900000002"  # raiser
DEALER_B_PHONE = "+919900000001"  # counterparty / seller for new auction

PASS_LIST = []
FAIL_LIST = []
SKIP_LIST = []


def lp(step, detail=""):
    PASS_LIST.append(step)
    print(f"PASS  {step}  {detail}")


def lf(step, status, detail=""):
    FAIL_LIST.append((step, status, detail))
    print(f"FAIL  {step}  status={status}  {detail}")


def ls(step, reason):
    SKIP_LIST.append((step, reason))
    print(f"SKIP  {step}  {reason}")


def login_dealer(phone):
    requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": phone}, timeout=20)
    r = requests.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def login_operator(phone):
    requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=20)
    r = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def H(token):
    return {"Authorization": f"Bearer {token}"}


def main():
    print("=" * 70)
    print("Logging in test users…")
    op = login_operator(OPERATOR_PHONE)
    op_token = op.get("access_token") or op.get("token")
    op_id = op["dealer"]["id"]
    print(f"  Operator id={op_id}  role={op['dealer'].get('role')}")

    da = login_dealer(DEALER_A_PHONE)
    da_token = da.get("access_token") or da.get("token")
    da_id = da["dealer"]["id"]
    print(f"  Dealer A id={da_id}")

    db_login = login_dealer(DEALER_B_PHONE)
    db_token = db_login.get("access_token") or db_login.get("token")
    db_id = db_login["dealer"]["id"]
    print(f"  Dealer B id={db_id}")

    # =================================================================
    # 1) ObjectId-leak fix verification
    # =================================================================
    print("\n" + "=" * 70)
    print("1) ObjectId-leak fix verification")
    print("=" * 70)

    # 1a — POST /admin/reputation/dealer/{A}/notes
    print("\n[1a] POST /admin/reputation/dealer/{A}/notes")
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/notes",
        headers=H(op_token),
        json={"note": "retest note", "visibility": "operator"},
        timeout=20,
    )
    print(f"  status={r.status_code} body={r.text[:300]}")
    if r.status_code == 200:
        body = r.json()
        required = {"id", "dealer_id", "note", "visibility", "created_by", "created_at"}
        missing = required - set(body.keys())
        if missing:
            lf("1a notes shape", r.status_code, f"missing keys: {missing}")
        elif body.get("note") != "retest note" or body.get("visibility") != "operator":
            lf("1a notes shape", r.status_code, f"value mismatch: {body}")
        else:
            lp("1a POST /admin/reputation/dealer/{id}/notes",
               f"id={body['id']}, created_by={body['created_by']}")
    else:
        lf("1a POST /admin/reputation/dealer/{id}/notes", r.status_code, r.text[:400])

    # 1b — POST /disputes (raise) then POST /disputes/{id}/messages
    print("\n[1b] POST /disputes then /disputes/{id}/messages")
    rd = requests.post(
        f"{BASE}/disputes",
        headers=H(da_token),
        json={
            "against_dealer_id": db_id,
            "auction_id": None,
            "dispute_type": "payment_delay",
            "title": "Retest payment delay",
            "description": "Buyer has not paid within window — retest.",
        },
        timeout=20,
    )
    print(f"  raise status={rd.status_code} body={rd.text[:300]}")
    if rd.status_code != 200:
        lf("1b raise dispute", rd.status_code, rd.text[:400])
        dispute_id = None
    else:
        dispute_id = rd.json().get("id")
        lp("1b raise dispute", f"dispute_id={dispute_id}")

    if dispute_id:
        rm = requests.post(
            f"{BASE}/disputes/{dispute_id}/messages",
            headers=H(da_token),
            json={"body": "retest message"},
            timeout=20,
        )
        print(f"  message status={rm.status_code} body={rm.text[:300]}")
        if rm.status_code == 200:
            mb = rm.json()
            required = {"id", "dispute_id", "actor_id", "actor_role", "body", "ts"}
            missing = required - set(mb.keys())
            if missing:
                lf("1b messages shape", rm.status_code, f"missing: {missing}")
            elif mb.get("actor_role") != "raiser":
                lf("1b messages actor_role", rm.status_code,
                   f"expected raiser, got {mb.get('actor_role')}")
            elif mb.get("body") != "retest message":
                lf("1b messages body", rm.status_code, f"got {mb.get('body')}")
            else:
                lp("1b POST /disputes/{id}/messages",
                   f"id={mb['id']} actor_role={mb['actor_role']} body={mb['body']!r}")
        else:
            lf("1b POST /disputes/{id}/messages", rm.status_code, rm.text[:400])

    # 1c — POST /disputes/{id}/evidence
    if dispute_id:
        print("\n[1c] POST /disputes/{id}/evidence")
        re_ = requests.post(
            f"{BASE}/disputes/{dispute_id}/evidence",
            headers=H(da_token),
            json={"kind": "note", "note": "retest evidence"},
            timeout=20,
        )
        print(f"  status={re_.status_code} body={re_.text[:300]}")
        if re_.status_code == 200:
            eb = re_.json()
            required = {"id", "dispute_id", "kind", "note", "ts"}
            missing = required - set(eb.keys())
            if missing:
                lf("1c evidence shape", re_.status_code, f"missing: {missing}")
            elif eb.get("kind") != "note" or eb.get("note") != "retest evidence":
                lf("1c evidence values", re_.status_code, f"got {eb}")
            else:
                lp("1c POST /disputes/{id}/evidence",
                   f"id={eb['id']} kind={eb['kind']} note={eb['note']!r}")
        else:
            lf("1c POST /disputes/{id}/evidence", re_.status_code, re_.text[:400])
    else:
        ls("1c evidence", "no dispute_id from 1b")

    # =================================================================
    # 2) Bid-restriction enforcement (B.10)
    # =================================================================
    print("\n" + "=" * 70)
    print("2) Bid-restriction enforcement (B.10)")
    print("=" * 70)

    # 2a — apply 24h cooldown on Dealer A
    print("\n[2a] Apply bidding_cooldown to Dealer A")
    rc = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/cooldown",
        headers=H(op_token),
        json={"reason": "retest", "duration_hours": 24},
        timeout=20,
    )
    print(f"  status={rc.status_code} body={rc.text[:300]}")
    if rc.status_code == 200:
        lp("2a apply cooldown", "200")
    else:
        lf("2a apply cooldown", rc.status_code, rc.text[:400])

    # 2b — find a live auction not seller=Dealer A
    print("\n[2b] Locate / launch a live auction (seller != Dealer A)")
    auctions = requests.get(f"{BASE}/auctions", timeout=20).json()
    live_auction = None
    for a in auctions:
        if a.get("status") == "live":
            seller_id = (a.get("seller") or {}).get("id") or a.get("seller_id")
            if seller_id != da_id:
                live_auction = a
                break
    if not live_auction:
        # Try to launch a fresh live auction via operator POST /api/cars
        print("  No existing live auction found — launching one via operator POST /cars")
        car_payload = {
            "registration_number": f"MH99RT{int(time.time()) % 10000}",
            "make": "Maruti Suzuki",
            "model": "Swift",
            "variant": "VXi",
            "year": 2022,
            "fuel_type": "Petrol",
            "transmission": "Manual",
            "km_driven": 38000,
            "owners": 1,
            "starting_bid": 350000,
            "reserve_price": 480000,
            "duration_minutes": 60,
        }
        rcar = requests.post(
            f"{BASE}/cars",
            headers=H(op_token),
            json=car_payload,
            timeout=30,
        )
        print(f"  POST /cars status={rcar.status_code} body={rcar.text[:300]}")
        if rcar.status_code == 200:
            live_auction = rcar.json().get("auction")
        else:
            ls("2b launch live auction", f"could not launch: {rcar.status_code}")

    if not live_auction:
        ls("2c bid-restricted enforcement", "no live auction available")
        ls("2d lift bidding_cooldown", "skipped because 2c skipped")
        ls("2e retry bid after lift", "skipped because 2c skipped")
    else:
        aid = live_auction.get("id")
        starting = live_auction.get("starting_bid", 0)
        cur = live_auction.get("current_bid", starting) or starting
        bid_amount = cur + 5000
        print(f"  Using auction id={aid} current_bid={cur} bid_amount={bid_amount}")

        # 2c — Dealer A bid → expect 403 DEALER_BIDDING_RESTRICTED:bidding_cooldown
        print("\n[2c] Dealer A places bid while cooldown active")
        rb = requests.post(
            f"{BASE}/auctions/{aid}/bid",
            headers=H(da_token),
            json={"amount": bid_amount},
            timeout=20,
        )
        print(f"  status={rb.status_code} body={rb.text[:300]}")
        try:
            detail = rb.json().get("detail", "")
        except Exception:
            detail = rb.text
        if rb.status_code == 403 and isinstance(detail, str) and detail.startswith("DEALER_BIDDING_RESTRICTED:"):
            lp("2c bid blocked while cooldown active", f"detail={detail!r}")
        else:
            lf("2c bid blocked while cooldown active", rb.status_code,
               f"detail={detail!r}")

        # 2d — lift the cooldown
        print("\n[2d] Lift bidding_cooldown")
        rl = requests.post(
            f"{BASE}/admin/reputation/dealer/{da_id}/lift/bidding_cooldown",
            headers=H(op_token),
            json={"reason": "retest done"},
            timeout=20,
        )
        print(f"  status={rl.status_code} body={rl.text[:300]}")
        if rl.status_code == 200:
            lp("2d lift bidding_cooldown", "200")
        else:
            lf("2d lift bidding_cooldown", rl.status_code, rl.text[:400])

        # 2e — retry same bid; expect 200 or 400 (not 403)
        print("\n[2e] Retry bid after lift (expect not 403)")
        # Re-fetch latest current_bid to recompute amount
        a_now = requests.get(f"{BASE}/auctions/{aid}", timeout=20)
        if a_now.status_code == 200:
            a_now_j = a_now.json()
            new_cur = a_now_j.get("current_bid", cur) or cur
            new_amount = new_cur + 5000
        else:
            new_amount = bid_amount + 5000
        print(f"  retry amount={new_amount}")
        rb2 = requests.post(
            f"{BASE}/auctions/{aid}/bid",
            headers=H(da_token),
            json={"amount": new_amount},
            timeout=20,
        )
        print(f"  status={rb2.status_code} body={rb2.text[:300]}")
        if rb2.status_code == 403:
            try:
                d2 = rb2.json().get("detail", "")
            except Exception:
                d2 = rb2.text
            lf("2e bid after lift NOT 403", rb2.status_code, f"detail={d2!r}")
        elif rb2.status_code in (200, 400):
            lp("2e bid after lift", f"status={rb2.status_code} (lift effective)")
        else:
            lf("2e bid after lift", rb2.status_code, rb2.text[:400])

    # =================================================================
    # 3) Reputation snapshot integrity
    # =================================================================
    print("\n" + "=" * 70)
    print("3) Reputation snapshot integrity")
    print("=" * 70)

    # 3a — GET /reputation/me as Dealer A
    print("\n[3a] GET /reputation/me as Dealer A")
    rep = requests.get(f"{BASE}/reputation/me", headers=H(da_token), timeout=20)
    print(f"  status={rep.status_code}")
    if rep.status_code != 200:
        lf("3a /reputation/me", rep.status_code, rep.text[:400])
        return
    body = rep.json()
    score = body.get("score")
    total_events = body.get("total_events")
    signals = body.get("signals", [])
    sig_map = {s.get("kind"): s for s in signals}
    print(f"  score={score} total_events={total_events} signal_kinds_seen={len(sig_map)}")
    expected_kinds = ["operator_score_adjustment", "operator_flag",
                      "dispute_won", "dispute_lost"]
    missing_or_zero = []
    for k in expected_kinds:
        if k not in sig_map:
            missing_or_zero.append(f"{k}=missing-defn")
            continue
        s = sig_map[k]
        count = s.get("count", 0)
        delta = s.get("delta", 0)
        if count == 0 and delta == 0:
            missing_or_zero.append(f"{k}: count=0 delta=0")
        print(f"    {k}: count={count} delta={delta}")
    # Dealer A is the raiser in these tests; dispute_lost may legitimately
    # be 0 for them. We'll fail only on the others being all zero.
    critical_missing = [m for m in missing_or_zero
                        if not m.startswith("dispute_lost")]
    if critical_missing:
        lf("3a expected signals non-zero", rep.status_code,
           f"missing/zero: {critical_missing}")
    else:
        lp("3a snapshot signals (operator_score_adjustment, operator_flag, dispute_won non-zero)",
           f"score={score} total_events={total_events}")

    # 3b - timeline
    print("\n[3b] GET /reputation/me/timeline")
    rt = requests.get(f"{BASE}/reputation/me/timeline?limit=200",
                      headers=H(da_token), timeout=20)
    print(f"  status={rt.status_code}")
    if rt.status_code != 200:
        lf("3b /reputation/me/timeline", rt.status_code, rt.text[:400])
    else:
        tl = rt.json()
        kinds_in_tl = {item.get("kind") for item in tl}
        print(f"  timeline len={len(tl)} kinds={sorted(kinds_in_tl)}")
        need = ["operator_score_adjustment"]
        missing = [k for k in need if k not in kinds_in_tl]
        if missing:
            lf("3b timeline contains required kinds", rt.status_code,
               f"missing: {missing}")
        else:
            lp("3b timeline grew",
               f"len={len(tl)} kinds={sorted(kinds_in_tl)}")

    # =================================================================
    # SUMMARY
    # =================================================================
    print("\n" + "=" * 70)
    print(f"SUMMARY: {len(PASS_LIST)} PASS / {len(FAIL_LIST)} FAIL / {len(SKIP_LIST)} SKIP")
    print("=" * 70)
    if FAIL_LIST:
        print("\nFAIL:")
        for s, st, d in FAIL_LIST:
            print(f"  - {s}  status={st}  {d}")
    if SKIP_LIST:
        print("\nSKIP:")
        for s, r in SKIP_LIST:
            print(f"  - {s}  reason={r}")


if __name__ == "__main__":
    main()
