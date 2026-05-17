#!/usr/bin/env python3
"""RUN 48 — Inspection versioning + history + post-launch flag + data integrity.

Target: http://localhost:8001/api · Operator +918977986662 OTP 123456
(DEV_BYPASS_OTP=true is set in /app/backend/.env for the duration of the run).

This harness exercises §1 through §8 of the RUN 48 review spec.
"""
import asyncio
import json
import os
import random
import re
import string
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx
import websockets

API_BASE = "http://localhost:8001/api"
OPERATOR_PHONE = "+918977986662"
DEALER_PHONE = "+919900000001"
OTP = "123456"
TIMEOUT = 30.0

PASS, FAIL = [], []

def _log(tag: str, ok: bool, msg: str) -> None:
    bucket = PASS if ok else FAIL
    bucket.append((tag, msg))
    marker = "PASS" if ok else "FAIL"
    print(f"  [{marker}] {tag}: {msg}")


def _check(tag: str, cond: bool, msg: str) -> bool:
    _log(tag, cond, msg)
    return cond


def _rand_reg() -> str:
    suffix = "".join(random.choices(string.ascii_uppercase, k=2)) + "".join(random.choices(string.digits, k=4))
    return f"MH48{suffix}"


async def _login(client: httpx.AsyncClient, phone: str, channel: str) -> Optional[Dict[str, Any]]:
    r = await client.post(f"{API_BASE}/auth/{channel}/send-otp", json={"phone": phone})
    if r.status_code != 200:
        print(f"  send-otp failed for {phone}: {r.status_code} {r.text}")
        return None
    r = await client.post(f"{API_BASE}/auth/{channel}/verify-otp", json={"phone": phone, "otp": OTP})
    if r.status_code != 200:
        print(f"  verify-otp failed for {phone}: {r.status_code} {r.text}")
        return None
    return r.json()


async def _create_draft_car(client: httpx.AsyncClient, op_headers: Dict[str, str], reg: str) -> Tuple[str, str]:
    payload = {
        "make": "Hyundai",
        "model": "Verna",
        "variant": "SX(O)",
        "year": 2023,
        "manufacturing_year": 2023,
        "registration_year": 2023,
        "kms": 18000,
        "km_driven": 18000,
        "fuel": "Petrol",
        "fuel_type": "Petrol",
        "transmission": "Manual",
        "color": "Phantom Black",
        "city": "Mumbai",
        "registration_number": reg,
        "starting_bid": 600000,
        "reserve_price": 700000,
        "duration_minutes": 60,   # default duration → draft
        "rto_details": "MH02 - Mumbai West",
        "notes": "Single-owner, dealer-driven only.",
    }
    r = await client.post(f"{API_BASE}/cars", json=payload, headers=op_headers)
    assert r.status_code == 200, f"POST /cars failed: {r.status_code} {r.text}"
    j = r.json()
    return j["car"]["id"], j["auction"]["id"]


def _full_inspection_payload(score: float) -> Dict[str, Any]:
    return {
        "sections": {
            "exterior":   {"completed": True, "score": score, "notes": "no scratches"},
            "interior":   {"completed": True, "score": score, "notes": "spotless"},
            "mechanical": {"completed": True, "score": score, "notes": "runs clean"},
        },
        "accident_history": "No accidents reported",
        "tyre_condition":   "Excellent",
        "service_history":  "Authorised - Hyundai",
    }


async def section_1_versioning(client: httpx.AsyncClient, op_headers: Dict[str, str]) -> Tuple[str, str]:
    print("\n=== §1 Versioning ===")
    car_id, auction_id = await _create_draft_car(client, op_headers, _rand_reg())
    _check("§1.0 draft car created", bool(car_id), f"car_id={car_id[:8]} aid={auction_id[:8]}")

    # First PUT, score=9
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(9), headers=op_headers)
    _check("§1.1 PUT inspection v1 status", r.status_code == 200, f"HTTP {r.status_code}")
    j = r.json()
    _check("§1.2 response.version == 1", j.get("version") == 1, f"version={j.get('version')}")
    created_at_v1 = j.get("created_at")
    updated_at_v1 = j.get("updated_at")

    # Sleep so updated_at definitely advances
    await asyncio.sleep(1.05)

    # Second PUT, score=7
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(7), headers=op_headers)
    _check("§1.3 PUT inspection v2 status", r.status_code == 200, f"HTTP {r.status_code}")
    j2 = r.json()
    _check("§1.4 response.version == 2", j2.get("version") == 2, f"version={j2.get('version')}")
    _check("§1.5 score updated", j2.get("inspection_score") == 7.0,
           f"score={j2.get('inspection_score')}")

    # GET inspection
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection")
    _check("§1.6 GET inspection status", r.status_code == 200, f"HTTP {r.status_code}")
    g = r.json()
    _check("§1.7 GET version == 2", g.get("version") == 2, f"version={g.get('version')}")
    _check("§1.8 updated_by present", bool(g.get("updated_by")), f"updated_by={g.get('updated_by')!r}")
    _check("§1.9 updated_at advanced", str(g.get("updated_at")) > str(created_at_v1),
           f"updated_at={g.get('updated_at')} created_at={created_at_v1}")
    return car_id, auction_id


async def section_2_audit_trail(client: httpx.AsyncClient, op_headers: Dict[str, str],
                                car_id: str) -> None:
    print("\n=== §2 Audit trail ===")
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection/history")
    if not _check("§2.1 history status", r.status_code == 200, f"HTTP {r.status_code} body={r.text[:300]}"):
        print("    [skipping rest of §2 — endpoint broken]")
        return
    h = r.json()
    _check("§2.2 history shape keys",
           set(h.keys()) >= {"car_id", "count", "entries"},
           f"keys={list(h.keys())}")
    _check("§2.3 count == 2", h.get("count") == 2, f"count={h.get('count')}")
    entries = h.get("entries", [])
    _check("§2.4 entries length == 2", len(entries) == 2, f"len={len(entries)}")

    # newest first
    e0 = entries[0]
    e1 = entries[1]
    _check("§2.5 entries[0].version == 2", e0.get("version") == 2, f"v={e0.get('version')}")
    _check("§2.6 entries[0].previous_version == 1",
           e0.get("previous_version") == 1, f"pv={e0.get('previous_version')}")
    _check("§2.7 entries[0].previous_values not null",
           e0.get("previous_values") is not None, f"pv_keys={list((e0.get('previous_values') or {}).keys())}")
    nv = e0.get("new_values") or {}
    expected_nv_keys = {"inspection_score", "condition_grade", "tyre_condition",
                       "accident_history", "service_history", "liquidity_rating",
                       "completion_percentage", "sections"}
    _check("§2.8 entries[0].new_values has 8 expected keys",
           set(nv.keys()) == expected_nv_keys,
           f"nv_keys={sorted(nv.keys())} missing={sorted(expected_nv_keys - set(nv.keys()))}")
    diff = e0.get("diff") or {}
    changes = diff.get("changes") or []
    _check("§2.9 diff.changes is non-empty list",
           isinstance(changes, list) and len(changes) > 0,
           f"changes_len={len(changes)}")
    _check("§2.10 actor_id/name/role present",
           bool(e0.get("actor_id")) and bool(e0.get("actor_name")) and bool(e0.get("actor_role")),
           f"actor_id={e0.get('actor_id')!r} name={e0.get('actor_name')!r} role={e0.get('actor_role')!r}")
    ts = e0.get("timestamp")
    iso_re = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
    _check("§2.11 timestamp ISO-formatted",
           isinstance(ts, str) and bool(iso_re.match(ts)),
           f"timestamp={ts!r}")

    _check("§2.12 entries[1].version == 1", e1.get("version") == 1, f"v={e1.get('version')}")
    _check("§2.13 entries[1].previous_version == 0",
           e1.get("previous_version") == 0, f"pv={e1.get('previous_version')}")
    _check("§2.14 entries[1].previous_values == null",
           e1.get("previous_values") is None, f"pv={e1.get('previous_values')!r}")

    # Third PUT
    await asyncio.sleep(1.05)
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(8), headers=op_headers)
    _check("§2.15 3rd PUT status", r.status_code == 200, f"HTTP {r.status_code}")
    _check("§2.16 3rd PUT version == 3",
           r.json().get("version") == 3, f"v={r.json().get('version')}")

    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection/history")
    h = r.json()
    _check("§2.17 history count == 3 after 3rd PUT",
           h.get("count") == 3, f"count={h.get('count')}")
    entries = h.get("entries", [])
    _check("§2.18 newest first (entries[0].version == 3)",
           entries[0].get("version") == 3, f"v0={entries[0].get('version')}")

    # limit=1
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection/history?limit=1")
    h = r.json()
    _check("§2.19 limit=1 honoured (count==1)",
           h.get("count") == 1 and len(h.get("entries", [])) == 1,
           f"count={h.get('count')} len={len(h.get('entries', []))}")


async def section_3_post_launch(client: httpx.AsyncClient, op_headers: Dict[str, str],
                                op_id: str, dealer_headers: Dict[str, str]) -> Tuple[str, str]:
    print("\n=== §3 Post-launch flag ===")
    car_id, auction_id = await _create_draft_car(client, op_headers, _rand_reg())
    _check("§3.0 draft car created", True, f"car_id={car_id[:8]} aid={auction_id[:8]}")

    # PUT inspection while still draft
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(8), headers=op_headers)
    _check("§3.1 PUT inspection on draft → 200", r.status_code == 200, f"HTTP {r.status_code}")

    # GET auction; should not be flagged
    r = await client.get(f"{API_BASE}/auctions/{auction_id}")
    a = r.json()
    _check("§3.2 inspection_updated_after_launch=False on draft",
           a.get("inspection_updated_after_launch") is False,
           f"flag={a.get('inspection_updated_after_launch')!r} status={a.get('status')}")

    # Upload 3 photos via /media/upload + set featured
    media_ids: List[str] = []
    # Generate a minimal valid JPEG using PIL
    try:
        from PIL import Image
        import io as _io
        _buf = _io.BytesIO()
        Image.new("RGB", (64, 64), color=(120, 80, 40)).save(_buf, format="JPEG", quality=70)
        jpeg_bytes = _buf.getvalue()
    except Exception as _e:
        # Fallback minimal JPEG header (won't pass image validators but...)
        jpeg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
    for i in range(3):
        files = {"file": (f"photo{i}.jpg", jpeg_bytes, "image/jpeg")}
        data = {"car_id": car_id, "section": "exterior"}
        r = await client.post(f"{API_BASE}/media/upload", files=files, data=data, headers=op_headers)
        if r.status_code == 200:
            media_ids.append(r.json()["id"])
        else:
            print(f"    media upload {i} failed: {r.status_code} {r.text[:200]}")
    _check("§3.3 3 photos uploaded", len(media_ids) == 3, f"uploaded={len(media_ids)}")

    if media_ids:
        r = await client.post(f"{API_BASE}/cars/{car_id}/media/featured/{media_ids[0]}",
                              headers=op_headers)
        _check("§3.4 set featured", r.status_code == 200, f"HTTP {r.status_code}")

    # Launch
    r = await client.post(f"{API_BASE}/admin/auctions/{auction_id}/launch",
                          json={"duration_minutes": 60}, headers=op_headers)
    _check("§3.5 launch auction → 200", r.status_code == 200, f"HTTP {r.status_code} body={r.text[:300]}")

    r = await client.get(f"{API_BASE}/auctions/{auction_id}")
    a = r.json()
    _check("§3.6 auction.status == live", a.get("status") == "live", f"status={a.get('status')}")

    # PUT inspection while live
    await asyncio.sleep(0.5)
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(6), headers=op_headers)
    _check("§3.7 PUT inspection on live → 200", r.status_code == 200, f"HTTP {r.status_code}")

    # GET auction anon
    r = await client.get(f"{API_BASE}/auctions/{auction_id}")
    a_anon = r.json()
    _check("§3.8a anon inspection_updated_after_launch == True",
           a_anon.get("inspection_updated_after_launch") is True,
           f"flag={a_anon.get('inspection_updated_after_launch')!r}")
    _check("§3.8b anon inspection_last_updated_at is a timestamp",
           bool(a_anon.get("inspection_last_updated_at")),
           f"ts={a_anon.get('inspection_last_updated_at')!r}")

    # GET auction dealer
    r = await client.get(f"{API_BASE}/auctions/{auction_id}", headers=dealer_headers)
    a_dealer = r.json()
    _check("§3.9a dealer inspection_updated_after_launch == True",
           a_dealer.get("inspection_updated_after_launch") is True,
           f"flag={a_dealer.get('inspection_updated_after_launch')!r}")
    _check("§3.9b dealer inspection_last_updated_at present",
           bool(a_dealer.get("inspection_last_updated_at")),
           f"ts={a_dealer.get('inspection_last_updated_at')!r}")

    # GET history → newest entry should have post_launch=True, auction_status_at_update="live"
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection/history")
    if r.status_code != 200:
        _check("§3.10 history endpoint reachable", False,
               f"HTTP {r.status_code} — cannot verify post_launch flag in history")
        return car_id, auction_id
    h = r.json()
    e0 = (h.get("entries") or [{}])[0]
    _check("§3.10 newest entry post_launch == True",
           e0.get("post_launch") is True,
           f"post_launch={e0.get('post_launch')!r}")
    _check("§3.11 newest entry auction_status_at_update == 'live'",
           e0.get("auction_status_at_update") == "live",
           f"status_at_update={e0.get('auction_status_at_update')!r}")

    return car_id, auction_id


async def section_4_integrity(client: httpx.AsyncClient, op_headers: Dict[str, str]) -> str:
    print("\n=== §4 Data-integrity gate ===")
    car_id, _ = await _create_draft_car(client, op_headers, _rand_reg())

    # 4.1 Empty body → 422 INSPECTION_EMPTY_NOT_ALLOWED
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection", json={}, headers=op_headers)
    _check("§4.1a empty body → 422", r.status_code == 422, f"HTTP {r.status_code}")
    body = r.json()
    detail = body.get("detail")
    code_match = isinstance(detail, dict) and detail.get("code") == "INSPECTION_EMPTY_NOT_ALLOWED"
    _check("§4.1b detail.code == INSPECTION_EMPTY_NOT_ALLOWED", code_match,
           f"detail={detail!r}")

    # 4.2 One completed section, no score → 200
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json={"sections": {"exterior": {"completed": True}}}, headers=op_headers)
    _check("§4.2 partial (completed only) → 200", r.status_code == 200, f"HTTP {r.status_code}")

    # 4.3 Only free text → 200
    car_id_3, _ = await _create_draft_car(client, op_headers, _rand_reg())
    r = await client.put(f"{API_BASE}/cars/{car_id_3}/inspection",
                         json={"accident_history": "hit a kerb"}, headers=op_headers)
    _check("§4.3 free-text only → 200", r.status_code == 200, f"HTTP {r.status_code}")

    # 4.4 All sections completed=false AND all text fields null AND no scores → 422
    car_id_4, _ = await _create_draft_car(client, op_headers, _rand_reg())
    r = await client.put(f"{API_BASE}/cars/{car_id_4}/inspection",
                         json={"sections": {"exterior": {"completed": False},
                                            "interior": {"completed": False}},
                               "accident_history": None,
                               "tyre_condition": None,
                               "service_history": None},
                         headers=op_headers)
    _check("§4.4 all-false + null text → 422", r.status_code == 422,
           f"HTTP {r.status_code} body={r.text[:200]}")
    return car_id


async def section_5_backfill(client: httpx.AsyncClient) -> None:
    print("\n=== §5 Backfill idempotency ===")
    # Use Mongo directly via Python client.
    from motor.motor_asyncio import AsyncIOMotorClient
    mc = AsyncIOMotorClient("mongodb://localhost:27017")
    db = mc["qdrives_db"]

    before = await db.inspections.count_documents({})
    _check("§5.1 db.inspections count read", isinstance(before, int), f"before={before}")

    # Restart backend
    print("    restarting backend...")
    os.system("sudo supervisorctl restart backend > /dev/null 2>&1")
    await asyncio.sleep(7)

    after = await db.inspections.count_documents({})
    _check("§5.2 count unchanged after restart",
           before == after, f"before={before} after={after}")

    # Confirm /api/ is back up
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.get(f"{API_BASE}/")
            _check("§5.3 backend up after restart", r.status_code == 200, f"HTTP {r.status_code}")
        except Exception as e:
            _check("§5.3 backend up after restart", False, str(e))

    # Grep backend.err.log for "[startup] legacy inspection backfill"
    import subprocess
    try:
        out = subprocess.run(
            "tail -n 200 /var/log/supervisor/backend.err.log",
            shell=True, capture_output=True, text=True
        ).stdout
        # Find the LAST startup line and check if a backfill line appears AFTER it.
        startup_indices = [i for i, line in enumerate(out.splitlines())
                           if "Application startup complete" in line]
        backfill_lines = [line for line in out.splitlines()
                          if "legacy inspection backfill" in line]
        most_recent_backfill = backfill_lines[-1] if backfill_lines else None
        # Get the most recent boot's backfill line, if any
        last_startup_idx = startup_indices[-1] if startup_indices else -1
        boot_lines = out.splitlines()[max(0, last_startup_idx - 10): last_startup_idx + 2]
        recent_backfill_count = sum(1 for ln in boot_lines if "legacy inspection backfill" in ln)
        # Spec: should NOT appear in most recent boot OR should say 0 records
        ok = recent_backfill_count == 0
        if not ok and most_recent_backfill:
            # also OK if it says "synthesised 0 records"
            ok = "synthesised 0 records" in most_recent_backfill
        _check("§5.4 no new backfill on restart", ok,
               f"recent_backfill_count={recent_backfill_count} last={most_recent_backfill!r}")
    except Exception as e:
        _check("§5.4 no new backfill on restart", False, f"grep failed: {e}")


async def section_6_role_parity(client: httpx.AsyncClient,
                                op_headers: Dict[str, str],
                                dealer_headers: Dict[str, str],
                                car_id: str, auction_id: str) -> None:
    print("\n=== §6 Cross-role parity ===")
    # GET /api/cars/{id}/inspection: byte-identical across roles
    r_anon = await client.get(f"{API_BASE}/cars/{car_id}/inspection")
    r_dealer = await client.get(f"{API_BASE}/cars/{car_id}/inspection", headers=dealer_headers)
    r_op = await client.get(f"{API_BASE}/cars/{car_id}/inspection", headers=op_headers)
    _check("§6.1 all 3 GETs status 200",
           r_anon.status_code == 200 and r_dealer.status_code == 200 and r_op.status_code == 200,
           f"anon={r_anon.status_code} dealer={r_dealer.status_code} op={r_op.status_code}")
    _check("§6.2 anon == dealer body",
           r_anon.content == r_dealer.content,
           f"anon_len={len(r_anon.content)} dealer_len={len(r_dealer.content)}")
    _check("§6.3 anon == operator body",
           r_anon.content == r_op.content,
           f"anon_len={len(r_anon.content)} op_len={len(r_op.content)}")

    # GET /api/auctions/{aid}: car.inspection.version + car.inspection.updated_by present
    r = await client.get(f"{API_BASE}/auctions/{auction_id}")
    a = r.json()
    insp = (a.get("car") or {}).get("inspection") or {}
    _check("§6.4 car.inspection.version present",
           "version" in insp and insp.get("version") is not None,
           f"version={insp.get('version')!r} insp_keys={sorted(insp.keys())}")
    _check("§6.5 car.inspection.updated_by present",
           "updated_by" in insp and insp.get("updated_by") is not None,
           f"updated_by={insp.get('updated_by')!r}")


async def section_7_ws(client: httpx.AsyncClient, op_headers: Dict[str, str],
                       dealer_token: str, car_id: str, auction_id: str) -> None:
    print("\n=== §7 WS broadcast ===")
    ws_url = f"ws://localhost:8001/api/ws/auction/{auction_id}?token={dealer_token}"

    # 7a — Listen for inspection_updated within 3s after PUT
    inspection_updated_received = False
    snapshot_received = False
    try:
        async with websockets.connect(ws_url, open_timeout=5) as ws:
            # Drain snapshot first
            try:
                snap = await asyncio.wait_for(ws.recv(), timeout=3.0)
                snapshot_received = True
                # not strictly required to parse
            except asyncio.TimeoutError:
                pass

            # PUT inspection
            async def do_put():
                await asyncio.sleep(0.3)
                await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                                 json=_full_inspection_payload(5), headers=op_headers)

            put_task = asyncio.create_task(do_put())

            deadline = time.time() + 5.0
            while time.time() < deadline:
                try:
                    frame = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                except asyncio.TimeoutError:
                    break
                try:
                    data = json.loads(frame)
                except Exception:
                    continue
                if data.get("type") == "inspection_updated":
                    inspection_updated_received = True
                    break
            await put_task
    except Exception as e:
        _check("§7.1 WS connection", False, f"WS error: {e}")

    _check("§7.1 snapshot received on connect", snapshot_received, "ok" if snapshot_received else "missing")
    _check("§7.2 inspection_updated frame received within 5s",
           inspection_updated_received, "received" if inspection_updated_received else "NOT received")

    # 7b — Disconnect, PUT again, reconnect → snapshot reflects latest
    # Capture current values via GET first
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection")
    pre_disc = r.json()

    await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                     json=_full_inspection_payload(4), headers=op_headers)
    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection")
    new_version = r.json().get("version")

    reconnect_snapshot_version = None
    reconnect_snapshot = None
    try:
        async with websockets.connect(ws_url, open_timeout=5) as ws2:
            try:
                snap = await asyncio.wait_for(ws2.recv(), timeout=4.0)
                reconnect_snapshot = json.loads(snap)
            except Exception:
                pass
    except Exception as e:
        _check("§7.3 reconnect WS", False, f"err: {e}")
        return

    if reconnect_snapshot:
        # Try to dig out the inspection version from the snapshot
        a = reconnect_snapshot.get("auction") or {}
        insp_block = ((a.get("car") or {}).get("inspection") or {})
        reconnect_snapshot_version = insp_block.get("version") or a.get("inspection_version")

    _check("§7.3 reconnect snapshot received",
           reconnect_snapshot is not None,
           f"keys={list((reconnect_snapshot or {}).keys())}")
    _check("§7.4 reconnect snapshot reflects latest inspection version",
           reconnect_snapshot_version == new_version,
           f"snap_version={reconnect_snapshot_version} new_version={new_version}")


async def section_8_regression(client: httpx.AsyncClient, op_headers: Dict[str, str],
                               dealer_headers: Dict[str, str],
                               auction_id_live: str) -> None:
    print("\n=== §8 Regression ===")
    # 8.1 duration_minutes constraints
    bad_low = {"make": "Tata", "model": "Punch", "year": 2023, "manufacturing_year": 2023,
               "registration_year": 2023, "kms": 1000, "fuel": "Petrol", "transmission": "Manual",
               "color": "Red", "city": "Mumbai", "registration_number": _rand_reg(),
               "starting_bid": 300000, "duration_minutes": 4}
    r = await client.post(f"{API_BASE}/cars", json=bad_low, headers=op_headers)
    _check("§8.1a duration=4 → 422", r.status_code == 422, f"HTTP {r.status_code}")

    bad_high = {**bad_low, "registration_number": _rand_reg(), "duration_minutes": 20161}
    r = await client.post(f"{API_BASE}/cars", json=bad_high, headers=op_headers)
    _check("§8.1b duration=20161 → 422", r.status_code == 422, f"HTTP {r.status_code}")

    # 8.2 bid placement on live auction
    r = await client.get(f"{API_BASE}/auctions/{auction_id_live}")
    a = r.json()
    cur = a.get("current_bid") or a.get("starting_bid") or 600000
    bid_amt = int(cur) + 5000
    r = await client.post(f"{API_BASE}/auctions/{auction_id_live}/bid",
                          json={"amount": bid_amt}, headers=dealer_headers)
    if r.status_code != 200:
        # try operator (some setups disallow operator bidding); dealer should work
        print(f"    bid response: {r.status_code} {r.text[:200]}")
    _check("§8.2 bid placement on live → 200", r.status_code == 200,
           f"HTTP {r.status_code} body={r.text[:200]}")

    # 8.3 PDF upload preserves sections
    car_id, _ = await _create_draft_car(client, op_headers, _rand_reg())
    # Put inspection first
    r = await client.put(f"{API_BASE}/cars/{car_id}/inspection",
                         json=_full_inspection_payload(8), headers=op_headers)
    _check("§8.3a inspection PUT before PDF", r.status_code == 200, f"HTTP {r.status_code}")

    # Upload PDF
    pdf_bytes = b"%PDF-1.4\n%pdfheader\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + b" " * 250
    files = {"file": ("test.pdf", pdf_bytes, "application/pdf")}
    data = {"car_id": car_id}
    r = await client.post(f"{API_BASE}/inspections/upload", files=files, data=data, headers=op_headers)
    _check("§8.3b PDF upload → 200", r.status_code == 200, f"HTTP {r.status_code} {r.text[:200]}")

    r = await client.get(f"{API_BASE}/cars/{car_id}/inspection")
    g = r.json()
    sections = g.get("sections") or {}
    _check("§8.3c sections preserved after PDF",
           bool(sections.get("exterior", {}).get("completed")) and
           sections.get("exterior", {}).get("score") == 8.0,
           f"exterior={sections.get('exterior')!r}")


async def main() -> int:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        print("Logging in operator + dealer...")
        op_login = await _login(client, OPERATOR_PHONE, "operator")
        if not op_login:
            print("operator login failed — abort")
            return 1
        dealer_login = await _login(client, DEALER_PHONE, "dealer")
        if not dealer_login:
            print("dealer login failed — abort")
            return 1
        op_token = op_login["token"]
        dealer_token = dealer_login["token"]
        op_headers = {"Authorization": f"Bearer {op_token}"}
        dealer_headers = {"Authorization": f"Bearer {dealer_token}"}
        op_id = op_login["dealer"]["id"]

        # §1
        car_id_1, auction_id_1 = await section_1_versioning(client, op_headers)
        # §2
        await section_2_audit_trail(client, op_headers, car_id_1)
        # §3
        car_id_3, auction_id_3 = await section_3_post_launch(client, op_headers, op_id, dealer_headers)
        # §4
        await section_4_integrity(client, op_headers)
        # §6 — before §5 (which restarts backend; tokens still valid since tv unchanged)
        await section_6_role_parity(client, op_headers, dealer_headers, car_id_3, auction_id_3)
        # §7
        await section_7_ws(client, op_headers, dealer_token, car_id_3, auction_id_3)
        # §8
        await section_8_regression(client, op_headers, dealer_headers, auction_id_3)
        # §5 (last — restarts backend)
        await section_5_backfill(client)

    print("\n" + "=" * 60)
    print(f"SUMMARY: PASS={len(PASS)}  FAIL={len(FAIL)}")
    if FAIL:
        print("\nFAILURES:")
        for t, m in FAIL:
            print(f"  ❌ {t}: {m}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    code = asyncio.run(main())
    sys.exit(code)
