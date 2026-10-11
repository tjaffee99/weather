#!/usr/bin/env python3
"""Global 0.1 deg elevation grid used to downscale temperature (lapse rate).

Source: AWS Terrain Tiles (Terrarium encoding, public dataset), zoom 4 mosaic,
reprojected from Web Mercator to an equirectangular grid.

Output: public/data/dem.bin — 8 byte header ("DEM1", width u16, height u16),
then width*height uint8 values q, elevation_m = (q/255)^2 * 9000 (ocean = 0),
rows from 90N to 90S, columns from 180W east. gzip-compressed.
"""
import argparse
import gzip
import io
import math
import struct
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/dem.bin")
    ap.add_argument("--zoom", type=int, default=5)
    ap.add_argument("--res", type=float, default=0.1)
    a = ap.parse_args()
    z = a.zoom
    n = 2 ** z
    sess = requests.Session()

    def tile(xy):
        x, y = xy
        r = sess.get(URL.format(z=z, x=x, y=y), timeout=60)
        r.raise_for_status()
        im = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype(np.float32)
        return xy, im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768

    mosaic = np.zeros((n * 256, n * 256), np.float32)
    with ThreadPoolExecutor(16) as ex:
        for (x, y), e in ex.map(tile, [(x, y) for x in range(n) for y in range(n)]):
            mosaic[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = e
    mosaic = np.maximum(mosaic, 0)  # sea surface (and depressions) -> 0
    # average 2x2 to reduce aliasing, then sample bilinearly at cell centres
    m = mosaic.reshape(n * 128, 2, n * 128, 2).mean((1, 3))
    size = m.shape[0]
    W = int(round(360 / a.res))
    H = int(round(180 / a.res))
    lon = -180 + a.res * (np.arange(W) + 0.5)
    lat = 90 - a.res * (np.arange(H) + 0.5)
    lat_c = np.clip(lat, -85.05, 85.05)
    px = (lon + 180) / 360 * size - 0.5
    py = (1 - np.log(np.tan(np.pi / 4 + np.radians(lat_c) / 2)) / np.pi) / 2 * size - 0.5
    x0 = np.floor(px).astype(int)
    y0 = np.clip(np.floor(py).astype(int), 0, size - 2)
    fx = (px - x0)[None, :]
    fy = np.clip(py - y0, 0, 1)[:, None]
    x0m, x1m = x0 % size, (x0 + 1) % size
    Y0, Y1 = y0[:, None], (y0 + 1)[:, None]
    e = (m[Y0, x0m] * (1 - fx) * (1 - fy) + m[Y0, x1m] * fx * (1 - fy)
         + m[Y1, x0m] * (1 - fx) * fy + m[Y1, x1m] * fx * fy)
    # Antarctica / Greenland ice sheets are above 85 deg only partially; keep as is
    q = np.clip(np.round(np.sqrt(np.clip(e, 0, 9000) / 9000) * 255), 0, 255).astype(np.uint8)
    raw = b"DEM1" + struct.pack("<HH", W, H) + q.tobytes()
    with open(a.out, "wb") as f:
        f.write(gzip.compress(raw, 9))
    print("wrote", a.out, W, H, "max elev", e.max())


if __name__ == "__main__":
    main()
