"""
Media business logic for Q Drives.

Storage-provider-agnostic. All file persistence is delegated to
`storage_service.StorageBackend` so we can swap GridFS for S3/Cloudinary
without rewriting endpoints.

Schema: db.media documents look like
    {
        id: uuid str,
        car_id: str,
        section: 'exterior' | 'interior' | 'engine' | 'tyres' | 'damage' | 'documents' | 'inspection',
        subsection: str | None,
        order: int,
        is_featured: bool,
        provider: 'gridfs' | 's3' | 'cloudinary' | 'external',
        storage_id: str,
        thumb_storage_id: str | None,  # client-provided thumbnail
        external_url: str | None,      # for legacy seeded URLs
        content_type: str,
        size: int,
        width: int | None,
        height: int | None,
        original_name: str | None,
        created_at: datetime,
        created_by: str,  # dealer id
    }
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from storage_service import get_default_storage

logger = logging.getLogger("qdrives.media")

# ---- Constants ----
SECTIONS = ("exterior", "interior", "engine", "tyres", "damage", "documents", "inspection")
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/heic", "image/heif", "image/webp"}
MAX_FILE_BYTES = 12 * 1024 * 1024  # 12MB safety ceiling per file
MAX_PER_CAR = 50

# Mandatory minimums per section enforced before launch.
MANDATORY_MINIMUMS: Dict[str, int] = {
    "exterior": 8,
    "interior": 6,
    "engine": 3,
    "tyres": 4,
    "documents": 2,
    "inspection": 1,  # at least one VIN/Chassis image
    # damage handled separately — either ≥1 image OR no_damage_attested = true
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _serialise_media(m: Dict[str, Any]) -> Dict[str, Any]:
    """Output shape that the frontend consumes. URLs are relative; the client
    prefixes them with EXPO_PUBLIC_BACKEND_URL."""
    if not m:
        return m
    out = dict(m)
    out.pop("_id", None)
    if isinstance(out.get("created_at"), datetime):
        out["created_at"] = out["created_at"].isoformat()
    if m.get("provider") == "external":
        out["url"] = m.get("external_url")
        out["thumb_url"] = m.get("external_url")
    else:
        mid = m.get("id")
        out["url"] = f"/api/media/{mid}/file"
        out["thumb_url"] = f"/api/media/{mid}/thumb" if m.get("thumb_storage_id") else f"/api/media/{mid}/file"
    return out


# ---------- Migration helper ----------
async def ensure_media_for_car(db, car: Dict[str, Any]) -> None:
    """If a car has legacy `images` URLs but no Media docs yet, create
    'external' media references so the frontend treats them uniformly."""
    car_id = car.get("id")
    if not car_id:
        return
    existing = await db.media.count_documents({"car_id": car_id})
    if existing:
        return
    images = car.get("images") or []
    if not images:
        return
    docs = []
    for i, url in enumerate(images):
        docs.append({
            "id": str(uuid.uuid4()),
            "car_id": car_id,
            "section": "exterior",
            "subsection": None,
            "order": i,
            "is_featured": (i == 0),
            "provider": "external",
            "storage_id": "",
            "thumb_storage_id": None,
            "external_url": url,
            "content_type": "image/jpeg",
            "size": 0,
            "width": None,
            "height": None,
            "original_name": None,
            "created_at": _now(),
            "created_by": car.get("seller_id", ""),
        })
    if docs:
        await db.media.insert_many(docs)


# ---------- CRUD ----------
async def list_for_car(db, car_id: str, section: Optional[str] = None) -> List[Dict[str, Any]]:
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        return []
    await ensure_media_for_car(db, car)
    q: Dict[str, Any] = {"car_id": car_id}
    if section:
        q["section"] = section
    items = await db.media.find(q, {"_id": 0}).sort([("order", 1), ("created_at", 1)]).to_list(MAX_PER_CAR + 10)
    return [_serialise_media(m) for m in items]


async def get(db, media_id: str) -> Optional[Dict[str, Any]]:
    m = await db.media.find_one({"id": media_id}, {"_id": 0})
    return m


async def create_uploaded(
    db,
    car_id: str,
    section: str,
    full_bytes: bytes,
    full_content_type: str,
    full_filename: str,
    thumb_bytes: Optional[bytes],
    thumb_content_type: Optional[str],
    width: Optional[int],
    height: Optional[int],
    subsection: Optional[str],
    created_by: str,
) -> Dict[str, Any]:
    """Persist binaries via the storage backend and create a Media record."""
    if section not in SECTIONS:
        raise ValueError(f"Unknown section: {section}")
    if full_content_type.lower() not in ALLOWED_TYPES:
        raise ValueError(f"Unsupported file type: {full_content_type}")
    if len(full_bytes) > MAX_FILE_BYTES:
        raise ValueError(f"File exceeds {MAX_FILE_BYTES // (1024*1024)} MB")
    count = await db.media.count_documents({"car_id": car_id})
    if count >= MAX_PER_CAR:
        raise ValueError(f"Maximum {MAX_PER_CAR} images per vehicle reached")

    storage = get_default_storage()
    full_id = await storage.put(full_filename, full_bytes, full_content_type, {"car_id": car_id, "section": section, "kind": "full"})
    thumb_id: Optional[str] = None
    if thumb_bytes:
        thumb_id = await storage.put(
            f"thumb_{full_filename}", thumb_bytes,
            thumb_content_type or "image/jpeg",
            {"car_id": car_id, "section": section, "kind": "thumb"},
        )

    next_order = await _next_order(db, car_id)
    is_first = await db.media.count_documents({"car_id": car_id}) == 0

    doc = {
        "id": str(uuid.uuid4()),
        "car_id": car_id,
        "section": section,
        "subsection": subsection or None,
        "order": next_order,
        "is_featured": is_first,
        "provider": storage.provider,
        "storage_id": full_id,
        "thumb_storage_id": thumb_id,
        "external_url": None,
        "content_type": full_content_type,
        "size": len(full_bytes),
        "width": width,
        "height": height,
        "original_name": full_filename,
        "created_at": _now(),
        "created_by": created_by,
    }
    await db.media.insert_one(dict(doc))
    return _serialise_media(doc)


async def _next_order(db, car_id: str) -> int:
    last = await db.media.find_one({"car_id": car_id}, sort=[("order", -1)])
    return (last["order"] + 1) if last else 0


async def delete_media(db, media_id: str) -> bool:
    m = await db.media.find_one({"id": media_id})
    if not m:
        return False
    storage = get_default_storage()
    if m.get("provider") in ("gridfs", "s3", "cloudinary"):
        for sid in (m.get("storage_id"), m.get("thumb_storage_id")):
            if sid:
                try:
                    await storage.delete(sid)
                except Exception as e:  # noqa: BLE001
                    logger.warning("storage delete failed for %s: %s", sid, e)
    await db.media.delete_one({"id": media_id})

    # If the deleted item was the featured one, pick a new featured (lowest order)
    if m.get("is_featured"):
        next_first = await db.media.find_one({"car_id": m["car_id"]}, sort=[("order", 1)])
        if next_first:
            await db.media.update_one({"id": next_first["id"]}, {"$set": {"is_featured": True}})
    return True


async def reorder(db, car_id: str, ordered_ids: List[str]) -> None:
    """Apply `order = index` to each id in the provided list. Ignores ids that
    don't belong to the car."""
    valid_ids = set()
    async for d in db.media.find({"car_id": car_id}, {"id": 1, "_id": 0}):
        valid_ids.add(d["id"])
    bulk = []
    idx = 0
    for mid in ordered_ids:
        if mid in valid_ids:
            bulk.append((mid, idx))
            idx += 1
    for mid, order in bulk:
        await db.media.update_one({"id": mid}, {"$set": {"order": order}})


async def set_featured(db, car_id: str, media_id: str) -> bool:
    m = await db.media.find_one({"id": media_id, "car_id": car_id})
    if not m:
        return False
    await db.media.update_many({"car_id": car_id}, {"$set": {"is_featured": False}})
    await db.media.update_one({"id": media_id}, {"$set": {"is_featured": True}})
    return True


async def update_section(
    db, media_id: str, section: Optional[str], subsection: Optional[str]
) -> Optional[Dict[str, Any]]:
    if section is not None and section not in SECTIONS:
        raise ValueError(f"Unknown section: {section}")
    fields: Dict[str, Any] = {}
    if section is not None:
        fields["section"] = section
    if subsection is not None:
        fields["subsection"] = subsection or None
    if not fields:
        return await db.media.find_one({"id": media_id}, {"_id": 0})
    await db.media.update_one({"id": media_id}, {"$set": fields})
    return await db.media.find_one({"id": media_id}, {"_id": 0})


# ---------- Completeness ----------
async def completeness(db, car_id: str) -> Dict[str, Any]:
    """Returns per-section counts + whether the listing meets minimums."""
    car = await db.cars.find_one({"id": car_id}, {"_id": 0})
    if not car:
        return {"valid": False, "reason": "car_not_found"}
    await ensure_media_for_car(db, car)

    counts: Dict[str, int] = {s: 0 for s in SECTIONS}
    total = 0
    async for d in db.media.find({"car_id": car_id}, {"section": 1, "_id": 0}):
        sec = d.get("section") or "exterior"
        counts[sec] = counts.get(sec, 0) + 1
        total += 1

    missing: List[Dict[str, Any]] = []
    for s, mn in MANDATORY_MINIMUMS.items():
        have = counts.get(s, 0)
        if have < mn:
            missing.append({"section": s, "have": have, "need": mn})

    no_damage = bool(car.get("no_damage_attested"))
    damage_count = counts.get("damage", 0)
    damage_ok = damage_count >= 1 or no_damage
    if not damage_ok:
        missing.append({"section": "damage", "have": damage_count, "need": 1, "needs_attestation": True})

    return {
        "total": total,
        "max": MAX_PER_CAR,
        "counts": counts,
        "minimums": MANDATORY_MINIMUMS,
        "missing": missing,
        "no_damage_attested": no_damage,
        "valid": len(missing) == 0,
    }
