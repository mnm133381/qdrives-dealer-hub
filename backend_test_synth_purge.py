"""
RUN 43 — P0 Trust + Data Mapping fix
Backend regression tests for synth purge + inspection field round-trip
behaviour on POST /api/cars + GET /api/auctions + GET /api/cars[/{id}].

Auth flow: operator =+918977986662  (DEV_BYPASS_OTP=true), OTP=123456.
Buyer dealer phone =+919900000001 (used only for sanity / read paths).

Test target: http://localhost:8001/api  (no curl, httpx only).
"""

import time
import httpx

BASE = "http://localhost:8001/api"

# --- forbidden synth tokens (must NEVER appear anywhere in any response) ---
SYNTH_ACCIDENT = {"None Reported", "Minor (Repaired)"}
SYNTH_SERVICE  = {"Authorised Service", "Authorised"}
SYNTH_GRADE    = {"B+", "C+"}
SYNTH_TYRE     = {"Excellent", "Fair", "Poor"}

INSP_FIELDS = ("inspection_score", "condition_grade",
               "tyre_condition", "accident_history", "service_history")

results = []
def rec(name, ok, detail=""):
    results.append((name, ok, detail))
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name} :: {detail}")


def op_token():
    r = httpx.post(f"{BASE}/auth/operator/verify-otp",
                   json={"phone": "+918977986662", "otp": "123456"},
                   timeout=30)
    assert r.status_code == 200, f"operator verify failed: {r.status_code} {r.text}"
    return r.json()["token"]


def assert_clean_car(car: dict, source: str):
    """Asserts every inspection field is either None or operator-clean."""
    issues = []
    insp = car.get("inspection_score")
    if insp is not None:
        try:
            ok = (0.0 <= float(insp) <= 10.0)
        except Exception:
            ok = False
        if not ok:
            issues.append(f"inspection_score out of range: {insp!r}")

    grade = car.get("condition_grade")
    if grade is not None:
        if grade in SYNTH_GRADE:
            issues.append(f"condition_grade is synth token {grade!r}")
        elif grade not in ("A", "B", "C", "D"):
            issues.append(f"condition_grade not in A/B/C/D: {grade!r}")

    tyre = car.get("tyre_condition")
    if tyre is not None and tyre in SYNTH_TYRE:
        issues.append(f"tyre_condition is synth token {tyre!r}")

    acc = car.get("accident_history")
    if acc is not None and acc in SYNTH_ACCIDENT:
        issues.append(f"accident_history is synth token {acc!r}")

    svc = car.get("service_history")
    if svc is not None and svc in SYNTH_SERVICE:
        issues.append(f"service_history is synth token {svc!r}")

    return issues


# ============== 1. Synth purge / cleanliness on read endpoints ==============
def test_synth_purge():
    # GET /api/auctions (anon)
    r = httpx.get(f"{BASE}/auctions", timeout=30)
    rec("1.A GET /auctions anon → 200",
        r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        return []
    auctions = r.json()
    leaks_auc = []
    car_ids = []
    for a in auctions:
        car = a.get("car") or {}
        if car.get("id"):
            car_ids.append(car["id"])
        issues = assert_clean_car(car, f"auction {a.get('id')}")
        if issues:
            leaks_auc.append({
                "auction_id": a.get("id"),
                "car_id": car.get("id"),
                "issues": issues,
                "fields": {k: car.get(k) for k in INSP_FIELDS},
            })
    rec("1.B /auctions: no synth tokens in any auction.car",
        len(leaks_auc) == 0,
        f"checked={len(auctions)} leaks={len(leaks_auc)} sample={leaks_auc[:2]}")

    # GET /api/cars (anon? actually it's public)
    r = httpx.get(f"{BASE}/cars", timeout=30)
    rec("1.C GET /cars → 200", r.status_code == 200, f"status={r.status_code}")
    leaks_cars = []
    cars_list = r.json() if r.status_code == 200 else []
    for c in cars_list:
        issues = assert_clean_car(c, f"car {c.get('id')}")
        if issues:
            leaks_cars.append({"car_id": c.get("id"), "issues": issues,
                               "fields": {k: c.get(k) for k in INSP_FIELDS}})
    rec("1.D /cars: no synth tokens",
        len(leaks_cars) == 0,
        f"checked={len(cars_list)} leaks={len(leaks_cars)} sample={leaks_cars[:2]}")

    # GET /api/cars/{id} for a few ids
    sample_ids = car_ids[:5] if car_ids else [c.get("id") for c in cars_list[:5] if c.get("id")]
    leaks_one = []
    for cid in sample_ids:
        rr = httpx.get(f"{BASE}/cars/{cid}", timeout=15)
        if rr.status_code != 200:
            leaks_one.append({"car_id": cid, "status": rr.status_code})
            continue
        issues = assert_clean_car(rr.json(), f"car/{cid}")
        if issues:
            leaks_one.append({"car_id": cid, "issues": issues})
    rec("1.E GET /cars/{id}: no synth tokens",
        len(leaks_one) == 0,
        f"checked={len(sample_ids)} leaks={len(leaks_one)} sample={leaks_one[:2]}")

    return auctions


# ============== 2. POST /api/cars accepts + persists real inspection data ==
BASE_REQUIRED = {
    "make": "Honda",
    "model": "City",
    "variant": "ZX CVT",
    "year": 2022,
    "fuel_type": "Petrol",
    "transmission": "Automatic",
    "km_driven": 32450,
    "owners": 1,
    "starting_bid": 800000,
    "reserve_price": 950000,
    "duration_minutes": 60,
}


def reg(prefix="TST"):
    return f"{prefix}{int(time.time() * 1000) % 10_000_000}"


def test_post_cars_persists_inspection(token):
    H = {"Authorization": f"Bearer {token}"}

    # 2a. real inspection values round-trip
    payload = {
        **BASE_REQUIRED,
        "registration_number": reg("R43A"),
        "inspection_score": 8.7,
        "condition_grade": "B",
        "accident_history": "Minor scratch on rear bumper, repaired",
    }
    r = httpx.post(f"{BASE}/cars", json=payload, headers=H, timeout=30)
    rec("2.A POST /cars (real values) → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return
    car_a = r.json()["car"]
    aid_a = r.json()["auction"]["id"]
    rr = httpx.get(f"{BASE}/cars/{car_a['id']}", timeout=15)
    rec("2.A.read GET /cars/{id} → 200", rr.status_code == 200)
    g = rr.json()
    rec("2.A.score round-trips 8.7", g.get("inspection_score") == 8.7,
        f"got={g.get('inspection_score')!r}")
    rec("2.A.grade round-trips 'B'", g.get("condition_grade") == "B",
        f"got={g.get('condition_grade')!r}")
    rec("2.A.acc round-trips exact text",
        g.get("accident_history") == "Minor scratch on rear bumper, repaired",
        f"got={g.get('accident_history')!r}")
    # tyre + service stay None on create
    rec("2.A.tyre stored None",
        g.get("tyre_condition") is None,
        f"got={g.get('tyre_condition')!r}")
    rec("2.A.svc stored None",
        g.get("service_history") is None,
        f"got={g.get('service_history')!r}")

    # 2b. omit all three → all stored as None
    payload2 = {**BASE_REQUIRED, "registration_number": reg("R43B")}
    r = httpx.post(f"{BASE}/cars", json=payload2, headers=H, timeout=30)
    rec("2.B POST /cars (omitted) → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        car_b = r.json()["car"]
        rr = httpx.get(f"{BASE}/cars/{car_b['id']}", timeout=15)
        g = rr.json()
        rec("2.B.score is None", g.get("inspection_score") is None,
            f"got={g.get('inspection_score')!r}")
        rec("2.B.grade is None (NOT defaulted to 'A')",
            g.get("condition_grade") is None,
            f"got={g.get('condition_grade')!r}")
        rec("2.B.acc is None (NOT defaulted to 'None Reported')",
            g.get("accident_history") is None,
            f"got={g.get('accident_history')!r}")
        rec("2.B.tyre is None", g.get("tyre_condition") is None,
            f"got={g.get('tyre_condition')!r}")
        rec("2.B.svc is None (NOT defaulted to 'Authorised Service')",
            g.get("service_history") is None,
            f"got={g.get('service_history')!r}")

    # 2c. lowercase padded grade → uppercased + trimmed
    payload3 = {
        **BASE_REQUIRED,
        "registration_number": reg("R43C"),
        "condition_grade": "  b  ",
    }
    r = httpx.post(f"{BASE}/cars", json=payload3, headers=H, timeout=30)
    rec("2.C POST /cars (grade='  b  ') → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        car_c = r.json()["car"]
        rr = httpx.get(f"{BASE}/cars/{car_c['id']}", timeout=15)
        g = rr.json()
        rec("2.C.grade normalised to 'B'", g.get("condition_grade") == "B",
            f"got={g.get('condition_grade')!r}")

    # 2d. whitespace-only accident_history → stored as None
    payload4 = {
        **BASE_REQUIRED,
        "registration_number": reg("R43D"),
        "accident_history": "   ",
    }
    r = httpx.post(f"{BASE}/cars", json=payload4, headers=H, timeout=30)
    rec("2.D POST /cars (acc='   ') → 200", r.status_code == 200,
        f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        car_d = r.json()["car"]
        rr = httpx.get(f"{BASE}/cars/{car_d['id']}", timeout=15)
        g = rr.json()
        rec("2.D.acc is None (whitespace trimmed)",
            g.get("accident_history") is None,
            f"got={g.get('accident_history')!r}")


# ============== 3. inspection_score boundary validation ====================
def test_inspection_score_bounds(token):
    H = {"Authorization": f"Bearer {token}"}

    def post(score, tag):
        p = {**BASE_REQUIRED, "registration_number": reg(f"R43S{tag}"),
             "inspection_score": score}
        return httpx.post(f"{BASE}/cars", json=p, headers=H, timeout=30)

    r = post(-1, "neg")
    rec("3.A inspection_score=-1 → 422",
        r.status_code == 422, f"status={r.status_code}")

    r = post(10.5, "ov")
    rec("3.B inspection_score=10.5 → 422",
        r.status_code == 422, f"status={r.status_code}")

    r = post(0.0, "lo")
    rec("3.C inspection_score=0.0 → 200 (boundary)",
        r.status_code == 200, f"status={r.status_code} body={r.text[:160]}")

    r = post(10.0, "hi")
    rec("3.D inspection_score=10.0 → 200 (boundary)",
        r.status_code == 200, f"status={r.status_code} body={r.text[:160]}")


# ============== 4. startup migration is idempotent =========================
def test_no_token_leakage_after_boot():
    r = httpx.get(f"{BASE}/auctions", timeout=30)
    if r.status_code != 200:
        rec("4 /auctions reachable", False, f"status={r.status_code}")
        return
    auctions = r.json()
    bad = 0
    for a in auctions:
        car = a.get("car") or {}
        if (car.get("accident_history") in SYNTH_ACCIDENT
            or car.get("service_history") in SYNTH_SERVICE
            or car.get("condition_grade") in SYNTH_GRADE
            or car.get("tyre_condition") in SYNTH_TYRE):
            bad += 1
    rec("4 startup synth purge idempotent (0 token leaks)",
        bad == 0, f"leaks={bad} of {len(auctions)} auctions")


# ============== 5. Regression — duration + draft → live ====================
def test_duration_regression(token):
    H = {"Authorization": f"Bearer {token}"}

    # 7-day draft
    p7 = {**BASE_REQUIRED, "duration_minutes": 10080,
          "registration_number": reg("R43W7")}
    r = httpx.post(f"{BASE}/cars", json=p7, headers=H, timeout=30)
    rec("5.A POST /cars duration=10080 → 200",
        r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code != 200:
        return
    body = r.json()
    aid = body["auction"]["id"]
    car_id = body["car"]["id"]
    rec("5.A.status draft", body["auction"]["status"] == "draft",
        f"status={body['auction'].get('status')}")

    # upload 3 media + featured then launch
    def upload(idx):
        # 1x1 JPEG
        jpeg = bytes.fromhex(
            "FFD8FFE000104A46494600010101006000600000FFDB004300080606070605"
            "080707070909080A0C140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E"
            "2720222C231C1C2837292C30313434341F27393D38323C2E333432FFC00011"
            "0800010001030122000211010311010011FFC4001F0000010501010101"
            "01010100000000000000000102030405060708090A0BFFC400B5100002"
            "010303020403050504040000017D01020300041105122131410613516107"
            "227114328191A1082342B1C11552D1F02433627282090A161718191A2526"
            "2728292A3435363738393A434445464748494A535455565758595A636465"
            "666768696A737475767778797A838485868788898A92939495969798999A"
            "A2A3A4A5A6A7A8A9AAB2B3B4B5B6B7B8B9BAC2C3C4C5C6C7C8C9CAD2D3D4"
            "D5D6D7D8D9DAE1E2E3E4E5E6E7E8E9EAF1F2F3F4F5F6F7F8F9FAFFDA0008"
            "010100003F00FBFD28A28AFFD9"
        )
        files = {"file": (f"e{idx}.jpg", jpeg, "image/jpeg")}
        data = {"car_id": car_id, "section": "exterior"}
        return httpx.post(f"{BASE}/media/upload", files=files, data=data,
                          headers=H, timeout=30)

    mids = []
    for i in range(3):
        rr = upload(i)
        if rr.status_code == 200:
            mids.append(rr.json().get("id") or rr.json().get("media", {}).get("id"))
    # featured
    if mids and mids[0]:
        httpx.post(f"{BASE}/cars/{car_id}/media/featured/{mids[0]}",
                   headers=H, timeout=15)

    rr = httpx.post(f"{BASE}/admin/auctions/{aid}/launch",
                    json={}, headers=H, timeout=30)
    rec("5.A.launch /launch → 200",
        rr.status_code == 200, f"status={rr.status_code} body={rr.text[:300]}")
    if rr.status_code == 200:
        au = rr.json().get("auction") or rr.json()
        # fetch fresh
        rr2 = httpx.get(f"{BASE}/auctions/{aid}",
                        headers=H, timeout=15)
        if rr2.status_code == 200:
            au = rr2.json()
        # duration 7d ± 60s tolerance
        from datetime import datetime
        try:
            s = au.get("start_time"); e = au.get("end_time")
            sd = datetime.fromisoformat(s.replace("Z", "+00:00")) if isinstance(s, str) else s
            ed = datetime.fromisoformat(e.replace("Z", "+00:00")) if isinstance(e, str) else e
            delta = (ed - sd).total_seconds()
            rec("5.A.7d window end-start ≈ 7 days",
                abs(delta - 7 * 86400) < 60,
                f"delta_seconds={delta}")
        except Exception as exc:
            rec("5.A.7d window parse", False, f"exc={exc}")

    # default 60-min flow
    p60 = {**BASE_REQUIRED, "duration_minutes": 60,
           "registration_number": reg("R43W6")}
    r = httpx.post(f"{BASE}/cars", json=p60, headers=H, timeout=30)
    rec("5.B POST /cars duration=60 → 200",
        r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    if r.status_code == 200:
        rec("5.B.status draft", r.json()["auction"]["status"] == "draft",
            f"status={r.json()['auction'].get('status')}")


def main():
    print("=" * 70)
    print("RUN 43 — P0 Trust + Data Mapping fix — backend regression")
    print("=" * 70)
    tok = op_token()
    test_synth_purge()
    test_post_cars_persists_inspection(tok)
    test_inspection_score_bounds(tok)
    test_no_token_leakage_after_boot()
    test_duration_regression(tok)

    print("\n" + "=" * 70)
    p = sum(1 for _, ok, _ in results if ok)
    f = sum(1 for _, ok, _ in results if not ok)
    print(f"SUMMARY: {p}/{len(results)} PASS · {f} FAIL")
    if f:
        print("FAILURES:")
        for n, ok, d in results:
            if not ok:
                print(f"  ✗ {n} :: {d}")
    print("=" * 70)


if __name__ == "__main__":
    main()
