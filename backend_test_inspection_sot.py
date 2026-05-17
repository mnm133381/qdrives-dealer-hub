"""
RUN 46 — Inspection Single-Source-of-Truth E2E tests.

Live backend target: http://localhost:8001/api
Auth: operator +918977986662 / OTP 123456 (DEV_BYPASS_OTP=true)
      dealer   +919900000001 / OTP 123456

Spec covers §1-§10 from the RUN 46 review request.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import string
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx
import websockets

BASE = os.environ.get("QDRIVES_TEST_BASE", "http://localhost:8001/api")
WS_BASE = os.environ.get("QDRIVES_WS_BASE", "ws://localhost:8001/api")

OPERATOR_PHONE = "+918977986662"
DEALER_PHONE   = "+919900000001"
OTP            = "123456"

# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
results: List[Tuple[str, bool, str]] = []

def record(name: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {name}: {detail}")
    results.append((name, ok, detail))

def must(cond: bool, name: str, detail: str = "") -> bool:
    record(name, cond, detail)
    return cond

def rand_reg() -> str:
    nums = "".join(random.choices(string.digits, k=4))
    return f"TS09AB{nums}"

def login(phone: str) -> Dict[str, Any]:
    endpoint = "/auth/operator/verify-otp" if phone == OPERATOR_PHONE else "/auth/dealer/verify-otp"
    r = httpx.post(BASE + endpoint, json={"phone": phone, "otp": OTP}, timeout=20)
    r.raise_for_status()
    return r.json()

def headers(tok: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}

def create_draft_car(op_tok: str, **overrides) -> Tuple[str, str]:
    """POST /api/cars (draft). Returns (car_id, auction_id)."""
    body = {
        "registration_number": overrides.get("registration_number", rand_reg()),
        "make": "Honda", "model": "City", "variant": "ZX CVT",
        "year": 2022, "manufacturing_year": 2022, "registration_year": 2022,
        "fuel_type": "Petrol", "transmission": "Automatic",
        "km_driven": 32450, "color": "Pearl White", "owners": 1,
        "reserve_price": overrides.get("reserve_price", 550000),
        "starting_bid":  overrides.get("starting_bid", 500000),
        "duration_minutes": overrides.get("duration_minutes", 60),
        "launch_immediately": False,
    }
    for k, v in overrides.items():
        if k not in body:
            body[k] = v
    r = httpx.post(BASE + "/cars", json=body, headers=headers(op_tok), timeout=20)
    r.raise_for_status()
    j = r.json()
    return j["car"]["id"], j["auction"]["id"]


def section_payload_full() -> Dict[str, Any]:
    return {
        "sections": {
            "exterior":   {"completed": True, "score": 9, "notes": "flawless paint"},
            "interior":   {"completed": True, "score": 9},
            "mechanical": {"completed": True, "score": 8},
            "tyres":      {"completed": True, "score": 9},
            "documents":  {"completed": True, "rc": True, "insurance": True, "puc": True},
            "photos":     {"completed": True, "photo_count": 12},
        },
        "accident_history": None,
        "tyre_condition":   "Good",
        "service_history":  "Authorised - Honda",
    }


# ---------------------------------------------------------------------
# Pre-flight: auth
# ---------------------------------------------------------------------
print("\n=== PRE-FLIGHT: auth ===")
op_auth = login(OPERATOR_PHONE)
OP_TOK = op_auth["token"]
OP_ID  = op_auth["dealer"]["id"]
record("operator login (+918977986662)", op_auth["dealer"]["role"] in ("super_admin", "admin"),
       f"role={op_auth['dealer']['role']} id={OP_ID}")

dl_auth = login(DEALER_PHONE)
DL_TOK = dl_auth["token"]
DL_ID  = dl_auth["dealer"]["id"]
record("dealer login (+919900000001)", dl_auth["dealer"]["role"] == "dealer",
       f"role={dl_auth['dealer']['role']} id={DL_ID}")


# ---------------------------------------------------------------------
# §1 · PUT → GET round-trip
# ---------------------------------------------------------------------
print("\n=== §1 · PUT → GET round-trip ===")
car_id, auction_id = create_draft_car(OP_TOK)
record("§1.0 POST /cars draft (60min)", bool(car_id),
       f"car_id={car_id} auction_id={auction_id}")

r = httpx.put(f"{BASE}/cars/{car_id}/inspection", json=section_payload_full(),
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§1.1 PUT /cars/{id}/inspection HTTP", f"got {r.status_code}: {r.text[:200]}")
put_body = r.json()
must(put_body.get("inspection_score") == 8.8, "§1.1a PUT response inspection_score≈8.8",
     f"got {put_body.get('inspection_score')}")
must(put_body.get("condition_grade") == "B", "§1.1b PUT condition_grade=B",
     f"got {put_body.get('condition_grade')}")

r = httpx.get(f"{BASE}/cars/{car_id}/inspection", timeout=20)
must(r.status_code == 200, "§1.2 GET /cars/{id}/inspection HTTP", f"got {r.status_code}")
g = r.json()
must(abs(float(g.get("inspection_score") or 0) - 8.8) < 0.01, "§1.3 inspection_score=8.8",
     f"got {g.get('inspection_score')}")
must(g.get("condition_grade") == "B", "§1.4 condition_grade=B", f"got {g.get('condition_grade')}")
must(g.get("liquidity_rating") == "HIGH", "§1.5 liquidity=HIGH", f"got {g.get('liquidity_rating')}")
must(g.get("completion_percentage") == 100, "§1.6 completion=100",
     f"got {g.get('completion_percentage')}")
sec_done = set(g.get("sections_completed") or [])
expected_sec = {"exterior","interior","mechanical","tyres","documents","photos"}
must(sec_done == expected_sec, "§1.7 all 6 sections completed",
     f"got {sorted(sec_done)}")
must((g.get("sections", {}).get("exterior") or {}).get("notes") == "flawless paint",
     "§1.8 exterior.notes='flawless paint'",
     f"got {(g.get('sections', {}).get('exterior') or {}).get('notes')}")
must((g.get("sections", {}).get("documents") or {}).get("rc") is True,
     "§1.9 documents.rc=true",
     f"got {(g.get('sections', {}).get('documents') or {}).get('rc')}")
must((g.get("sections", {}).get("photos") or {}).get("photo_count") == 12,
     "§1.10 photos.photo_count=12",
     f"got {(g.get('sections', {}).get('photos') or {}).get('photo_count')}")


# ---------------------------------------------------------------------
# §2 · Silent-D bug closed
# ---------------------------------------------------------------------
print("\n=== §2 · Silent-D bug ===")
car2_id, auction2_id = create_draft_car(OP_TOK)
body2 = {
    "sections": {
        "exterior":   {"completed": True, "score": 9},
        "interior":   {"completed": True, "score": 9},
        "mechanical": {"completed": True, "score": 8},
        "tyres":      {"completed": True, "score": 9},
        # documents and photos NOT scored, NOT completed (silent-D guard)
    },
}
r = httpx.put(f"{BASE}/cars/{car2_id}/inspection", json=body2,
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§2.1 PUT HTTP=200", f"got {r.status_code}")
r = httpx.get(f"{BASE}/cars/{car2_id}/inspection", timeout=20)
g2 = r.json()
must(abs(float(g2.get("inspection_score") or 0) - 8.8) < 0.01,
     "§2.2 score=8.8 (docs+photos do NOT drag average)",
     f"got {g2.get('inspection_score')}")
must(g2.get("condition_grade") == "B", "§2.3 grade=B", f"got {g2.get('condition_grade')}")
must(g2.get("liquidity_rating") == "HIGH", "§2.4 liquidity=HIGH",
     f"got {g2.get('liquidity_rating')}")
must(g2.get("completion_percentage") == 67, "§2.5 completion=67 (4/6 rounds to 67)",
     f"got {g2.get('completion_percentage')}")
sec2 = set(g2.get("sections_completed") or [])
must(sec2 == {"exterior","interior","mechanical","tyres"},
     "§2.6 documents+photos NOT in sections_completed", f"got {sorted(sec2)}")


# ---------------------------------------------------------------------
# §3 · Role parity (anon == dealer == operator byte-identical)
# ---------------------------------------------------------------------
print("\n=== §3 · Role parity ===")
r_anon = httpx.get(f"{BASE}/cars/{car_id}/inspection", timeout=20)
r_deal = httpx.get(f"{BASE}/cars/{car_id}/inspection", headers=headers(DL_TOK), timeout=20)
r_oper = httpx.get(f"{BASE}/cars/{car_id}/inspection", headers=headers(OP_TOK), timeout=20)
must(r_anon.status_code == r_deal.status_code == r_oper.status_code == 200,
     "§3.1 all 3 GETs return 200",
     f"anon={r_anon.status_code} dealer={r_deal.status_code} operator={r_oper.status_code}")
b_anon = r_anon.content
b_deal = r_deal.content
b_oper = r_oper.content
must(b_anon == b_deal == b_oper, "§3.2 byte-identical bodies for anon/dealer/operator",
     f"anon_len={len(b_anon)} deal_len={len(b_deal)} oper_len={len(b_oper)}")


# ---------------------------------------------------------------------
# §4 · _enrich_auction join
# ---------------------------------------------------------------------
print("\n=== §4 · _enrich_auction join ===")
# Use car/auction from §1 (has full inspection)
r = httpx.get(f"{BASE}/auctions/{auction_id}", timeout=20)
must(r.status_code == 200, "§4.0a GET /auctions/{aid} anon HTTP=200", f"got {r.status_code}")
ea = r.json()
car_block = (ea.get("car") or {})
insp_block = car_block.get("inspection") or {}
must(insp_block.get("inspection_score") == car_block.get("inspection_score"),
     "§4.1 car.inspection.inspection_score mirrors car.inspection_score",
     f"insp={insp_block.get('inspection_score')} flat={car_block.get('inspection_score')}")
must(insp_block.get("condition_grade") == car_block.get("condition_grade"),
     "§4.2 car.inspection.condition_grade mirrors car.condition_grade",
     f"insp={insp_block.get('condition_grade')} flat={car_block.get('condition_grade')}")
need_keys = {"sections", "accident_history", "liquidity_rating", "pdf", "updated_at"}
got_keys = set(insp_block.keys())
must(need_keys.issubset(got_keys),
     "§4.3 car.inspection has sections/accident_history/liquidity_rating/pdf/updated_at",
     f"missing={sorted(need_keys - got_keys)}")

# Authed (dealer) — same shape
r = httpx.get(f"{BASE}/auctions/{auction_id}", headers=headers(DL_TOK), timeout=20)
must(r.status_code == 200, "§4.4a GET /auctions authed dealer HTTP=200", f"got {r.status_code}")
ea2 = r.json()
insp_block2 = (ea2.get("car") or {}).get("inspection") or {}
must(insp_block2.get("inspection_score") == insp_block.get("inspection_score"),
     "§4.4 authed and anon agree on car.inspection.inspection_score",
     f"authed={insp_block2.get('inspection_score')} anon={insp_block.get('inspection_score')}")


# ---------------------------------------------------------------------
# §5 · Update path (no stale)
# ---------------------------------------------------------------------
print("\n=== §5 · Update path (no stale cache) ===")
body5 = {
    "sections": {
        "exterior":   {"completed": True, "score": 7},
        "interior":   {"completed": True, "score": 7},
        "mechanical": {"completed": True, "score": 7},
    },
}
r = httpx.put(f"{BASE}/cars/{car_id}/inspection", json=body5,
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§5.1 PUT (update) HTTP=200", f"got {r.status_code}")
g5 = httpx.get(f"{BASE}/cars/{car_id}/inspection", timeout=20).json()
must(abs(float(g5.get("inspection_score") or 0) - 7.0) < 0.01, "§5.2 score=7.0",
     f"got {g5.get('inspection_score')}")
must(g5.get("condition_grade") == "C", "§5.3 grade=C", f"got {g5.get('condition_grade')}")
must(g5.get("liquidity_rating") == "MEDIUM", "§5.4 liquidity=MEDIUM",
     f"got {g5.get('liquidity_rating')}")
must(g5.get("completion_percentage") == 50, "§5.5 completion=50 (3/6)",
     f"got {g5.get('completion_percentage')}")
# Cross-check via /auctions
r = httpx.get(f"{BASE}/auctions/{auction_id}", timeout=20)
ea5 = r.json()
car5 = ea5.get("car") or {}
must(car5.get("condition_grade") == "C", "§5.6 /auctions car.condition_grade='C' (not stale 'B')",
     f"got {car5.get('condition_grade')}")
must((car5.get("inspection") or {}).get("condition_grade") == "C",
     "§5.7 car.inspection.condition_grade='C'",
     f"got {(car5.get('inspection') or {}).get('condition_grade')}")


# ---------------------------------------------------------------------
# §6 · PDF preserves sections
# ---------------------------------------------------------------------
print("\n=== §6 · PDF upload preserves sections ===")
# Build a minimal valid PDF padded to >=200 bytes
pdf_core = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
pad = b"%" + b" " * max(0, 250 - len(pdf_core)) + b"\n"
pdf_bytes = pdf_core + pad
files = {"file": ("inspection-test.pdf", pdf_bytes, "application/pdf")}
data  = {"car_id": car_id, "version": "v1"}
r = httpx.post(f"{BASE}/inspections/upload", data=data, files=files,
               headers=headers(OP_TOK), timeout=30)
must(r.status_code == 200, "§6.1 POST /inspections/upload HTTP=200",
     f"got {r.status_code}: {r.text[:200]}")
g6 = httpx.get(f"{BASE}/cars/{car_id}/inspection", timeout=20).json()
# Sections from §5 should be preserved
ext_score = (g6.get("sections", {}).get("exterior") or {}).get("score")
must(ext_score == 7 or ext_score == 7.0, "§6.2 sections.exterior.score still 7",
     f"got {ext_score}")
pdf_obj = g6.get("pdf") or {}
must(isinstance(pdf_obj, dict) and pdf_obj.get("filename") and pdf_obj.get("status") == "verified",
     "§6.3 pdf object populated with filename + status='verified'",
     f"got {pdf_obj}")
# Auction join carries it
r = httpx.get(f"{BASE}/auctions/{auction_id}", timeout=20)
insp6 = ((r.json().get("car") or {}).get("inspection") or {})
must(bool(insp6.get("pdf")), "§6.4 car.inspection.pdf populated on /auctions",
     f"got {insp6.get('pdf')}")


# ---------------------------------------------------------------------
# §7 · Legacy flat-field seed
# ---------------------------------------------------------------------
print("\n=== §7 · Legacy flat-field seed ===")
car7_id, auction7_id = create_draft_car(
    OP_TOK,
    inspection_score=8.5,
    condition_grade="B",
    accident_history="Minor scratch front bumper",
)
g7 = httpx.get(f"{BASE}/cars/{car7_id}/inspection", timeout=20).json()
must(g7.get("inspection_score") == 8.5, "§7.1 GET inspection_score=8.5",
     f"got {g7.get('inspection_score')}")
must(g7.get("condition_grade") == "B", "§7.2 condition_grade=B (operator-supplied wins)",
     f"got {g7.get('condition_grade')}")
must(g7.get("accident_history") == "Minor scratch front bumper",
     "§7.3 accident_history matches",
     f"got {g7.get('accident_history')!r}")


# ---------------------------------------------------------------------
# §8 · Edge cases
# ---------------------------------------------------------------------
print("\n=== §8 · Edge cases ===")
# 8.1 exterior.score=11 → 422
car8_id, _ = create_draft_car(OP_TOK)
r = httpx.put(f"{BASE}/cars/{car8_id}/inspection",
              json={"sections": {"exterior": {"completed": True, "score": 11}}},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 422, "§8.1 score=11 → 422", f"got {r.status_code}")

# 8.2 exterior.score=-1 → 422
r = httpx.put(f"{BASE}/cars/{car8_id}/inspection",
              json={"sections": {"exterior": {"completed": True, "score": -1}}},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 422, "§8.2 score=-1 → 422", f"got {r.status_code}")

# 8.3 accident_history="   " → null on GET
r = httpx.put(f"{BASE}/cars/{car8_id}/inspection",
              json={"sections": {}, "accident_history": "   "},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§8.3a whitespace accident_history PUT HTTP=200",
     f"got {r.status_code}")
g83 = httpx.get(f"{BASE}/cars/{car8_id}/inspection", timeout=20).json()
must(g83.get("accident_history") is None, "§8.3b accident_history whitespace → null",
     f"got {g83.get('accident_history')!r}")

# 8.4 accident_history="hit a kerb"
r = httpx.put(f"{BASE}/cars/{car8_id}/inspection",
              json={"sections": {}, "accident_history": "hit a kerb"},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§8.4a accident_history PUT HTTP=200", f"got {r.status_code}")
g84 = httpx.get(f"{BASE}/cars/{car8_id}/inspection", timeout=20).json()
must(g84.get("accident_history") == "hit a kerb", "§8.4b accident_history='hit a kerb'",
     f"got {g84.get('accident_history')!r}")

# 8.5 empty body {} → 200, aggregates null, completion=0
car85_id, _ = create_draft_car(OP_TOK)
r = httpx.put(f"{BASE}/cars/{car85_id}/inspection", json={},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§8.5a empty body {} PUT HTTP=200", f"got {r.status_code}")
g85 = httpx.get(f"{BASE}/cars/{car85_id}/inspection", timeout=20).json()
must(g85.get("inspection_score") is None
     and g85.get("condition_grade") is None
     and g85.get("liquidity_rating") is None,
     "§8.5b empty body → all aggregates null",
     f"score={g85.get('inspection_score')} grade={g85.get('condition_grade')} liq={g85.get('liquidity_rating')}")
must(g85.get("completion_percentage") == 0, "§8.5c completion=0",
     f"got {g85.get('completion_percentage')}")
must(g85.get("sections_completed") == [], "§8.5d sections_completed=[]",
     f"got {g85.get('sections_completed')}")

# 8.6 PUT /cars/does-not-exist/inspection → 404
r = httpx.put(f"{BASE}/cars/does-not-exist/inspection", json={},
              headers=headers(OP_TOK), timeout=20)
must(r.status_code == 404, "§8.6 PUT unknown car → 404", f"got {r.status_code}")

# 8.7 GET /cars/does-not-exist/inspection → 200 with stable empty shape
r = httpx.get(f"{BASE}/cars/does-not-exist/inspection", timeout=20)
must(r.status_code == 200, "§8.7a GET unknown car → 200 (NOT 404)",
     f"got {r.status_code}")
g87 = r.json()
must(set(g87.get("sections", {}).keys()) == {"exterior","interior","mechanical","tyres","documents","photos"},
     "§8.7b stable empty shape (6 sections all stub)",
     f"got {sorted((g87.get('sections') or {}).keys())}")
must(g87.get("inspection_score") is None and g87.get("condition_grade") is None,
     "§8.7c empty aggregates null",
     f"score={g87.get('inspection_score')}")

# 8.8 PUT as dealer JWT → 403
r = httpx.put(f"{BASE}/cars/{car_id}/inspection", json={},
              headers=headers(DL_TOK), timeout=20)
must(r.status_code == 403, "§8.8 PUT as dealer JWT → 403", f"got {r.status_code}")


# ---------------------------------------------------------------------
# §9 · Regression
# ---------------------------------------------------------------------
print("\n=== §9 · Regression ===")
# Create draft, upload 3 photos + featured, launch
car9_id, auction9_id = create_draft_car(OP_TOK, duration_minutes=60)
# Upload 3 photos via /media/upload
tiny_jpg = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c"
    "140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27"
    "393d38323c2e333432ffc0000b08000800010101011100ffc4001f00000105010101010101000000"
    "0000000000010203040506070809000affc400b5100002010303020403050504040000017d010203"
    "00041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a"
    "25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475"
    "767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9ba"
    "c2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda"
    "0008010100003f00f4ff00d9"
)
media_ids: List[str] = []
for i in range(3):
    files = {"file": (f"photo_{i}.jpg", tiny_jpg, "image/jpeg")}
    data = {"car_id": car9_id, "section": "exterior"}
    r = httpx.post(f"{BASE}/media/upload", data=data, files=files,
                   headers=headers(OP_TOK), timeout=30)
    if r.status_code == 200:
        media_ids.append(r.json().get("id"))
    else:
        record(f"§9.upload[{i}] HTTP", False, f"{r.status_code}: {r.text[:200]}")

must(len(media_ids) == 3, "§9.1 uploaded 3 photos", f"got {len(media_ids)}")

# Set first as featured
if media_ids:
    r = httpx.post(f"{BASE}/cars/{car9_id}/media/featured/{media_ids[0]}",
                   headers=headers(OP_TOK), timeout=20)
    must(r.status_code == 200, "§9.2 set featured HTTP=200",
         f"got {r.status_code}: {r.text[:200]}")

r = httpx.post(f"{BASE}/admin/auctions/{auction9_id}/launch", json={},
               headers=headers(OP_TOK), timeout=20)
must(r.status_code == 200, "§9.3 launch HTTP=200",
     f"got {r.status_code}: {r.text[:300]}")
if r.status_code == 200:
    launched_status = ((r.json().get("auction") or {}).get("status"))
    must(launched_status == "live", "§9.4 status=live after launch",
         f"got {launched_status}")

# duration_minutes validation
r = httpx.post(f"{BASE}/cars", json={
    "registration_number": rand_reg(), "make": "Honda", "model": "City",
    "year": 2022, "fuel_type": "Petrol", "transmission": "Automatic",
    "km_driven": 1000, "reserve_price": 550000, "starting_bid": 500000,
    "duration_minutes": 4,
}, headers=headers(OP_TOK), timeout=20)
must(r.status_code == 422, "§9.5 duration_minutes=4 → 422", f"got {r.status_code}")

r = httpx.post(f"{BASE}/cars", json={
    "registration_number": rand_reg(), "make": "Honda", "model": "City",
    "year": 2022, "fuel_type": "Petrol", "transmission": "Automatic",
    "km_driven": 1000, "reserve_price": 550000, "starting_bid": 500000,
    "duration_minutes": 20161,
}, headers=headers(OP_TOK), timeout=20)
must(r.status_code == 422, "§9.6 duration_minutes=20161 → 422", f"got {r.status_code}")


# ---------------------------------------------------------------------
# §10 · WebSocket inspection_updated
# ---------------------------------------------------------------------
print("\n=== §10 · WS inspection_updated frame ===")

async def ws_check() -> Tuple[bool, str]:
    ws_url = f"{WS_BASE}/ws/auction/{auction_id}?token={DL_TOK}"
    try:
        async with websockets.connect(ws_url, open_timeout=10, close_timeout=5) as ws:
            # Drain initial snapshot (may fail if server has serialization bug — ignore)
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=3)
            except Exception:
                first = None

            # Trigger PUT in background
            async def trigger():
                await asyncio.sleep(0.3)
                async with httpx.AsyncClient(timeout=15) as ac:
                    await ac.put(
                        f"{BASE}/cars/{car_id}/inspection",
                        json={"sections": {"exterior": {"completed": True, "score": 8}}},
                        headers=headers(OP_TOK),
                    )
            asyncio.create_task(trigger())

            deadline = asyncio.get_event_loop().time() + 5
            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=4)
                except asyncio.TimeoutError:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "inspection_updated":
                    has_ids = msg.get("car_id") == car_id and msg.get("auction_id") == auction_id
                    return True, f"frame: {msg} has_ids={has_ids}"
            return False, "no inspection_updated frame within 5s"
    except Exception as e:
        return False, f"ws exception: {e!r}"

try:
    ok10, detail10 = asyncio.run(ws_check())
except Exception as e:
    ok10, detail10 = False, f"runner failed: {e!r}"
record("§10.1 WS inspection_updated frame received", ok10, detail10)


# ---------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------
print("\n" + "=" * 72)
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
failed = total - passed
print(f"TOTAL: {passed}/{total} PASS  ({failed} FAIL)")
print("=" * 72)
if failed:
    print("\nFAILURES:")
    for name, ok, detail in results:
        if not ok:
            print(f"  ✗ {name}: {detail}")
print()

sys.exit(0 if failed == 0 else 1)
