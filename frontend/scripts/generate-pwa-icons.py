#!/usr/bin/env python3
"""
Generate PWA icons from the master Q Drives brand icon.

Outputs (placed in /app/frontend/public/icons/):
  - icon-192.png            (PWA 192x192, any purpose)
  - icon-512.png            (PWA 512x512, any purpose — splash on Android)
  - icon-maskable-192.png   (PWA 192x192, maskable: 80% safe zone)
  - icon-maskable-512.png   (PWA 512x512, maskable: 80% safe zone)
  - apple-touch-icon.png    (iOS A2HS 180x180)
  - favicon-32.png          (browser tab 32x32)
  - favicon-16.png          (browser tab 16x16)
  - favicon.ico             (multi-res .ico bundle for legacy browsers)

Notes:
  - The MASKABLE icons add ~20% padding around the logo so Android
    OS-level safe-zone masking (circle, squircle, rounded square)
    never clips the shield.
  - Background color matches the QD Auctions brand dark surface (#08080A).
"""
from __future__ import annotations

import os
from pathlib import Path
from PIL import Image

ROOT = Path("/app/frontend")
SRC_ICON = ROOT / "assets" / "brand" / "qdrives-app-icon.png"
SRC_SHIELD = ROOT / "assets" / "brand" / "qdrives-shield.png"
OUT_DIR = ROOT / "public" / "icons"
BG = (8, 8, 10, 255)  # #08080A — matches the dark theme background


def _open_master() -> Image.Image:
    """Open the source icon and flatten alpha onto the brand background."""
    src = SRC_ICON if SRC_ICON.exists() else SRC_SHIELD
    if not src.exists():
        raise FileNotFoundError(f"Source icon not found: {src}")
    img = Image.open(src).convert("RGBA")
    # Square-crop / pad to a square canvas so resize() doesn't distort.
    w, h = img.size
    side = max(w, h)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return sq


def _save_resized(master: Image.Image, size: int, out_path: Path,
                  *, flatten: bool = True, safe_zone_ratio: float = 1.0) -> None:
    """Resize master onto an (optionally) padded square canvas.

    safe_zone_ratio < 1.0 → logo only fills the inner portion of the
    canvas, leaving padding for OS masking (maskable icons need this).
    """
    canvas = Image.new("RGBA", (size, size), BG if flatten else (0, 0, 0, 0))
    inner = max(1, int(size * safe_zone_ratio))
    resized = master.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(resized, (offset, offset), resized)
    if flatten:
        # Drop alpha — PNG can keep it, but for maskable icons we want
        # a solid background so OS masking shows our brand colour.
        canvas = canvas.convert("RGB")
    canvas.save(out_path, "PNG", optimize=True)
    print(f"  wrote {out_path.relative_to(ROOT)} ({size}x{size})")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Reading master icon...")
    master = _open_master()
    print(f"Generating PWA icons in {OUT_DIR.relative_to(ROOT)}/")

    # Standard "any purpose" icons — keep transparency-friendly background.
    _save_resized(master, 192, OUT_DIR / "icon-192.png", flatten=True, safe_zone_ratio=1.0)
    _save_resized(master, 512, OUT_DIR / "icon-512.png", flatten=True, safe_zone_ratio=1.0)

    # Maskable icons — 80% inner safe-zone so OS masking doesn't clip the logo.
    _save_resized(master, 192, OUT_DIR / "icon-maskable-192.png", flatten=True, safe_zone_ratio=0.78)
    _save_resized(master, 512, OUT_DIR / "icon-maskable-512.png", flatten=True, safe_zone_ratio=0.78)

    # iOS A2HS icon
    _save_resized(master, 180, OUT_DIR / "apple-touch-icon.png", flatten=True, safe_zone_ratio=0.88)

    # Favicons
    _save_resized(master, 32, OUT_DIR / "favicon-32.png", flatten=True, safe_zone_ratio=0.92)
    _save_resized(master, 16, OUT_DIR / "favicon-16.png", flatten=True, safe_zone_ratio=0.92)

    # Multi-size .ico — saved in public/ root for legacy /favicon.ico requests.
    ico_path = ROOT / "public" / "favicon.ico"
    fav32 = Image.open(OUT_DIR / "favicon-32.png").convert("RGBA")
    fav32.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  wrote {ico_path.relative_to(ROOT)} (multi-size .ico)")

    print("Done.")


if __name__ == "__main__":
    main()
