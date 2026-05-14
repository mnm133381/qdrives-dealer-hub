"""
Targeted regression test for media-pipeline fix in _enrich_auction.

Verifies (read-only, no DB writes):
  1. GET /api/auctions → each item has car.images (legacy) AND car.media (NEW).
  2. GET /api/auctions/{id} → same shape preserved; no regressions.
  3. GET /api/cars (list) + /api/cars/{id} → still respond 200.
  4. POST /api/auctions/{id}/bid → 401 anon (signature unchanged).
  5. GET /api/cars/{id}/media + /api/cars/{id}/media/completeness → no 500s.
  6. POST /api/cars/{id}/media/featured/{media_id} → 401 anon (admin-only).
"""
import os
import json
import sys
import requests

BASE = os.environ.get(
    "BASE_URL",
    "https://qdrives-dealer-hub.preview.emergentagent.com/api",
)
TIMEOUT = 20

results = []  # (label, passed, info)


def check(label, cond, info=""):
    results.append((label, bool(cond), info))
    sym = "✅" if cond else "❌"
    print(f"{sym} {label}{(' — ' + info) if info else ''}")


def safe_keys(d, limit=20):
    if not isinstance(d, dict):
        return type(d).__name__
    return list(d.keys())[:limit]


def main():
    print(f"BASE = {BASE}")
    s = requests.Session()
    s.headers.update({"User-Agent": "media-pipeline-regression/1.0"})

    # ------------------------------------------------------------------
    # 1) GET /api/auctions  (public list)
    # ------------------------------------------------------------------
    print("\n--- 1) GET /api/auctions ---")
    try:
        r = s.get(f"{BASE}/auctions", timeout=TIMEOUT)
    except Exception as e:
        check("GET /auctions reachable", False, str(e))
        return
    check("GET /auctions HTTP 200", r.status_code == 200, f"status={r.status_code}")
    try:
        auctions = r.json()
    except Exception as e:
        check("GET /auctions is JSON", False, str(e))
        return
    check("GET /auctions is JSON list", isinstance(auctions, list),
          f"type={type(auctions).__name__}, len={len(auctions) if isinstance(auctions, list) else 'NA'}")

    if not auctions:
        check("auctions has >= 1 item", False, "empty list — cannot spot-check item shape")
    else:
        check("auctions has >= 1 item", True, f"count={len(auctions)}")
        sample = auctions[: min(3, len(auctions))]
        for i, a in enumerate(sample):
            car = a.get("car") or {}
            check(
                f"item[{i}] has car object",
                isinstance(car, dict) and bool(car),
                f"car keys={safe_keys(car)}",
            )
            check(
                f"item[{i}] car.images present (array)",
                isinstance(car.get("images"), list),
                f"images_len={len(car.get('images') or [])}, sample={(car.get('images') or [None])[:1]}",
            )
            # NEW field — MUST be present (may be empty)
            check(
                f"item[{i}] car.media present (NEW field, array)",
                isinstance(car.get("media"), list),
                f"media_len={len(car.get('media') or [])}",
            )
            # If media has items, schema check
            if car.get("media"):
                m0 = car["media"][0]
                required = {"id", "section", "subsection", "url", "thumb_url", "is_featured", "order", "provider"}
                missing = required - set(m0.keys()) if isinstance(m0, dict) else required
                check(
                    f"item[{i}] car.media[0] has expected keys",
                    not missing,
                    f"missing={sorted(missing)}, got={sorted(m0.keys()) if isinstance(m0, dict) else type(m0).__name__}",
                )

    # ------------------------------------------------------------------
    # 2) GET /api/auctions/{id} — specific
    # ------------------------------------------------------------------
    print("\n--- 2) GET /api/auctions/{id} ---")
    target = auctions[0] if auctions else None
    if target and target.get("id"):
        aid = target["id"]
        r = s.get(f"{BASE}/auctions/{aid}", timeout=TIMEOUT)
        check(f"GET /auctions/{aid} HTTP 200", r.status_code == 200, f"status={r.status_code}")
        try:
            single = r.json()
        except Exception as e:
            check("single auction JSON", False, str(e))
            single = {}
        car = (single.get("car") or {}) if isinstance(single, dict) else {}
        check(
            "single.car.images array present",
            isinstance(car.get("images"), list),
            f"images_len={len(car.get('images') or [])}",
        )
        check(
            "single.car.media array present (NEW)",
            isinstance(car.get("media"), list),
            f"media_len={len(car.get('media') or [])}",
        )
        # Regression: previously-returned auction fields
        # Spot-check that core auction fields are preserved.
        expected_auction_keys = {"id", "car_id", "seller_id", "status", "start_time", "end_time"}
        present = set(single.keys()) if isinstance(single, dict) else set()
        missing_top = expected_auction_keys - present
        check(
            "single auction preserves core fields",
            not missing_top,
            f"missing_top={sorted(missing_top)}; got={sorted(present)[:20]}",
        )
        check(
            "single has recent_bids list (regression check)",
            isinstance(single.get("recent_bids"), list),
            f"type={type(single.get('recent_bids')).__name__}",
        )
        check(
            "single has seller object (regression check)",
            "seller" in single,  # may be None for missing seller, but key should exist
            f"seller_present={'seller' in single}",
        )
    else:
        check("Sample auction id available", False, "no auction to fetch by id")

    # ------------------------------------------------------------------
    # 3) GET /api/cars list + a single car
    # ------------------------------------------------------------------
    print("\n--- 3) GET /api/cars ---")
    r = s.get(f"{BASE}/cars", timeout=TIMEOUT)
    check("GET /cars HTTP 200", r.status_code == 200, f"status={r.status_code}")
    cars = []
    try:
        cars = r.json()
    except Exception:
        pass
    check("GET /cars is list", isinstance(cars, list), f"len={len(cars) if isinstance(cars, list) else 'NA'}")

    car_id_for_media = None
    if cars:
        car_id_for_media = cars[0].get("id")
        r2 = s.get(f"{BASE}/cars/{car_id_for_media}", timeout=TIMEOUT)
        check(
            f"GET /cars/{car_id_for_media} HTTP 200",
            r2.status_code == 200,
            f"status={r2.status_code}",
        )

    # Pick a car id from auctions instead — guaranteed to have an auction context
    if target and isinstance(target.get("car"), dict):
        car_id_for_media = target["car"].get("id") or car_id_for_media

    # ------------------------------------------------------------------
    # 4) POST /api/auctions/{id}/bid — endpoint signature, no real bid
    # ------------------------------------------------------------------
    print("\n--- 4) POST /api/auctions/{id}/bid (anon) ---")
    if target and target.get("id"):
        r = s.post(
            f"{BASE}/auctions/{target['id']}/bid",
            json={"amount": 1},
            timeout=TIMEOUT,
        )
        # Should reject anonymous caller (401) — never a 500.
        check(
            "POST /bid anon → 401 (not authenticated)",
            r.status_code == 401,
            f"status={r.status_code}, body={r.text[:160]}",
        )
        check(
            "POST /bid never 500",
            r.status_code != 500,
            f"status={r.status_code}",
        )

    # ------------------------------------------------------------------
    # 5) GET /api/cars/{id}/media + /completeness — no 500s
    # ------------------------------------------------------------------
    print("\n--- 5) /api/cars/{id}/media + completeness ---")
    if car_id_for_media:
        r = s.get(f"{BASE}/cars/{car_id_for_media}/media", timeout=TIMEOUT)
        check(
            f"GET /cars/{car_id_for_media}/media HTTP 200",
            r.status_code == 200,
            f"status={r.status_code}",
        )
        check(
            "GET /cars/{id}/media never 500",
            r.status_code != 500,
            f"status={r.status_code}",
        )
        try:
            media_list = r.json()
            check(
                "media endpoint returns list",
                isinstance(media_list, list),
                f"type={type(media_list).__name__}",
            )
        except Exception:
            pass

        r = s.get(f"{BASE}/cars/{car_id_for_media}/media/completeness", timeout=TIMEOUT)
        check(
            f"GET /cars/{car_id_for_media}/media/completeness HTTP 200",
            r.status_code == 200,
            f"status={r.status_code}",
        )
        check(
            "GET completeness never 500",
            r.status_code != 500,
            f"status={r.status_code}",
        )

    # ------------------------------------------------------------------
    # 6) POST /api/cars/{id}/media/featured/{media_id} — anon must 401
    # ------------------------------------------------------------------
    print("\n--- 6) POST set-featured anon (admin gate) ---")
    if car_id_for_media:
        fake_media_id = "00000000-0000-0000-0000-000000000000"
        r = s.post(
            f"{BASE}/cars/{car_id_for_media}/media/featured/{fake_media_id}",
            timeout=TIMEOUT,
        )
        # Auth gate must fire BEFORE any other validation — expect 401 anon.
        check(
            "POST set-featured anon → 401",
            r.status_code == 401,
            f"status={r.status_code}, body={r.text[:160]}",
        )
        check(
            "POST set-featured never 500",
            r.status_code != 500,
            f"status={r.status_code}",
        )

    # ------------------------------------------------------------------
    # Final tally
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"RESULT: {passed}/{total} checks passed")
    failed = [(l, info) for l, ok, info in results if not ok]
    if failed:
        print("\nFAILED:")
        for label, info in failed:
            print(f"  ❌ {label} — {info}")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
