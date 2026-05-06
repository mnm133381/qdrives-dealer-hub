"""
Backend tests for Q Drives vehicle media platform.
Targets public ingress URL (EXPO_PUBLIC_BACKEND_URL).
Auth: mock OTP 123456. Admin: +919900000099, Dealer: +919900000002.
"""
import io
import sys
import httpx
import traceback

BASE = "https://qdrives-dealer-hub.preview.emergentagent.com"
API = BASE + "/api"

ADMIN_PHONE = "+919900000099"
DEALER_PHONE = "+919900000002"
OTP = "123456"

results = []


def log(name, ok, detail=""):
    results.append((name, ok, detail))
    prefix = "PASS" if ok else "FAIL"
    print(f"[{prefix}] {name} :: {detail}")


def login(phone: str):
    r = httpx.post(f"{API}/auth/send-otp", json={"phone": phone}, timeout=30)
    r.raise_for_status()
    r = httpx.post(f"{API}/auth/verify-otp", json={"phone": phone, "otp": OTP}, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data["token"], data["dealer"]


def make_jpeg(color: str = "red") -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buf, "JPEG")
    return buf.getvalue()


def main():
    admin_tok, admin_dealer = login(ADMIN_PHONE)
    dealer_tok, dealer_dealer = login(DEALER_PHONE)
    log("login admin+dealer", True, f"admin role={admin_dealer.get('role')} dealer role={dealer_dealer.get('role')}")

    admin_h = {"Authorization": f"Bearer {admin_tok}"}
    dealer_h = {"Authorization": f"Bearer {dealer_tok}"}

    r = httpx.get(f"{API}/auctions", timeout=30)
    r.raise_for_status()
    auctions = r.json()
    assert auctions, "no auctions"
    car_id = auctions[0]["car"]["id"]
    log("pick first auction car", True, f"car_id={car_id}")

    # ===== 1. List media =====
    r = httpx.get(f"{API}/cars/{car_id}/media", timeout=30)
    if r.status_code != 200:
        log("GET media 200", False, f"{r.status_code} {r.text[:200]}")
        return
    items = r.json()
    log("GET media non-empty list", isinstance(items, list) and len(items) >= 1, f"len={len(items)}")
    first = items[0] if items else {}
    required = ["id", "car_id", "section", "order", "is_featured", "provider", "url", "thumb_url"]
    missing_keys = [k for k in required if k not in first]
    log("media item required fields", not missing_keys, f"missing={missing_keys}")
    log("first item is_featured=true, provider=external",
        first.get("is_featured") is True and first.get("provider") == "external",
        f"is_featured={first.get('is_featured')} provider={first.get('provider')}")

    legacy_exterior_id = None
    for it in items:
        if it.get("provider") == "external" and it.get("section") == "exterior":
            legacy_exterior_id = it["id"]
            break
    log("auto-migrated external exterior item found", legacy_exterior_id is not None, f"id={legacy_exterior_id}")

    r = httpx.get(f"{API}/cars/{car_id}/media?section=interior", timeout=30)
    log("GET media?section=interior 200 list (not 500)",
        r.status_code == 200 and isinstance(r.json(), list),
        f"status={r.status_code} len={len(r.json()) if r.status_code==200 else 'n/a'}")

    # ===== 2. Completeness =====
    r = httpx.get(f"{API}/cars/{car_id}/media/completeness", headers=dealer_h, timeout=30)
    log("GET completeness dealer 200", r.status_code == 200, f"{r.status_code}")
    comp = r.json()
    log("completeness valid=false", comp.get("valid") is False, f"valid={comp.get('valid')}")
    log("completeness counts dict", isinstance(comp.get("counts"), dict), f"counts={comp.get('counts')}")
    missing = comp.get("missing") or []
    shape_ok = len(missing) > 0 and all("section" in m and "have" in m and "need" in m for m in missing)
    log("missing entries have section/have/need", shape_ok, f"missing={missing}")
    damage_entry = next((m for m in missing if m["section"] == "damage"), None)
    log("damage entry needs_attestation=true",
        damage_entry is not None and damage_entry.get("needs_attestation") is True,
        f"damage_entry={damage_entry}")

    # ===== 3. Upload =====
    jpeg_bytes = make_jpeg("red")

    # invalid section
    r = httpx.post(f"{API}/media/upload", headers=admin_h,
                   data={"car_id": car_id, "section": "foo", "width": "64", "height": "64"},
                   files={"file": ("img.jpg", jpeg_bytes, "image/jpeg")}, timeout=60)
    log("upload invalid section -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")

    # dealer
    r = httpx.post(f"{API}/media/upload", headers=dealer_h,
                   data={"car_id": car_id, "section": "interior", "width": "64", "height": "64"},
                   files={"file": ("img.jpg", jpeg_bytes, "image/jpeg")}, timeout=60)
    log("upload dealer -> 403 Admin required",
        r.status_code == 403 and "Admin" in r.text, f"{r.status_code} {r.text[:160]}")

    # admin
    r = httpx.post(f"{API}/media/upload", headers=admin_h,
                   data={"car_id": car_id, "section": "interior", "width": "64", "height": "64"},
                   files={"file": ("img.jpg", jpeg_bytes, "image/jpeg")}, timeout=60)
    log("upload admin -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    uploaded = r.json() if r.status_code == 200 else {}
    interior_id = uploaded.get("id")
    log("provider=gridfs", uploaded.get("provider") == "gridfs", f"provider={uploaded.get('provider')}")
    log("section=interior", uploaded.get("section") == "interior", f"section={uploaded.get('section')}")
    log("is_featured=false (had featured already)", uploaded.get("is_featured") is False,
        f"is_featured={uploaded.get('is_featured')}")
    expected_url = f"/api/media/{interior_id}/file"
    log("url=/api/media/{id}/file", uploaded.get("url") == expected_url, f"url={uploaded.get('url')}")
    log("thumb_url falls back to /file (no thumb)", uploaded.get("thumb_url") == expected_url,
        f"thumb_url={uploaded.get('thumb_url')}")

    # ===== 4. Fetch file & thumb =====
    r = httpx.get(f"{API}/media/{interior_id}/file", timeout=30)
    log("GET /media/{id}/file 200", r.status_code == 200, f"status={r.status_code} len={len(r.content)}")
    log("file content-type image/jpeg",
        r.headers.get("content-type", "").startswith("image/jpeg"),
        f"ct={r.headers.get('content-type')}")
    log("file body bytes == uploaded", r.content == jpeg_bytes,
        f"body_len={len(r.content)} up_len={len(jpeg_bytes)}")

    r = httpx.get(f"{API}/media/{interior_id}/thumb", timeout=30)
    log("GET /media/{id}/thumb 200 (fallback)", r.status_code == 200, f"status={r.status_code}")
    log("thumb body == uploaded (no thumb sent)", r.content == jpeg_bytes,
        f"body_len={len(r.content)}")

    # ===== 5. Reorder =====
    r = httpx.get(f"{API}/cars/{car_id}/media", timeout=30)
    items = r.json()
    ids_in_order = [it["id"] for it in items]
    ordered = [interior_id, legacy_exterior_id]
    other_ids = [i for i in ids_in_order if i not in ordered]
    payload_ids = ordered + other_ids

    r = httpx.post(f"{API}/cars/{car_id}/media/reorder", headers=dealer_h,
                   json={"ordered_ids": payload_ids}, timeout=30)
    log("reorder dealer -> 403", r.status_code == 403, f"{r.status_code}")

    r = httpx.post(f"{API}/cars/{car_id}/media/reorder", headers=admin_h,
                   json={"ordered_ids": payload_ids}, timeout=30)
    log("reorder admin -> 200", r.status_code == 200, f"{r.status_code}")

    r = httpx.get(f"{API}/cars/{car_id}/media", timeout=30)
    items2 = r.json()
    by_id = {it["id"]: it for it in items2}
    log("interior order=0", by_id.get(interior_id, {}).get("order") == 0,
        f"order={by_id.get(interior_id, {}).get('order')}")
    log("exterior (legacy) order=1", by_id.get(legacy_exterior_id, {}).get("order") == 1,
        f"order={by_id.get(legacy_exterior_id, {}).get('order')}")

    # ===== 6. Featured =====
    r = httpx.post(f"{API}/cars/{car_id}/media/featured/{interior_id}", headers=dealer_h, timeout=30)
    log("featured dealer -> 403", r.status_code == 403, f"{r.status_code}")

    r = httpx.post(f"{API}/cars/{car_id}/media/featured/{interior_id}", headers=admin_h, timeout=30)
    log("featured admin -> 200", r.status_code == 200, f"{r.status_code}")

    r = httpx.get(f"{API}/cars/{car_id}/media", timeout=30)
    items3 = r.json()
    flags = {it["id"]: it.get("is_featured") for it in items3}
    log("interior is_featured=true", flags.get(interior_id) is True, f"val={flags.get(interior_id)}")
    log("legacy exterior is_featured=false", flags.get(legacy_exterior_id) is False, f"val={flags.get(legacy_exterior_id)}")
    log("exactly one featured", sum(1 for v in flags.values() if v) == 1,
        f"count={sum(1 for v in flags.values() if v)}")

    # ===== 7. Patch section =====
    r = httpx.patch(f"{API}/media/{interior_id}", headers=admin_h, json={"section": "engine"}, timeout=30)
    log("PATCH section=engine 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    patched = r.json() if r.status_code == 200 else {}
    log("PATCH returned section=engine", patched.get("section") == "engine",
        f"section={patched.get('section')}")

    r = httpx.get(f"{API}/cars/{car_id}/media", timeout=30)
    by_id4 = {it["id"]: it for it in r.json()}
    log("GET confirms section=engine",
        by_id4.get(interior_id, {}).get("section") == "engine",
        f"section={by_id4.get(interior_id, {}).get('section')}")

    r = httpx.patch(f"{API}/media/{interior_id}", headers=admin_h, json={"section": "invalid_foo"}, timeout=30)
    log("PATCH invalid section -> 400", r.status_code == 400, f"{r.status_code}")

    # ===== 8. Attest no-damage =====
    r = httpx.post(f"{API}/cars/{car_id}/attest-no-damage", headers=admin_h,
                   json={"no_damage_attested": True}, timeout=30)
    log("attest-no-damage admin -> 200", r.status_code == 200, f"{r.status_code}")

    r = httpx.get(f"{API}/cars/{car_id}/media/completeness", headers=admin_h, timeout=30)
    comp2 = r.json()
    log("completeness.no_damage_attested=true", comp2.get("no_damage_attested") is True,
        f"val={comp2.get('no_damage_attested')}")
    miss2 = comp2.get("missing") or []
    log("damage entry removed from missing",
        not any(m["section"] == "damage" for m in miss2),
        f"missing sections={[m['section'] for m in miss2]}")

    # ===== 9. Delete =====
    r = httpx.delete(f"{API}/media/{legacy_exterior_id}", headers=dealer_h, timeout=30)
    log("DELETE exterior dealer -> 403", r.status_code == 403, f"{r.status_code}")

    r = httpx.delete(f"{API}/media/{interior_id}", headers=admin_h, timeout=30)
    log("DELETE interior admin -> 200", r.status_code == 200, f"{r.status_code}")

    r = httpx.delete(f"{API}/media/{interior_id}", headers=admin_h, timeout=30)
    log("DELETE interior again -> 404", r.status_code == 404, f"{r.status_code}")

    # ===== 10. Regression =====
    r = httpx.get(f"{API}/auctions", timeout=30)
    log("GET /auctions still works", r.status_code == 200 and len(r.json()) > 0, f"{r.status_code}")

    r = httpx.get(f"{API}/cars/{car_id}", timeout=30)
    log("GET /cars/{id} still works",
        r.status_code == 200 and r.json().get("id") == car_id, f"{r.status_code}")

    payload = {
        "registration_number": "MH02TEST9999",
        "make": "Hyundai", "model": "Verna", "variant": "SX(O)",
        "year": 2023, "manufacturing_year": 2023, "registration_year": 2023,
        "fuel_type": "Petrol", "transmission": "Automatic",
        "km_driven": 18500, "color": "Titan Grey", "owners": 1,
        "insurance_validity": "12/2026", "rto_details": "MH02 - Mumbai West",
        "notes": "Regression test listing",
        "reserve_price": 1250000, "starting_bid": 1000000,
        "images": [], "description": "",
        "duration_minutes": 60,
    }
    r = httpx.post(f"{API}/cars", headers=admin_h, json=payload, timeout=30)
    log("POST /cars admin creates listing",
        r.status_code == 200 and "car" in r.json() and "auction" in r.json(),
        f"{r.status_code} {r.text[:200]}")

    print()
    print("=" * 60)
    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"TOTAL {passed}/{total} assertions passed")
    print("=" * 60)
    if passed != total:
        print("FAILURES:")
        for n, ok, d in results:
            if not ok:
                print(f"  - {n} :: {d}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}")
        traceback.print_exc()
        sys.exit(2)
