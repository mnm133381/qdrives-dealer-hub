"""
Push Notifications dispatcher for Q Drives / QD Auctions.

Two channels supported:

1. **Expo Push** (iOS/Android native apps via Expo Go / standalone EAS builds).
   Uses Expo's push API directly: https://exp.host/--/api/v2/push/send
   Tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx].

2. **FCM Web Push** (PWA installs / browser sessions registered via
   firebase/messaging). Tokens are 163+ char opaque strings produced by
   Firebase Cloud Messaging. Dispatch uses the FCM HTTP v1 API, which
   requires a service account JSON. If `FCM_SERVICE_ACCOUNT_PATH` is
   unset, web dispatch logs and no-ops (so the platform stays healthy
   even without FCM credentials wired in yet).

For an MVP we do best-effort delivery + minimal logging. If a token
is reported dead by the gateway we delete it from the dealer's
push_tokens list so we don't keep spamming dead devices.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

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


# ==============================================================
# FCM Web Push (PWA / browser sessions)
# ==============================================================

FCM_HTTP_V1_URL_TMPL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_FCM_ACCESS_TOKEN_CACHE: Dict[str, Tuple[str, float]] = {}


def is_likely_fcm_web_token(token: Optional[str]) -> bool:
    """FCM web tokens are 140+ char opaque strings without the Expo wrapper."""
    if not token or not isinstance(token, str):
        return False
    if token.startswith(_EXPO_TOKEN_PREFIX):
        return False
    # FCM registration IDs are url-safe-ish base64 of length ~150-200.
    return 100 <= len(token) <= 4096


def _load_fcm_service_account() -> Optional[Dict[str, Any]]:
    """Load and cache the Firebase service-account JSON, if configured."""
    path = (os.environ.get("FCM_SERVICE_ACCOUNT_PATH") or "").strip()
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        logger.warning("FCM_SERVICE_ACCOUNT_PATH set but file missing: %s", path)
        return None
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to read FCM service account: %s", exc)
        return None


async def _get_fcm_access_token(sa: Dict[str, Any]) -> Optional[str]:
    """Mint an OAuth2 access token from the service-account JWT (cached 50min)."""
    client_email = sa.get("client_email")
    if not client_email:
        return None
    cached = _FCM_ACCESS_TOKEN_CACHE.get(client_email)
    if cached and cached[1] - 60 > time.time():
        return cached[0]
    # Lazy import — keeps cold-start cheap when web push isn't configured.
    try:
        import jwt  # type: ignore
    except ImportError:
        logger.warning("PyJWT not installed; web push disabled. `pip install PyJWT[crypto]`.")
        return None
    now = int(time.time())
    payload = {
        "iss": client_email,
        "scope": _FCM_SCOPE,
        "aud": sa.get("token_uri", "https://oauth2.googleapis.com/token"),
        "iat": now,
        "exp": now + 3600,
    }
    try:
        signed = jwt.encode(payload, sa["private_key"], algorithm="RS256")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to sign FCM JWT: %s", exc)
        return None
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as cx:
            r = await cx.post(
                sa.get("token_uri", "https://oauth2.googleapis.com/token"),
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": signed,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            r.raise_for_status()
            tok = r.json().get("access_token")
            if tok:
                _FCM_ACCESS_TOKEN_CACHE[client_email] = (tok, time.time() + 3000)
            return tok
    except Exception as exc:  # noqa: BLE001
        logger.warning("FCM OAuth exchange failed: %s", exc)
        return None


async def _send_one_fcm(
    cx: httpx.AsyncClient,
    project_id: str,
    access_token: str,
    token: str,
    title: str,
    body: str,
    data: Dict[str, Any],
) -> Tuple[str, bool, Optional[str]]:
    """Returns (token, ok, error_code)."""
    # FCM data payloads must be string-only key/value pairs.
    str_data = {k: ("" if v is None else str(v)) for k, v in (data or {}).items()}
    payload = {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": str_data,
            "webpush": {
                "fcm_options": {
                    "link": str_data.get("url") or (f"/lot/{str_data['auction_id']}" if str_data.get("auction_id") else "/")
                },
                "notification": {
                    "icon": "/icons/icon-192.png",
                    "badge": "/icons/icon-192.png",
                    "tag": str_data.get("tag") or "qd-fcm",
                },
            },
        }
    }
    try:
        r = await cx.post(
            FCM_HTTP_V1_URL_TMPL.format(project_id=project_id),
            json=payload,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
        if r.status_code == 200:
            return token, True, None
        # FCM returns 404/403 for invalid/unregistered tokens.
        err_code = ""
        try:
            err_code = (r.json() or {}).get("error", {}).get("status") or ""
        except Exception:
            pass
        return token, False, err_code or f"http_{r.status_code}"
    except Exception as exc:  # noqa: BLE001
        logger.debug("FCM send error for one token: %s", exc)
        return token, False, "exception"


async def send_web_to_dealer(
    db,
    dealer_id: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Send an FCM web push to every browser session of a dealer."""
    sa = _load_fcm_service_account()
    if not sa:
        # FCM not configured yet — log once at debug level (caller already
        # logs at info for the unified dispatcher path).
        logger.debug("FCM web push skipped: FCM_SERVICE_ACCOUNT_PATH not configured")
        return
    dealer = await db.dealers.find_one({"id": dealer_id}, {"_id": 0, "push_tokens": 1})
    if not dealer:
        return
    tokens = [t for t in (dealer.get("push_tokens") or []) if is_likely_fcm_web_token(t)]
    if not tokens:
        return
    project_id = sa.get("project_id")
    access_token = await _get_fcm_access_token(sa)
    if not project_id or not access_token:
        return
    bad: List[str] = []
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as cx:
        results = await asyncio.gather(
            *[_send_one_fcm(cx, project_id, access_token, t, title, body, data or {}) for t in tokens],
            return_exceptions=True,
        )
    for res in results:
        if isinstance(res, tuple) and not res[1]:
            tok, _, err = res
            if err in ("NOT_FOUND", "UNREGISTERED", "INVALID_ARGUMENT", "http_404", "http_403"):
                bad.append(tok)
    if bad:
        try:
            await db.dealers.update_many(
                {"push_tokens": {"$in": bad}},
                {"$pull": {"push_tokens": {"$in": bad}}},
            )
            logger.info("Removed %d dead FCM web tokens", len(bad))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to prune dead FCM tokens: %s", exc)


async def send_to_dealer_all_channels(
    db,
    dealer_id: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Fan-out to BOTH Expo native and FCM web channels for a single dealer.

    Use this from new dispatch sites that should reach the user on
    whichever device they're currently using. Existing call sites that
    only invoke `send_to_dealer` keep working (native only).
    """
    await asyncio.gather(
        send_to_dealer(db, dealer_id, title, body, data),
        send_web_to_dealer(db, dealer_id, title, body, data),
        return_exceptions=True,
    )
