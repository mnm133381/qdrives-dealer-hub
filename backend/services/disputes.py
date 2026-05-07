"""
Dispute System — operator-grade marketplace control layer.

State machine
-------------
    raised
      │  evidence_uploaded / message_added (any time, no transition)
      ▼
    under_review                ◄───────┐
      │  request_evidence              │
      ▼                                │
    evidence_pending                   │  reopen_for_review
      │  evidence_received             │
      ▼                                │
    operator_decision (decided)        │
      │  resolve                       │
      ▼                                │
    resolved (terminal: decided_for / decided_against / withdrawn)
      ▲                                │
      └────────  (escalated side-state at any non-terminal step) ─┘

Operator-only decision authority — dealers cannot self-resolve. Withdrawal
is the ONLY dealer-driven terminal transition and only from the raiser
when the dispute is still in `raised` state.

Storage
-------
  disputes                immutable record + current state + SLA fields
  dispute_evidence        attachment metadata (file content base64 inline)
  dispute_messages        timestamped chat trail (raiser ↔ counterparty ↔ operator)
  dispute_audit           every state transition + actor, append-only

SLA model
---------
Each dispute carries `sla_ack_hours` and `sla_resolve_hours` derived from
the dispute_type at creation. Aging is computed on read:
    sla_ack_breached      = (now - raised_at).hours > sla_ack_hours and not under_review
    sla_resolve_breached  = (now - raised_at).hours > sla_resolve_hours and not terminal
    aging_severity        = "ok" | "warning" | "breach" | "critical"

Reputation hooks
----------------
On `resolved` with decision_for=raiser → record `dispute_lost` against
opposite party and `dispute_won` for raiser. If operator marks the
dispute as frivolous, raiser also gets `dispute_raised_frivolous`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------
# Type & state catalog
# ---------------------------------------------------------------------

DISPUTE_TYPES: Dict[str, Dict[str, Any]] = {
    "payment_delay": {
        "label": "Payment Delay",
        "description": "Counterparty has not paid within the settlement window.",
        "sla_ack_hours": 24,  "sla_resolve_hours": 72,
        "priority_base": 60, "category": "settlement",
    },
    "vehicle_mismatch": {
        "label": "Vehicle Mismatch",
        "description": "Vehicle delivered does not match the auction listing or inspection.",
        "sla_ack_hours": 48,  "sla_resolve_hours": 7 * 24,
        "priority_base": 50, "category": "delivery",
    },
    "hidden_damage": {
        "label": "Hidden Damage",
        "description": "Damage discovered post-delivery that was not disclosed.",
        "sla_ack_hours": 48,  "sla_resolve_hours": 7 * 24,
        "priority_base": 55, "category": "delivery",
    },
    "title_legal_issue": {
        "label": "Title / Legal Issue",
        "description": "RC / title transfer, encumbrance, or legal complication.",
        "sla_ack_hours": 24,  "sla_resolve_hours": 14 * 24,
        "priority_base": 75, "category": "compliance",
    },
    "fake_bidding": {
        "label": "Fake / Shill Bidding",
        "description": "Suspected fake bidding, shilling, or collusion to inflate price.",
        "sla_ack_hours":  6,  "sla_resolve_hours": 24,
        "priority_base": 90, "category": "conduct",
    },
    "settlement_failure": {
        "label": "Settlement Failure",
        "description": "Settlement could not be completed for reasons other than payment.",
        "sla_ack_hours": 24,  "sla_resolve_hours": 72,
        "priority_base": 65, "category": "settlement",
    },
    "abusive_conduct": {
        "label": "Abusive Conduct",
        "description": "Abusive language, harassment, or intimidation.",
        "sla_ack_hours": 12,  "sla_resolve_hours": 48,
        "priority_base": 70, "category": "conduct",
    },
    "reserve_manipulation": {
        "label": "Reserve Manipulation",
        "description": "Suspected manipulation of reserve price by seller.",
        "sla_ack_hours":  6,  "sla_resolve_hours": 24,
        "priority_base": 85, "category": "conduct",
    },
}

DISPUTE_STATES = (
    "raised",
    "under_review",
    "evidence_pending",
    "decided",          # operator decided, awaiting effects
    "resolved",         # terminal
    "withdrawn",        # terminal — raiser pulled
    "escalated",        # side-state; combined with one of the above
)

TERMINAL_STATES = {"resolved", "withdrawn"}

DECISION_OUTCOMES = {
    "decided_for_raiser",       # in favour of who raised it
    "decided_against_raiser",   # against the raiser
    "decided_inconclusive",     # no clear party at fault
    "frivolous",                # raiser penalty
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------

async def raise_dispute(
    db,
    *,
    raiser_dealer_id: str,
    against_dealer_id: Optional[str],
    auction_id: Optional[str],
    dispute_type: str,
    title: str,
    description: str,
    initial_evidence: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if dispute_type not in DISPUTE_TYPES:
        raise ValueError(f"Unknown dispute_type: {dispute_type}")

    defn = DISPUTE_TYPES[dispute_type]
    now = now_utc()
    dispute = {
        "id": str(uuid.uuid4()),
        "raiser_dealer_id": raiser_dealer_id,
        "against_dealer_id": against_dealer_id,
        "auction_id": auction_id,
        "dispute_type": dispute_type,
        "title": title.strip()[:200],
        "description": description.strip()[:5000],
        "state": "raised",
        "is_escalated": False,
        "raised_at": now,
        "updated_at": now,
        "decided_at": None,
        "resolved_at": None,
        "decision_outcome": None,
        "decision_reason": None,
        "decision_actor_id": None,
        "sla_ack_hours": defn["sla_ack_hours"],
        "sla_resolve_hours": defn["sla_resolve_hours"],
        "priority_base": defn["priority_base"],
        "category": defn["category"],
        # Counters maintained for cheap queue rendering
        "evidence_count": 0,
        "message_count": 0,
    }
    await db.disputes.insert_one(dispute)

    if initial_evidence:
        for ev in initial_evidence:
            await add_evidence(
                db, dispute_id=dispute["id"], actor_id=raiser_dealer_id,
                kind=ev.get("kind", "note"), filename=ev.get("filename"),
                content_base64=ev.get("content_base64"), note=ev.get("note"),
            )

    await _audit(
        db, dispute_id=dispute["id"], actor_id=raiser_dealer_id,
        action="raise", from_state=None, to_state="raised",
        meta={"type": dispute_type, "auction_id": auction_id},
    )
    return _enrich_for_read(dispute)


# ---------------------------------------------------------------------
# Evidence + chat
# ---------------------------------------------------------------------

async def add_evidence(
    db,
    *,
    dispute_id: str,
    actor_id: str,
    kind: str,            # "image" | "document" | "note"
    filename: Optional[str] = None,
    content_base64: Optional[str] = None,
    note: Optional[str] = None,
    mime_type: Optional[str] = None,
) -> Dict[str, Any]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d["state"] in TERMINAL_STATES:
        raise ValueError("dispute is terminal — cannot add evidence")

    doc = {
        "id": str(uuid.uuid4()),
        "dispute_id": dispute_id,
        "actor_id": actor_id,
        "kind": kind,
        "filename": filename,
        "mime_type": mime_type,
        "content_base64": content_base64,   # may be None for kind="note"
        "note": note,
        "ts": now_utc(),
    }
    # Keep payloads bounded — refuse > ~6MB to avoid runaway docs
    if content_base64 and len(content_base64) > 8_000_000:
        raise ValueError("evidence file too large (>6MB)")

    await db.dispute_evidence.insert_one(doc)
    doc.pop("_id", None)
    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {"updated_at": now_utc()},
         "$inc": {"evidence_count": 1}},
    )
    # If still in `raised`, auto-advance the SLA clock side flag
    await _audit(
        db, dispute_id=dispute_id, actor_id=actor_id,
        action="add_evidence", from_state=d["state"], to_state=d["state"],
        meta={"evidence_id": doc["id"], "kind": kind, "filename": filename},
    )
    return {**doc, "ts": doc["ts"].isoformat(), "content_base64": None}


async def add_message(
    db,
    *,
    dispute_id: str,
    actor_id: str,
    actor_role: str,            # "raiser" | "counterparty" | "operator"
    body: str,
) -> Dict[str, Any]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d["state"] in TERMINAL_STATES:
        raise ValueError("dispute is terminal — chat is closed")

    doc = {
        "id": str(uuid.uuid4()),
        "dispute_id": dispute_id,
        "actor_id": actor_id,
        "actor_role": actor_role,
        "body": body.strip()[:4000],
        "ts": now_utc(),
    }
    await db.dispute_messages.insert_one(doc)
    doc.pop("_id", None)
    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {"updated_at": now_utc()},
         "$inc": {"message_count": 1}},
    )
    return {**doc, "ts": doc["ts"].isoformat()}


# ---------------------------------------------------------------------
# State transitions (operator)
# ---------------------------------------------------------------------

async def operator_take_review(
    db, *, dispute_id: str, actor_id: str, note: Optional[str] = None,
) -> Dict[str, Any]:
    return await _transition(
        db, dispute_id=dispute_id, actor_id=actor_id,
        from_states={"raised", "evidence_pending"}, to_state="under_review",
        action="take_review", reason=note,
    )


async def operator_request_evidence(
    db, *, dispute_id: str, actor_id: str, request: str,
) -> Dict[str, Any]:
    res = await _transition(
        db, dispute_id=dispute_id, actor_id=actor_id,
        from_states={"under_review", "raised"}, to_state="evidence_pending",
        action="request_evidence", reason=request,
    )
    await add_message(
        db, dispute_id=dispute_id, actor_id=actor_id,
        actor_role="operator", body=f"[Evidence requested] {request}",
    )
    return res


async def operator_escalate(
    db, *, dispute_id: str, actor_id: str, reason: str,
) -> Dict[str, Any]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d["state"] in TERMINAL_STATES:
        raise ValueError("dispute is terminal — cannot escalate")

    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {"is_escalated": True, "escalated_at": now_utc(),
                  "escalated_by": actor_id, "updated_at": now_utc()}},
    )
    await _audit(
        db, dispute_id=dispute_id, actor_id=actor_id,
        action="escalate", from_state=d["state"], to_state=d["state"],
        meta={"reason": reason},
    )
    fresh = await db.disputes.find_one({"id": dispute_id})
    return _enrich_for_read(fresh)


async def operator_decide(
    db,
    *,
    dispute_id: str,
    actor_id: str,
    outcome: str,                       # one of DECISION_OUTCOMES
    reason: str,
    reputation_impact: Optional[Dict[str, int]] = None,   # {dealer_id: delta}
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if outcome not in DECISION_OUTCOMES:
        raise ValueError(f"unknown decision outcome: {outcome}")

    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d["state"] in TERMINAL_STATES:
        raise ValueError("dispute is already terminal")

    now = now_utc()
    update = {
        "state": "resolved",
        "decision_outcome": outcome,
        "decision_reason": reason.strip()[:2000],
        "decision_actor_id": actor_id,
        "decided_at": now,
        "resolved_at": now,
        "updated_at": now,
    }
    await db.disputes.update_one({"id": dispute_id}, {"$set": update})
    await _audit(
        db, dispute_id=dispute_id, actor_id=actor_id,
        action="decide", from_state=d["state"], to_state="resolved",
        meta={"outcome": outcome, "reason": reason,
              "reputation_impact": reputation_impact or {}},
    )

    # Compute reputation effect descriptor (callers apply the actual signals
    # via services.reputation.on_dispute_resolved to keep coupling minimal)
    raiser = d.get("raiser_dealer_id")
    against = d.get("against_dealer_id")
    rep_effect: Dict[str, Any] = {
        "outcome": outcome,
        "raiser_dealer_id": raiser,
        "against_dealer_id": against,
        "frivolous_raiser_id": None,
        "loser_dealer_id": None,
        "winner_dealer_id": None,
    }
    if outcome == "decided_for_raiser":
        rep_effect["loser_dealer_id"] = against
        rep_effect["winner_dealer_id"] = raiser
    elif outcome == "decided_against_raiser":
        rep_effect["loser_dealer_id"] = raiser
        rep_effect["winner_dealer_id"] = against
    elif outcome == "frivolous":
        rep_effect["frivolous_raiser_id"] = raiser

    fresh = await db.disputes.find_one({"id": dispute_id})
    return _enrich_for_read(fresh), rep_effect


async def raiser_withdraw(
    db, *, dispute_id: str, actor_id: str, reason: Optional[str] = None,
) -> Dict[str, Any]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d.get("raiser_dealer_id") != actor_id:
        raise PermissionError("only the raiser can withdraw")
    if d["state"] != "raised":
        raise ValueError("can only withdraw while in raised state")

    now = now_utc()
    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {
            "state": "withdrawn",
            "resolved_at": now,
            "decision_outcome": "withdrawn",
            "decision_reason": reason or "withdrawn by raiser",
            "decision_actor_id": actor_id,
            "updated_at": now,
        }},
    )
    await _audit(
        db, dispute_id=dispute_id, actor_id=actor_id,
        action="withdraw", from_state="raised", to_state="withdrawn",
        meta={"reason": reason},
    )
    fresh = await db.disputes.find_one({"id": dispute_id})
    return _enrich_for_read(fresh)


# ---------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------

def _aging(dispute: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or now_utc()
    raised_at = dispute["raised_at"]
    if isinstance(raised_at, datetime) and raised_at.tzinfo is None:
        raised_at = raised_at.replace(tzinfo=timezone.utc)
    elapsed_hours = (now - raised_at).total_seconds() / 3600
    sla_ack = dispute.get("sla_ack_hours", 24)
    sla_res = dispute.get("sla_resolve_hours", 72)

    state = dispute["state"]
    is_terminal = state in TERMINAL_STATES

    ack_breached = (state == "raised") and (elapsed_hours > sla_ack)
    resolve_breached = (not is_terminal) and (elapsed_hours > sla_res)
    resolve_warning = (not is_terminal) and (elapsed_hours > sla_res * 0.7)

    if is_terminal:
        severity = "closed"
    elif resolve_breached or dispute.get("is_escalated"):
        severity = "critical"
    elif ack_breached or resolve_warning:
        severity = "breach"
    elif elapsed_hours > sla_ack * 0.5:
        severity = "warning"
    else:
        severity = "ok"

    return {
        "elapsed_hours": round(elapsed_hours, 1),
        "ack_breached": ack_breached,
        "resolve_breached": resolve_breached,
        "severity": severity,
    }


def _priority_score(dispute: Dict[str, Any], aging: Dict[str, Any]) -> int:
    """Higher = more urgent. Used to sort the operator queue."""
    p = dispute.get("priority_base", 50)
    if dispute.get("is_escalated"):
        p += 30
    if aging["resolve_breached"]:
        p += 25
    if aging["ack_breached"]:
        p += 15
    if aging["severity"] == "warning":
        p += 5
    return p


def _enrich_for_read(d: Dict[str, Any]) -> Dict[str, Any]:
    if not d:
        return d
    out = {k: v for k, v in d.items() if k != "_id"}
    aging = _aging(d)
    out["aging"] = aging
    out["priority_score"] = _priority_score(d, aging)
    out["is_terminal"] = d["state"] in TERMINAL_STATES
    # ISO-stringify
    for k in ("raised_at", "updated_at", "decided_at", "resolved_at", "escalated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    type_def = DISPUTE_TYPES.get(d.get("dispute_type"), {})
    out["type_label"] = type_def.get("label", d.get("dispute_type"))
    return out


async def get_dispute(db, dispute_id: str) -> Optional[Dict[str, Any]]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        return None
    return _enrich_for_read(d)


async def get_dispute_evidence(db, dispute_id: str, include_content: bool = False) -> List[Dict[str, Any]]:
    cursor = db.dispute_evidence.find({"dispute_id": dispute_id}).sort("ts", 1)
    out: List[Dict[str, Any]] = []
    async for e in cursor:
        item = {k: v for k, v in e.items() if k != "_id"}
        if not include_content:
            item.pop("content_base64", None)
        if isinstance(item.get("ts"), datetime):
            item["ts"] = item["ts"].isoformat()
        out.append(item)
    return out


async def get_dispute_messages(db, dispute_id: str) -> List[Dict[str, Any]]:
    cursor = db.dispute_messages.find({"dispute_id": dispute_id}).sort("ts", 1)
    out: List[Dict[str, Any]] = []
    async for m in cursor:
        item = {k: v for k, v in m.items() if k != "_id"}
        if isinstance(item.get("ts"), datetime):
            item["ts"] = item["ts"].isoformat()
        out.append(item)
    return out


async def get_dispute_audit(db, dispute_id: str) -> List[Dict[str, Any]]:
    cursor = db.dispute_audit.find({"dispute_id": dispute_id}).sort("ts", 1)
    out: List[Dict[str, Any]] = []
    async for a in cursor:
        item = {k: v for k, v in a.items() if k != "_id"}
        if isinstance(item.get("ts"), datetime):
            item["ts"] = item["ts"].isoformat()
        out.append(item)
    return out


async def list_disputes_for_dealer(db, dealer_id: str) -> List[Dict[str, Any]]:
    cursor = db.disputes.find({
        "$or": [
            {"raiser_dealer_id": dealer_id},
            {"against_dealer_id": dealer_id},
        ]
    }).sort("updated_at", -1)
    out: List[Dict[str, Any]] = []
    async for d in cursor:
        out.append(_enrich_for_read(d))
    return out


async def operator_queue(
    db,
    *,
    state: Optional[str] = None,
    dispute_type: Optional[str] = None,
    only_open: bool = True,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    q: Dict[str, Any] = {}
    if only_open:
        q["state"] = {"$nin": list(TERMINAL_STATES)}
    if state:
        q["state"] = state
    if dispute_type:
        q["dispute_type"] = dispute_type

    cursor = db.disputes.find(q).limit(limit)
    docs: List[Dict[str, Any]] = []
    async for d in cursor:
        docs.append(_enrich_for_read(d))
    docs.sort(key=lambda x: x["priority_score"], reverse=True)
    return docs


async def operator_queue_summary(db) -> Dict[str, Any]:
    cursor = db.disputes.find({"state": {"$nin": list(TERMINAL_STATES)}})
    total = 0
    breached = 0
    escalated = 0
    by_type: Dict[str, int] = {}
    async for d in cursor:
        total += 1
        if d.get("is_escalated"):
            escalated += 1
        a = _aging(d)
        if a["severity"] in ("breach", "critical"):
            breached += 1
        by_type[d.get("dispute_type", "other")] = by_type.get(d.get("dispute_type", "other"), 0) + 1

    return {
        "open_total": total,
        "sla_breached": breached,
        "escalated": escalated,
        "by_type": by_type,
    }


# ---------------------------------------------------------------------
# Internal: audit helper
# ---------------------------------------------------------------------

async def _transition(
    db,
    *,
    dispute_id: str,
    actor_id: str,
    from_states: set,
    to_state: str,
    action: str,
    reason: Optional[str],
) -> Dict[str, Any]:
    d = await db.disputes.find_one({"id": dispute_id})
    if not d:
        raise ValueError("dispute not found")
    if d["state"] not in from_states:
        raise ValueError(f"cannot {action} from state '{d['state']}'")

    now = now_utc()
    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {"state": to_state, "updated_at": now}},
    )
    await _audit(
        db, dispute_id=dispute_id, actor_id=actor_id,
        action=action, from_state=d["state"], to_state=to_state,
        meta={"reason": reason},
    )
    fresh = await db.disputes.find_one({"id": dispute_id})
    return _enrich_for_read(fresh)


async def _audit(
    db,
    *,
    dispute_id: str,
    actor_id: str,
    action: str,
    from_state: Optional[str],
    to_state: str,
    meta: Optional[Dict[str, Any]] = None,
) -> None:
    await db.dispute_audit.insert_one({
        "id": str(uuid.uuid4()),
        "dispute_id": dispute_id,
        "actor_id": actor_id,
        "action": action,
        "from_state": from_state,
        "to_state": to_state,
        "meta": meta or {},
        "ts": now_utc(),
    })
