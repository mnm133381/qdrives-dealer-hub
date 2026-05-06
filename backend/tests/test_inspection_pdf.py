"""
Q Drives — Inspection PDF endpoint tests.
Covers upload (auth/seller-only/PDF-only/size cap), by-car, file download (header & ?token=),
auction enrichment with inspection_pdf, and re-upload replacement.
"""
import os
import io
import time
import uuid
import requests
import pytest


# Build a tiny but valid PDF (>200 bytes) on the fly
def _make_pdf(size: int = 800) -> bytes:
    head = b"%PDF-1.4\n%minimal pdf for tests\n"
    pad = b"% padding " + (b"a" * max(0, size - len(head) - 30)) + b"\n"
    tail = b"%%EOF\n"
    return head + pad + tail


SEED_PHONE_SELLER = "+919900000002"  # Royal Drives Co.
SEED_PHONE_OTHER = "+919900000001"  # Apex Premium Motors


@pytest.fixture(scope="module")
def seller_ctx(api_client, base_url):
    r = api_client.post(f"{base_url}/api/auth/verify-otp",
                        json={"phone": SEED_PHONE_SELLER, "otp": "123456"})
    assert r.status_code == 200, r.text
    j = r.json()
    return {"token": j["token"], "id": j["dealer"]["id"]}


@pytest.fixture(scope="module")
def other_ctx(api_client, base_url):
    r = api_client.post(f"{base_url}/api/auth/verify-otp",
                        json={"phone": SEED_PHONE_OTHER, "otp": "123456"})
    assert r.status_code == 200, r.text
    j = r.json()
    return {"token": j["token"], "id": j["dealer"]["id"]}


@pytest.fixture(scope="module")
def seller_car(api_client, base_url, seller_ctx):
    """Create a fresh car owned by the seller so tests are deterministic."""
    body = {
        "registration_number": f"TEST{uuid.uuid4().hex[:6].upper()}",
        "make": "Audi", "model": "Q5 Test", "variant": "TFSI",
        "year": 2021, "fuel_type": "Petrol", "transmission": "Automatic",
        "km_driven": 30000, "color": "White", "owners": 1,
        "reserve_price": 1000000, "starting_bid": 900000,
        "images": [], "description": "TEST", "duration_minutes": 60,
    }
    r = api_client.post(f"{base_url}/api/cars", json=body,
                        headers={"Authorization": f"Bearer {seller_ctx['token']}"})
    assert r.status_code == 200, r.text
    d = r.json()
    return {"car_id": d["car"]["id"], "auction_id": d["auction"]["id"]}


# ---------- Upload validation ----------
class TestInspectionUpload:
    def test_upload_requires_auth(self, api_client, base_url, seller_car):
        files = {"file": ("x.pdf", _make_pdf(), "application/pdf")}
        data = {"car_id": seller_car["car_id"], "version": "v1"}
        # No auth header
        r = requests.post(f"{base_url}/api/inspections/upload", data=data, files=files)
        assert r.status_code == 401

    def test_upload_rejects_non_pdf(self, api_client, base_url, seller_ctx, seller_car):
        files = {"file": ("notes.txt", b"hello world " * 50, "text/plain")}
        data = {"car_id": seller_car["car_id"], "version": "v1"}
        r = requests.post(
            f"{base_url}/api/inspections/upload", data=data, files=files,
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 400, r.text

    def test_upload_rejects_oversize(self, api_client, base_url, seller_ctx, seller_car):
        big = _make_pdf(size=10 * 1024 * 1024 + 4096)
        files = {"file": ("big.pdf", big, "application/pdf")}
        data = {"car_id": seller_car["car_id"], "version": "v1"}
        r = requests.post(
            f"{base_url}/api/inspections/upload", data=data, files=files,
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 413, r.text

    def test_upload_non_seller_403(self, api_client, base_url, other_ctx, seller_car):
        files = {"file": ("x.pdf", _make_pdf(), "application/pdf")}
        data = {"car_id": seller_car["car_id"], "version": "v1"}
        r = requests.post(
            f"{base_url}/api/inspections/upload", data=data, files=files,
            headers={"Authorization": f"Bearer {other_ctx['token']}"},
        )
        assert r.status_code == 403, r.text

    def test_upload_success_seller(self, api_client, base_url, seller_ctx, seller_car, request):
        pdf = _make_pdf(1500)
        files = {"file": ("audi-q5-inspection.pdf", pdf, "application/pdf")}
        data = {"car_id": seller_car["car_id"], "version": "v1"}
        r = requests.post(
            f"{base_url}/api/inspections/upload", data=data, files=files,
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        for k in ("id", "car_id", "uploader_id", "uploader_name", "filename",
                  "size_bytes", "version", "status", "gridfs_id", "created_at"):
            assert k in j, f"missing {k}"
        assert j["car_id"] == seller_car["car_id"]
        assert j["uploader_id"] == seller_ctx["id"]
        assert j["status"] == "verified"
        assert j["size_bytes"] == len(pdf)
        # share id with later tests
        request.config._insp_id_v1 = j["id"]


# ---------- by-car + auction enrichment ----------
class TestByCarAndEnrichment:
    def test_by_car_returns_metadata(self, api_client, base_url, seller_car):
        r = api_client.get(f"{base_url}/api/inspections/by-car/{seller_car['car_id']}")
        assert r.status_code == 200
        j = r.json()
        assert j is not None
        assert j["car_id"] == seller_car["car_id"]
        assert j["filename"].endswith(".pdf")

    def test_auction_enrichment_includes_pdf(self, api_client, base_url, seller_car):
        r = api_client.get(f"{base_url}/api/auctions/{seller_car['auction_id']}")
        assert r.status_code == 200
        a = r.json()
        assert a.get("inspection_pdf") is not None
        assert a["inspection_pdf"]["car_id"] == seller_car["car_id"]
        assert a["inspection_pdf"]["status"] == "verified"

    def test_by_car_unknown_returns_null(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/inspections/by-car/{uuid.uuid4()}")
        assert r.status_code == 200
        assert r.json() is None


# ---------- File download (header + ?token=) ----------
class TestFileDownload:
    def test_download_no_token_401(self, api_client, base_url, request):
        iid = getattr(request.config, "_insp_id_v1", None)
        assert iid, "upload test must run first"
        r = requests.get(f"{base_url}/api/inspections/file/{iid}")
        assert r.status_code == 401

    def test_download_with_bearer_header_200_pdf(self, api_client, base_url, seller_ctx, request):
        iid = request.config._insp_id_v1
        r = requests.get(
            f"{base_url}/api/inspections/file/{iid}",
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content.startswith(b"%PDF")

    def test_download_with_query_token_200_pdf(self, api_client, base_url, seller_ctx, request):
        iid = request.config._insp_id_v1
        r = requests.get(f"{base_url}/api/inspections/file/{iid}",
                         params={"token": seller_ctx["token"]})
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/pdf")

    def test_download_unknown_id_404(self, api_client, base_url, seller_ctx):
        r = requests.get(
            f"{base_url}/api/inspections/file/{uuid.uuid4()}",
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 404


# ---------- Re-upload replaces previous record ----------
class TestReuploadReplaces:
    def test_reupload_replaces_record(self, api_client, base_url, seller_ctx, seller_car):
        pdf2 = _make_pdf(2400)
        files = {"file": ("audi-q5-inspection-v2.pdf", pdf2, "application/pdf")}
        data = {"car_id": seller_car["car_id"], "version": "v2"}
        r = requests.post(
            f"{base_url}/api/inspections/upload", data=data, files=files,
            headers={"Authorization": f"Bearer {seller_ctx['token']}"},
        )
        assert r.status_code == 200, r.text
        new_meta = r.json()
        assert new_meta["version"] == "v2"
        assert new_meta["size_bytes"] == len(pdf2)

        # by-car returns latest only
        r2 = api_client.get(f"{base_url}/api/inspections/by-car/{seller_car['car_id']}")
        assert r2.status_code == 200
        j = r2.json()
        assert j["id"] == new_meta["id"]
        assert j["version"] == "v2"
        assert j["size_bytes"] == len(pdf2)
