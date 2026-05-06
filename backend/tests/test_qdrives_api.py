"""
Q Drives backend API regression tests.

Covers:
- Health
- OTP send/verify (mock)
- Auth /me + KYC
- Cars (list seeded)
- Auctions (list, filter live, single + recent_bids)
- Market pulse
- Dashboard stats
- Bid placement (valid, low amount, own auction)
- Watchlist toggle
- Notifications (incl. outbid)
- Car create -> auto auction
- AI price estimate (mock fallback ok)
- WebSocket /api/ws/auction/{id} snapshot + new_bid broadcast
"""
import json
import time
import uuid
import asyncio

import pytest
import requests
import websockets


# ---------- Health ----------
class TestHealth:
    def test_root(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "ok"


# ---------- Auth / OTP ----------
NEW_PHONE = f"+9198{int(time.time()) % 100000000:08d}"
SEED_PHONE = "+919900000001"


@pytest.fixture(scope="session")
def auth_state():
    """Holds tokens & ids shared across test classes."""
    return {}


class TestOtpAuth:
    def test_send_otp_returns_dev_otp(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/auth/send-otp", json={"phone": NEW_PHONE})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("success") is True
        assert data.get("dev_otp") == "123456"

    def test_send_otp_invalid_phone(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/auth/send-otp", json={"phone": "123"})
        assert r.status_code == 400

    def test_verify_wrong_otp(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/verify-otp",
            json={"phone": NEW_PHONE, "otp": "000000"},
        )
        assert r.status_code == 400

    def test_verify_new_user_creates_dealer(self, api_client, base_url, auth_state):
        r = api_client.post(
            f"{base_url}/api/auth/verify-otp",
            json={"phone": NEW_PHONE, "otp": "123456"},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "token" in data and data["token"]
        assert data["is_new"] is True
        assert data["dealer"]["phone"] == NEW_PHONE
        auth_state["new_token"] = data["token"]
        auth_state["new_dealer_id"] = data["dealer"]["id"]

    def test_verify_existing_user_is_not_new(self, api_client, base_url, auth_state):
        # Re-login same phone -> is_new=false
        r = api_client.post(
            f"{base_url}/api/auth/verify-otp",
            json={"phone": NEW_PHONE, "otp": "123456"},
        )
        assert r.status_code == 200
        assert r.json()["is_new"] is False

    def test_verify_seed_dealer(self, api_client, base_url, auth_state):
        r = api_client.post(
            f"{base_url}/api/auth/verify-otp",
            json={"phone": SEED_PHONE, "otp": "123456"},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["is_new"] is False
        assert data["dealer"]["phone"] == SEED_PHONE
        auth_state["seed_token"] = data["token"]
        auth_state["seed_dealer_id"] = data["dealer"]["id"]


class TestMeAndKyc:
    def test_me_without_token_401(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/auth/me")
        assert r.status_code == 401

    def test_me_with_token(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        r = api_client.get(
            f"{base_url}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["id"] == auth_state["new_dealer_id"]
        assert "phone" in d

    def test_kyc_updates_profile(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        body = {
            "full_name": "TEST Tester",
            "dealership_name": "TEST Auto Hub",
            "city": "Mumbai",
            "gst_number": "29ABCDE1234F1Z5",
            "pan_number": "ABCDE1234F",
        }
        r = api_client.post(
            f"{base_url}/api/auth/kyc",
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["kyc_completed"] is True
        assert d["verified"] is True
        assert d["dealership_name"] == "TEST Auto Hub"
        # Verify persistence with a follow-up GET
        r2 = api_client.get(
            f"{base_url}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r2.status_code == 200
        assert r2.json()["dealership_name"] == "TEST Auto Hub"


# ---------- Cars / Auctions / Market ----------
class TestCatalog:
    def test_cars_seeded(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/cars")
        assert r.status_code == 200
        cars = r.json()
        assert isinstance(cars, list)
        assert len(cars) >= 12, f"expected >=12 seeded cars, got {len(cars)}"
        first = cars[0]
        for k in ("id", "make", "model", "year", "images"):
            assert k in first

    def test_auctions_list_enriched(self, api_client, base_url, auth_state):
        r = api_client.get(f"{base_url}/api/auctions")
        assert r.status_code == 200
        auctions = r.json()
        assert isinstance(auctions, list) and len(auctions) > 0
        a = auctions[0]
        for k in ("id", "car", "seller", "status", "seconds_remaining"):
            assert k in a, f"missing {k} in enriched auction"
        assert a["car"] is not None
        assert a["seller"] is not None
        auth_state["sample_auction"] = a

    def test_auctions_filter_live(self, api_client, base_url, auth_state):
        r = api_client.get(f"{base_url}/api/auctions?status_filter=live")
        assert r.status_code == 200
        live = r.json()
        assert isinstance(live, list)
        assert len(live) >= 1, "expected some live auctions from seed"
        for a in live:
            assert a["status"] == "live"
        auth_state["live_auctions"] = live

    def test_get_single_auction_with_recent_bids(self, api_client, base_url, auth_state):
        live = auth_state["live_auctions"]
        a = live[0]
        r = api_client.get(f"{base_url}/api/auctions/{a['id']}")
        assert r.status_code == 200
        d = r.json()
        assert d["id"] == a["id"]
        assert "recent_bids" in d
        assert isinstance(d["recent_bids"], list)

    def test_market_pulse(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/market/pulse")
        assert r.status_code == 200
        d = r.json()
        for k in ("live", "upcoming", "ended", "live_volume_inr", "top_makes"):
            assert k in d
        assert isinstance(d["live_volume_inr"], (int, float))


# ---------- Dashboard ----------
class TestDashboard:
    def test_dashboard_stats_requires_auth(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/dashboard/stats")
        assert r.status_code == 401

    def test_dashboard_stats_authed(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        r = api_client.get(
            f"{base_url}/api/dashboard/stats",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        d = r.json()
        for k in ("trust_score", "your_bids", "your_wins", "your_listings", "live_auctions"):
            assert k in d


# ---------- Bidding ----------
class TestBidding:
    def test_bid_low_amount_400(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        # Find an auction NOT owned by new dealer
        live = auth_state["live_auctions"]
        target = next(a for a in live if a["seller"]["id"] != auth_state["new_dealer_id"])
        auth_state["bid_target"] = target
        r = api_client.post(
            f"{base_url}/api/auctions/{target['id']}/bid",
            json={"amount": 100},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 400

    def test_bid_on_own_auction_400(self, api_client, base_url, auth_state):
        # Try all seed dealers; pick the first one that owns any live auction
        live = auth_state["live_auctions"]
        owner_token = None
        own = None
        for phone in ["+919900000001", "+919900000002", "+919900000003", "+919900000004", "+919900000005"]:
            r = api_client.post(
                f"{base_url}/api/auth/verify-otp",
                json={"phone": phone, "otp": "123456"},
            )
            d = r.json()
            seller_id = d["dealer"]["id"]
            owned = next((a for a in live if a["seller"]["id"] == seller_id), None)
            if owned:
                owner_token = d["token"]
                own = owned
                break
        assert own is not None, "no seed dealer owns a live auction (unexpected)"
        cur = own.get("current_bid", 0) or 0
        r = api_client.post(
            f"{base_url}/api/auctions/{own['id']}/bid",
            json={"amount": cur + 5000},
            headers={"Authorization": f"Bearer {owner_token}"},
        )
        assert r.status_code == 400
        assert "own auction" in r.text.lower()

    def test_bid_valid(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        target = auth_state["bid_target"]
        # refresh current_bid
        r0 = api_client.get(f"{base_url}/api/auctions/{target['id']}")
        cur = r0.json().get("current_bid", 0) or 0
        amount = cur + 5000
        r = api_client.post(
            f"{base_url}/api/auctions/{target['id']}/bid",
            json={"amount": amount},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["success"] is True
        assert body["bid"]["amount"] == amount
        # Verify persistence: GET auction now shows current_bid == amount
        r2 = api_client.get(f"{base_url}/api/auctions/{target['id']}")
        assert r2.json()["current_bid"] == amount
        auth_state["last_bid_amount"] = amount

    def test_outbid_creates_notification_for_prev_top(self, api_client, base_url, auth_state):
        # New dealer is now top. Login as a different seed dealer to outbid -> new dealer should get a notification
        # Use seed dealer #2
        r = api_client.post(
            f"{base_url}/api/auth/verify-otp",
            json={"phone": "+919900000002", "otp": "123456"},
        )
        token2 = r.json()["token"]
        dealer2_id = r.json()["dealer"]["id"]
        target = auth_state["bid_target"]
        # If seed#2 happens to own this auction, fallback to seed#3
        ad = api_client.get(f"{base_url}/api/auctions/{target['id']}").json()
        if ad["seller"]["id"] == dealer2_id:
            r = api_client.post(
                f"{base_url}/api/auth/verify-otp",
                json={"phone": "+919900000003", "otp": "123456"},
            )
            token2 = r.json()["token"]
        cur = ad.get("current_bid", 0)
        amount = cur + 5000
        rb = api_client.post(
            f"{base_url}/api/auctions/{target['id']}/bid",
            json={"amount": amount},
            headers={"Authorization": f"Bearer {token2}"},
        )
        assert rb.status_code == 200, rb.text
        # New dealer should now have an "outbid" notification
        new_token = auth_state["new_token"]
        rn = api_client.get(
            f"{base_url}/api/notifications",
            headers={"Authorization": f"Bearer {new_token}"},
        )
        assert rn.status_code == 200
        notifs = rn.json()
        assert any(n["type"] == "outbid" for n in notifs), "expected outbid notification"


# ---------- Watchlist ----------
class TestWatchlist:
    def test_watchlist_toggle(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        h = {"Authorization": f"Bearer {token}"}
        live = auth_state["live_auctions"]
        aid = live[0]["id"]
        # Add
        r = api_client.post(f"{base_url}/api/watchlist/{aid}", headers=h)
        assert r.status_code == 200 and r.json()["watching"] is True
        # GET contains it
        rg = api_client.get(f"{base_url}/api/watchlist", headers=h)
        assert rg.status_code == 200
        ids = [a["id"] for a in rg.json()]
        assert aid in ids
        # Remove
        rd = api_client.delete(f"{base_url}/api/watchlist/{aid}", headers=h)
        assert rd.status_code == 200 and rd.json()["watching"] is False
        # Verify removal
        rg2 = api_client.get(f"{base_url}/api/watchlist", headers=h)
        assert aid not in [a["id"] for a in rg2.json()]


# ---------- Sell flow: create car + auction ----------
class TestSellFlow:
    def test_create_car_creates_auction(self, api_client, base_url, auth_state):
        token = auth_state["new_token"]
        body = {
            "registration_number": f"TEST{uuid.uuid4().hex[:6].upper()}",
            "make": "Tata",
            "model": "Nexon",
            "variant": "XZ+",
            "year": 2022,
            "fuel_type": "Petrol",
            "transmission": "Manual",
            "km_driven": 22000,
            "color": "Flame Red",
            "owners": 1,
            "reserve_price": 900000,
            "starting_bid": 800000,
            "images": [],
            "description": "TEST listing",
            "duration_minutes": 30,
        }
        r = api_client.post(
            f"{base_url}/api/cars",
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert "car" in d and "auction" in d
        assert d["auction"]["status"] in ("live", "upcoming")
        assert d["auction"]["car"]["id"] == d["car"]["id"]


# ---------- AI price estimate ----------
class TestAiPricing:
    def test_price_estimate_returns_required_fields(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/price-estimate",
            json={
                "make": "Hyundai",
                "model": "Creta",
                "year": 2021,
                "km_driven": 35000,
                "fuel_type": "Petrol",
                "owners": 1,
                "condition_score": 8.5,
            },
            timeout=60,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("estimated_price_inr", "market_low_inr", "market_high_inr", "confidence", "reasoning"):
            assert k in d, f"missing {k}"
        assert isinstance(d["estimated_price_inr"], int)
        assert d["market_low_inr"] <= d["estimated_price_inr"] <= d["market_high_inr"]


# ---------- WebSocket ----------
class TestWebSocket:
    def test_ws_snapshot_and_broadcast(self, api_client, base_url, auth_state):
        # Pick a fresh live auction not owned by new dealer
        live = api_client.get(f"{base_url}/api/auctions?status_filter=live").json()
        target = next(a for a in live if a["seller"]["id"] != auth_state["new_dealer_id"])
        aid = target["id"]
        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/api/ws/auction/{aid}"

        token = auth_state["new_token"]

        async def run():
            async with websockets.connect(ws_url, open_timeout=15) as ws:
                # snapshot
                msg = await asyncio.wait_for(ws.recv(), timeout=10)
                snap = json.loads(msg)
                assert snap["type"] == "snapshot"
                assert snap["auction"]["id"] == aid

                # Place a bid via REST -> should broadcast new_bid to this ws
                cur = api_client.get(f"{base_url}/api/auctions/{aid}").json().get("current_bid", 0)
                amount = cur + 5000
                rb = api_client.post(
                    f"{base_url}/api/auctions/{aid}/bid",
                    json={"amount": amount},
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert rb.status_code == 200, rb.text

                # Wait for broadcast (skip pings)
                got = None
                for _ in range(5):
                    raw = await asyncio.wait_for(ws.recv(), timeout=10)
                    data = json.loads(raw)
                    if data.get("type") == "new_bid":
                        got = data
                        break
                assert got is not None, "did not receive new_bid"
                assert got["current_bid"] == amount

        asyncio.run(run())
