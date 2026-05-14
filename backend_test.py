"""
Backend test suite for the Draft → Launch auction workflow.

Targets: standard host http://localhost:8001 (API prefix /api), per review
request. Uses OTP=123456 via DEV_BYPASS_OTP (operator phone allow-listed
via ADMIN_PHONES env var).

Run:
    python /app/backend_test.py
"""
from __future__ import annotations

import io
import sys
import traceback
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

BASE = "http://localhost:8001/api"
OPERATOR_PHONE = "+918977986662"  # super_admin per ADMIN_PHONES / test_credentials
OTP = "123456"

results: List[Tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    sym = "PASS" if ok else "FAIL"
    print(f"[{sym}] {name} :: {detail}")


def operator_login() -> str:
    r = requests.post(f"{BASE}/auth/operator/send-otp", json={"phone": OPERATOR_PHONE}, timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f"operator send-otp failed: {r.status_code} {r.text}")
    r = requests.post(
        f"{BASE}/auth/operator/verify-otp",
        json={"phone": OPERATOR_PHONE, "otp": OTP},
        timeout=10,
    )
    if r.status_code != 200:
        raise RuntimeError(f"operator verify-otp failed: {r.status_code} {r.text}")
    body = r.json()
    if body.get("dealer", {}).get("role") not in ("admin", "super_admin"):
        raise RuntimeError(f"operator role wrong: {body.get('dealer', {}).get('role')}")
    return body["token"]


def make_jpeg_bytes(size_px: int = 64, color: Tuple[int, int, int] = (200, 50, 50)) -> bytes:
    """Generate a minimal valid JPEG."""
    try:
        from PIL import Image
        img = Image.new("RGB", (size_px, size_px), color)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    except Exception:
        return bytes.fromhex(
            "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00fbfba28a2803ffd9"
        )


def create_car_draft(token: str, suffix: str = "DRAFT", launch_immediately: bool = False) -> Dict[str, Any]:
    payload = {
        "registration_number": f"MH99{suffix}",
        "make": "Hyundai",
        "model": "Creta",
        "variant": "SX(O) Turbo",
        "year": 2023,
        "manufacturing_year": 2022,
        "registration_year": 2023,
        "fuel_type": "Petrol",
        "transmission": "Automatic",
        "km_driven": 28000,
        "color": "Phantom Black",
        "owners": 1,
        "insurance_validity": "08/2026",
        "rto_details": "MH02 - Mumbai West",
        "notes": "Single owner, accident-free, full service history.",
        "reserve_price": 1450000,
        "starting_bid": 1100000,
        "duration_minutes": 60,
        "launch_immediately": launch_immediately,
    }
    r = requests.post(
        f"{BASE}/cars", json=payload,
        headers={"Authorization": f"Bearer {token}"}, timeout=15,
    )
    if r.status_code != 200:
        raise RuntimeError(f"POST /cars failed: {r.status_code} {r.text}")
    return r.json()


def upload_media(token: str, car_id: str, section: str = "exterior") -> Dict[str, Any]:
    files = {
        "file": ("photo.jpg", make_jpeg_bytes(), "image/jpeg"),
    }
    data = {"car_id": car_id, "section": section}
    r = requests.post(
        f"{BASE}/media/upload", files=files, data=data,
        headers={"Authorization": f"Bearer {token}"}, timeout=20,
    )
    if r.status_code != 200:
        raise RuntimeError(f"POST /media/upload failed: {r.status_code} {r.text}")
    return r.json()


def set_featured(token: str, car_id: str, media_id: str) -> None:
    r = requests.post(
        f"{BASE}/cars/{car_id}/media/featured/{media_id}",
        headers={"Authorization": f"Bearer {token}"}, timeout=10,
    )
    if r.status_code != 200:
        raise RuntimeError(f"set_featured failed: {r.status_code} {r.text}")


def run() -> bool:
    print("=" * 70)
    print("Draft → Launch workflow test :: BASE =", BASE)
    print("=" * 70)

    op_token = operator_login()
    auth = {"Authorization": f"Bearer {op_token}"}
    print(f"[setup] Operator JWT acquired for {OPERATOR_PHONE}")

    # ---- 1. Default-to-draft on car/auction creation ----
    res_default = create_car_draft(op_token, suffix="DR001")
    draft_auction = res_default["auction"]
    draft_id = draft_auction["id"]
    draft_car_id = res_default["car"]["id"]
    ok = draft_auction.get("status") == "draft"
    record("1a. POST /cars defaults to status='draft'",
           ok, f"status={draft_auction.get('status')} auction_id={draft_id}")

    res_imm = create_car_draft(op_token, suffix="IMM01", launch_immediately=True)
    imm_auction = res_imm["auction"]
    imm_id = imm_auction["id"]
    ok = imm_auction.get("status") == "live"
    record("1b. POST /cars with launch_immediately=true → status='live'",
           ok, f"status={imm_auction.get('status')} auction_id={imm_id}")

    # ---- 2. Draft hidden from dealers ----
    r = requests.get(f"{BASE}/auctions", timeout=10)
    pub_list = r.json() if r.status_code == 200 else []
    hidden_ok = (
        r.status_code == 200
        and not any(a.get("status") == "draft" for a in pub_list)
        and not any(a.get("id") == draft_id for a in pub_list)
    )
    record("2a. GET /auctions (anon) excludes drafts",
           hidden_ok,
           f"status={r.status_code} total={len(pub_list)} draft_present={any(a.get('id')==draft_id for a in pub_list)}")

    r = requests.get(f"{BASE}/auctions/{draft_id}", timeout=10)
    if r.status_code == 200:
        body = r.json()
        ok_directfetch = body.get("status") == "draft"
        record("2b. GET /auctions/{draft_id} direct fetch", ok_directfetch,
               f"200 returned with status={body.get('status')} (preserved, NOT promoted to live)")
    elif r.status_code == 404:
        record("2b. GET /auctions/{draft_id} direct fetch", True,
               f"404 — draft filtered (acceptable per review)")
    else:
        record("2b. GET /auctions/{draft_id} direct fetch", False,
               f"unexpected status={r.status_code} body={r.text[:200]}")

    # ---- 3. Launch readiness pre-flight (empty draft) ----
    r = requests.get(f"{BASE}/admin/auctions/{draft_id}/launch-readiness",
                     headers=auth, timeout=10)
    ok = r.status_code == 200
    readiness_empty = r.json() if ok else {}
    record("3a. GET /launch-readiness reachable (empty draft)",
           ok, f"status={r.status_code}")
    if ok:
        issues = readiness_empty.get("issues", [])
        upload_issue = any("Upload at least" in i and "photos" in i for i in issues)
        featured_issue = any("Featured" in i for i in issues)
        ok2 = (
            readiness_empty.get("ready") is False
            and upload_issue and featured_issue
        )
        record("3b. Empty draft: ready=false + photos+featured issues present",
               ok2,
               f"ready={readiness_empty.get('ready')} media_count={readiness_empty.get('media_count')} "
               f"featured_count={readiness_empty.get('featured_count')} "
               f"min_photos_required={readiness_empty.get('min_photos_required')} issues={issues}")

    # ---- 4. Launch endpoint hard-gating ----
    r = requests.post(
        f"{BASE}/admin/auctions/{draft_id}/launch", json={},
        headers=auth, timeout=10,
    )
    ok = r.status_code == 422
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    detail = body.get("detail") if isinstance(body, dict) else None
    code_ok = (
        isinstance(detail, dict)
        and detail.get("code") == "LAUNCH_NOT_READY"
        and isinstance(detail.get("issues"), list)
        and len(detail["issues"]) > 0
    )
    record("4a. POST /launch on unready draft → 422 LAUNCH_NOT_READY", ok and code_ok,
           f"status={r.status_code} detail={detail}")

    # Upload 3 media + set featured
    media_ids: List[str] = []
    for _ in range(3):
        m = upload_media(op_token, draft_car_id, section="exterior")
        media_ids.append(m["id"])
    record("4b. Uploaded 3 media via /media/upload", len(media_ids) == 3,
           f"media_ids={media_ids}")
    set_featured(op_token, draft_car_id, media_ids[0])
    record("4c. Set featured via POST /cars/{car_id}/media/featured/{media_id}",
           True, f"featured_media={media_ids[0]}")

    r = requests.get(f"{BASE}/admin/auctions/{draft_id}/launch-readiness",
                     headers=auth, timeout=10)
    readiness_ready = r.json() if r.status_code == 200 else {}
    ok = (
        readiness_ready.get("ready") is True
        and readiness_ready.get("media_count", 0) >= 3
        and readiness_ready.get("featured_count", 0) >= 1
    )
    record("4d. Re-check /launch-readiness → ready=true", ok,
           f"ready={readiness_ready.get('ready')} media_count={readiness_ready.get('media_count')} "
           f"featured_count={readiness_ready.get('featured_count')} issues={readiness_ready.get('issues')}")

    before_launch_ts = datetime.utcnow()
    r = requests.post(
        f"{BASE}/admin/auctions/{draft_id}/launch", json={},
        headers=auth, timeout=10,
    )
    ok = r.status_code == 200
    body = r.json() if ok else {}
    launched_at = body.get("launched_at")
    auc = body.get("auction") or {}
    success_flag = body.get("success") is True
    status_live = auc.get("status") == "live"

    delta_min = None
    delta_start = None
    timing_ok = False
    try:
        st = datetime.fromisoformat((auc.get("start_time") or "").replace("Z", "+00:00")).replace(tzinfo=None)
        et = datetime.fromisoformat((auc.get("end_time") or "").replace("Z", "+00:00")).replace(tzinfo=None)
        delta_min = (et - st).total_seconds() / 60.0
        delta_start = abs((st - before_launch_ts).total_seconds())
        timing_ok = (55 <= delta_min <= 65) and (delta_start < 60)
    except Exception as e:
        print("    [warn] timing parse fail:", e)

    record("4e. POST /launch on ready draft → 200, status=live, timestamps OK",
           ok and success_flag and status_live and bool(launched_at) and timing_ok,
           f"status_code={r.status_code} success={success_flag} auction.status={auc.get('status')} "
           f"launched_at={launched_at} start={auc.get('start_time')} end={auc.get('end_time')} "
           f"duration_min={delta_min} start_drift_s={delta_start}")

    # ---- 5. Double-launch idempotency ----
    r = requests.post(
        f"{BASE}/admin/auctions/{draft_id}/launch", json={},
        headers=auth, timeout=10,
    )
    ok = r.status_code == 409
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    record("5. Double-launch on already-live auction → 409",
           ok, f"status={r.status_code} detail={body.get('detail') if isinstance(body, dict) else body}")

    # ---- 6. Now visible to dealers ----
    r = requests.get(f"{BASE}/auctions", timeout=10)
    pub_list2 = r.json() if r.status_code == 200 else []
    in_list = any(a.get("id") == draft_id for a in pub_list2)
    record("6a. Launched auction now appears in GET /auctions (anon)",
           in_list, f"status={r.status_code} list_size={len(pub_list2)} present={in_list}")

    r = requests.get(f"{BASE}/auctions/{draft_id}", timeout=10)
    ok = r.status_code == 200
    body = r.json() if ok else {}
    car = body.get("car") or {}
    media_list = car.get("media") or []
    images_list = car.get("images") or []
    images_resolved = all(
        (isinstance(u, str) and ("/api/media/" in u or u.startswith("http"))) for u in images_list
    ) if images_list else False
    no_unsplash_placeholder = not any(
        isinstance(u, str) and "unsplash.com" in u for u in images_list
    )
    record(
        "6b. GET /auctions/{id} returns status=live with media[]+images resolved",
        ok and body.get("status") == "live" and len(media_list) >= 3
        and images_resolved and no_unsplash_placeholder,
        f"status={body.get('status')} media_count={len(media_list)} images={len(images_list)} "
        f"images_resolved={images_resolved} unsplash_present={not no_unsplash_placeholder} "
        f"sample_url={(images_list or ['<none>'])[0]}",
    )

    # ---- 7. Duration override ----
    res2 = create_car_draft(op_token, suffix="DR002")
    draft2_id = res2["auction"]["id"]
    draft2_car_id = res2["car"]["id"]
    m_ids2 = []
    for _ in range(3):
        m = upload_media(op_token, draft2_car_id, section="exterior")
        m_ids2.append(m["id"])
    set_featured(op_token, draft2_car_id, m_ids2[0])

    r = requests.post(
        f"{BASE}/admin/auctions/{draft2_id}/launch",
        json={"duration_minutes": 5}, headers=auth, timeout=10,
    )
    ok = r.status_code == 200
    body = r.json() if ok else {}
    auc2 = body.get("auction") or {}
    delta_min2 = None
    timing_ok = False
    try:
        st = datetime.fromisoformat((auc2.get("start_time") or "").replace("Z", "+00:00")).replace(tzinfo=None)
        et = datetime.fromisoformat((auc2.get("end_time") or "").replace("Z", "+00:00")).replace(tzinfo=None)
        delta_min2 = (et - st).total_seconds() / 60.0
        timing_ok = 4.5 <= delta_min2 <= 5.5
    except Exception:
        pass
    record("7. POST /launch with duration_minutes=5 → end-start ≈ 5 min",
           ok and timing_ok,
           f"status={r.status_code} duration_min={delta_min2}")

    # ---- Regression sanity ----
    for path, hdrs, label in [
        ("/auctions", {}, "GET /auctions anon"),
        ("/auctions", auth, "GET /auctions auth"),
        ("/admin/realtime/health", auth, "GET /admin/realtime/health"),
        ("/dashboard/stats", auth, "GET /dashboard/stats"),
    ]:
        r = requests.get(f"{BASE}{path}", headers=hdrs, timeout=10)
        ok = r.status_code < 500
        record(f"R. {label} no 5xx", ok, f"status={r.status_code}")

    # ---- Summary ----
    total = len(results)
    failed = [r for r in results if not r[1]]
    print()
    print("=" * 70)
    print(f"SUMMARY: {total - len(failed)}/{total} passed")
    if failed:
        print("FAILURES:")
        for name, _, detail in failed:
            print(f"  ❌ {name} — {detail}")
    print("=" * 70)
    return len(failed) == 0


if __name__ == "__main__":
    try:
        ok = run()
        sys.exit(0 if ok else 1)
    except Exception as e:
        traceback.print_exc()
        sys.exit(2)
