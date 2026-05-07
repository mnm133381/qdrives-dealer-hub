"""
Settlement v2 backend tests — 16-state operator-controlled deal completion.

Targets:
  - GET /api/settlements/states (catalog, no auth)
  - GET /api/settlements/me + /{id} + /mark-payment-sent + /proof  (dealer)
  - GET/POST /api/admin/settlements/queue, /summary, /{id}, /transition,
    /note, /dealer-message, /proof   (operator)

Setup: seeds two settlements directly via the settlement service helper, by
calling create_for_auction_win on synthetic auction docs. This keeps the
test deterministic and isolated from the auction_scheduler timing.

Auth credentials (from /app/memory/test_credentials.md):
  Operator (super_admin): +918977986662, OTP 123456
  Dealer A: +919900000002 (Royal Drives Co.) — winner
  Dealer B: +919900000001 (Apex Premium Motors) — non-owner for cross access
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
from motor.motor_asyncio import AsyncIOMotorClient

# ------------------------------------------------------------
# Config
# ------------------------------------------------------------
BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "qdrives_db"

OPERATOR_PHONE = "+918977986662"
DEALER_A_PHONE = "+919900000002"   # the winner
DEALER_B_PHONE = "+919900000001"   # not the winner
OTP = "123456"

PASS = []   # list[str]
FAIL = []   # list[(name, detail)]

def ok(name: str) -> None:
    PASS.append(name)
    print(f"PASS  {name}")

def bad(name: str, detail: str) -> None:
    FAIL.append((name, detail))
    print(f"FAIL  {name}\n        {detail}")

# ------------------------------------------------------------
# Auth helpers
# ------------------------------------------------------------
def operator_login(phone: str) -> Tuple[str, Dict[str, Any]]:
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": phone}, timeout=20)
    assert r.status_code == 200, f"send-otp operator: {r.status_code} {r.text}"
    r = requests.post(f"{BASE}/auth/operator/verify-otp", json={"phone": phone, "otp": OTP}, timeout=20)
    assert r.status_code == 200, f"verify-otp operator: {r.status_code} {r.text}"
    j = r.json()
    return j["token"], j["dealer"]

def dealer_login(phone: str) -> Tuple[str, Dict[str, Any]]:
    r = requests.post(f"{BASE}/auth/dealer/send-otp", json={"phone": phone}, timeout=20)
    assert r.status_code == 200, f"send-otp dealer: {r.status_code} {r.text}"
    r = requests.post(f"{BASE}/auth/dealer/verify-otp", json={"phone": phone, "otp": OTP}, timeout=20)
    assert r.status_code == 200, f"verify-otp dealer: {r.status_code} {r.text}"
    j = r.json()
    return j["token"], j["dealer"]

def H(tok: Optional[str]) -> Dict[str, str]:
    return {"Authorization": f"Bearer {tok}"} if tok else {}

# ------------------------------------------------------------
# Direct DB helpers (seed + verify audits)
# ------------------------------------------------------------
async def seed_settlement(dealer_id: str, winning_amount: float, auction_id: Optional[str] = None) -> Dict[str, Any]:
    """Insert a synthetic auction + drive sett_svc.create_for_auction_win."""
    sys.path.insert(0, "/app/backend")
    from services import settlement as sett_svc  # type: ignore

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    aid = auction_id or str(uuid.uuid4())
    auction = {
        "id": aid,
        "car": {
            "make": "Hyundai",
            "model": "Creta",
            "variant": "SX(O)",
            "year": 2022,
            "registration_number": "MH02XX9999",
            "kms_driven": 24500,
            "images": ["https://example.com/img.jpg"],
        },
        "ended_at": datetime.now(timezone.utc),
        "end_time": datetime.now(timezone.utc),
        "reserve_price": int(winning_amount * 0.9),
        "reserve_met": True,
    }
    settlement = await sett_svc.create_for_auction_win(
        db, auction=auction, winner_dealer_id=dealer_id, winning_amount=winning_amount,
    )
    client.close()
    return {"settlement": settlement, "auction_id": aid}

async def count_audit(settlement_id: str) -> int:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    n = await db.settlement_audit.count_documents({"settlement_id": settlement_id})
    client.close()
    return n

async def count_settlements_for_auction(auction_id: str) -> int:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    n = await db.settlements.count_documents({"auction_id": auction_id})
    client.close()
    return n

async def double_create(dealer_id: str, winning_amount: float, auction_id: str) -> int:
    """Call create_for_auction_win twice for the same auction — should be idempotent."""
    sys.path.insert(0, "/app/backend")
    from services import settlement as sett_svc  # type: ignore

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    auction = {
        "id": auction_id,
        "car": {"make": "X", "model": "Y", "year": 2022, "registration_number": "MH00X0000"},
        "ended_at": datetime.now(timezone.utc),
        "reserve_met": True,
    }
    await sett_svc.create_for_auction_win(db, auction=auction, winner_dealer_id=dealer_id, winning_amount=winning_amount)
    await sett_svc.create_for_auction_win(db, auction=auction, winner_dealer_id=dealer_id, winning_amount=winning_amount)
    n = await db.settlements.count_documents({"auction_id": auction_id})
    client.close()
    return n

# ------------------------------------------------------------
# Test sections
# ------------------------------------------------------------

def section_catalog():
    print("\n=== A. Catalog (GET /settlements/states) ===")
    r = requests.get(f"{BASE}/settlements/states", timeout=20)
    if r.status_code != 200:
        bad("A.1 catalog 200", f"{r.status_code} {r.text}")
        return
    j = r.json()
    states = j.get("states") or []
    if len(states) == 16:
        ok("A.1 catalog has 16 states")
    else:
        bad("A.1 catalog has 16 states", f"got {len(states)}: {states}")
    terminals = j.get("terminal_states") or []
    if set(terminals) == {"completed", "refund_completed"}:
        ok("A.2 terminal_states == {completed, refund_completed}")
    else:
        bad("A.2 terminal_states", f"got {terminals}")
    transitions = j.get("transitions") or {}
    if len(transitions) == 16:
        ok("A.3 transitions has 16 entries")
    else:
        bad("A.3 transitions has 16 entries", f"got {len(transitions)}: {list(transitions.keys())}")
    if all(("from" in t and "to" in t and "operator_only" in t) for t in transitions.values()):
        ok("A.4 each transition has from/to/operator_only")
    else:
        bad("A.4 each transition has from/to/operator_only", json.dumps(transitions, default=str)[:400])
    if j.get("dealer_allowed_actions") == ["mark_payment_sent"]:
        ok("A.5 dealer_allowed_actions == ['mark_payment_sent']")
    else:
        bad("A.5 dealer_allowed_actions", f"got {j.get('dealer_allowed_actions')}")


def assert_state(tok: str, sid: str, expected: str, label: str, *, admin=True) -> Optional[Dict[str, Any]]:
    url = f"{BASE}/admin/settlements/{sid}" if admin else f"{BASE}/settlements/{sid}"
    r = requests.get(url, headers=H(tok), timeout=20)
    if r.status_code != 200:
        bad(f"{label} GET {url}", f"{r.status_code} {r.text}")
        return None
    s = r.json()
    if s.get("state") != expected:
        bad(f"{label} state == {expected}", f"got {s.get('state')}")
        return s
    ok(f"{label} state == {expected}")
    return s


def transition(tok: str, sid: str, action: str, *, payload=None, reason=None, expect=200, label: str = "") -> Optional[Dict[str, Any]]:
    body = {"action": action, "payload": payload or {}, "reason": reason or f"{action} via test"}
    r = requests.post(f"{BASE}/admin/settlements/{sid}/transition", headers=H(tok), json=body, timeout=20)
    if r.status_code != expect:
        bad(f"{label or action} expect {expect}", f"got {r.status_code} {r.text[:200]}")
        return None
    ok(f"{label or action} → {expect}")
    return r.json() if r.status_code == 200 else None


def section_e2e_full_payment(op_tok: str, dealer_a_tok: str, dealer_a_id: str):
    print("\n=== B. Happy path: full-payment branch (≥10L for reputation hook) ===")
    seed = asyncio.run(seed_settlement(dealer_a_id, 1_200_000.0))
    s = seed["settlement"]
    sid = s["id"]
    print(f"  seeded settlement_id={sid} state={s.get('state')} deposit={s.get('deposit_amount')}")
    # invariant: deposit == 5%
    if s.get("deposit_amount") == int(round(1_200_000 * 0.05)):
        ok("B.0 deposit_amount == 5% of winning")
    else:
        bad("B.0 deposit_amount == 5% of winning", f"got {s.get('deposit_amount')}")

    # Initial state should be awaiting_operator_review (auto-advance from auction_won)
    assert_state(op_tok, sid, "awaiting_operator_review", "B.1")

    n0 = asyncio.run(count_audit(sid))

    # request_deposit
    transition(op_tok, sid, "request_deposit",
               payload={"deadline_hours": 48, "instructions": "Pay 5% to QD-CURRENT-AC #00001"},
               label="B.2 request_deposit")
    assert_state(op_tok, sid, "deposit_requested", "B.2a")

    # dealer marks payment sent
    proof = {"kind": "utr", "note": "TXN1234ABC"}
    r = requests.post(f"{BASE}/settlements/{sid}/mark-payment-sent",
                      headers=H(dealer_a_tok), json=proof, timeout=20)
    if r.status_code == 200 and r.json().get("state") == "deposit_under_verification":
        ok("B.3 dealer mark-payment-sent → deposit_under_verification")
    else:
        bad("B.3 dealer mark-payment-sent", f"{r.status_code} {r.text[:300]}")

    # verify deposit
    transition(op_tok, sid, "verify_deposit", label="B.4 verify_deposit")
    assert_state(op_tok, sid, "deposit_verified", "B.4a")

    # schedule_visit
    ws = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    we = (datetime.now(timezone.utc) + timedelta(days=2, hours=4)).isoformat()
    transition(op_tok, sid, "schedule_visit",
               payload={"window_start": ws, "window_end": we,
                        "address": "Q Drives Mumbai, Andheri",
                        "instructions": "Bring originals + Aadhaar"},
               label="B.5 schedule_visit")
    assert_state(op_tok, sid, "visit_scheduled", "B.5a")

    # mark_inspection_done
    transition(op_tok, sid, "mark_inspection_done", label="B.6 mark_inspection_done")
    assert_state(op_tok, sid, "inspection_completed", "B.6a")

    # request_full_payment
    transition(op_tok, sid, "request_full_payment",
               payload={"amount": 1_140_000, "instructions": "Pay balance via NEFT"},
               label="B.7 request_full_payment")
    assert_state(op_tok, sid, "full_payment_requested", "B.7a")

    # mark_full_payment_received
    transition(op_tok, sid, "mark_full_payment_received",
               payload={"method": "NEFT", "ref": "UTR-FULL-XYZ-001"},
               label="B.8 mark_full_payment_received")
    assert_state(op_tok, sid, "full_payment_received", "B.8a")

    # mark_vehicle_delivered
    transition(op_tok, sid, "mark_vehicle_delivered", label="B.9 mark_vehicle_delivered")
    assert_state(op_tok, sid, "vehicle_delivered", "B.9a")

    # complete_deal (terminal)
    transition(op_tok, sid, "complete_deal", label="B.10 complete_deal")
    final = assert_state(op_tok, sid, "completed", "B.10a")

    # Audit: every transition added a row. We did 8 operator transitions
    # + 1 dealer mark-payment-sent + creation rows.
    n1 = asyncio.run(count_audit(sid))
    if n1 - n0 >= 9:
        ok(f"B.11 audit grew by ≥9 rows (n0={n0} → n1={n1})")
    else:
        bad("B.11 audit grew by ≥9 rows", f"n0={n0} n1={n1}")

    # Reputation hook for dealer A (high value)
    rep = requests.get(f"{BASE}/admin/reputation/dealer/{dealer_a_id}",
                       headers=H(op_tok), timeout=20)
    if rep.status_code == 200:
        rj = rep.json()
        # search timeline for settlement_completed and high_value_settlement
        signals = rj.get("timeline") or []
        kinds = {x.get("signal_kind") or x.get("kind") for x in signals}
        # Some shapes use 'kind' or 'signal_kind'
        text = json.dumps(rj)
        if "settlement_completed" in text:
            ok("B.12 reputation has settlement_completed signal")
        else:
            bad("B.12 reputation has settlement_completed signal", f"timeline kinds={kinds}")
        if "high_value_settlement" in text:
            ok("B.13 reputation has high_value_settlement signal (≥10L)")
        else:
            bad("B.13 reputation has high_value_settlement signal", f"timeline kinds={kinds}")
    else:
        bad("B.12 reputation lookup", f"{rep.status_code} {rep.text[:200]}")

    return sid


def section_e2e_refund(op_tok: str, dealer_a_tok: str, dealer_a_id: str):
    print("\n=== C. Happy path: refund branch ===")
    seed = asyncio.run(seed_settlement(dealer_a_id, 800_000.0))
    s = seed["settlement"]
    sid = s["id"]
    assert_state(op_tok, sid, "awaiting_operator_review", "C.1")
    transition(op_tok, sid, "request_deposit", payload={"deadline_hours": 48,
               "instructions": "Pay 5% to QD account"}, label="C.2 request_deposit")

    r = requests.post(f"{BASE}/settlements/{sid}/mark-payment-sent",
                      headers=H(dealer_a_tok), json={"kind": "utr", "note": "TXN-REFUND-CASE"}, timeout=20)
    if r.status_code == 200:
        ok("C.3 dealer mark-payment-sent")
    else:
        bad("C.3 dealer mark-payment-sent", f"{r.status_code} {r.text[:200]}")

    transition(op_tok, sid, "verify_deposit", label="C.4 verify_deposit")
    transition(op_tok, sid, "schedule_visit",
               payload={"window_start": datetime.now(timezone.utc).isoformat(),
                        "window_end": (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat(),
                        "address": "Q Drives Mumbai", "instructions": "Bring originals"},
               label="C.5 schedule_visit")
    transition(op_tok, sid, "mark_inspection_done", label="C.6 mark_inspection_done")

    # Refund branch
    transition(op_tok, sid, "approve_refund", payload={"amount": 40_000},
               label="C.7 approve_refund")
    assert_state(op_tok, sid, "refund_approved", "C.7a")

    transition(op_tok, sid, "mark_refund_completed",
               payload={"method": "NEFT", "ref": "UTR-REF-001"},
               label="C.8 mark_refund_completed")
    assert_state(op_tok, sid, "refund_completed", "C.8a")

    return sid


def section_negative(op_tok: str, dealer_a_tok: str, dealer_a_id: str, dealer_b_tok: str,
                     completed_sid: str):
    print("\n=== D. Negative cases ===")
    # D.1 Dealer hits POST /admin/settlements/{id}/transition → 403
    r = requests.post(f"{BASE}/admin/settlements/{completed_sid}/transition",
                      headers=H(dealer_a_tok),
                      json={"action": "complete_deal"}, timeout=20)
    if r.status_code == 403:
        ok("D.1 dealer→/admin/settlements/transition → 403")
    else:
        bad("D.1 dealer→/admin/settlements/transition → 403", f"got {r.status_code} {r.text[:150]}")

    # D.2 Operator action on a terminal state → 400 settlement is terminal
    r = requests.post(f"{BASE}/admin/settlements/{completed_sid}/transition",
                      headers=H(op_tok),
                      json={"action": "complete_deal", "reason": "second time"}, timeout=20)
    if r.status_code == 400 and "terminal" in r.text.lower():
        ok("D.2 operator complete_deal twice on terminal → 400 'terminal'")
    else:
        bad("D.2 operator complete_deal twice on terminal", f"got {r.status_code} {r.text[:200]}")

    # D.3 Invalid action → 400 'unknown action'
    # Need a non-terminal settlement
    seed = asyncio.run(seed_settlement(dealer_a_id, 500_000.0))
    sid = seed["settlement"]["id"]
    r = requests.post(f"{BASE}/admin/settlements/{sid}/transition",
                      headers=H(op_tok),
                      json={"action": "wave_a_magic_wand", "reason": "test"}, timeout=20)
    if r.status_code == 400 and "unknown action" in r.text.lower():
        ok("D.3 invalid action → 400 'unknown action'")
    else:
        bad("D.3 invalid action → 400 'unknown action'", f"got {r.status_code} {r.text[:200]}")

    # D.4 Cross-dealer GET → 404
    r = requests.get(f"{BASE}/settlements/{sid}",
                     headers=H(dealer_b_tok), timeout=20)
    if r.status_code == 404:
        ok("D.4 GET /settlements/{wrong-owner} as dealer_B → 404")
    else:
        bad("D.4 cross-dealer GET → 404", f"got {r.status_code} {r.text[:200]}")

    # D.5 Dealer attempting mark-payment-sent on settlement they don't own → 400 or 404
    # Move sid to deposit_requested first so action would be valid
    transition(op_tok, sid, "request_deposit", payload={"deadline_hours": 48}, label="D.5-prep request_deposit")
    r = requests.post(f"{BASE}/settlements/{sid}/mark-payment-sent",
                      headers=H(dealer_b_tok),
                      json={"kind": "utr", "note": "stranger upload"}, timeout=20)
    if r.status_code == 400 and ("only the winning dealer" in r.text.lower() or "settlement not found" in r.text.lower()):
        ok("D.5 mark-payment-sent by non-owner → 400 'only the winning dealer'")
    elif r.status_code == 404:
        ok("D.5 mark-payment-sent by non-owner → 404")
    else:
        bad("D.5 mark-payment-sent by non-owner", f"got {r.status_code} {r.text[:200]}")

    # D.6 mark-payment-sent with content_base64 > 8MB → 400 "payment proof too large"
    big = "A" * (8_000_001)
    r = requests.post(f"{BASE}/settlements/{sid}/mark-payment-sent",
                      headers=H(dealer_a_tok),
                      json={"kind": "image", "filename": "huge.jpg",
                            "mime_type": "image/jpeg", "content_base64": big,
                            "note": "too big"}, timeout=60)
    if r.status_code == 400 and "too large" in r.text.lower():
        ok("D.6 oversized proof (>8MB chars) → 400 'payment proof too large'")
    else:
        bad("D.6 oversized proof → 400", f"got {r.status_code} {r.text[:200]}")

    # D.7 GET /admin/settlements/{id} as dealer → 403
    r = requests.get(f"{BASE}/admin/settlements/{sid}", headers=H(dealer_a_tok), timeout=20)
    if r.status_code == 403:
        ok("D.7 GET /admin/settlements/{id} as dealer → 403")
    else:
        bad("D.7 GET /admin/settlements/{id} as dealer", f"got {r.status_code} {r.text[:200]}")

    # D.8 Anonymous GET /admin/settlements/queue → 401 (sanity)
    r = requests.get(f"{BASE}/admin/settlements/queue", timeout=20)
    if r.status_code in (401, 403):
        ok("D.8 anon /admin/settlements/queue → 401/403")
    else:
        bad("D.8 anon /admin/settlements/queue → 401/403", f"got {r.status_code}")

    return sid  # pending settlement for audit/proof tests


def section_audit_trail(op_tok: str, dealer_a_tok: str, dealer_a_id: str, completed_sid: str):
    print("\n=== E. Audit trail invariants ===")
    # operator full audit
    r = requests.get(f"{BASE}/admin/settlements/{completed_sid}", headers=H(op_tok), timeout=20)
    if r.status_code != 200:
        bad("E.0 admin GET completed", f"{r.status_code} {r.text[:200]}")
        return
    j = r.json()
    audit = j.get("audit") or []
    if isinstance(audit, list) and len(audit) >= 10:
        ok(f"E.1 operator view returns 'audit' array ({len(audit)} rows)")
    else:
        bad("E.1 operator view returns 'audit' array", f"audit={audit!r}")
    needed = {"actor_id", "action", "from_state", "to_state", "ts", "meta"}
    if all(needed.issubset(a.keys()) for a in audit):
        ok("E.2 every audit row has actor_id/action/from_state/to_state/ts/meta")
    else:
        missing = [a for a in audit if not needed.issubset(a.keys())]
        bad("E.2 every audit row keys", f"first-missing={missing[:1]}")

    # dealer view
    r = requests.get(f"{BASE}/settlements/{completed_sid}", headers=H(dealer_a_tok), timeout=20)
    if r.status_code != 200:
        bad("E.3 dealer GET completed", f"{r.status_code} {r.text[:200]}")
        return
    j = r.json()
    pub = j.get("audit_public") or []
    if isinstance(pub, list) and len(pub) >= 10:
        ok(f"E.4 dealer view returns 'audit_public' ({len(pub)} rows)")
    else:
        bad("E.4 dealer view returns 'audit_public'", f"got {pub!r}")
    public_keys = {"id", "ts", "action", "from_state", "to_state"}
    leak_keys = {"meta", "actor_id"}
    if all(set(p.keys()) == public_keys for p in pub):
        ok("E.5 audit_public hides operator metadata (no actor_id, no meta)")
    else:
        sample = pub[0] if pub else None
        bad("E.5 audit_public hides operator metadata", f"sample keys={sorted((sample or {}).keys())}")


def section_summary(op_tok: str):
    print("\n=== F. Summary endpoint ===")
    r = requests.get(f"{BASE}/admin/settlements/summary", headers=H(op_tok), timeout=20)
    if r.status_code != 200:
        bad("F.0 GET summary", f"{r.status_code} {r.text[:200]}")
        return
    j = r.json()
    if {"by_state", "buckets", "total_open"}.issubset(j.keys()):
        ok("F.1 summary has by_state, buckets, total_open")
    else:
        bad("F.1 summary keys", f"got {sorted(j.keys())}")
    needed = {"deposit_pending", "deposit_submitted", "visit_scheduled", "inspection_completed",
              "payment_pending", "refund_pending", "delayed", "completed"}
    if needed.issubset(j.get("buckets", {}).keys()):
        ok("F.2 buckets has the 8 required keys")
    else:
        miss = needed - set(j.get("buckets", {}).keys())
        bad("F.2 buckets has the 8 required keys", f"missing={miss}")
    if isinstance(j.get("total_open"), int) and j["total_open"] >= 0:
        ok(f"F.3 total_open is non-neg int (={j['total_open']})")
    else:
        bad("F.3 total_open non-neg int", f"got {j.get('total_open')!r}")


def section_idempotency(dealer_a_id: str):
    print("\n=== G. Idempotency: create_for_auction_win twice ===")
    aid = str(uuid.uuid4())
    n = asyncio.run(double_create(dealer_a_id, 600_000.0, aid))
    if n == 1:
        ok("G.1 create_for_auction_win is idempotent (1 settlement for the auction)")
    else:
        bad("G.1 idempotency", f"settlements for auction_id={aid}: {n}")


def section_proof_endpoints(op_tok: str, dealer_a_tok: str, pending_sid: str):
    """The 'pending_sid' is in deposit_requested state from D.5-prep — let's
    upload a real proof, fetch it via dealer + operator endpoints."""
    print("\n=== H. Proof endpoints ===")
    proof_b64 = base64.b64encode(b"hello-deposit-proof").decode()
    r = requests.post(f"{BASE}/settlements/{pending_sid}/mark-payment-sent",
                      headers=H(dealer_a_tok),
                      json={"kind": "image", "filename": "proof.png",
                            "mime_type": "image/png", "content_base64": proof_b64,
                            "note": "screenshot"}, timeout=30)
    if r.status_code == 200 and r.json().get("state") == "deposit_under_verification":
        ok("H.1 dealer mark-payment-sent")
    else:
        bad("H.1 dealer mark-payment-sent", f"{r.status_code} {r.text[:200]}")
        return
    # dealer fetches own proof
    r = requests.get(f"{BASE}/settlements/{pending_sid}/proof", headers=H(dealer_a_tok), timeout=20)
    if r.status_code == 200 and r.json().get("content_base64") == proof_b64:
        ok("H.2 dealer GET /settlements/{id}/proof returns content")
    else:
        bad("H.2 dealer GET /settlements/{id}/proof", f"{r.status_code} {r.text[:200]}")
    # operator fetches proof
    r = requests.get(f"{BASE}/admin/settlements/{pending_sid}/proof", headers=H(op_tok), timeout=20)
    if r.status_code == 200 and r.json().get("content_base64") == proof_b64:
        ok("H.3 operator GET /admin/settlements/{id}/proof returns content")
    else:
        bad("H.3 operator GET /admin/settlements/{id}/proof", f"{r.status_code} {r.text[:200]}")


# ------------------------------------------------------------
# main
# ------------------------------------------------------------
def main():
    print(f"Backend: {BASE}")
    op_tok, op_user = operator_login(OPERATOR_PHONE)
    print(f"  operator id={op_user['id']} role={op_user.get('role')}")
    if op_user.get("role") not in ("super_admin", "admin", "operations_admin"):
        bad("operator role", f"{op_user.get('role')}")
        return

    dealer_a_tok, dealer_a = dealer_login(DEALER_A_PHONE)
    print(f"  dealer_A id={dealer_a['id']} role={dealer_a.get('role')}")
    dealer_b_tok, dealer_b = dealer_login(DEALER_B_PHONE)
    print(f"  dealer_B id={dealer_b['id']} role={dealer_b.get('role')}")

    section_catalog()

    completed_sid = section_e2e_full_payment(op_tok, dealer_a_tok, dealer_a["id"])
    refund_sid = section_e2e_refund(op_tok, dealer_a_tok, dealer_a["id"])

    pending_sid = section_negative(op_tok, dealer_a_tok, dealer_a["id"], dealer_b_tok, completed_sid)

    if completed_sid:
        section_audit_trail(op_tok, dealer_a_tok, dealer_a["id"], completed_sid)
    section_summary(op_tok)
    section_idempotency(dealer_a["id"])
    section_proof_endpoints(op_tok, dealer_a_tok, pending_sid)

    print("\n=== TOTAL ===")
    print(f"  PASS: {len(PASS)}")
    print(f"  FAIL: {len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for n, d in FAIL:
            print(f"  - {n}: {d[:300]}")


if __name__ == "__main__":
    main()
