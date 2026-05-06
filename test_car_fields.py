"""
Targeted backend test: POST /api/cars accepting new optional vehicle detail fields.
Covers:
  A. Full payload with all new fields
  B. Minimal/legacy payload (backwards compat)
  C. Missing required field returns 422
  D. GET /api/cars/{id} returns the new fields persisted in A
"""
import os
import requests

BASE = os.environ.get("BACKEND_URL", "https://qdrives-dealer-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

PHONE = "+919900000002"
OTP = "123456"

results = []


def record(name, ok, msg=""):
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name} :: {msg}")
    results.append((name, ok, msg))
    return ok


def login():
    r = requests.post(f"{API}/auth/send-otp", json={"phone": PHONE}, timeout=15)
    assert r.status_code == 200, f"send-otp: {r.status_code} {r.text}"
    r = requests.post(f"{API}/auth/verify-otp", json={"phone": PHONE, "otp": OTP}, timeout=15)
    assert r.status_code == 200, f"verify-otp: {r.status_code} {r.text}"
    return r.json()["token"]


def auth_h(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_full_payload(tok):
    payload = {
        "registration_number": "MH02XY9999",
        "make": "Hyundai",
        "model": "Creta",
        "variant": "Signature 1.5 Turbo",
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
        "notes": "Single owner, full service history at authorised dealer.",
        "starting_bid": 1500000,
        "reserve_price": 1700000,
        "duration_minutes": 60,
        "images": [],
        "description": ""
    }
    r = requests.post(f"{API}/cars", json=payload, headers=auth_h(tok), timeout=30)
    if not record("A.1 status 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}"):
        return None
    body = r.json()
    car = body.get("car", {})
    auction = body.get("auction", {})

    record("A.2 car.manufacturing_year == 2022", car.get("manufacturing_year") == 2022, str(car.get("manufacturing_year")))
    record("A.3 car.registration_year == 2023", car.get("registration_year") == 2023, str(car.get("registration_year")))
    record("A.4 car.insurance_validity == '08/2026'", car.get("insurance_validity") == "08/2026", str(car.get("insurance_validity")))
    record("A.5 car.rto_details == 'MH02 - Mumbai West'", car.get("rto_details") == "MH02 - Mumbai West", str(car.get("rto_details")))
    record("A.6 car.notes contains exact string",
           car.get("notes") == "Single owner, full service history at authorised dealer.",
           str(car.get("notes"))[:80])
    record("A.7 car.year == 2023 (registration_year fallback)", car.get("year") == 2023, str(car.get("year")))
    record("A.8 car.rc_verified is False", car.get("rc_verified") is False, str(car.get("rc_verified")))
    record("A.9 auction.status == 'live'", auction.get("status") == "live", str(auction.get("status")))
    record("A.10 auction.car.id == car.id",
           (auction.get("car") or {}).get("id") == car.get("id"),
           f"{(auction.get('car') or {}).get('id')} vs {car.get('id')}")
    return car.get("id")


def test_minimal_payload(tok):
    payload = {
        "registration_number": "MH99AB1111",
        "make": "Tata",
        "model": "Nexon",
        "year": 2022,
        "fuel_type": "Diesel",
        "transmission": "Manual",
        "km_driven": 41000,
        "color": "White",
        "owners": 2,
        "starting_bid": 800000,
        "reserve_price": 900000
    }
    r = requests.post(f"{API}/cars", json=payload, headers=auth_h(tok), timeout=30)
    if not record("B.1 status 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}"):
        return
    car = r.json().get("car", {})
    record("B.2 manufacturing_year falls back to year (2022)", car.get("manufacturing_year") == 2022, str(car.get("manufacturing_year")))
    record("B.3 registration_year == 2022", car.get("registration_year") == 2022, str(car.get("registration_year")))
    record("B.4 insurance_validity == ''", car.get("insurance_validity") == "", repr(car.get("insurance_validity")))
    record("B.5 rto_details == ''", car.get("rto_details") == "", repr(car.get("rto_details")))
    record("B.6 notes == ''", car.get("notes") == "", repr(car.get("notes")))
    record("B.7 rc_verified is False", car.get("rc_verified") is False, str(car.get("rc_verified")))


def test_missing_required(tok):
    payload = {
        # "make" intentionally missing
        "registration_number": "MH33ZZ4444",
        "model": "Nexon",
        "year": 2022,
        "fuel_type": "Diesel",
        "transmission": "Manual",
        "km_driven": 41000,
        "color": "White",
        "owners": 2,
        "starting_bid": 800000,
        "reserve_price": 900000
    }
    r = requests.post(f"{API}/cars", json=payload, headers=auth_h(tok), timeout=20)
    record("C.1 missing 'make' returns 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")


def test_get_car(car_id):
    r = requests.get(f"{API}/cars/{car_id}", timeout=15)
    if not record("D.1 GET /cars/{id} status 200", r.status_code == 200, str(r.status_code)):
        return
    car = r.json()
    record("D.2 manufacturing_year persisted (2022)", car.get("manufacturing_year") == 2022, str(car.get("manufacturing_year")))
    record("D.3 registration_year persisted (2023)", car.get("registration_year") == 2023, str(car.get("registration_year")))
    record("D.4 insurance_validity persisted", car.get("insurance_validity") == "08/2026", str(car.get("insurance_validity")))
    record("D.5 rto_details persisted", car.get("rto_details") == "MH02 - Mumbai West", str(car.get("rto_details")))
    record("D.6 notes persisted", car.get("notes") == "Single owner, full service history at authorised dealer.", str(car.get("notes"))[:80])
    record("D.7 rc_verified is False", car.get("rc_verified") is False, str(car.get("rc_verified")))


def main():
    print(f"BASE: {API}")
    tok = login()
    car_id = test_full_payload(tok)
    test_minimal_payload(tok)
    test_missing_required(tok)
    if car_id:
        test_get_car(car_id)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, m) for n, ok, m in results if not ok]
    print("\n========== SUMMARY ==========")
    print(f"Total: {len(results)}  Passed: {passed}  Failed: {len(failed)}")
    for n, m in failed:
        print(f"  - FAIL {n} :: {m}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
