"""Quick retest — Step 4 confirmation that seller_id=me now works for operator drafts."""
import os
import sys
import json
import httpx

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com/api"
OPERATOR_PHONE = "+918977986662"
OTP = "123456"


def main():
    results = []
    with httpx.Client(timeout=30.0) as client:
        # 1. Operator login
        r = client.post(f"{BASE}/auth/operator/verify-otp",
                        json={"phone": OPERATOR_PHONE, "otp": OTP})
        print(f"[1] verify-otp → HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"    body: {r.text[:400]}")
            sys.exit(1)
        token = r.json()["token"]
        operator_id = r.json()["dealer"]["id"]
        print(f"    operator_id={operator_id}")
        H = {"Authorization": f"Bearer {token}"}

        # 2. POST /api/cars (minimal valid)
        car_payload = {
            "registration_number": "MH12RT4421",
            "make": "Maruti Suzuki",
            "model": "Swift VXi",
            "year": 2021,
            "fuel_type": "petrol",
            "transmission": "manual",
            "km_driven": 41250,
            "color": "Pearl Arctic White",
            "owners": 1,
            "starting_bid": 425000,
            "reserve_price": 480000,
            "duration_minutes": 60,
        }
        r = client.post(f"{BASE}/cars", headers=H, json=car_payload)
        print(f"[2] POST /cars → HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"    body: {r.text[:400]}")
            sys.exit(1)
        body = r.json()
        auction = body.get("auction") or {}
        auction_id = auction.get("id")
        auction_status = auction.get("status")
        print(f"    auction_id={auction_id}, status={auction_status}")
        results.append(("POST /cars → 200 + auction.id present", bool(auction_id)))
        # NB: status will be "draft" only if backend creates draft listings; otherwise we still proceed
        results.append((f"auction.status == 'draft' (got {auction_status!r})", auction_status == "draft"))

        # 3. GET /auctions?seller_id=me (with auth)
        r = client.get(f"{BASE}/auctions?seller_id=me", headers=H)
        print(f"[3] GET /auctions?seller_id=me (auth) → HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"    body: {r.text[:400]}")
            sys.exit(1)
        data = r.json()
        is_list = isinstance(data, list)
        ids = [a.get("id") for a in data] if is_list else []
        present_in_me = auction_id in ids
        # is the draft (status=draft) present?
        draft_match = any(a.get("id") == auction_id and a.get("status") == "draft" for a in data) if is_list else False
        print(f"    response_is_list={is_list}, count={len(ids)}, new_auction_in_list={present_in_me}, draft_status_match={draft_match}")
        results.append(("GET /auctions?seller_id=me returns list", is_list))
        results.append(("Newly-created auction present in seller_id=me", present_in_me))
        results.append(("Newly-created auction visible as status='draft' in seller_id=me", draft_match))

        # 4. GET /auctions (anonymous)
        r = client.get(f"{BASE}/auctions")
        print(f"[4] GET /auctions (anon) → HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"    body: {r.text[:400]}")
            sys.exit(1)
        data2 = r.json()
        anon_ids = [a.get("id") for a in data2] if isinstance(data2, list) else []
        absent_anon = auction_id not in anon_ids
        print(f"    anon_count={len(anon_ids)}, draft_excluded_from_anon={absent_anon}")
        results.append(("Anonymous GET /auctions excludes the draft (privacy)", absent_anon))

    print("\n=== STEP 4 RETEST RESULTS ===")
    all_ok = True
    for label, ok in results:
        flag = "PASS" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"  [{flag}] {label}")
    print(f"\nOverall: {'PASS' if all_ok else 'FAIL'}")
    sys.exit(0 if all_ok else 2)


if __name__ == "__main__":
    main()
