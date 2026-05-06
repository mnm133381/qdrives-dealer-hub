"""
Phase 2B+ Settlement Pipeline backend validation.

Tests:
  • GET  /api/admin/settlements/pipeline
  • POST /api/admin/auctions/{auction_id}/settlement/note

Usage:
  python backend_test_settlement_pipeline.py
"""
import asyncio
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

import httpx
import websockets

BASE = os.environ.get("QDRIVES_BASE", "http://localhost:8001") + "/api"
WS_BASE = BASE.replace("http", "ws", 1)

OP_PHONE = "+919900000099"
DEALER_PHONE = "+919900000002"
OFF_LIST = "+919876543210"
OTP = "123456"

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
DIM = "\033[90m"
RESET = "\033[0m"

passed: List[str] = []
failed: List[str] = []


def ok(msg: str):
    passed.append(msg)
    print(f"{GREEN}PASS{RESET} {msg}")


def fail(msg: str):
    failed.append(msg)
    print(f"{RED}FAIL{RESET} {msg}")


def expect(cond: bool, msg: str):
    if cond:
        ok(msg)
    else:
        fail(msg)


async def login(client: httpx.AsyncClient, phone: str, role: str) -> str:
    path = "/auth/operator" if role == "operator" else "/auth/dealer"
    r = await client.post(f"{BASE}{path}/send-otp", json={"phone": phone})
    r.raise_for_status()
    r = await client.post(f"{BASE}{path}/verify-otp", json={"phone": phone, "otp": OTP})
    r.raise_for_status()
    return r.json()["token"]


async def main():
    async with httpx.AsyncClient(timeout=30) as client:
        # --- Login as operator + dealer ---
        print(f"\n{YELLOW}=== Login ==={RESET}")
        op_token = await login(client, OP_PHONE, "operator")
        dl_token = await login(client, DEALER_PHONE, "dealer")
        op_hdr = {"Authorization": f"Bearer {op_token}"}
        dl_hdr = {"Authorization": f"Bearer {dl_token}"}
        ok(f"operator login {OP_PHONE}")
        ok(f"dealer   login {DEALER_PHONE}")

        # Fetch operator id for audit/note verification
        r = await client.get(f"{BASE}/auth/me", headers=op_hdr)
        op_id = r.json()["id"]
        op_full_name = r.json().get("full_name") or r.json().get("dealership_name")
        print(f"{DIM}operator_id={op_id}  name={op_full_name}{RESET}")

        # =========================================================
        # A) AUTH GATING
        # =========================================================
        print(f"\n{YELLOW}=== A) Auth gating ==={RESET}")

        # A.1 Anonymous GET → 401
        r = await client.get(f"{BASE}/admin/settlements/pipeline")
        expect(r.status_code == 401, f"A.1 anonymous GET pipeline → 401 (got {r.status_code})")

        # A.2 Dealer GET → 403
        r = await client.get(f"{BASE}/admin/settlements/pipeline", headers=dl_hdr)
        expect(r.status_code == 403, f"A.2 dealer GET pipeline → 403 (got {r.status_code})")

        # A.3 Operator GET → 200
        r = await client.get(f"{BASE}/admin/settlements/pipeline", headers=op_hdr)
        expect(r.status_code == 200, f"A.3 operator GET pipeline → 200 (got {r.status_code})")
        pipeline = r.json() if r.status_code == 200 else {}

        # A.4 Anonymous POST note → 401 (pick any aid, even fake)
        sample_aid = (pipeline.get("items") or [{}])[0].get("id", "00000000-0000-0000-0000-000000000000")
        r = await client.post(f"{BASE}/admin/auctions/{sample_aid}/settlement/note", json={"note": "hello world test"})
        expect(r.status_code == 401, f"A.4 anonymous POST note → 401 (got {r.status_code})")

        # A.5 Dealer POST note → 403
        r = await client.post(f"{BASE}/admin/auctions/{sample_aid}/settlement/note",
                              json={"note": "hello world test"}, headers=dl_hdr)
        expect(r.status_code == 403, f"A.5 dealer POST note → 403 (got {r.status_code})")

        # A.6 Operator POST note on existing auction → 200 (deferred to C)
        # keep placeholder; verified under section C.

        # =========================================================
        # B) PIPELINE PAYLOAD CORRECTNESS
        # =========================================================
        print(f"\n{YELLOW}=== B) Pipeline payload ==={RESET}")

        items = pipeline.get("items", [])
        by_state = pipeline.get("by_state", {})
        ts_val = pipeline.get("ts")
        sla = pipeline.get("sla_hours")
        hv = pipeline.get("high_value_threshold")

        # B.1 by_state sum matches item.status counts
        from collections import Counter
        status_counts = Counter(it.get("status") for it in items)
        # Only count keys that are in by_state
        mismatch = False
        for s, c in by_state.items():
            if status_counts.get(s, 0) != c:
                mismatch = True
                print(f"  {DIM}by_state[{s}]={c} vs item-count={status_counts.get(s,0)}{RESET}")
        expect(not mismatch, f"B.1 by_state matches item.status counts (total items={len(items)})")

        # B.2 items count <= 300
        expect(len(items) <= 300, f"B.2 items count <= 300 (got {len(items)})")

        # B.3 Sample item has documented keys
        if items:
            sample = items[0]
            required = {
                "id", "status", "car", "final_bid", "starting_bid", "reserve_price",
                "reserve_met", "top_bidder", "suspended_dealer", "total_bids",
                "ended_at", "payment_received_at", "released_at", "settled_at",
                "cancelled_at", "dispute_opened_at", "settlement_age_h",
                "payment_overdue", "high_value_unsettled", "dispute_flag",
                "settlement_notes", "cancelled_reason",
            }
            missing = required - set(sample.keys())
            expect(not missing, f"B.3 sample item has required keys (missing={missing or 'none'})")
            # car sub-keys
            car = sample.get("car") or {}
            car_missing = {"id", "make", "model", "year", "registration_number"} - set(car.keys())
            expect(not car_missing, f"B.3 sample item.car has required keys (missing={car_missing or 'none'})")
        else:
            ok("B.3 no items in pipeline — skipping sample-key check")

        # B.4 payment_overdue semantics
        overdue_violations = []
        for it in items:
            po = it.get("payment_overdue")
            expected = (it.get("status") == "ended_pending_payment"
                        and (it.get("settlement_age_h") or 0) > 48)
            if bool(po) != bool(expected):
                overdue_violations.append((it.get("id"), it.get("status"), it.get("settlement_age_h"), po))
        expect(not overdue_violations, f"B.4 payment_overdue iff status=ended_pending_payment AND age>48h (violations={len(overdue_violations)})")

        # B.5 high_value_unsettled semantics
        hv_violations = []
        for it in items:
            hvf = it.get("high_value_unsettled")
            expected = (int(it.get("final_bid") or 0) >= 1_000_000
                        and it.get("status") not in ("settled", "cancelled"))
            if bool(hvf) != bool(expected):
                hv_violations.append((it.get("id"), it.get("status"), it.get("final_bid"), hvf))
        expect(not hv_violations, f"B.5 high_value_unsettled iff final_bid>=10L AND status not terminal (violations={len(hv_violations)})")

        # B.6 suspended_dealer mirrors top_bidder.suspended
        sus_violations = []
        for it in items:
            sd = bool(it.get("suspended_dealer"))
            tb = it.get("top_bidder") or {}
            tb_sus = bool(tb.get("suspended")) if tb else False
            if sd != tb_sus:
                sus_violations.append((it.get("id"), sd, tb_sus))
        expect(not sus_violations, f"B.6 suspended_dealer mirrors top_bidder.suspended (violations={len(sus_violations)})")

        # B.7 dispute_flag iff status == 'dispute'
        disp_violations = [it for it in items
                            if bool(it.get("dispute_flag")) != (it.get("status") == "dispute")]
        expect(not disp_violations, f"B.7 dispute_flag iff status=='dispute' (violations={len(disp_violations)})")

        # B.8 settlement_age_h non-negative int
        age_violations = [it for it in items
                           if not isinstance(it.get("settlement_age_h"), int) or it["settlement_age_h"] < 0]
        expect(not age_violations, f"B.8 settlement_age_h is non-negative int (violations={len(age_violations)})")

        # B.9 ts is RFC3339 UTC, sla==48, hv==1000000
        from datetime import datetime
        ts_ok = False
        try:
            datetime.fromisoformat((ts_val or "").replace("Z", "+00:00"))
            ts_ok = True
        except Exception:
            pass
        expect(ts_ok, f"B.9a ts is valid RFC3339: {ts_val}")
        expect(sla == 48, f"B.9b sla_hours == 48 (got {sla})")
        expect(hv == 1_000_000, f"B.9c high_value_threshold == 1000000 (got {hv})")

        # B.10 Terminal items (settled/cancelled) must have been within window (30d)
        # Check that any included terminal item has ended_at/cancelled_at/settled_at within 30d.
        now_sec = time.time()
        term_violations = []
        for it in items:
            if it.get("status") not in ("settled", "cancelled"):
                continue
            anchors = [it.get("settled_at"), it.get("cancelled_at"), it.get("ended_at")]
            found_in_window = False
            for anc in anchors:
                if not anc:
                    continue
                try:
                    dt = datetime.fromisoformat(anc.replace("Z", "+00:00"))
                    age_days = (now_sec - dt.timestamp()) / 86400
                    if age_days <= 31:  # 30d + tolerance
                        found_in_window = True
                        break
                except Exception:
                    continue
            if not found_in_window:
                term_violations.append((it.get("id"), it.get("status"), anchors))
        expect(not term_violations,
               f"B.10 terminal items within 30d window (violations={len(term_violations)})")

        # =========================================================
        # C) NOTE APPEND BEHAVIOR
        # =========================================================
        print(f"\n{YELLOW}=== C) Note append ==={RESET}")

        # Find a target auction from pipeline (prefer first)
        target_id = None
        if items:
            # Prefer a cancelled entry for test isolation
            cancelled = [it for it in items if it.get("status") == "cancelled"]
            target_id = (cancelled[0]["id"] if cancelled else items[0]["id"])
        if not target_id:
            fail("C.*  no auction in pipeline to target — skipping note tests")
        else:
            print(f"{DIM}target_auction_id={target_id}{RESET}")

            # C.1 empty note → 400
            r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                   json={"note": ""}, headers=op_hdr)
            expect(r.status_code == 400, f"C.1 note='' → 400 (got {r.status_code})")

            # C.2 note 'hi' → 400
            r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                   json={"note": "hi"}, headers=op_hdr)
            expect(r.status_code == 400, f"C.2 note='hi' → 400 (got {r.status_code})")

            # C.3 whitespace → 400
            r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                   json={"note": "     "}, headers=op_hdr)
            expect(r.status_code == 400, f"C.3 note='     ' → 400 (got {r.status_code})")

            # C.4 valid note → 200
            note_text = "Buyer requested 24h delay on payment, escalated."
            r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                   json={"note": note_text}, headers=op_hdr)
            expect(r.status_code == 200, f"C.4 valid note → 200 (got {r.status_code})")
            note_obj_1 = r.json().get("note") if r.status_code == 200 else {}

            # C.5 pipeline shows the note with correct fields
            await asyncio.sleep(0.2)
            r = await client.get(f"{BASE}/admin/settlements/pipeline?window_days=30", headers=op_hdr)
            pipeline2 = r.json()
            target_item = next((it for it in pipeline2.get("items", []) if it.get("id") == target_id), None)
            if target_item is None:
                fail("C.5 could not find target auction in pipeline after note add")
            else:
                notes = target_item.get("settlement_notes") or []
                match = next((n for n in notes if n.get("id") == note_obj_1.get("id")), None)
                if not match:
                    fail(f"C.5 appended note not found in settlement_notes[] (id={note_obj_1.get('id')})")
                else:
                    expect(match.get("text") == note_text, f"C.5a note.text matches")
                    expect(match.get("operator_id") == op_id, f"C.5b note.operator_id matches operator ({match.get('operator_id')} vs {op_id})")
                    expect(bool(match.get("operator_name")), f"C.5c note.operator_name set to {match.get('operator_name')}")
                    expect(bool(match.get("created_at")), f"C.5d note.created_at present")

            # C.6 append a second valid note → 2 notes ordered ascending
            note_text_2 = "Follow-up call scheduled for tomorrow at 4pm."
            r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                   json={"note": note_text_2}, headers=op_hdr)
            expect(r.status_code == 200, f"C.6a second note → 200 (got {r.status_code})")
            note_obj_2 = r.json().get("note") if r.status_code == 200 else {}
            await asyncio.sleep(0.2)
            r = await client.get(f"{BASE}/admin/settlements/pipeline?window_days=30", headers=op_hdr)
            target_item = next((it for it in r.json().get("items", []) if it.get("id") == target_id), None)
            notes = (target_item or {}).get("settlement_notes") or []
            # Filter to notes created during this test (both note_obj_1 and note_obj_2)
            our_notes = [n for n in notes if n.get("id") in (note_obj_1.get("id"), note_obj_2.get("id"))]
            expect(len(our_notes) == 2, f"C.6b both notes present (found {len(our_notes)})")
            # Ascending created_at
            if len(our_notes) == 2:
                # Find by order in settlement_notes
                idx1 = next(i for i, n in enumerate(notes) if n.get("id") == note_obj_1.get("id"))
                idx2 = next(i for i, n in enumerate(notes) if n.get("id") == note_obj_2.get("id"))
                expect(idx1 < idx2, f"C.6c notes ordered by created_at ascending (idx1={idx1}, idx2={idx2})")

            # C.7 non-existent auction → 404
            fake_id = "00000000-0000-0000-0000-0000000badaa"
            r = await client.post(f"{BASE}/admin/auctions/{fake_id}/settlement/note",
                                   json={"note": "some valid text here"}, headers=op_hdr)
            expect(r.status_code == 404, f"C.7 non-existent auction → 404 (got {r.status_code})")

            # C.8 no DELETE/PATCH for notes
            r = await client.delete(f"{BASE}/admin/auctions/{target_id}/settlement/note/{note_obj_1.get('id')}",
                                     headers=op_hdr)
            expect(r.status_code in (404, 405), f"C.8a DELETE note endpoint should not exist (got {r.status_code})")
            r = await client.patch(f"{BASE}/admin/auctions/{target_id}/settlement/note/{note_obj_1.get('id')}",
                                    json={"note": "edited"}, headers=op_hdr)
            expect(r.status_code in (404, 405), f"C.8b PATCH note endpoint should not exist (got {r.status_code})")

            # =========================================================
            # D) AUDIT INTEGRATION
            # =========================================================
            print(f"\n{YELLOW}=== D) Audit integration ==={RESET}")
            await asyncio.sleep(0.3)  # let fire-and-forget audit land
            r = await client.get(f"{BASE}/admin/audit-logs",
                                  params={"action": "settlement_note_add", "limit": 50},
                                  headers=op_hdr)
            expect(r.status_code == 200, f"D.1a audit-logs?action=settlement_note_add → 200 (got {r.status_code})")
            if r.status_code == 200:
                audit_items = r.json().get("items", [])
                matching = [a for a in audit_items
                            if a.get("target_id") == target_id
                            and a.get("actor_id") == op_id
                            and (a.get("meta") or {}).get("note_id") == note_obj_1.get("id")]
                expect(len(matching) >= 1,
                       f"D.1b settlement_note_add entry present with actor_id/target_id/meta.note_id")
                if matching:
                    m = matching[0]
                    expect("text" in (m.get("meta") or {}),
                           f"D.1c meta.text present in audit entry")

            # =========================================================
            # E) IDEMPOTENCY / CONCURRENCY (LIGHT)
            # =========================================================
            print(f"\n{YELLOW}=== E) Sequential append (3x) ==={RESET}")
            before_count = len(notes)
            seq_ids = []
            for i in range(3):
                r = await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                       json={"note": f"Sequential concurrency test note #{i+1} tracking"},
                                       headers=op_hdr)
                expect(r.status_code == 200, f"E.1.{i+1} sequential note → 200 (got {r.status_code})")
                if r.status_code == 200:
                    seq_ids.append(r.json().get("note", {}).get("id"))
            expect(len(set(seq_ids)) == 3, f"E.2 all 3 sequential note ids unique (got {len(set(seq_ids))})")
            await asyncio.sleep(0.2)
            r = await client.get(f"{BASE}/admin/settlements/pipeline?window_days=30", headers=op_hdr)
            target_item = next((it for it in r.json().get("items", []) if it.get("id") == target_id), None)
            notes_after = (target_item or {}).get("settlement_notes") or []
            delta = len(notes_after) - before_count
            expect(delta == 3, f"E.3 settlement_notes grew by exactly 3 (before={before_count}, after={len(notes_after)}, delta={delta})")

            # =========================================================
            # F) WS BROADCAST (SMOKE)
            # =========================================================
            print(f"\n{YELLOW}=== F) WS broadcast smoke ==={RESET}")
            ws_url = f"{WS_BASE}/ws/auction/{target_id}?token={op_token}"
            got_note_frame = False
            try:
                async with websockets.connect(ws_url, open_timeout=5, close_timeout=2) as ws:
                    # Drain initial snapshot frames briefly
                    async def drain_until_note():
                        nonlocal got_note_frame
                        while True:
                            try:
                                msg = await asyncio.wait_for(ws.recv(), timeout=4)
                            except asyncio.TimeoutError:
                                return
                            try:
                                data = json.loads(msg)
                            except Exception:
                                continue
                            if data.get("type") == "settlement_note":
                                got_note_frame = True
                                return

                    # Fire note in background
                    async def post_note():
                        await asyncio.sleep(0.5)
                        await client.post(f"{BASE}/admin/auctions/{target_id}/settlement/note",
                                           json={"note": "WS smoke test note appended."}, headers=op_hdr)

                    await asyncio.gather(drain_until_note(), post_note())
                expect(got_note_frame, f"F.1 WS received frame with type='settlement_note'")
            except Exception as e:
                fail(f"F.1 WS connection failed: {e!r}")

        # =========================================================
        # SUMMARY
        # =========================================================
        print(f"\n{YELLOW}=== Summary ==={RESET}")
        print(f"{GREEN}PASSED: {len(passed)}{RESET}   {RED}FAILED: {len(failed)}{RESET}")
        if failed:
            print(f"\n{RED}Failures:{RESET}")
            for f in failed:
                print(f"  • {f}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
