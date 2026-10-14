#!/usr/bin/env python3
"""Microclimates: what the 1-degree climate cells miss, from WorldClim at 2.5'.

The finder and atlas blend 1-degree ERA5 cells and shift temperatures to each
pixel's elevation (src/climate/blend.ts). That leaves out everything that
isn't elevation: the fog-cooled coast of San Francisco versus the hot East
Bay valleys a few miles inland, Lima's cold coast, lake shores, cold-air
basins, warm cities. WorldClim 2.1 (station climatology, 1970-2000, ~4.6 km)
resolves these. For every 2.5' land pixel this script blends WorldClim's own
1-degree cell means exactly the way the app blends ERA5 (B-spline weights,
elevation reach, lapse-rate shift), and keeps the difference:

    offset = WorldClim(pixel) - WorldClim blended like the app (pixel)

so only the fine-scale pattern is used, never WorldClim's absolute values or
period. Offsets for the monthly mean daily high and low are stored as yearly
curves (mean + 2 harmonics) in 10x10 degree tiles that the browser loads
for the area on screen, plus per-city values for labels.

  python pipeline/microclimate.py --wc wc/ --work work/

Data: Fick & Hijmans 2017, WorldClim 2.1 (CC BY 4.0),
https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_2.5m_{tmax,tmin,elev}.zip
"""
import argparse
import gzip
import io
import json
import os
import zipfile

import numpy as np
import tifffile

PX = 24  # 2.5' pixels per degree
LAT_TOP, LAT_BOTTOM = 84, -60  # the finder's grid
ROWS, COLS = LAT_TOP - LAT_BOTTOM, 360
LAPSE, DZ0, DZ_STEP, LEVELS, EXCESS = 0.0065, -2000.0, 500.0, 9, 300.0  # mirrors src/climate/types.ts, blend.ts
TILE = 10  # degrees per tile
HARMONICS = 2
NC = 2 * HARMONICS + 1
SCALE = 0.1  # °C per int8 step
MONTH_START = np.array([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365])


def read_stack(path: str) -> np.ndarray:
    """(12, 4320, 8640) float32 with NaN over the sea, from a WorldClim zip."""
    z = zipfile.ZipFile(path)
    names = sorted(n for n in z.namelist() if n.endswith(".tif"))
    out = []
    for n in names:
        a = tifffile.imread(io.BytesIO(z.read(n))).astype(np.float32)
        a[a < -1e30] = np.nan
        out.append(a)
    return np.stack(out)


def bspline(f: np.ndarray) -> np.ndarray:
    a = 1 - f
    return np.stack([a ** 3 / 6, (3 * f ** 3 - 6 * f ** 2 + 4) / 6, (-3 * f ** 3 + 3 * f ** 2 + 3 * f + 1) / 6, f ** 3 / 6])


def app_blend(cell_val: np.ndarray, cell_z: np.ndarray, z: np.ndarray, r0: int) -> np.ndarray:
    """WorldClim cell means blended to one degree-row of 2.5' pixels (24 x 8640) the way blend.ts does.

    cell_val (k, ROWS, COLS), cell_z (ROWS, COLS) with NaN where there is no cell; z (24, 8640) pixel elevations.
    """
    k = cell_val.shape[0]
    rows = np.arange(PX) + 0.5
    lat = LAT_TOP - r0 - rows / PX  # pixel-centre latitudes of this cell row
    y = (LAT_TOP - 0.5) - lat  # grid rows from the first cell centre
    y0 = np.floor(y).astype(int)
    wy = bspline(y - y0)  # (4, 24)
    lon = -180 + (np.arange(COLS * PX) + 0.5) / PX
    x = lon + 179.5
    x0 = np.floor(x).astype(int)
    wx = bspline(x - x0)  # (4, 8640)
    num = np.zeros((k, PX, COLS * PX))
    den = np.zeros((PX, COLS * PX))
    for j in range(4):
        yy = y0 + j - 1  # (24,)
        okr = (yy >= 0) & (yy < ROWS)
        yyc = np.clip(yy, 0, ROWS - 1)
        for i in range(4):
            xx = (x0 + i - 1) % COLS  # (8640,)
            cz = cell_z[yyc[:, None], xx[None, :]]  # (24, 8640)
            w = wy[j][:, None] * wx[i][None, :] * okr[:, None]
            have = ~np.isnan(cz) & (w > 0)
            want = z - np.where(have, cz, 0)
            dz = np.clip(want, DZ0, DZ0 + (LEVELS - 1) * DZ_STEP)
            q = np.where(have, w * np.exp(-np.abs(want - dz) / EXCESS), 0)
            cv = cell_val[:, yyc[:, None], xx[None, :]]  # (k, 24, 8640)
            num += np.where(have, q * (np.nan_to_num(cv) - LAPSE * dz), 0)
            den += q
    return np.where(den > 0, num / np.maximum(den, 1e-12), np.nan)


def harmonics(monthly: np.ndarray) -> np.ndarray:
    """(12, ...) monthly means -> (NC, ...) yearly-curve coefficients (same basis as atlasData.ts)."""
    t = ((MONTH_START[:-1] + MONTH_START[1:]) / 2) / 365
    days = np.diff(MONTH_START)
    B = [np.ones(12)]
    for k in range(1, HARMONICS + 1):
        B += [np.cos(2 * np.pi * k * t), np.sin(2 * np.pi * k * t)]
    B = np.array(B)  # (NC, 12)
    W = np.diag(days / 365)
    G = B @ W @ B.T
    P = np.linalg.solve(G, B @ W).astype(np.float32)  # (NC, 12): coefficients = P @ monthly
    flat = monthly.reshape(12, -1)
    out = np.zeros((NC, flat.shape[1]), np.float32)
    step = 1 << 22
    for s in range(0, flat.shape[1], step):
        out[:, s : s + step] = P @ np.nan_to_num(flat[:, s : s + step])
    return out.reshape((NC,) + monthly.shape[1:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wc", required=True, help="folder with wc2.1_2.5m_{tmax,tmin,elev}.zip")
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", default="public/data/micro")
    ap.add_argument("--cities", default="public/data/cities.json")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    elev = tifffile.imread(io.BytesIO(zipfile.ZipFile(os.path.join(a.wc, "wc2.1_2.5m_elev.zip")).read("wc2.1_2.5m_elev.tif")))
    elev = np.where(elev < -1e30, np.nan, elev).astype(np.float32)
    r_top, r_bot = (90 - LAT_TOP) * PX, (90 - LAT_BOTTOM) * PX
    elev = elev[r_top:r_bot]  # (3456, 8640)
    coefs = []
    land = None
    for var in ("tmax", "tmin"):
        T = read_stack(os.path.join(a.wc, f"wc2.1_2.5m_{var}.zip"))[:, r_top:r_bot]  # (12, 3456, 8640)
        land = ~np.isnan(T[0])
        # WorldClim's own 1-degree cells: land means of temperature and elevation
        blk = lambda x: x.reshape(x.shape[:-2] + (ROWS, PX, COLS, PX))  # noqa: E731
        n = blk(land.astype(np.float32)).sum((-3, -1))
        cell_T = np.where(n > 0, blk(np.nan_to_num(T)).sum((-3, -1)) / np.maximum(n, 1), np.nan)
        cell_z = np.where(n > 0, blk(np.where(land, np.nan_to_num(elev), 0)).sum((-3, -1)) / np.maximum(n, 1), np.nan)
        off = np.full(T.shape, np.nan, np.float32)
        for r in range(ROWS):
            sl = slice(r * PX, (r + 1) * PX)
            if not land[sl].any():
                continue
            z = np.nan_to_num(elev[sl])
            b = app_blend(cell_T, cell_z, z, r)
            off[:, sl] = np.where(land[sl][None], T[:, sl] - b, np.nan)
        v = off[6][land]
        print(f"{var}: July offset p1 {np.nanpercentile(v, 1):.1f}, p50 {np.nanpercentile(v, 50):.1f}, p99 {np.nanpercentile(v, 99):.1f} °C", flush=True)
        del T
        coefs.append(np.clip(np.round(harmonics(off) / SCALE), -127, 127).astype(np.int8))
        del off

    # yearly curves, int8 in SCALE steps: (2*NC, 3456, 8640)
    q = np.where(land[None], np.concatenate(coefs), 0).astype(np.int8)
    del coefs
    # carry coastal values two pixels out to sea, so interpolating at the shore isn't pulled to 0
    have = land.copy()
    for _ in range(2):
        acc = np.zeros(q.shape, np.int32)
        cnt = np.zeros(have.shape, np.int16)
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(have, di, 0), dj, 1)
            acc += np.where(sh[None], np.roll(np.roll(q, di, 1), dj, 2), 0)
            cnt += sh
        new = ~have & (cnt > 0)
        q = np.where(new[None], np.round(acc / np.maximum(cnt, 1)[None]), q).astype(np.int8)
        have |= new

    # tiles: TILE x TILE degrees, plane-major int8, gzip; only tiles with land
    tiles = []
    total = 0
    tp = TILE * PX
    for ty in range((LAT_TOP - LAT_BOTTOM + TILE - 1) // TILE):
        for tx in range(360 // TILE):
            sl = (slice(None), slice(ty * tp, (ty + 1) * tp), slice(tx * tp, (tx + 1) * tp))
            if not land[sl[1:]].any():
                continue
            blockq = np.zeros((2 * NC, tp, tp), np.int8)
            src = q[sl]
            blockq[:, : src.shape[1], : src.shape[2]] = src
            gz = gzip.compress(blockq.tobytes(), 9, mtime=0)
            with open(os.path.join(a.out, f"{ty}_{tx}.bin"), "wb") as f:
                f.write(gz)
            tiles.append([ty, tx])
            total += len(gz)
    meta = {
        "source": "WorldClim 2.1 (1970-2000) 2.5' monthly tmax/tmin minus the app's 1-degree blend of the same",
        "px": PX, "tile": TILE, "top": LAT_TOP, "left": -180, "harmonics": HARMONICS, "scale": SCALE,
        "planes": ["tmax"] * NC + ["tmin"] * NC, "tiles": tiles,
    }
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB")

    # per-city curves for labels (nearest land pixel within 3 pixels)
    cj = json.load(open(a.cities))
    if "mc" not in cj["fields"]:
        cj["fields"].append("mc")
    idx = cj["fields"].index("mc")
    for row in cj["rows"]:
        la, lo = row[2], row[3]
        i, j = int((LAT_TOP - la) * PX), int((lo + 180) * PX) % (360 * PX)
        best = None
        for d in range(4):
            for di in range(-d, d + 1):
                for dj in range(-d, d + 1):
                    ii, jj = i + di, (j + dj) % (360 * PX)
                    if 0 <= ii < land.shape[0] and land[ii, jj] and best is None:
                        best = (ii, jj)
            if best:
                break
        val = [int(x) for x in q[:, best[0], best[1]]] if best else None
        if len(row) > idx:
            row[idx] = val
        else:
            row.append(val)
    with open(a.cities, "w") as f:
        json.dump(cj, f, ensure_ascii=False, separators=(",", ":"))
    print("cities updated")


if __name__ == "__main__":
    main()
