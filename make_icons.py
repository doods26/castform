#!/usr/bin/env python3
"""
Generate Castform's PWA icons with zero dependencies (stdlib zlib/struct only).

Draws a Poke Ball (matching the favicon) on a dark navy gradient and writes:
  public/icon-192.png, public/icon-512.png,
  public/icon-maskable-512.png (smaller ball for the maskable safe area),
  public/apple-touch-icon.png (180, opaque, for iOS add-to-home-screen).

Usage:  python make_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent / "public"


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _pixels(size, ball_frac):
    """Yield RGB bytes for an icon of the given size (row-major)."""
    top, bot = (0x16, 0x23, 0x3F), (0x0A, 0x11, 0x20)  # navy gradient
    white, black, red = (0xF4, 0xF6, 0xFB), (0x14, 0x18, 0x22), (0xEE, 0x54, 0x66)
    cx = cy = (size - 1) / 2.0
    R = size * ball_frac
    band = R * 0.16
    r_btn_in = R * 0.30      # white center button
    r_btn_out = R * 0.42     # black ring around button
    edge = R * 0.045         # crisp outer rim
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG filter: none
        bg = _lerp(top, bot, y / (size - 1))
        for x in range(size):
            dx, dy = x - cx, y - cy
            d = (dx * dx + dy * dy) ** 0.5
            if d > R:
                raw += bytes(bg)
                continue
            if d > R - edge:                       # dark outer rim
                col = black
            elif abs(dy) <= band:                  # equatorial band
                col = black
            elif d <= r_btn_out:                   # center button + ring
                col = white if d <= r_btn_in else black
            elif dy < 0:                           # upper half
                col = red
            else:                                  # lower half
                col = white
            raw += bytes(col)
    return bytes(raw)


def _png(path, size, ball_frac):
    raw = _pixels(size, ball_frac)

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    out = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(out)
    print(f"Wrote {path.name} ({size}x{size}, {round(len(out) / 1024, 1)} KB)")


def main():
    OUT.mkdir(exist_ok=True)
    _png(OUT / "icon-192.png", 192, 0.34)
    _png(OUT / "icon-512.png", 512, 0.34)
    _png(OUT / "icon-maskable-512.png", 512, 0.27)  # safe-area padding
    _png(OUT / "apple-touch-icon.png", 180, 0.34)


if __name__ == "__main__":
    main()
