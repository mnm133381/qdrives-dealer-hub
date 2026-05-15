"""
P0 operator end-to-end draft creation test (review-driven).
Target: http://localhost:8001/api
DEV_BYPASS_OTP=true; OTP="123456".
"""
import json
import httpx

BASE = "http://localhost:8001/api"
OTP = "123456"

OPERATOR_PHONE = "+918977986662"   # Nihad M, super_admin
OPERATOR_PHONE_ALT = "+919900000099"
DEALER_PHONE = "+919900000001"     # approved dealer (Apex)

results = []
def rec(name, ok, detail=""):
    flag = "PASS" if ok else "FAIL"
    results.append((flag, name, detail))
    print(f"[{flag}] {name} — {detail}")

def post(path, **kw):
    return httpx.post(BASE + path, timeout=30, **kw)
def get(path, **kw):
    return httpx.get(BASE + path, timeout=30, **kw)

# ---------- 1. Operator login ----------
print("\n=== 1. OPERATOR LOGIN ===")
r = post("/auth/operator/send-otp", json={"phone": OPERATOR_PHONE})
rec("1a operator send-otp 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")

r = post("/auth/operator/verify-otp", json={"phone": OPERATOR_PHONE, "otp": OTP})
op_body = {}
try: op_body = r.json()
except: pass
rec("1b operator verify-otp 200", r.status_code == 200, f"got {r.status_code} body keys={list(op_body.keys()) if op_body else r.text[:200]}")

op_token = op_body.get("access_token") or op_body.get("token")
op_dealer = op_body.get("dealer") or {}
op_role = op_dealer.get("role")
rec("1c operator token present", bool(op_token), f"token len={len(op_token) if op_token else 0}")
rec("1d operator role admin-tier", op_role in ("super_admin","admin","operations_admin","inspection_admin"),
    f"role={op_role!r}")

# auth/me
h_op = {"Authorization": f"Bearer {op_token}"} if op_token else {}
r = get("/auth/me", headers=h_op)
me_body = {}
try: me_body = r.json()
except: pass
rec("1e /auth/me 200", r.status_code == 200, f"got {r.status_code}")
rec("1f /auth/me role matches", me_body.get("role") == op_role, f"me.role={me_body.get('role')!r} login.role={op_role!r}")

# ---------- 2. Role isolation: operator phone on dealer endpoint ----------
print("\n=== 2. ROLE ISOLATION ===")
r = post("/auth/dealer/send-otp", json={"phone": OPERATOR_PHONE})
try:
    rb = r.json()
except Exception:
    rb = {}
rec("2a dealer/send-otp w/ operator phone → 403", r.status_code == 403,
    f"got {r.status_code} body={rb}")
rec("2b dealer/send-otp detail == USE_OPERATOR_LOGIN", rb.get("detail") == "USE_OPERATOR_LOGIN",
    f"detail={rb.get('detail')!r}")

# dealer login
r = post("/auth/dealer/send-otp", json={"phone": DEALER_PHONE})
rec("2c dealer/send-otp w/ dealer phone 200", r.status_code == 200, f"got {r.status_code}")
r = post("/auth/dealer/verify-otp", json={"phone": DEALER_PHONE, "otp": OTP})
dlr_body = {}
try: dlr_body = r.json()
except: pass
rec("2d dealer/verify-otp 200", r.status_code == 200, f"got {r.status_code}")
dlr_token = dlr_body.get("access_token") or dlr_body.get("token")
h_dlr = {"Authorization": f"Bearer {dlr_token}"} if dlr_token else {}
rec("2e dealer.role == 'dealer'", (dlr_body.get("dealer") or {}).get("role") == "dealer",
    f"role={(dlr_body.get('dealer') or {}).get('role')!r}")

# dealer tries POST /cars
car_payload_min = {
  "registration_number": "MH04AB1234",
  "make": "Honda", "model": "City", "variant": "VX CVT",
  "year": 2022, "manufacturing_year": 2022, "registration_year": 2022,
  "fuel_type": "Petrol", "transmission": "Automatic", "km_driven": 28000,
  "color": "White", "owners": 1, "insurance_validity": "06/2026",
  "rto_details": "Mumbai East", "notes": "Single owner test draft",
  "starting_bid": 600000, "reserve_price": 800000, "duration_minutes": 60,
  "images": [], "description": "Test draft"
}
r = post("/cars", json=car_payload_min, headers=h_dlr)
try:
    rb = r.json()
except Exception:
    rb = {}
rec("2f dealer POST /cars → 403", r.status_code == 403, f"got {r.status_code} body={rb}")
rec("2g detail mentions 'Admin access required'", "Admin access required" in str(rb.get("detail","")),
    f"detail={rb.get('detail')!r}")

# ---------- 3. Operator creates DRAFT ----------
print("\n=== 3. OPERATOR CREATES DRAFT ===")
r = post("/cars", json=car_payload_min, headers=h_op)
draft_body = {}
try: draft_body = r.json()
except: pass
rec("3a operator POST /cars 200", r.status_code == 200, f"got {r.status_code} body={str(draft_body)[:300]}")

car = draft_body.get("car") or {}
auction = draft_body.get("auction") or {}
car_id = car.get("id")
auction_id = auction.get("id")
rec("3b res.car.id present", bool(car_id), f"car.id={car_id!r}")
rec("3c res.auction.id present", bool(auction_id), f"auction.id={auction_id!r}")
rec("3d auction.status == 'draft'", auction.get("status") == "draft", f"status={auction.get('status')!r}")
print("\n[BODY SHAPE]", json.dumps({
    "top_level_keys": list(draft_body.keys()),
    "car_keys": list(car.keys())[:20],
    "auction_keys": list(auction.keys())[:30],
    "car.id": car_id,
    "auction.id": auction_id,
    "auction.status": auction.get("status"),
    "auction.seller_id": auction.get("seller_id"),
}, indent=2, default=str))

# ---------- 4. Visibility ----------
print("\n=== 4. DRAFT VISIBILITY ===")
# Anonymous /auctions should EXCLUDE drafts
r = get("/auctions")
anon_list = r.json() if r.status_code == 200 else []
ids = [a.get("id") for a in anon_list]
draft_in_anon = auction_id in ids if auction_id else False
rec("4a anon /auctions excludes draft", not draft_in_anon, f"draft_in_list={draft_in_anon}, total={len(anon_list)}")
# also no draft status leaks
has_draft_status = any(a.get("status") == "draft" for a in anon_list)
rec("4b anon /auctions has no draft-status items", not has_draft_status,
    f"any draft status={has_draft_status}")

# operator listing with seller_id=me (review-requested filter — endpoint may not exist)
r = get("/auctions", params={"seller_id":"me"}, headers=h_op)
op_list = r.json() if r.status_code == 200 else []
print(f"   /auctions?seller_id=me as operator → status={r.status_code} count={len(op_list) if isinstance(op_list,list) else 'n/a'}")
ids_op = [a.get("id") for a in op_list] if isinstance(op_list, list) else []
# This endpoint doesn't filter by seller_id at all — it always uses marketplace_query which excludes drafts.
draft_in_op = auction_id in ids_op
rec("4c /auctions?seller_id=me as operator INCLUDES draft (review expected)",
    draft_in_op,
    f"draft visible to operator via /auctions?seller_id=me = {draft_in_op} (likely FAILS: endpoint ignores seller_id and uses marketplace_query that excludes drafts)")

# Try GET /auctions/{draft_id} directly with operator
r = get(f"/auctions/{auction_id}", headers=h_op) if auction_id else None
if r is not None:
    rec("4d operator GET /auctions/{draft_id} returns 200", r.status_code == 200,
        f"got {r.status_code}")
    try:
        body = r.json()
        rec("4e GET /auctions/{draft_id} preserves status=draft", body.get("status") == "draft",
            f"status={body.get('status')!r}")
    except Exception as e:
        rec("4e parse", False, str(e))

# ---------- 5. Launch readiness ----------
print("\n=== 5. LAUNCH READINESS ===")
if auction_id:
    r = get(f"/admin/auctions/{auction_id}/launch-readiness", headers=h_op)
    rd = {}
    try: rd = r.json()
    except: pass
    rec("5a launch-readiness 200", r.status_code == 200, f"got {r.status_code} body={rd}")
    rec("5b ready==false", rd.get("ready") is False, f"ready={rd.get('ready')!r}")
    rec("5c media_count==0", rd.get("media_count") == 0, f"media_count={rd.get('media_count')!r}")
    rec("5d issues non-empty", bool(rd.get("issues")), f"issues={rd.get('issues')}")
else:
    rec("5 launch-readiness", False, "no auction_id")

# ---------- 6. Validation 422 sanity ----------
print("\n=== 6. VALIDATION 422 ===")
bad = dict(car_payload_min)
bad["registration_number"] = "MH04ZZ7777"
bad["starting_bid"] = 0
bad["reserve_price"] = 0
r = post("/cars", json=bad, headers=h_op)
try: rb = r.json()
except: rb = {"_raw": r.text[:300]}
print(f"   POST /cars (zero bids) → status={r.status_code} body={str(rb)[:400]}")
rec("6a starting/reserve=0 returns 422 (review expects)", r.status_code == 422,
    f"got {r.status_code} (likely FAILS — model has no gt=0 validator, accepts 0 as int)")
if r.status_code == 422:
    rec("6b 422 detail is list", isinstance(rb.get("detail"), list),
        f"detail type={type(rb.get('detail')).__name__}")
else:
    # If created, we expect the field doesn't validate. Report.
    rec("6b 422 detail is list", False, f"non-422 — payload accepted (status={r.status_code})")

# Also try missing required field
bad2 = dict(car_payload_min)
bad2.pop("make")
bad2["registration_number"] = "MH04ZZ8888"
r = post("/cars", json=bad2, headers=h_op)
rec("6c missing 'make' returns 422", r.status_code == 422, f"got {r.status_code}")
try:
    rb = r.json()
    rec("6d missing-field detail is list", isinstance(rb.get("detail"), list), f"detail={str(rb.get('detail'))[:200]}")
except Exception:
    rec("6d parse", False, "n/a")

# ---------- SUMMARY ----------
print("\n" + "="*78)
print("SUMMARY")
print("="*78)
passes = sum(1 for f,_,_ in results if f=="PASS")
fails = sum(1 for f,_,_ in results if f=="FAIL")
print(f"PASS={passes}  FAIL={fails}  TOTAL={len(results)}")
for f, n, d in results:
    if f == "FAIL":
        print(f"  ❌ {n} — {d}")
print("\nCore Question: Operator able to create draft? →",
      "YES" if all(r[0]=="PASS" for r in results if r[1].startswith("3")) else "NO")
