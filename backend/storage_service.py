"""
Storage abstraction layer for Q Drives.

Provides a provider-agnostic interface so we can swap GridFS for S3 / Cloudinary
later by registering a different backend in `get_default_storage()`. Business
logic in `media.py` only ever talks to the abstract `StorageBackend` — never
to GridFS / S3 SDKs directly.
"""
from __future__ import annotations

import io
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Dict, Optional

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorGridFSBucket


class StorageBackend(ABC):
    """Abstract storage backend. Every concrete impl returns a string `storage_id`
    that uniquely identifies the stored object within that provider."""

    provider: str = "abstract"

    @abstractmethod
    async def put(
        self,
        filename: str,
        data: bytes,
        content_type: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Persist `data`. Returns provider-specific storage id (string)."""

    @abstractmethod
    async def stream(self, storage_id: str) -> AsyncIterator[bytes]:
        """Yield bytes chunks for streaming downloads."""

    @abstractmethod
    async def get_meta(self, storage_id: str) -> Optional[Dict[str, Any]]:
        """Return basic metadata: { content_type, size, filename }. None if missing."""

    @abstractmethod
    async def delete(self, storage_id: str) -> None:
        """Best-effort delete. Should not raise if object is already gone."""

    async def exists(self, storage_id: str) -> bool:
        return (await self.get_meta(storage_id)) is not None


class GridFSStorage(StorageBackend):
    """MongoDB GridFS implementation. Default backend for MVP."""

    provider = "gridfs"
    BUCKET = "media"

    def __init__(self, db) -> None:
        self.db = db
        self.fs = AsyncIOMotorGridFSBucket(db, bucket_name=self.BUCKET)

    async def put(self, filename, data, content_type, metadata=None) -> str:
        meta = {"contentType": content_type}
        if metadata:
            meta.update(metadata)
        file_id = await self.fs.upload_from_stream(
            filename, io.BytesIO(data), metadata=meta
        )
        return str(file_id)

    async def stream(self, storage_id):
        try:
            oid = ObjectId(storage_id)
        except Exception:
            return
        try:
            stream = await self.fs.open_download_stream(oid)
        except Exception:
            return
        try:
            while True:
                chunk = await stream.readchunk()
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                await stream.close()
            except Exception:
                pass

    async def get_meta(self, storage_id):
        try:
            oid = ObjectId(storage_id)
        except Exception:
            return None
        files_col = self.db[f"{self.BUCKET}.files"]
        doc = await files_col.find_one({"_id": oid})
        if not doc:
            return None
        return {
            "content_type": (doc.get("metadata") or {}).get("contentType", "application/octet-stream"),
            "size": doc.get("length", 0),
            "filename": doc.get("filename", ""),
        }

    async def delete(self, storage_id):
        try:
            oid = ObjectId(storage_id)
        except Exception:
            return
        try:
            await self.fs.delete(oid)
        except Exception:
            pass


# ---------- Singleton wiring ----------
_default_storage: Optional[StorageBackend] = None


def init_default_storage(db) -> StorageBackend:
    """Called once on app startup. Easy to swap to S3StorageBackend later."""
    global _default_storage
    _default_storage = GridFSStorage(db)
    return _default_storage


def get_default_storage() -> StorageBackend:
    if _default_storage is None:
        raise RuntimeError("Storage backend not initialised. Call init_default_storage().")
    return _default_storage
