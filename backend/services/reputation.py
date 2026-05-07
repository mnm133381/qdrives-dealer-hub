"""
Dealer Reputation Engine — deterministic, fully explainable.

NO black-box AI. Every score is derived from observable signals with
clear weights, time-windows, and an audit trail. Operators can override
any score, but the override itself is recorded as a signal in the
ledger so the trail remains immutable.

Signals tracked
---------------
The full taxonomy is in SIGNAL_DEFINITIONS below. Each signal carries:
  - kind          : machine key (snake_case)
  - label         : human-readable name
  - weight        : points added per occurrence (negative = penalty)
  - window        : "30d" | "90d" | "lifetime" | "rolling"
  - cap           : maximum cumulative impact per dealer (clamps abuse)
  - description   : explainability copy shown to dealer + operator
  - category      : "settlement" | "conduct" | "compliance" | "activity"

Scoring math
------------
  base = 70
  score = clamp(base + sum(weight_i * count_i, capped per signal), 0, 100)

Tier mapping
------------
  85-100  Trusted     (green)
  70-84   Stable      (silver)
  50-69   Watch       (amber)
  25-49   Risky       (red)
   0-24   Restricted  (graphite-black; auto-suspend hook)

Storage
-------
  reputation_signals      append-only ledger (one doc per signal event)
  reputation_snapshots    cached point-in-time scores (for timeline)
  dealer_restrictions     active operator restrictions (cooldowns, shadows)
  operator_actions_audit  every operator override / restriction action

The ledger is the source of truth. Snapshots are advisory cache rebuilt
on demand from the ledger — never trust them for decisions.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------
# Signal definitions — single source of truth for the scoring engine.
# ---------------------------------------------------------------------

SIGNAL_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    # ── Settlement signals (positive: completed deals) ───────────────
    "settlement_completed": {
        "label": "Successful settlement",
        "weight": +3,
        "window": "lifetime",
        "cap": 60,
        "category": "settlement",
        "description": "A purchase was paid for and the vehicle released within SLA.",
    },
    "high_value_settlement": {
        "label": "High-value completion (≥₹10L)",
        "weight": +5,
        "window": "90d",
        "cap": 30,
        "category": "settlement",
        "description": "Successfully completed a transaction at ₹10L or higher.",
    },
    # ── Settlement signals (negative: failed deals) ──────────────────
    "payment_delayed": {
        "label": "Payment delay",
        "weight": -4,
        "window": "90d",
        "cap": -32,
        "category": "settlement",
        "description": "Did not pay within the 48-hour settlement window.",
    },
    "settlement_failed": {
        "label": "Settlement failure",
        "weight": -8,
        "window": "lifetime",
        "cap": -40,
        "category": "settlement",
        "description": "A won auction did not reach final settlement.",
    },
    "cancellation_after_win": {
        "label": "Cancellation after winning",
        "weight": -6,
        "window": "90d",
        "cap": -30,
        "category": "settlement",
        "description": "Backed out of a deal after winning the auction.",
    },
    # ── Dispute signals ──────────────────────────────────────────────
    "dispute_lost": {
        "label": "Dispute decided against",
        "weight": -10,
        "window": "lifetime",
        "cap": -50,
        "category": "conduct",
        "description": "Operator decided a dispute against this dealer.",
    },
    "dispute_won": {
        "label": "Dispute decided in favour",
        "weight": +2,
        "window": "lifetime",
        "cap": 20,
        "category": "conduct",
        "description": "Operator decided a dispute in this dealer's favour.",
    },
    "dispute_raised_frivolous": {
        "label": "Frivolous dispute raised",
        "weight": -3,
        "window": "90d",
        "cap": -15,
        "category": "conduct",
        "description": "Operator marked a dispute raised by this dealer as frivolous.",
    },
    # ── Conduct signals ──────────────────────────────────────────────
    "reserve_manipulation": {
        "label": "Reserve manipulation attempt",
        "weight": -15,
        "window": "lifetime",
        "cap": -45,
        "category": "conduct",
        "description": "Detected attempt to manipulate reserve pricing.",
    },
    "suspicious_bid_pattern": {
        "label": "Suspicious bidding pattern",
        "weight": -8,
        "window": "90d",
        "cap": -32,
        "category": "conduct",
        "description": "Bidding behaviour matched anti-collusion / shilling heuristic.",
    },
    "bid_spam": {
        "label": "Bid spam (>20 bids on a lot, no win)",
        "weight": -2,
        "window": "30d",
        "cap": -10,
        "category": "conduct",
        "description": "Repeated bid placement without conversion. Slows the market.",
    },
    "watchlist_abuse": {
        "label": "Watchlist abuse (>50 watches, 0 bids)",
        "weight": -3,
        "window": "30d",
        "cap": -9,
        "category": "conduct",
        "description": "Excessive watching with zero bidding intent.",
    },
    "abusive_conduct": {
        "label": "Abusive conduct flagged",
        "weight": -12,
        "window": "lifetime",
        "cap": -36,
        "category": "conduct",
        "description": "Operator flagged the dealer for abusive language or behaviour.",
    },
    # ── Compliance signals ───────────────────────────────────────────
    "operator_flag": {
        "label": "Operator flag",
        "weight": -20,
        "window": "lifetime",
        "cap": -60,
        "category": "compliance",
        "description": "Operator manually flagged this account for review.",
    },
    "forced_kyc_review": {
        "label": "Forced KYC re-verification",
        "weight": -10,
        "window": "lifetime",
        "cap": -20,
        "category": "compliance",
        "description": "Account flagged for KYC re-verification.",
    },
    "operator_score_adjustment": {
        "label": "Operator manual adjustment",
        "weight": 0,           # weight is dynamic — taken from signal.value
        "window": "lifetime",
        "cap": 999,            # uncapped — operator authority
        "category": "compliance",
        "description": "Operator manually adjusted this dealer's trust score.",
        "dynamic_weight": True,
    },
    # ── Activity signals ─────────────────────────────────────────────
    "inactive_60d": {
        "label": "Inactive for 60+ days",
        "weight": -5,
        "window": "rolling",
        "cap": -5,
        "category": "activity",
        "description": "No bidding, listing, or platform activity in 60+ days.",
    },
}

BASE_SCORE = 70

TIERS: List[Dict[str, Any]] = [
    {"key": "trusted",    "label": "Trusted",    "min": 85, "max": 100, "color": "#10B981"},
    {"key": "stable",     "label": "Stable",     "min": 70, "max":  84, "color": "#C0C0C8"},
    {"key": "watch",      "label": "Watch",      "min": 50, "max":  69, "color": "#F59E0B"},
    {"key": "risky",      "label": "Risky",      "min": 25, "max":  49, "color": "#DC2626"},
    {"key": "restricted", "label": "Restricted", "min":  0, "max":  24, "color": "#0B0B0D"},
]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def tier_for(score: int) -> Dict[str, Any]:
    for t in TIERS:
        if t["min"] <= score <= t["max"]:
            return t
    return TIERS[-1]


def window_start(window: str, ref: Optional[datetime] = None) -> Optional[datetime]:
    """Return the lower bound for a given window key (or None for lifetime)."""
    if window == "lifetime":
        return None
    ref = ref or now_utc()
    days = {"30d": 30, "90d": 90, "rolling": 60}.get(window, 0)
    return ref - timedelta(days=days)


# ---------------------------------------------------------------------
# Signal recording — append-only ledger
# ---------------------------------------------------------------------

async def record_signal(
    db,
    *,
    dealer_id: str,
    signal_kind: str,
    value: float = 1.0,
    source: str = "system",
    ref_id: Optional[str] = None,
    ref_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    note: Optional[str] = None,
    weight_override: Optional[float] = None,
) -> Dict[str, Any]:
    """Append a single signal event to the immutable ledger.

    `value` is the raw count (e.g. 1 settlement, 1 dispute) unless the
    signal definition is dynamic_weight, in which case `value` IS the
    point delta (positive or negative) supplied by the operator.

    Idempotency: callers passing `ref_id`+`ref_type` get protection —
    the same signal won't be recorded twice for the same source event.
    """
    if signal_kind not in SIGNAL_DEFINITIONS:
        raise ValueError(f"Unknown reputation signal: {signal_kind}")

    if ref_id and ref_type:
        existing = await db.reputation_signals.find_one({
            "dealer_id": dealer_id,
            "signal_kind": signal_kind,
            "ref_id": ref_id,
            "ref_type": ref_type,
        })
        if existing:
            return existing

    doc = {
        "id": str(uuid.uuid4()),
        "dealer_id": dealer_id,
        "signal_kind": signal_kind,
        "value": float(value),
        "weight_override": weight_override,
        "source": source,
        "ref_id": ref_id,
        "ref_type": ref_type,
        "actor_id": actor_id,
        "note": note,
        "ts": now_utc(),
    }
    await db.reputation_signals.insert_one(doc)
    return doc


# ---------------------------------------------------------------------
# Scoring computation — pure given a signal feed
# ---------------------------------------------------------------------

def _signal_in_window(sig_ts: datetime, window: str, ref: Optional[datetime] = None) -> bool:
    if window == "lifetime":
        return True
    start = window_start(window, ref)
    if start is None:
        return True
    if sig_ts.tzinfo is None:
        sig_ts = sig_ts.replace(tzinfo=timezone.utc)
    return sig_ts >= start


def aggregate_signals(
    signals: List[Dict[str, Any]],
    ref: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Reduce a flat list of signal events into per-kind aggregates plus
    a final score. Pure function — no DB."""
    ref = ref or now_utc()
    aggregates: Dict[str, Dict[str, Any]] = {}

    # Pre-seed every defined signal so the breakdown is always complete
    for kind, defn in SIGNAL_DEFINITIONS.items():
        aggregates[kind] = {
            "kind": kind,
            "label": defn["label"],
            "category": defn["category"],
            "description": defn["description"],
            "window": defn["window"],
            "weight_per": defn["weight"],
            "cap": defn["cap"],
            "count": 0,
            "raw_value": 0.0,
            "delta": 0,
            "in_window": [],
        }

    for s in signals:
        kind = s.get("signal_kind")
        defn = SIGNAL_DEFINITIONS.get(kind)
        if not defn:
            continue
        if not _signal_in_window(s["ts"], defn["window"], ref):
            continue

        agg = aggregates[kind]
        if defn.get("dynamic_weight"):
            # Operator override: value IS the delta, not a count.
            delta = float(s.get("value", 0.0))
            agg["count"] += 1
            agg["raw_value"] += delta
            agg["delta"] += int(round(delta))
        else:
            count_inc = float(s.get("value", 1.0))
            agg["count"] += int(round(count_inc))
            agg["raw_value"] += count_inc
            raw_delta = defn["weight"] * count_inc
            # Apply cap
            cap = defn["cap"]
            if cap >= 0:
                agg["delta"] = int(round(min(agg["delta"] + raw_delta, cap)))
            else:
                agg["delta"] = int(round(max(agg["delta"] + raw_delta, cap)))

        # Trim recent for display (last 10 in-window events)
        if len(agg["in_window"]) < 10:
            agg["in_window"].append({
                "id": s.get("id"),
                "ts": s["ts"].isoformat() if isinstance(s["ts"], datetime) else s["ts"],
                "value": s.get("value"),
                "ref_id": s.get("ref_id"),
                "ref_type": s.get("ref_type"),
                "source": s.get("source"),
                "note": s.get("note"),
            })

    raw_score = BASE_SCORE + sum(a["delta"] for a in aggregates.values())
    score = max(0, min(100, int(round(raw_score))))
    tier = tier_for(score)

    # Count contribution by category
    by_category: Dict[str, int] = {}
    for a in aggregates.values():
        by_category[a["category"]] = by_category.get(a["category"], 0) + a["delta"]

    return {
        "score": score,
        "raw_score": int(round(raw_score)),
        "base_score": BASE_SCORE,
        "tier": tier,
        "category_deltas": by_category,
        "signals": list(aggregates.values()),
    }


# ---------------------------------------------------------------------
# DB-backed reputation queries
# ---------------------------------------------------------------------

async def get_dealer_reputation(db, dealer_id: str) -> Dict[str, Any]:
    """Compute the current reputation snapshot for a dealer."""
    cursor = db.reputation_signals.find({"dealer_id": dealer_id}).sort("ts", -1)
    signals: List[Dict[str, Any]] = []
    async for s in cursor:
        signals.append(s)

    agg = aggregate_signals(signals)
    badges = _compute_badges(agg, signals)
    restrictions = await get_active_restrictions(db, dealer_id)

    return {
        "dealer_id": dealer_id,
        "score": agg["score"],
        "raw_score": agg["raw_score"],
        "base_score": agg["base_score"],
        "tier": agg["tier"],
        "category_deltas": agg["category_deltas"],
        "signals": agg["signals"],
        "badges": badges,
        "restrictions": restrictions,
        "computed_at": now_utc().isoformat(),
        "total_events": len(signals),
    }


async def reputation_summary(db, dealer_id: str) -> Dict[str, Any]:
    """Lightweight reputation card — used inline on auction cards / queues."""
    full = await get_dealer_reputation(db, dealer_id)
    return {
        "dealer_id": dealer_id,
        "score": full["score"],
        "tier": full["tier"],
        "badges": [b["key"] for b in full["badges"]],
        "has_active_restriction": bool(full["restrictions"]),
        "computed_at": full["computed_at"],
    }


async def get_reputation_timeline(
    db, dealer_id: str, limit: int = 100
) -> List[Dict[str, Any]]:
    """Reverse-chronological signal stream for the dealer's history view."""
    cursor = db.reputation_signals.find({"dealer_id": dealer_id}).sort("ts", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for s in cursor:
        defn = SIGNAL_DEFINITIONS.get(s.get("signal_kind"), {})
        items.append({
            "id": s.get("id"),
            "ts": s["ts"].isoformat() if isinstance(s["ts"], datetime) else s["ts"],
            "kind": s.get("signal_kind"),
            "label": defn.get("label", s.get("signal_kind")),
            "category": defn.get("category", "other"),
            "weight_per": defn.get("weight", 0),
            "value": s.get("value"),
            "source": s.get("source"),
            "ref_id": s.get("ref_id"),
            "ref_type": s.get("ref_type"),
            "actor_id": s.get("actor_id"),
            "note": s.get("note"),
        })
    return items


# ---------------------------------------------------------------------
# Badges — pure function over aggregates
# ---------------------------------------------------------------------

def _compute_badges(agg: Dict[str, Any], raw_signals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    badges: List[Dict[str, Any]] = []
    score = agg["score"]
    sig_map = {a["kind"]: a for a in agg["signals"]}

    if score >= 85 and sig_map["settlement_completed"]["count"] >= 10:
        badges.append({"key": "trusted_dealer", "label": "Trusted Dealer", "color": "#10B981"})

    if sig_map["high_value_settlement"]["count"] >= 3:
        badges.append({"key": "high_value", "label": "High-Value Buyer", "color": "#FBBF24"})

    if sig_map["settlement_completed"]["count"] >= 25:
        badges.append({"key": "veteran", "label": "Veteran (25+ deals)", "color": "#C0C0C8"})

    if sig_map["dispute_lost"]["count"] == 0 and sig_map["settlement_completed"]["count"] >= 5:
        badges.append({"key": "clean_record", "label": "Clean Record", "color": "#10B981"})

    if sig_map["payment_delayed"]["count"] >= 2:
        badges.append({"key": "payment_risk", "label": "Payment Risk", "color": "#DC2626"})

    if sig_map["operator_flag"]["count"] >= 1:
        badges.append({"key": "operator_flagged", "label": "Operator-Flagged", "color": "#0B0B0D"})

    return badges


# ---------------------------------------------------------------------
# Operator actions — restrictions, audit log
# ---------------------------------------------------------------------

RESTRICTION_KINDS = {"suspended", "bidding_cooldown", "shadow_restricted", "kyc_review"}


async def record_operator_action(
    db,
    *,
    actor_id: str,
    target_dealer_id: str,
    action: str,
    reason: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Append-only audit log for every reputation/restriction action."""
    doc = {
        "id": str(uuid.uuid4()),
        "actor_id": actor_id,
        "target_dealer_id": target_dealer_id,
        "action": action,
        "reason": reason,
        "payload": payload or {},
        "ts": now_utc(),
    }
    await db.operator_actions_audit.insert_one(doc)
    return doc


async def apply_restriction(
    db,
    *,
    actor_id: str,
    target_dealer_id: str,
    kind: str,
    reason: str,
    expires_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    if kind not in RESTRICTION_KINDS:
        raise ValueError(f"Unknown restriction: {kind}")

    # Lift any prior active restriction of the same kind first
    await db.dealer_restrictions.update_many(
        {"dealer_id": target_dealer_id, "kind": kind, "active": True},
        {"$set": {"active": False, "lifted_at": now_utc(),
                  "lifted_by": actor_id, "lifted_reason": "superseded"}},
    )

    doc = {
        "id": str(uuid.uuid4()),
        "dealer_id": target_dealer_id,
        "kind": kind,
        "reason": reason,
        "applied_at": now_utc(),
        "expires_at": expires_at,
        "applied_by": actor_id,
        "active": True,
        "lifted_at": None,
        "lifted_by": None,
    }
    await db.dealer_restrictions.insert_one(doc)
    await record_operator_action(
        db, actor_id=actor_id, target_dealer_id=target_dealer_id,
        action=f"apply_{kind}", reason=reason,
        payload={"expires_at": expires_at.isoformat() if expires_at else None},
    )
    return doc


async def lift_restriction(
    db,
    *,
    actor_id: str,
    target_dealer_id: str,
    kind: str,
    reason: str,
) -> Optional[Dict[str, Any]]:
    res = await db.dealer_restrictions.find_one_and_update(
        {"dealer_id": target_dealer_id, "kind": kind, "active": True},
        {"$set": {"active": False, "lifted_at": now_utc(),
                  "lifted_by": actor_id, "lifted_reason": reason}},
        return_document=True,
    )
    await record_operator_action(
        db, actor_id=actor_id, target_dealer_id=target_dealer_id,
        action=f"lift_{kind}", reason=reason,
    )
    return res


async def get_active_restrictions(db, dealer_id: str) -> List[Dict[str, Any]]:
    now = now_utc()
    cursor = db.dealer_restrictions.find({"dealer_id": dealer_id, "active": True})
    out: List[Dict[str, Any]] = []
    async for r in cursor:
        # Auto-expire restrictions that have passed their expiry
        exp = r.get("expires_at")
        if exp and isinstance(exp, datetime):
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= now:
                await db.dealer_restrictions.update_one(
                    {"id": r["id"]},
                    {"$set": {"active": False, "lifted_at": now,
                              "lifted_by": "system", "lifted_reason": "expired"}},
                )
                continue
        out.append({
            "id": r["id"],
            "kind": r["kind"],
            "reason": r.get("reason"),
            "applied_at": r["applied_at"].isoformat() if isinstance(r.get("applied_at"), datetime) else r.get("applied_at"),
            "expires_at": r["expires_at"].isoformat() if isinstance(r.get("expires_at"), datetime) else r.get("expires_at"),
            "applied_by": r.get("applied_by"),
        })
    return out


async def is_dealer_blocked_from_bidding(db, dealer_id: str) -> Tuple[bool, Optional[str]]:
    """Used by the bid endpoint to enforce reputation restrictions."""
    restrictions = await get_active_restrictions(db, dealer_id)
    for r in restrictions:
        if r["kind"] in ("suspended", "bidding_cooldown"):
            return True, r["kind"]
    return False, None


async def add_operator_note(
    db,
    *,
    actor_id: str,
    target_dealer_id: str,
    note: str,
    visibility: str = "operator",   # "operator" | "dealer"
) -> Dict[str, Any]:
    doc = {
        "id": str(uuid.uuid4()),
        "dealer_id": target_dealer_id,
        "note": note,
        "visibility": visibility,
        "created_by": actor_id,
        "created_at": now_utc(),
    }
    await db.dealer_notes.insert_one(doc)
    doc.pop("_id", None)
    await record_operator_action(
        db, actor_id=actor_id, target_dealer_id=target_dealer_id,
        action="add_note", reason=None,
        payload={"note_id": doc["id"], "visibility": visibility},
    )
    return doc


async def list_operator_notes(db, dealer_id: str) -> List[Dict[str, Any]]:
    cursor = db.dealer_notes.find({"dealer_id": dealer_id}).sort("created_at", -1)
    out: List[Dict[str, Any]] = []
    async for n in cursor:
        out.append({
            "id": n["id"],
            "note": n.get("note"),
            "visibility": n.get("visibility"),
            "created_by": n.get("created_by"),
            "created_at": n["created_at"].isoformat() if isinstance(n.get("created_at"), datetime) else n.get("created_at"),
        })
    return out


async def list_audit_for_dealer(db, dealer_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    cursor = db.operator_actions_audit.find(
        {"target_dealer_id": dealer_id}
    ).sort("ts", -1).limit(limit)
    out: List[Dict[str, Any]] = []
    async for a in cursor:
        out.append({
            "id": a["id"],
            "ts": a["ts"].isoformat() if isinstance(a.get("ts"), datetime) else a.get("ts"),
            "actor_id": a.get("actor_id"),
            "action": a.get("action"),
            "reason": a.get("reason"),
            "payload": a.get("payload", {}),
        })
    return out


# ---------------------------------------------------------------------
# Convenience: backfill scoring from settlement / dispute lifecycle hooks
# ---------------------------------------------------------------------

async def on_settlement_completed(db, dealer_id: str, auction_id: str, amount: float) -> None:
    await record_signal(
        db, dealer_id=dealer_id,
        signal_kind="settlement_completed",
        ref_id=auction_id, ref_type="auction",
        source="system", note=f"₹{amount:,.0f}",
    )
    if amount >= 1_000_000:
        await record_signal(
            db, dealer_id=dealer_id,
            signal_kind="high_value_settlement",
            ref_id=auction_id, ref_type="auction",
            source="system", note=f"₹{amount:,.0f}",
        )


async def on_payment_delayed(db, dealer_id: str, auction_id: str) -> None:
    await record_signal(
        db, dealer_id=dealer_id,
        signal_kind="payment_delayed",
        ref_id=auction_id, ref_type="auction",
        source="system",
    )


async def on_settlement_failed(db, dealer_id: str, auction_id: str) -> None:
    await record_signal(
        db, dealer_id=dealer_id,
        signal_kind="settlement_failed",
        ref_id=auction_id, ref_type="auction",
        source="system",
    )


async def on_cancellation_after_win(db, dealer_id: str, auction_id: str) -> None:
    await record_signal(
        db, dealer_id=dealer_id,
        signal_kind="cancellation_after_win",
        ref_id=auction_id, ref_type="auction",
        source="system",
    )


async def on_dispute_resolved(
    db, *, against_dealer_id: str, in_favour_dealer_id: Optional[str],
    dispute_id: str, frivolous_raiser_id: Optional[str] = None,
) -> None:
    await record_signal(
        db, dealer_id=against_dealer_id,
        signal_kind="dispute_lost",
        ref_id=dispute_id, ref_type="dispute",
        source="system",
    )
    if in_favour_dealer_id:
        await record_signal(
            db, dealer_id=in_favour_dealer_id,
            signal_kind="dispute_won",
            ref_id=dispute_id, ref_type="dispute",
            source="system",
        )
    if frivolous_raiser_id:
        await record_signal(
            db, dealer_id=frivolous_raiser_id,
            signal_kind="dispute_raised_frivolous",
            ref_id=dispute_id, ref_type="dispute",
            source="system",
        )
