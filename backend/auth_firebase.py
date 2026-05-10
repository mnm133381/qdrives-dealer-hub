"""
Firebase ID-token verification + lightweight in-memory rate limiting.

Migration context:
- The legacy mocked OTP path (`MOCK_OTP = "123456"`) is being removed.
- Firebase Phone Auth issues SMS from the client SDK (Android/iOS/Web)
  and returns an ID token to the app. The app posts that token to
  /auth/.../verify-otp where this module verifies it server-side.
- We trust ONLY:
    * iss == "https://securetoken.google.com/<project_id>"
    * audience == project_id
    * phone_number claim is present (required for our flow)
    * sign_in_provider == "phone"

DEV_BYPASS_OTP env flag (default OFF) is intentionally retained as an
escape hatch for staging/CI ONLY — it is NEVER active in production
unless explicitly turned on. It bypasses Firebase verification and
treats `phone` as already-verified. Do not enable in prod.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Optional, Tuple

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials as fb_credentials

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------
# Firebase Admin initialisation (idempotent)
# ---------------------------------------------------------------------
_DEFAULT_SA_PATH = Path(__file__).parent / "secrets" / "firebase-service-account.json"
_FIREBASE_READY = False
_FIREBASE_PROJECT_ID: Optional[str] = None


def _init_firebase() -> bool:
    """Lazy, idempotent Firebase Admin init. Safe to call repeatedly."""
    global _FIREBASE_READY, _FIREBASE_PROJECT_ID
    if _FIREBASE_READY:
        return True
    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", str(_DEFAULT_SA_PATH))
    if not Path(sa_path).is_file():
        logger.warning("Firebase SA file missing at %s — phone-auth verify will fail", sa_path)
        return False
    try:
        if not firebase_admin._apps:
            cred = fb_credentials.Certificate(sa_path)
            firebase_admin.initialize_app(cred)
        # Cache project_id from the service account for audience validation
        with open(sa_path, "r", encoding="utf-8") as fh:
            import json as _json
            sa_data = _json.load(fh)
            _FIREBASE_PROJECT_ID = sa_data.get("project_id")
        _FIREBASE_READY = True
        logger.info("Firebase Admin initialised — project=%s", _FIREBASE_PROJECT_ID)
        return True
    except Exception as exc:  # pragma: no cover - boot path
        logger.exception("Firebase Admin init failed: %s", exc)
        return False


_init_firebase()


# ---------------------------------------------------------------------
# Token verification
# ---------------------------------------------------------------------
class FirebaseAuthError(Exception):
    """Raised when an ID token cannot be trusted for OTP-style sign-in."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def verify_id_token_phone(id_token: str, expected_phone: Optional[str] = None) -> str:
    """Verify a Firebase ID token and return the canonical E.164 phone.

    Raises FirebaseAuthError on any failure. The caller should map this
    to HTTP 401/400.
    """
    if not id_token or not isinstance(id_token, str):
        raise FirebaseAuthError("missing_token", "Firebase ID token is required.")
    if not _init_firebase():
        raise FirebaseAuthError("firebase_unavailable", "Authentication backend not configured.")
    try:
        decoded: Dict[str, object] = fb_auth.verify_id_token(id_token, check_revoked=False)
    except fb_auth.ExpiredIdTokenError:
        raise FirebaseAuthError("expired", "OTP session expired. Please request a new code.")
    except fb_auth.RevokedIdTokenError:
        raise FirebaseAuthError("revoked", "Session revoked. Please sign in again.")
    except fb_auth.InvalidIdTokenError as exc:
        raise FirebaseAuthError("invalid", f"Invalid OTP token: {exc}")
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Unexpected Firebase verify failure")
        raise FirebaseAuthError("verify_failed", "Could not verify OTP token.")

    # Audience hardening: confirm the token belongs to our project
    aud = decoded.get("aud")
    if _FIREBASE_PROJECT_ID and aud and aud != _FIREBASE_PROJECT_ID:
        raise FirebaseAuthError("wrong_project", "Token issued for another project.")

    # Provider hardening: only phone-auth tokens are accepted at this gate.
    firebase_meta = decoded.get("firebase") or {}
    provider = ""
    if isinstance(firebase_meta, dict):
        provider = str(firebase_meta.get("sign_in_provider", "") or "")
    if provider and provider != "phone":
        raise FirebaseAuthError(
            "wrong_provider",
            f"Token provider must be 'phone', got '{provider}'.",
        )

    phone = decoded.get("phone_number")
    if not phone or not isinstance(phone, str):
        raise FirebaseAuthError("no_phone", "Token has no verified phone number.")

    phone = phone.strip()
    if expected_phone:
        # Loose match: tolerate whitespace differences but enforce equality
        if phone.replace(" ", "") != str(expected_phone).strip().replace(" ", ""):
            raise FirebaseAuthError(
                "phone_mismatch",
                "OTP token phone does not match the requested number.",
            )
    return phone


# ---------------------------------------------------------------------
# Rate limiting (in-memory sliding window)
# ---------------------------------------------------------------------
# Keyed by (kind, identifier) where kind is "send" or "verify" and
# identifier is the E.164 phone or client IP. Each bucket stores a
# deque of monotonic timestamps. Cleared automatically on each check.
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: Dict[Tuple[str, str], Deque[float]] = {}


def _rate_check(kind: str, identifier: str, max_events: int, window_sec: int) -> bool:
    """Return True if the event is permitted. Records the event when allowed."""
    if not identifier:
        return True
    now = time.monotonic()
    cutoff = now - window_sec
    key = (kind, identifier)
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS.setdefault(key, deque())
        # Drop expired entries cheaply from the left
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= max_events:
            return False
        bucket.append(now)
        # Opportunistic GC of unrelated buckets so memory stays bounded
        if len(_RATE_BUCKETS) > 4096:  # pragma: no cover - growth path
            stale = [k for k, b in _RATE_BUCKETS.items() if not b or b[-1] < cutoff]
            for k in stale[:1024]:
                _RATE_BUCKETS.pop(k, None)
    return True


def check_send_rate(phone: str, ip: Optional[str] = None) -> Tuple[bool, str]:
    """Limit OTP-send: 5/hour per phone, 30/hour per IP."""
    # 5 sends per hour per phone (matches MSG91/Twilio defaults)
    if not _rate_check("send_phone", phone, max_events=5, window_sec=3600):
        return False, "Too many OTP requests for this number. Try again in an hour."
    if ip and not _rate_check("send_ip", ip, max_events=30, window_sec=3600):
        return False, "Too many OTP requests from this device. Slow down."
    return True, ""


def check_send_cooldown(phone: str) -> Tuple[bool, str]:
    """Short retry cooldown — 1 send / 20s per phone."""
    if not _rate_check("send_cooldown", phone, max_events=1, window_sec=20):
        return False, "Please wait a few seconds before requesting another OTP."
    return True, ""


def check_verify_rate(phone: str, ip: Optional[str] = None) -> Tuple[bool, str]:
    """Limit OTP-verify: 10/hour per phone, 60/hour per IP."""
    if not _rate_check("verify_phone", phone, max_events=10, window_sec=3600):
        return False, "Too many verification attempts. Try again later."
    if ip and not _rate_check("verify_ip", ip, max_events=60, window_sec=3600):
        return False, "Too many verification attempts from this device."
    return True, ""


# ---------------------------------------------------------------------
# Dev bypass (off by default)
# ---------------------------------------------------------------------
def dev_bypass_enabled() -> bool:
    """Returns True only when explicitly enabled via env var."""
    return str(os.getenv("DEV_BYPASS_OTP", "")).strip().lower() in ("1", "true", "yes")
