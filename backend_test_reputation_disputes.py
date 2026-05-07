"""
P1 — Dealer Reputation Engine + Dispute System backend tests.

Run target: REACT_APP_BACKEND_URL/api (public ingress).
Credentials: see /app/memory/test_credentials.md

Operator (super_admin) : +918977986662 / OTP 123456
Dealer A (raiser)      : +919900000002 / OTP 123456
Dealer B (counterparty): +919900000001 / OTP 123456
"""
import os
import json
import requests
from typing import Any, Dict, Optional

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
OTP = "123456"

OPERATOR_PHONE = "+918977986662"
DEALER_A_PHONE = "+919900000002"
DEALER_B_PHONE = "+919900000001"

PASS = []
FAIL = []
SKIP = []


def log_pass(step: str, detail: str = ""):
    PASS.append(step)
    print(f"PASS  {step}  {detail}")


def log_fail(step: str, status: int, detail: str):
    FAIL.append((step, status, detail))
    print(f"FAIL  {step}  status={status}  {detail}")


def log_skip(step: str, reason: str):
    SKIP.append((step, reason))
    print(f"SKIP  {step}  {reason}")


def login_dealer(phone: str) -> Dict[str, Any]:
    r = requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": phone}, timeout=20)
    r.raise_for_status()
    r2 = requests.post(
        f"{BASE}/auth/dealer/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r2.raise_for_status()
    return r2.json()


def login_operator(phone: str) -> Dict[str, Any]:
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=20)
    r.raise_for_status()
    r2 = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": phone, "otp": OTP},
        timeout=20,
    )
    r2.raise_for_status()
    return r2.json()


def H(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def main():
    print("=" * 70)
    print("Logging in test users…")
    def _tk(resp):
        return resp.get("access_token") or resp.get("token")

    op = login_operator(OPERATOR_PHONE)
    op_token = _tk(op)
    op_id = op["dealer"]["id"]
    print(f"Operator {OPERATOR_PHONE} role={op['dealer'].get('role')} id={op_id}")

    da = login_dealer(DEALER_A_PHONE)
    da_token = _tk(da)
    da_id = da["dealer"]["id"]
    print(f"Dealer A {DEALER_A_PHONE} status={da['dealer'].get('status')} id={da_id}")

    db_login = login_dealer(DEALER_B_PHONE)
    db_token = _tk(db_login)
    db_id = db_login["dealer"]["id"]
    print(f"Dealer B {DEALER_B_PHONE} status={db_login['dealer'].get('status')} id={db_id}")

    # ---------------------------------------------------------------
    # A) REPUTATION — DEALER SELF-VIEW
    # ---------------------------------------------------------------
    print("\n--- A) Reputation Dealer self-view ---")

    # 1
    r = requests.get(f"{BASE}/reputation/me", headers=H(da_token), timeout=20)
    if r.status_code == 200:
        body = r.json()
        ok = (
            isinstance(body.get("score"), int)
            and 0 <= body["score"] <= 100
            and isinstance(body.get("tier"), dict)
            and {"key", "label", "min", "max", "color"}.issubset(body["tier"].keys())
            and body.get("base_score") == 70
            and isinstance(body.get("signals"), list)
            and isinstance(body.get("badges"), list)
            and isinstance(body.get("restrictions"), list)
        )
        signals_kinds = len(body.get("signals", []))
        if ok:
            log_pass("A.1 GET /reputation/me", f"score={body['score']} tier={body['tier']['key']} signals={signals_kinds}")
        else:
            log_fail("A.1 GET /reputation/me", 200, f"shape mismatch: keys={list(body.keys())}")
    else:
        log_fail("A.1 GET /reputation/me", r.status_code, r.text[:200])

    # 2
    r = requests.get(f"{BASE}/reputation/me/timeline?limit=50", headers=H(da_token), timeout=20)
    if r.status_code == 200 and isinstance(r.json(), list):
        log_pass("A.2 GET /reputation/me/timeline", f"events={len(r.json())}")
    else:
        log_fail("A.2 GET /reputation/me/timeline", r.status_code, r.text[:200])

    # 3
    r = requests.get(f"{BASE}/reputation/dealer/{db_id}/summary", headers=H(da_token), timeout=20)
    if r.status_code == 200:
        body = r.json()
        if {"score", "tier", "badges", "has_active_restriction", "computed_at"}.issubset(body.keys()):
            log_pass("A.3 GET /reputation/dealer/{B}/summary", f"score={body['score']} tier={body['tier'].get('key')}")
        else:
            log_fail("A.3 GET /reputation/dealer/{B}/summary", 200, f"keys={list(body.keys())}")
    else:
        log_fail("A.3 GET /reputation/dealer/{B}/summary", r.status_code, r.text[:200])

    # ---------------------------------------------------------------
    # B) REPUTATION — OPERATOR
    # ---------------------------------------------------------------
    print("\n--- B) Reputation operator views ---")

    # 4
    r = requests.get(f"{BASE}/admin/reputation/dealers", headers=H(op_token), timeout=30)
    if r.status_code == 200:
        rows = r.json()
        ids = {row.get("dealer_id") for row in rows}
        required_keys = {"dealer_id", "name", "phone", "score", "tier", "badges", "active_restrictions", "total_events"}
        ok = (
            isinstance(rows, list)
            and da_id in ids
            and db_id in ids
            and all(required_keys.issubset(row.keys()) for row in rows[:3])
        )
        if ok:
            log_pass("B.4 GET /admin/reputation/dealers", f"count={len(rows)} contains A,B")
        else:
            log_fail("B.4 GET /admin/reputation/dealers", 200, f"missing one of A,B in ids; sample keys={list(rows[0].keys()) if rows else None}")
    else:
        log_fail("B.4 GET /admin/reputation/dealers", r.status_code, r.text[:200])

    # 5
    r = requests.get(
        f"{BASE}/admin/reputation/dealers?sort=score_asc&tier=stable",
        headers=H(op_token), timeout=30,
    )
    if r.status_code == 200:
        rows = r.json()
        scores = [row["score"] for row in rows]
        ok_sort = scores == sorted(scores)
        ok_tier = all(row["tier"]["key"] == "stable" for row in rows) if rows else True
        if ok_sort and ok_tier:
            log_pass("B.5 sort=score_asc&tier=stable", f"count={len(rows)} all stable & ascending")
        else:
            log_fail("B.5 sort=score_asc&tier=stable", 200, f"sort_ok={ok_sort} tier_ok={ok_tier}")
    else:
        log_fail("B.5 sort=score_asc&tier=stable", r.status_code, r.text[:200])

    # 6
    r = requests.get(f"{BASE}/admin/reputation/dealer/{da_id}", headers=H(op_token), timeout=30)
    if r.status_code == 200:
        body = r.json()
        if {"dealer", "reputation", "timeline", "operator_notes", "operator_audit"}.issubset(body.keys()):
            score_before = body["reputation"]["score"]
            log_pass("B.6 GET /admin/reputation/dealer/{A}", f"score_before={score_before}")
        else:
            log_fail("B.6 GET /admin/reputation/dealer/{A}", 200, f"keys={list(body.keys())}")
            score_before = None
    else:
        log_fail("B.6 GET /admin/reputation/dealer/{A}", r.status_code, r.text[:200])
        score_before = None

    # 7  adjust -5
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/adjust",
        headers=H(op_token),
        json={"delta": -5, "reason": "test penalty for QA"},
        timeout=30,
    )
    if r.status_code == 200:
        # Re-fetch
        r2 = requests.get(f"{BASE}/admin/reputation/dealer/{da_id}", headers=H(op_token), timeout=20)
        body = r2.json()
        score_after = body["reputation"]["score"]
        timeline = body["timeline"]
        adjust_event_present = any(
            (e.get("kind") or e.get("signal_kind")) == "operator_score_adjustment"
            for e in timeline
        )
        if score_before is not None and score_after == max(0, score_before - 5) and adjust_event_present:
            log_pass("B.7 POST /admin/.../adjust delta=-5", f"score {score_before} → {score_after}")
        else:
            log_fail(
                "B.7 POST /admin/.../adjust delta=-5",
                200,
                f"before={score_before} after={score_after} adjust_event={adjust_event_present} timeline_kinds={[e.get('kind') or e.get('signal_kind') for e in timeline[:3]]}",
            )
    else:
        log_fail("B.7 POST /admin/.../adjust delta=-5", r.status_code, r.text[:200])
        score_after = None

    # 8 flag
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/flag",
        headers=H(op_token),
        json={"reason": "test flag", "duration_hours": None},
        timeout=20,
    )
    if r.status_code == 200:
        body_after = r.json()
        score_after_flag = body_after.get("score")
        # Check timeline for operator_flag
        rt = requests.get(f"{BASE}/admin/reputation/dealer/{da_id}", headers=H(op_token), timeout=20)
        tl = rt.json()["timeline"]
        flag_event = any((e.get("kind") or e.get("signal_kind")) == "operator_flag" for e in tl)
        # operator_flag is recorded as a signal — it should drop reputation further (or at least not increase).
        if flag_event and (score_after is None or score_after_flag <= score_after):
            log_pass("B.8 POST /admin/.../flag", f"score post-flag={score_after_flag} flag_signal_present=True")
        else:
            log_fail("B.8 POST /admin/.../flag", 200, f"score_after={score_after} score_after_flag={score_after_flag} flag_event={flag_event}")
    else:
        log_fail("B.8 POST /admin/.../flag", r.status_code, r.text[:200])

    # 9 cooldown 24h
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/cooldown",
        headers=H(op_token),
        json={"reason": "test cooldown", "duration_hours": 24},
        timeout=20,
    )
    if r.status_code == 200:
        body = r.json()
        if body.get("cooldown_until"):
            log_pass("B.9 POST /admin/.../cooldown", f"cooldown_until={body['cooldown_until']}")
        else:
            log_fail("B.9 POST /admin/.../cooldown", 200, f"missing cooldown_until: {body}")
    else:
        log_fail("B.9 POST /admin/.../cooldown", r.status_code, r.text[:200])

    # 10 dealer A bid → 403 DEALER_BIDDING_RESTRICTED
    # find a live auction not seller=A
    auctions = requests.get(f"{BASE}/auctions", headers=H(da_token), timeout=20).json()
    live = None
    for a in auctions:
        if a.get("status") == "live":
            seller_id = (a.get("seller") or {}).get("id") or a.get("seller_id")
            if seller_id != da_id:
                live = a
                break
    if not live:
        log_skip("B.10 bid blocked by cooldown", "no live auction available")
    else:
        amt = int((live.get("current_bid") or live.get("starting_bid") or 0)) + 50000
        rb = requests.post(
            f"{BASE}/auctions/{live['id']}/bid",
            headers=H(da_token),
            json={"amount": amt},
            timeout=20,
        )
        if rb.status_code == 403 and "DEALER_BIDDING_RESTRICTED" in (rb.json().get("detail", "")):
            log_pass("B.10 dealer A bid blocked", f"detail={rb.json()['detail']}")
        else:
            log_fail("B.10 dealer A bid blocked", rb.status_code, rb.text[:300])

    # 11 lift bidding_cooldown
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/lift/bidding_cooldown",
        headers=H(op_token),
        json={"reason": "test lift"},
        timeout=20,
    )
    if r.status_code == 200:
        log_pass("B.11 POST /admin/.../lift/bidding_cooldown", "")
    else:
        log_fail("B.11 POST /admin/.../lift/bidding_cooldown", r.status_code, r.text[:200])

    # 12 notes
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{da_id}/notes",
        headers=H(op_token),
        json={"note": "Watching closely", "visibility": "operator"},
        timeout=20,
    )
    if r.status_code == 200:
        log_pass("B.12 POST /admin/.../notes", "")
    else:
        log_fail("B.12 POST /admin/.../notes", r.status_code, r.text[:200])

    # ---------------------------------------------------------------
    # C) DISPUTES — DEALER FLOWS
    # ---------------------------------------------------------------
    print("\n--- C) Disputes Dealer flows ---")

    # 13 types
    r = requests.get(f"{BASE}/disputes/types", headers=H(da_token), timeout=20)
    if r.status_code == 200:
        types = r.json()
        keys = {t["key"] for t in types}
        expected = {
            "payment_delay", "vehicle_mismatch", "hidden_damage",
            "title_legal_issue", "fake_bidding", "settlement_failure",
            "abusive_conduct", "reserve_manipulation",
        }
        sla_ok = all("sla_ack_hours" in t and "sla_resolve_hours" in t for t in types)
        if expected.issubset(keys) and len(types) == 8 and sla_ok:
            log_pass("C.13 GET /disputes/types", f"count={len(types)} keys ok")
        else:
            log_fail("C.13 GET /disputes/types", 200, f"keys={keys} sla_ok={sla_ok}")
    else:
        log_fail("C.13 GET /disputes/types", r.status_code, r.text[:200])

    # 14 raise dispute
    r = requests.post(
        f"{BASE}/disputes",
        headers=H(da_token),
        json={
            "against_dealer_id": db_id,
            "auction_id": None,
            "dispute_type": "payment_delay",
            "title": "QA test dispute",
            "description": "Counterparty has not paid for >48h after winning.",
        },
        timeout=20,
    )
    dispute_id = None
    if r.status_code == 200:
        body = r.json()
        dispute_id = body.get("id")
        if dispute_id:
            log_pass("C.14 POST /disputes", f"dispute_id={dispute_id}")
        else:
            log_fail("C.14 POST /disputes", 200, f"no id in body: {body}")
    else:
        log_fail("C.14 POST /disputes", r.status_code, r.text[:300])

    # 15 list mine
    r = requests.get(f"{BASE}/disputes/me", headers=H(da_token), timeout=20)
    if r.status_code == 200 and dispute_id:
        items = r.json()
        item = next((i for i in items if i.get("id") == dispute_id), None)
        if item:
            sev = (item.get("aging") or {}).get("severity")
            if sev in ("ok", "warning"):
                log_pass("C.15 GET /disputes/me", f"contains new; aging.severity={sev}")
            else:
                log_fail("C.15 GET /disputes/me", 200, f"aging.severity unexpected: {sev}; aging={item.get('aging')}")
        else:
            log_fail("C.15 GET /disputes/me", 200, f"new dispute not in list (count={len(items)})")
    elif r.status_code != 200:
        log_fail("C.15 GET /disputes/me", r.status_code, r.text[:200])
    else:
        log_skip("C.15", "no dispute_id")

    # 16 detail
    if dispute_id:
        r = requests.get(f"{BASE}/disputes/{dispute_id}", headers=H(da_token), timeout=20)
        if r.status_code == 200:
            body = r.json()
            if "aging" in body and isinstance(body.get("evidence"), list) and isinstance(body.get("messages"), list):
                log_pass("C.16 GET /disputes/{id}", f"evidence={len(body['evidence'])} messages={len(body['messages'])}")
            else:
                log_fail("C.16 GET /disputes/{id}", 200, f"keys={list(body.keys())}")
        else:
            log_fail("C.16 GET /disputes/{id}", r.status_code, r.text[:200])

    # 17 message
    if dispute_id:
        r = requests.post(
            f"{BASE}/disputes/{dispute_id}/messages",
            headers=H(da_token),
            json={"body": "Please pay ASAP."},
            timeout=20,
        )
        if r.status_code == 200:
            log_pass("C.17 POST /disputes/{id}/messages", "")
        else:
            log_fail("C.17 POST /disputes/{id}/messages", r.status_code, r.text[:200])

    # 18 evidence
    if dispute_id:
        r = requests.post(
            f"{BASE}/disputes/{dispute_id}/evidence",
            headers=H(da_token),
            json={"kind": "note", "note": "Evidence note text"},
            timeout=20,
        )
        if r.status_code == 200:
            log_pass("C.18 POST /disputes/{id}/evidence", "")
        else:
            log_fail("C.18 POST /disputes/{id}/evidence", r.status_code, r.text[:200])

    # 19 detail counts
    if dispute_id:
        r = requests.get(f"{BASE}/disputes/{dispute_id}", headers=H(da_token), timeout=20)
        if r.status_code == 200:
            body = r.json()
            mc = body.get("message_count")
            ec = body.get("evidence_count")
            if mc == 1 and ec == 1:
                log_pass("C.19 detail counts", f"messages={mc} evidence={ec}")
            else:
                log_fail("C.19 detail counts", 200, f"message_count={mc} evidence_count={ec}")
        else:
            log_fail("C.19 detail counts", r.status_code, r.text[:200])

    # 20 dealer B access
    if dispute_id:
        r = requests.get(f"{BASE}/disputes/{dispute_id}", headers=H(db_token), timeout=20)
        if r.status_code == 200:
            log_pass("C.20 dealer B GET /disputes/{id}", "counterparty access ok")
        else:
            log_fail("C.20 dealer B GET /disputes/{id}", r.status_code, r.text[:200])

    # 21 third-party (skip — only A and B in test)
    log_skip("C.21 third-party access", "only 2 dealers used in test")

    # ---------------------------------------------------------------
    # D) DISPUTES — OPERATOR FLOWS
    # ---------------------------------------------------------------
    print("\n--- D) Disputes operator flows ---")

    # 22 queue
    r = requests.get(f"{BASE}/admin/disputes/queue", headers=H(op_token), timeout=30)
    if r.status_code == 200:
        items = r.json()
        item = next((i for i in items if i.get("id") == dispute_id), None)
        if item and "raiser_reputation" in item and "against_reputation" in item and "priority_score" in item:
            log_pass("D.22 GET /admin/disputes/queue",
                     f"priority_score={item['priority_score']} raiser_rep_score={(item['raiser_reputation'] or {}).get('score')}")
        else:
            log_fail("D.22 GET /admin/disputes/queue", 200,
                     f"missing fields. found_item={bool(item)} keys={list(item.keys()) if item else None}")
    else:
        log_fail("D.22 GET /admin/disputes/queue", r.status_code, r.text[:200])

    # 23 summary
    r = requests.get(f"{BASE}/admin/disputes/summary", headers=H(op_token), timeout=20)
    if r.status_code == 200:
        body = r.json()
        if (body.get("open_total") or 0) >= 1:
            log_pass("D.23 GET /admin/disputes/summary", f"open_total={body['open_total']}")
        else:
            log_fail("D.23 GET /admin/disputes/summary", 200, f"open_total={body.get('open_total')} body={body}")
    else:
        log_fail("D.23 GET /admin/disputes/summary", r.status_code, r.text[:200])

    # 24 take-review
    if dispute_id:
        r = requests.post(f"{BASE}/admin/disputes/{dispute_id}/take-review", headers=H(op_token), timeout=20)
        if r.status_code == 200 and r.json().get("state") == "under_review":
            log_pass("D.24 take-review", "state=under_review")
        else:
            log_fail("D.24 take-review", r.status_code, r.text[:200])

    # 25 request-evidence
    if dispute_id:
        r = requests.post(
            f"{BASE}/admin/disputes/{dispute_id}/request-evidence",
            headers=H(op_token),
            json={"request": "Please attach proof of payment delay timeline"},
            timeout=20,
        )
        if r.status_code == 200 and r.json().get("state") == "evidence_pending":
            log_pass("D.25 request-evidence", "state=evidence_pending")
        else:
            log_fail("D.25 request-evidence", r.status_code, r.text[:200])

    # 26 escalate
    if dispute_id:
        r = requests.post(
            f"{BASE}/admin/disputes/{dispute_id}/escalate",
            headers=H(op_token),
            json={"reason": "high-value transaction"},
            timeout=20,
        )
        if r.status_code == 200 and r.json().get("is_escalated") is True:
            log_pass("D.26 escalate", "is_escalated=true")
        else:
            log_fail("D.26 escalate", r.status_code, r.text[:200])

    # 27 decide for_raiser
    db_score_before = None
    da_score_before = None
    if dispute_id:
        # capture pre-decide scores for B (loser) + A (winner)
        rb = requests.get(f"{BASE}/admin/reputation/dealer/{db_id}", headers=H(op_token), timeout=20)
        ra = requests.get(f"{BASE}/admin/reputation/dealer/{da_id}", headers=H(op_token), timeout=20)
        if rb.status_code == 200 and ra.status_code == 200:
            db_score_before = rb.json()["reputation"]["score"]
            da_score_before = ra.json()["reputation"]["score"]
        r = requests.post(
            f"{BASE}/admin/disputes/{dispute_id}/decide",
            headers=H(op_token),
            json={"outcome": "decided_for_raiser",
                  "reason": "Counterparty failed to pay despite multiple reminders"},
            timeout=30,
        )
        if r.status_code == 200 and r.json().get("state") == "resolved":
            log_pass("D.27 decide_for_raiser", "state=resolved")
        else:
            log_fail("D.27 decide_for_raiser", r.status_code, r.text[:300])

    # 28 dealer B (loser) reputation lower + dispute_lost
    if dispute_id and db_score_before is not None:
        r = requests.get(f"{BASE}/admin/reputation/dealer/{db_id}", headers=H(op_token), timeout=20)
        body = r.json()
        new_score = body["reputation"]["score"]
        timeline = body["timeline"]
        lost_event = next(
            (e for e in timeline
             if (e.get("kind") or e.get("signal_kind")) == "dispute_lost"
             and (e.get("ref_id") == dispute_id or dispute_id in json.dumps(e))),
            None,
        )
        if new_score < db_score_before and lost_event:
            log_pass("D.28 dealer B lost", f"score {db_score_before} → {new_score} dispute_lost present")
        else:
            log_fail("D.28 dealer B lost", 200,
                     f"before={db_score_before} after={new_score} lost_event={lost_event}")

    # 29 dealer A (winner) timeline contains dispute_won
    if dispute_id:
        r = requests.get(f"{BASE}/admin/reputation/dealer/{da_id}", headers=H(op_token), timeout=20)
        timeline = r.json()["timeline"]
        won_event = next(
            (e for e in timeline
             if (e.get("kind") or e.get("signal_kind")) == "dispute_won"
             and (e.get("ref_id") == dispute_id or dispute_id in json.dumps(e))),
            None,
        )
        if won_event:
            log_pass("D.29 dealer A won", "dispute_won event present")
        else:
            kinds = [e.get("kind") or e.get("signal_kind") for e in timeline[:8]]
            log_fail("D.29 dealer A won", 200, f"no dispute_won event; recent_kinds={kinds}")

    # ---------------------------------------------------------------
    # E) NEGATIVE / GUARD CASES
    # ---------------------------------------------------------------
    print("\n--- E) Negative / guard cases ---")

    # 30 dealer cannot adjust
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/{db_id}/adjust",
        headers=H(da_token),
        json={"delta": -1, "reason": "should fail"},
        timeout=20,
    )
    if r.status_code == 403:
        log_pass("E.30 dealer adjust → 403", "")
    else:
        log_fail("E.30 dealer adjust → 403", r.status_code, r.text[:200])

    # 31 dealer cannot decide
    if dispute_id:
        r = requests.post(
            f"{BASE}/admin/disputes/{dispute_id}/decide",
            headers=H(da_token),
            json={"outcome": "decided_inconclusive", "reason": "should fail"},
            timeout=20,
        )
        if r.status_code == 403:
            log_pass("E.31 dealer decide → 403", "")
        else:
            log_fail("E.31 dealer decide → 403", r.status_code, r.text[:200])

    # 32 second decide on resolved → 400 already terminal
    if dispute_id:
        r = requests.post(
            f"{BASE}/admin/disputes/{dispute_id}/decide",
            headers=H(op_token),
            json={"outcome": "decided_inconclusive", "reason": "second attempt"},
            timeout=20,
        )
        if r.status_code == 400 and "terminal" in r.text.lower():
            log_pass("E.32 second decide → 400 terminal", f"detail={r.json().get('detail')}")
        else:
            log_fail("E.32 second decide → 400 terminal", r.status_code, r.text[:200])

    # 33 invalid type
    r = requests.post(
        f"{BASE}/disputes",
        headers=H(da_token),
        json={
            "against_dealer_id": db_id,
            "auction_id": None,
            "dispute_type": "not_a_real_type",
            "title": "bad type test",
            "description": "this should fail validation",
        },
        timeout=20,
    )
    if r.status_code == 400:
        log_pass("E.33 invalid dispute_type → 400", "")
    else:
        log_fail("E.33 invalid dispute_type → 400", r.status_code, r.text[:200])

    # 34 nonexistent dealer adjust → 404
    r = requests.post(
        f"{BASE}/admin/reputation/dealer/nonexistent-id-xyz-0000/adjust",
        headers=H(op_token),
        json={"delta": -1, "reason": "test ne"},
        timeout=20,
    )
    if r.status_code == 404:
        log_pass("E.34 nonexistent dealer adjust → 404", "")
    else:
        log_fail("E.34 nonexistent dealer adjust → 404", r.status_code, r.text[:200])

    # ---------------------------------------------------------------
    # SUMMARY
    # ---------------------------------------------------------------
    print("\n" + "=" * 70)
    print(f"PASS={len(PASS)}  FAIL={len(FAIL)}  SKIP={len(SKIP)}")
    if FAIL:
        print("\nFailed steps:")
        for s, code, det in FAIL:
            print(f"  - {s}  [{code}]  {det[:200]}")
    if SKIP:
        print("\nSkipped steps:")
        for s, why in SKIP:
            print(f"  - {s}  ({why})")


if __name__ == "__main__":
    main()
