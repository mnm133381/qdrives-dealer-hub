"""
Q Drives Settlement & Deal Completion engine.

Q Drives is the only seller. Dealers are buyers. All vehicles are at the
Q Drives office. Operators MANUALLY control every stage. Nothing
auto-progresses past `awaiting_operator_review`. WhatsApp + manual
verification are intentional. The platform tracks; humans decide.

State machine (terminal states marked *):
  auction_won
    └─► awaiting_operator_review
          └─► deposit_requested
                └─► deposit_under_verification
                      ├─► deposit_verified
                      │     └─► visit_scheduled
                      │           └─► inspection_completed
                      │                 ├─► refund_approved
                      │                 │     └─► refund_completed *
                      │                 └─► full_payment_requested
                      │                       └─► full_payment_received
                      │                             └─► vehicle_delivered
                      │                                   └─► completed *
                      └─► deposit_requested  (proof rejected)

  Side / annotation states (settable from any non-terminal state):
    no_show_review, settlement_delayed, dispute

Storage:
  settlements        main records (current state + denorm fields)
  settlement_audit   append-only state transition + note + message log

Audit invariant: EVERY mutation appends a row to settlement_audit.
No silent transitions. No hard deletes anywhere.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------
# State catalog
# ---------------------------------------------------------------------

STATES = (
    "auction_won",
    "awaiting_operator_review",
    "deposit_requested",
    "deposit_under_verification",
    "deposit_verified",
    "visit_scheduled",
    "inspection_completed",
    "refund_approved",
    "refund_completed",
    "full_payment_requested",
    "full_payment_received",
    "vehicle_delivered",
    "completed",
    "no_show_review",
    "settlement_delayed",
    "dispute",
)

TERMINAL_STATES = {"completed", "refund_completed"}

# Side annotations — these states can be ENTERED from any non-terminal,
# but they are non-terminal themselves; the operator must move them
# back into the main flow OR into a true terminal.
ANNOTATION_STATES = {"no_show_review", "settlement_delayed", "dispute"}

# Allowed source states per transition action — the only place new
# transitions get added. Anything not declared here is rejected.
TRANSITIONS: Dict[str, Dict[str, Any]] = {
    "request_deposit": {
        "from": {"awaiting_operator_review", "settlement_delayed", "no_show_review"},
        "to": "deposit_requested",
        "operator_only": True,
    },
    "mark_payment_sent": {
        "from": {"deposit_requested"},
        "to": "deposit_under_verification",
        "operator_only": False,        # dealer triggers this
    },
    "reject_proof": {
        "from": {"deposit_under_verification"},
        "to": "deposit_requested",
        "operator_only": True,
    },
    "verify_deposit": {
        "from": {"deposit_under_verification"},
        "to": "deposit_verified",
        "operator_only": True,
    },
    "schedule_visit": {
        "from": {"deposit_verified", "settlement_delayed"},
        "to": "visit_scheduled",
        "operator_only": True,
    },
    "mark_inspection_done": {
        "from": {"visit_scheduled"},
        "to": "inspection_completed",
        "operator_only": True,
    },
    "approve_refund": {
        "from": {"inspection_completed"},
        "to": "refund_approved",
        "operator_only": True,
    },
    "mark_refund_completed": {
        "from": {"refund_approved"},
        "to": "refund_completed",
        "operator_only": True,
    },
    "request_full_payment": {
        "from": {"inspection_completed"},
        "to": "full_payment_requested",
        "operator_only": True,
    },
    "mark_full_payment_received": {
        "from": {"full_payment_requested"},
        "to": "full_payment_received",
        "operator_only": True,
    },
    "mark_vehicle_delivered": {
        "from": {"full_payment_received"},
        "to": "vehicle_delivered",
        "operator_only": True,
    },
    "complete_deal": {
        "from": {"vehicle_delivered"},
        "to": "completed",
        "operator_only": True,
    },
    # Annotation transitions — settable from any non-terminal main-flow state
    "flag_no_show": {
        "from": set(STATES) - TERMINAL_STATES - {"no_show_review"},
        "to": "no_show_review",
        "operator_only": True,
    },
    "mark_delayed": {
        "from": set(STATES) - TERMINAL_STATES - {"settlement_delayed", "dispute"},
        "to": "settlement_delayed",
        "operator_only": True,
    },
    "mark_dispute": {
        "from": set(STATES) - TERMINAL_STATES - {"dispute"},
        "to": "dispute",
        "operator_only": True,
    },
    # Recovery: from settlement_delayed / no_show_review back to a
    # working state. Op picks where to resume.
    "resume_to_review": {
        "from": {"settlement_delayed", "no_show_review", "dispute"},
        "to": "awaiting_operator_review",
        "operator_only": True,
    },
}

DEALER_ALLOWED_ACTIONS = {"mark_payment_sent"}


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def calc_deposit(winning_amount: float) -> int:
    """5% of winning bid, rounded to nearest rupee."""
    return int(round(winning_amount * 0.05))


def _strip_internal(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Hide operator-only fields from dealer-facing responses."""
    if not doc:
        return doc
    out = {k: v for k, v in doc.items() if k != "_id"}
    out.pop("internal_notes", None)
    out.pop("operator_alerts", None)
    return out


def _isoify(d: Dict[str, Any]) -> Dict[str, Any]:
    """ISO-stringify all datetime fields recursively (one level deep
    for lists). Keep mutation-shaped doc otherwise intact."""
    out: Dict[str, Any] = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, list):
            out[k] = [_isoify(x) if isinstance(x, dict) else x for x in v]
        elif isinstance(v, dict):
            out[k] = _isoify(v)
        else:
            out[k] = v
    return out


# ---------------------------------------------------------------------
# Settlement creation hook (called from auction-end logic)
# ---------------------------------------------------------------------

async def create_for_auction_win(
    db,
    *,
    auction: Dict[str, Any],
    winner_dealer_id: str,
    winning_amount: float,
) -> Optional[Dict[str, Any]]:
    """Idempotent: if a settlement already exists for this auction, return
    it. Otherwise create one in `auction_won` and immediately transition
    to `awaiting_operator_review` (the operator queue entry point)."""
    existing = await db.settlements.find_one({"auction_id": auction["id"]})
    if existing:
        return _isoify(_strip_internal(existing))

    now = now_utc()
    deposit_amount = calc_deposit(winning_amount)

    car = auction.get("car") or {}
    snap = {
        "car_make": car.get("make"),
        "car_model": car.get("model"),
        "car_variant": car.get("variant"),
        "car_year": car.get("year"),
        "car_reg": car.get("registration_number") or car.get("reg_number"),
        "car_kms": car.get("kms_driven") or car.get("kms"),
        "car_image": (car.get("images") or [None])[0],
    }

    settlement = {
        "id": str(uuid.uuid4()),
        "auction_id": auction["id"],
        "dealer_id": winner_dealer_id,
        "state": "auction_won",
        "prior_state": None,
        "winning_amount": float(winning_amount),
        "deposit_amount": deposit_amount,
        "deposit_deadline_at": None,
        "deposit_proof": None,                  # set when dealer marks payment sent
        "deposit_verified_at": None,
        "deposit_verified_by": None,
        "visit_scheduled_at": None,
        "visit_window_start": None,
        "visit_window_end": None,
        "visit_address": None,
        "visit_instructions_for_dealer": None,
        "inspection_completed_at": None,
        "inspection_completed_by": None,
        "decision_branch": None,                # 'refund' | 'full_payment'
        "full_payment_amount": None,
        "full_payment_received_at": None,
        "full_payment_method": None,
        "full_payment_ref": None,
        "vehicle_delivered_at": None,
        "refund_amount": None,
        "refund_completed_at": None,
        "refund_method": None,
        "refund_ref": None,
        "no_show_flagged_at": None,
        "delayed_flagged_at": None,
        "dispute_id": None,
        # Snapshot for fast UI rendering
        "snapshot": snap,
        "auction_ended_at": auction.get("ended_at") or auction.get("end_time") or now,
        "reserve_met": bool(auction.get("reserve_met") or auction.get("reserve_price") and (winning_amount >= (auction.get("reserve_price") or 0))),
        # Communication
        "internal_notes": [],                   # operator-only
        "dealer_messages": [],                  # operator → dealer
        # Lifecycle
        "created_at": now,
        "updated_at": now,
        "completed_at": None,
    }
    await db.settlements.insert_one(settlement)
    settlement.pop("_id", None)

    await _audit(
        db, settlement_id=settlement["id"], actor_id="system",
        action="create", from_state=None, to_state="auction_won",
        meta={"auction_id": auction["id"], "winning_amount": winning_amount},
    )
    # Auto-advance to awaiting_operator_review
    await db.settlements.update_one(
        {"id": settlement["id"]},
        {"$set": {"state": "awaiting_operator_review",
                  "prior_state": "auction_won", "updated_at": now_utc()}},
    )
    await _audit(
        db, settlement_id=settlement["id"], actor_id="system",
        action="auto_review_intake",
        from_state="auction_won", to_state="awaiting_operator_review",
        meta={},
    )
    fresh = await db.settlements.find_one({"id": settlement["id"]})
    return _isoify(_strip_internal(fresh))


# ---------------------------------------------------------------------
# Generic transition runner
# ---------------------------------------------------------------------

class TransitionError(Exception):
    pass


async def transition(
    db,
    *,
    settlement_id: str,
    action: str,
    actor_id: str,
    actor_is_operator: bool,
    payload: Optional[Dict[str, Any]] = None,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    if action not in TRANSITIONS:
        raise TransitionError(f"unknown action: {action}")
    spec = TRANSITIONS[action]
    if spec["operator_only"] and not actor_is_operator:
        raise TransitionError("operator authority required")
    if not actor_is_operator and action not in DEALER_ALLOWED_ACTIONS:
        raise TransitionError("dealer cannot perform this action")

    s = await db.settlements.find_one({"id": settlement_id})
    if not s:
        raise TransitionError("settlement not found")

    if s["state"] in TERMINAL_STATES:
        raise TransitionError(f"settlement is terminal ({s['state']})")
    if s["state"] not in spec["from"]:
        raise TransitionError(f"cannot {action} from state '{s['state']}'")
    if not actor_is_operator and s.get("dealer_id") != actor_id:
        raise TransitionError("only the winning dealer can act here")

    payload = payload or {}
    now = now_utc()
    set_fields: Dict[str, Any] = {
        "state": spec["to"],
        "prior_state": s["state"],
        "updated_at": now,
    }

    # Per-action side effects
    if action == "request_deposit":
        deadline_hours = int(payload.get("deadline_hours") or 48)
        set_fields["deposit_deadline_at"] = now + timedelta(hours=deadline_hours)
        if payload.get("instructions"):
            set_fields["deposit_instructions"] = str(payload["instructions"])[:2000]

    elif action == "mark_payment_sent":
        proof = {
            "kind": payload.get("kind", "note"),     # image | note | utr | document
            "filename": payload.get("filename"),
            "mime_type": payload.get("mime_type"),
            "content_base64": payload.get("content_base64"),
            "note": payload.get("note"),
            "uploaded_at": now,
            "uploaded_by": actor_id,
        }
        if proof.get("content_base64") and len(proof["content_base64"]) > 8_000_000:
            raise TransitionError("payment proof too large (>6MB)")
        set_fields["deposit_proof"] = proof

    elif action == "reject_proof":
        set_fields["deposit_proof"] = None  # cleared so dealer must re-upload

    elif action == "verify_deposit":
        set_fields["deposit_verified_at"] = now
        set_fields["deposit_verified_by"] = actor_id

    elif action == "schedule_visit":
        if payload.get("window_start"):
            set_fields["visit_window_start"] = _parse_dt(payload["window_start"])
        if payload.get("window_end"):
            set_fields["visit_window_end"] = _parse_dt(payload["window_end"])
        set_fields["visit_address"] = payload.get("address") or s.get("visit_address")
        set_fields["visit_instructions_for_dealer"] = payload.get("instructions")
        set_fields["visit_scheduled_at"] = now

    elif action == "mark_inspection_done":
        set_fields["inspection_completed_at"] = now
        set_fields["inspection_completed_by"] = actor_id

    elif action == "approve_refund":
        amount = float(payload.get("amount") or s.get("deposit_amount") or 0)
        set_fields["refund_amount"] = amount
        set_fields["decision_branch"] = "refund"

    elif action == "mark_refund_completed":
        set_fields["refund_completed_at"] = now
        set_fields["refund_method"] = payload.get("method")
        set_fields["refund_ref"] = payload.get("ref")
        set_fields["completed_at"] = now

    elif action == "request_full_payment":
        amount = float(payload.get("amount") or 0)
        if not amount:
            # Default: winning_amount - deposit_amount
            amount = max(0.0, float(s["winning_amount"]) - float(s.get("deposit_amount") or 0))
        set_fields["full_payment_amount"] = amount
        set_fields["decision_branch"] = "full_payment"
        if payload.get("instructions"):
            set_fields["full_payment_instructions"] = str(payload["instructions"])[:2000]

    elif action == "mark_full_payment_received":
        set_fields["full_payment_received_at"] = now
        set_fields["full_payment_method"] = payload.get("method")
        set_fields["full_payment_ref"] = payload.get("ref")

    elif action == "mark_vehicle_delivered":
        set_fields["vehicle_delivered_at"] = now

    elif action == "complete_deal":
        set_fields["completed_at"] = now

    elif action == "flag_no_show":
        set_fields["no_show_flagged_at"] = now

    elif action == "mark_delayed":
        set_fields["delayed_flagged_at"] = now

    elif action == "mark_dispute":
        set_fields["dispute_id"] = payload.get("dispute_id")

    elif action == "resume_to_review":
        pass  # state change only; reason captured in audit

    await db.settlements.update_one(
        {"id": settlement_id}, {"$set": set_fields}
    )
    await _audit(
        db, settlement_id=settlement_id, actor_id=actor_id,
        action=action, from_state=s["state"], to_state=spec["to"],
        meta={"reason": reason, "payload": _safe_payload_audit(payload)},
    )
    fresh = await db.settlements.find_one({"id": settlement_id})
    return _isoify(_strip_internal(fresh))


def _safe_payload_audit(p: Dict[str, Any]) -> Dict[str, Any]:
    """Strip large blobs from the audit payload (keep hashes / metadata only)."""
    if not p:
        return {}
    out = {k: v for k, v in p.items() if k not in ("content_base64",)}
    if p.get("content_base64"):
        out["content_b64_size"] = len(p["content_base64"])
    return out


def _parse_dt(s: Any) -> Optional[datetime]:
    if not s:
        return None
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


# ---------------------------------------------------------------------
# Notes & dealer-visible messages
# ---------------------------------------------------------------------

async def add_internal_note(
    db, *, settlement_id: str, actor_id: str, text: str,
) -> Dict[str, Any]:
    s = await db.settlements.find_one({"id": settlement_id})
    if not s:
        raise TransitionError("settlement not found")
    note = {
        "id": str(uuid.uuid4()),
        "text": text.strip()[:2000],
        "by": actor_id,
        "at": now_utc(),
    }
    await db.settlements.update_one(
        {"id": settlement_id},
        {"$push": {"internal_notes": note}, "$set": {"updated_at": now_utc()}},
    )
    await _audit(
        db, settlement_id=settlement_id, actor_id=actor_id,
        action="internal_note", from_state=s["state"], to_state=s["state"],
        meta={"note_id": note["id"]},
    )
    return _isoify(note)


async def add_dealer_message(
    db, *, settlement_id: str, actor_id: str, text: str,
) -> Dict[str, Any]:
    """Dealer-visible operator message (e.g. WhatsApp instructions copy,
    visit address details, etc.). Append-only."""
    s = await db.settlements.find_one({"id": settlement_id})
    if not s:
        raise TransitionError("settlement not found")
    msg = {
        "id": str(uuid.uuid4()),
        "text": text.strip()[:4000],
        "by": actor_id,
        "at": now_utc(),
    }
    await db.settlements.update_one(
        {"id": settlement_id},
        {"$push": {"dealer_messages": msg}, "$set": {"updated_at": now_utc()}},
    )
    await _audit(
        db, settlement_id=settlement_id, actor_id=actor_id,
        action="dealer_message", from_state=s["state"], to_state=s["state"],
        meta={"message_id": msg["id"]},
    )
    return _isoify(msg)


# ---------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------

async def get_dealer_view(db, settlement_id: str, dealer_id: str) -> Optional[Dict[str, Any]]:
    s = await db.settlements.find_one({"id": settlement_id, "dealer_id": dealer_id})
    if not s:
        return None
    audit = await _public_audit(db, settlement_id)
    out = _isoify(_strip_internal(s))
    out["audit_public"] = audit
    return out


async def get_operator_view(db, settlement_id: str) -> Optional[Dict[str, Any]]:
    s = await db.settlements.find_one({"id": settlement_id})
    if not s:
        return None
    audit = await _full_audit(db, settlement_id)
    out = _isoify({k: v for k, v in s.items() if k != "_id"})
    out["audit"] = audit
    return out


async def list_for_dealer(db, dealer_id: str) -> List[Dict[str, Any]]:
    cursor = db.settlements.find({"dealer_id": dealer_id}).sort("updated_at", -1)
    out: List[Dict[str, Any]] = []
    async for s in cursor:
        out.append(_isoify(_strip_internal(s)))
    return out


async def operator_queue(
    db, state: Optional[str] = None, limit: int = 200
) -> List[Dict[str, Any]]:
    q: Dict[str, Any] = {}
    if state:
        q["state"] = state
    cursor = db.settlements.find(q).sort("updated_at", -1).limit(limit)
    out: List[Dict[str, Any]] = []
    async for s in cursor:
        out.append(_isoify({k: v for k, v in s.items() if k != "_id" and k != "internal_notes"}))
    return out


async def operator_queue_summary(db) -> Dict[str, int]:
    """Per-state counters for the operator console rail."""
    counts: Dict[str, int] = {st: 0 for st in STATES}
    cursor = db.settlements.find({})
    async for s in cursor:
        st = s.get("state")
        if st in counts:
            counts[st] += 1
    return counts


# ---------------------------------------------------------------------
# Audit helpers
# ---------------------------------------------------------------------

async def _audit(
    db, *, settlement_id: str, actor_id: str, action: str,
    from_state: Optional[str], to_state: str, meta: Optional[Dict[str, Any]] = None,
) -> None:
    await db.settlement_audit.insert_one({
        "id": str(uuid.uuid4()),
        "settlement_id": settlement_id,
        "actor_id": actor_id,
        "action": action,
        "from_state": from_state,
        "to_state": to_state,
        "meta": meta or {},
        "ts": now_utc(),
    })


async def _full_audit(db, settlement_id: str) -> List[Dict[str, Any]]:
    cur = db.settlement_audit.find({"settlement_id": settlement_id}).sort("ts", 1)
    out = []
    async for a in cur:
        out.append(_isoify({k: v for k, v in a.items() if k != "_id"}))
    return out


async def _public_audit(db, settlement_id: str) -> List[Dict[str, Any]]:
    """Dealer-facing audit — same data minus operator metadata details."""
    cur = db.settlement_audit.find({"settlement_id": settlement_id}).sort("ts", 1)
    out = []
    async for a in cur:
        item = {
            "id": a["id"],
            "ts": a["ts"].isoformat() if isinstance(a.get("ts"), datetime) else a.get("ts"),
            "action": a.get("action"),
            "from_state": a.get("from_state"),
            "to_state": a.get("to_state"),
        }
        out.append(item)
    return out


async def get_dealer_proof_content(db, settlement_id: str, dealer_id: str) -> Optional[Dict[str, Any]]:
    s = await db.settlements.find_one({"id": settlement_id, "dealer_id": dealer_id})
    if not s or not s.get("deposit_proof"):
        return None
    p = s["deposit_proof"]
    return {
        "kind": p.get("kind"),
        "filename": p.get("filename"),
        "mime_type": p.get("mime_type"),
        "content_base64": p.get("content_base64"),
        "note": p.get("note"),
    }


async def get_operator_proof_content(db, settlement_id: str) -> Optional[Dict[str, Any]]:
    s = await db.settlements.find_one({"id": settlement_id})
    if not s or not s.get("deposit_proof"):
        return None
    p = s["deposit_proof"]
    return {
        "kind": p.get("kind"),
        "filename": p.get("filename"),
        "mime_type": p.get("mime_type"),
        "content_base64": p.get("content_base64"),
        "note": p.get("note"),
        "uploaded_at": p["uploaded_at"].isoformat() if isinstance(p.get("uploaded_at"), datetime) else p.get("uploaded_at"),
    }
