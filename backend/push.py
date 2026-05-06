"""
Expo Push Notifications dispatcher for Q Drives.

Uses Expo's push API directly: https://exp.host/--/api/v2/push/send
No FCM/APNS keys needed during development. Tokens look like
ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx].

For an MVP we do best-effort delivery + minimal logging. If a token
is reported as `DeviceNotRegistered` we delete it from the dealer's
push_tokens list so we don't keep spamming dead devices.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Iterable, List, Optional

import httpx

logger = logging.getLogger("qdrives.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
_HTTP_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_EXPO_TOKEN_PREFIX = ("ExponentPushToken[", "ExpoPushToken[")


def is_valid_expo_token(token: Optional[str]) -> bool:
    if not token or not isinstance(token, str):
        return False
    return token.startswith(_EXPO_TOKEN_PREFIX) and token.endswith("]")


def _build_messages(
    tokens: Iterable[str],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    sound: str = "default",
    channel_id: str = "default",
) -> List[Dict[str, Any]]:
    msgs: List[Dict[str, Any]] = []
    for t in tokens:
        if not is_valid_expo_token(t):
            continue
        msgs.append({
            "to": t,
            "title": title,
            "body": body,
            "sound": sound,
            "priority": "high",
            "channelId": channel_id,
            "data": data or {},
        })
    return msgs


async def _post_to_expo(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not messages:
        return []
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as cx:
            r = await cx.post(
                EXPO_PUSH_URL,
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip, deflate",
                    "Content-Type": "application/json",
                },
                json=messages,
            )
            r.raise_for_status()
            payload = r.json()
            return payload.get("data") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("Expo push call failed: %s", exc)
        return []


async def _cleanup_dead_tokens(db, results: List[Dict[str, Any]], tokens: List[str]) -> None:
    """If Expo returns DeviceNotRegistered for a token, drop it from the dealer doc."""
    if not results or not tokens:
        return
    bad: List[str] = []
    for tok, res in zip(tokens, results):
        if not isinstance(res, dict):
            continue
        if res.get("status") == "error":
            details = res.get("details") or {}
            if details.get("error") in ("DeviceNotRegistered", "InvalidCredentials"):
                bad.append(tok)
    if not bad:
        return
    try:
        await db.dealers.update_many(
            {"push_tokens": {"$in": bad}},
            {"$pull": {"push_tokens": {"$in": bad}}},
        )
        logger.info("Removed %d dead Expo push tokens", len(bad))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to prune dead push tokens: %s", exc)


async def send_to_dealer(
    db,
    dealer_id: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Send a push notification to every device of a dealer (best-effort)."""
    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0, "push_tokens": 1})
    if not dealer:
        return
    tokens = [t for t in (dealer.get("push_tokens") or []) if is_valid_expo_token(t)]
    if not tokens:
        return
    msgs = _build_messages(tokens, title, body, data)
    results = await _post_to_expo(msgs)
    await _cleanup_dead_tokens(db, results, tokens)


async def send_to_dealers(
    db,
    dealer_ids: Iterable[str],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Fan out to several dealers concurrently."""
    ids = list({d for d in dealer_ids if d})
    if not ids:
        return
    await asyncio.gather(
        *[send_to_dealer(db, did, title, body, data) for did in ids],
        return_exceptions=True,
    )
