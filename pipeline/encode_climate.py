#!/usr/bin/env python3
"""Quantise + compress the ERA5 daily samples for the browser.

Input : <work>/samples_pass0.npz (from era5_climate.py) and static_<res>.npz, plus
        samples_sun / _uv / _extra (era5_climate.py --only-...) and samples_aq (gefs_aq.py)
Output: public/data/climate/meta.json, cells.bin, <var>.bin (gzip) for the finder,
        levels.bin: per-elevation-level factors for precipitation and snow (needs
        hires_normals.npz from era5_climate.py --only-hires), and atlas/<id>.bin:
        daily normals as yearly harmonics per cell for the atlas view

Each variable is one file so the app only downloads what the active criteria
need. Values are quantised to uint8 codes and predictively coded on the full
raster (land cells only are stored; sea positions carry the last land value so
predictors stay smooth along coasts):
  mode 0 raw         residual = code
  mode 1 spatial     residual = code - MED(left, up, upleft)
  mode 2 temporal    on the first day of each 3-day sample block as mode 1,
                     otherwise MED prediction of the day-to-day change
Residuals are stored mod 256, day-major. The decoder lives in
src/climate/codec.ts and must mirror this file exactly.
"""
import argparse
import gzip
import json
import os
import struct

import numpy as np

PRECIP_EDGES = [0.1, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150]  # mm/day
WIND_EDGES = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 120, 150]  # km/h
SNOW_EDGES = [1, 2.5, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500]  # cm
SNOWFALL_EDGES = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100, 150]  # cm/day

VARS = {
    # id: (source key, encoding)
    "feels": ("feels_max", {"type": "linear", "scale": 1.0, "offset": -100.0}),
    "tmax": ("tmax", {"type": "linear", "scale": 1.0, "offset": -100.0}),
    "tmin": ("tmin", {"type": "linear", "scale": 1.0, "offset": -100.0}),
    "dew": ("dew", {"type": "linear", "scale": 1.0, "offset": -100.0}),
    "sst": ("sst", {"type": "linear", "scale": 1.0, "offset": -100.0, "nodata": 0}),
    "cloud": ("cloud", {"type": "linear", "scale": 10.0, "offset": 0.0}),
    "precip": ("precip", {"type": "bins", "edges": PRECIP_EDGES}),
    "wind": ("wind", {"type": "bins", "edges": WIND_EDGES}),
    "snow": ("snow", {"type": "bins", "edges": SNOW_EDGES}),
    # hours of sunshine per day (WMO: direct normal irradiance >= 120 W/m2), half-hour steps
    "sun": ("sun", {"type": "linear", "scale": 0.5, "offset": 0.0}),
    # daily peak UV index, half-unit steps
    "uv": ("uv", {"type": "linear", "scale": 0.5, "offset": 0.0}),
    # daytime (9-18 local) mean relative humidity, %
    "rh": ("rh", {"type": "linear", "scale": 1.0, "offset": 0.0}),
    # snowfall in the day, cm (10:1)
    "snowfall": ("snowfall", {"type": "bins", "edges": SNOWFALL_EDGES}),
    # US AQI from daily mean PM2.5 (NOAA GEFS-Aerosols, 2021-2025), steps of 2
    "aqi": ("aqi", {"type": "linear", "scale": 2.0, "offset": 0.0}),
}
MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]
BLOCK = 3
# ERA5 rains lightly far too often ("drizzle bias"): days with >= 1 mm are
# over-counted by ~30-50% versus station records. Subtracting 1 mm/day makes
# ERA5's >= 2 mm days line up with observed >= 1 mm rain-day counts in the
# mid-latitudes (London, Paris, Sydney, Miami, Seattle within ~10%).
DRIZZLE_OFFSET_MM = 1.0


def quantise(x: np.ndarray, enc: dict) -> np.ndarray:
    if enc["type"] == "bins":
        return np.digitize(np.nan_to_num(x, nan=0.0), enc["edges"]).astype(np.uint8)
    q = np.round((np.nan_to_num(x, nan=0.0) - enc["offset"]) / enc["scale"])
    lo = 1 if "nodata" in enc else 0
    q = np.clip(q, lo, 255).astype(np.uint8)
    if "nodata" in enc:
        q[np.isnan(x)] = enc["nodata"]
    return q


def carry_fill(F: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Sea positions take the value of the last land cell in raster order (0 before any)."""
    T, R, C = F.shape
    pos = np.where(mask.ravel(), np.arange(R * C), -1)
    last = np.maximum.accumulate(pos)
    flat = F.reshape(T, R * C)
    out = np.where(last >= 0, flat[:, np.maximum(last, 0)], 0)
    return out.reshape(T, R, C)


def med_pred(F: np.ndarray) -> np.ndarray:
    F = F.astype(np.int32)
    left = np.zeros_like(F)
    up = np.zeros_like(F)
    ul = np.zeros_like(F)
    left[..., 1:] = F[..., :-1]
    up[:, 1:, :] = F[:, :-1, :]
    ul[:, 1:, 1:] = F[:, :-1, :-1]
    # first column: use the cell above for every neighbour
    left[:, 1:, 0] = F[:, :-1, 0]
    ul[:, 1:, 0] = F[:, :-1, 0]
    # first row: use the cell to the left
    up[:, 0, 1:] = F[:, 0, :-1]
    ul[:, 0, 1:] = F[:, 0, :-1]
    mx = np.maximum(left, up)
    mn = np.minimum(left, up)
    return np.where(ul >= mx, mn, np.where(ul <= mn, mx, left + up - ul))


def residuals(Q: np.ndarray, mask: np.ndarray, mode: int) -> bytes:
    T = Q.shape[0]
    if mode == 0:
        return Q[:, mask].tobytes()
    F = carry_fill(Q.astype(np.int32), mask)
    R1 = (F - med_pred(F)) % 256
    if mode == 2:
        D = np.zeros_like(F)
        D[1:] = F[1:] - F[:-1]
        RD = (D - med_pred(D)) % 256
        temporal = np.array([t % BLOCK != 0 for t in range(T)])
        R1 = np.where(temporal[:, None, None], RD, R1)
    return R1.astype(np.uint8)[:, mask].tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--res", default="1.0")
    ap.add_argument("--out", default="public/data/climate")
    ap.add_argument("--min-land", type=float, default=0.005)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    st = np.load(os.path.join(a.work, f"static_{a.res}.npz"))
    smp = dict(np.load(os.path.join(a.work, "samples_pass0.npz")))
    sun_path = os.path.join(a.work, "samples_sun.npz")
    if os.path.exists(sun_path):  # produced by era5_climate.py --only-sun
        smp["sun"] = np.load(sun_path)["sun"]
    uv_path = os.path.join(a.work, "samples_uv.npz")
    if os.path.exists(uv_path):  # produced by era5_climate.py --only-uv
        smp["uv"] = np.load(uv_path)["uv"]
    extra_path = os.path.join(a.work, "samples_extra.npz")
    if os.path.exists(extra_path):  # era5_climate.py --only-extra
        ex = np.load(extra_path)
        smp["rh"], smp["snowfall"] = ex["rh"], ex["snowfall"]
    aq_path = os.path.join(a.work, "samples_aq.npz")
    if os.path.exists(aq_path):  # gefs_aq.py
        smp["aqi"] = np.load(aq_path)["aqi"]
    match_full(smp, a.work, st)
    land, elev, lat, lon = st["land"], st["elev"], st["lat"], st["lon"]
    R, C = land.shape
    mask = land > a.min_land
    ncells = int(mask.sum())
    res = float(a.res)

    # cells.bin: "CEL1", R u16, C u16, ncells u32, mask bytes (R*C), elev int16[n], landfrac u8[n]
    cells = b"CEL1" + struct.pack("<HHI", R, C, ncells) + mask.astype(np.uint8).tobytes()
    cells += np.round(elev[mask]).astype("<i2").tobytes()
    cells += np.clip(np.round(land[mask] * 255), 0, 255).astype(np.uint8).tobytes()
    with open(os.path.join(a.out, "cells.bin"), "wb") as f:
        f.write(gzip.compress(cells, 9, mtime=0))

    meta = {
        "version": 1,
        "source": "ERA5 hourly reanalysis (Copernicus/ECMWF) via ARCO-ERA5; daily metrics in local solar time",
        "grid": {"nx": C, "ny": R, "lon0": float(lon[0]), "lat0": float(lat[0]), "dx": res, "dy": res},
        "days": int(smp["tmax"].shape[0]),
        "block": BLOCK,
        "ncells": ncells,
        "sampleYears": [int(y) for y in smp["years"]],
        "vars": {},
    }
    total = 0
    for vid, (key, enc) in VARS.items():
        if key not in smp:
            print(f"skipping {vid}: no samples")
            continue
        x = smp[key]
        if vid == "precip":
            x = np.maximum(x - DRIZZLE_OFFSET_MM, 0)
            enc = {**enc, "drizzleOffset": DRIZZLE_OFFSET_MM}
        Q = quantise(x, enc)
        best = None
        for mode in (0, 1, 2):
            blob = gzip.compress(bytes([mode]) + residuals(Q, mask, mode), 9, mtime=0)
            if best is None or len(blob) < len(best[1]):
                best = (mode, blob)
        mode, blob = best
        with open(os.path.join(a.out, f"{vid}.bin"), "wb") as f:
            f.write(blob)
        total += len(blob)
        # checksum of codes in cell-major order so the decoder can be verified
        cm = Q[:, mask].T.astype(np.uint64)
        checksum = int((cm.ravel() * (np.arange(cm.size, dtype=np.uint64) % 65521 + 1)).sum() % (2**52))
        meta["vars"][vid] = {**enc, "file": f"{vid}.bin", "bytes": len(blob), "mode": mode, "checksum": checksum}
        print(f"{vid:7s} mode {mode} {len(blob)/1e6:6.2f} MB")
    F = level_factors(a.work, st, mask)
    if F is not None:
        codes = np.stack([factor_codes(F[v]) for v in LEVEL_VARS])  # (3, 12, LEVELS, ncells)
        blob = gzip.compress(codes.tobytes(), 9, mtime=0)
        with open(os.path.join(a.out, "levels.bin"), "wb") as f:
            f.write(blob)
        meta["levels"] = {"file": "levels.bin", "vars": list(LEVEL_VARS), "steps": FACTOR_STEPS, "bytes": len(blob),
                          "sigma": LEVEL_SIGMA}
        print(f"levels  {len(blob)/1e6:6.2f} MB")
    meta["atlas"] = atlas(smp, mask, os.path.join(a.out, "atlas"), F)
    meta["atlasHarmonics"] = HARMONICS
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"cells {ncells}, total {total/1e6:.2f} MB")


# monthly normals: triangle windows round mid-month (mirrors monthWeights() in src/climate/types.ts)
MONTH_NARROW, MONTH_WIDE = 30.4, 45.0


def match_full(smp: dict, work: str, st) -> None:
    """Make the sample's precipitation, snowfall and snow depth agree with every
    day of the period (full_normals.npz, era5_climate.py --only-full).

    The sample has one real day per calendar date. For rain and snow a few
    sampled storms can dominate a cell's totals (New York's sample caught the
    blizzards of Feb 2017, Feb 2021 and Feb 2024: twice its real snowfall).
    Precipitation and snowfall are rescaled so each cell's monthly means match
    the full period's, with the factors interpolated between mid-months.
    Snow depth is quantile-mapped per cell and month onto the full period's
    daily values, which fixes both the depth and the number of days with snow
    on the ground. The sample keeps its days, so the conditions that happen
    together (cold, snowy, sunny...) stay together."""
    path = os.path.join(work, "full_normals.npz")
    if not os.path.exists(path):
        print("no full_normals.npz: precipitation and snow from the sample days alone")
        return
    fn = np.load(path)
    lat, lon = st["lat"], st["lon"]
    month = np.searchsorted(MONTH_START[1:], np.arange(365), side="right")
    mids = (np.array(MONTH_START[:12]) + np.array(MONTH_START[1:])) / 2
    # each day's two nearest mid-months and their weights (wrapping round the year)
    d = np.arange(365) + 0.5
    m1 = np.searchsorted(mids, d) % 12
    m0 = (m1 - 1) % 12
    span = (mids[m1] - mids[m0]) % 365
    w1 = ((d - mids[m0]) % 365) / span
    probe = [("New York", 40.75, -73.98), ("Boston", 42.36, -71.06), ("Chicago", 41.88, -87.63), ("Denver", 39.74, -104.99), ("Fresno", 36.74, -119.79)]
    cell = [(n, int(np.argmin(abs(lat - la))), int(np.argmin(abs(((lon - lo + 180) % 360) - 180)))) for n, la, lo in probe]

    for key, eps in (("precip", 0.02), ("snowfall", 0.005)):
        if key not in smp:
            continue
        x = smp[key].astype(np.float32)
        full = fn[f"{key}1"].astype(np.float32)
        before = {n: np.nansum(x[:, i, j]) for n, i, j in cell}
        for _ in range(3):  # a few rounds: the interpolated factors shift the monthly means a little
            samp = np.stack([np.nanmean(x[month == m], 0) for m in range(12)])
            f = np.where(samp > eps, full / np.maximum(samp, 1e-9), 1.0)
            f = np.where((samp > eps) & (full < eps), 0.0, np.clip(f, 0, 10)).astype(np.float32)
            x *= f[m0] * (1 - w1)[:, None, None] + f[m1] * w1[:, None, None]
        smp[key] = x
        unit = 25.4 if key == "precip" else 2.54
        print(f"full-period {key}: " + ", ".join(f"{n} {before[n] / unit:.0f} -> {np.nansum(x[:, i, j]) / unit:.0f} in" for n, i, j in cell))

    if "snow" in smp and os.path.exists(os.path.join(work, "full_snow.f16")):
        days = np.load(os.path.join(work, "full_snow.f16"), mmap_mode="r")
        months = fn["months"]
        x = smp["snow"].astype(np.float32)
        thr = 2.54
        before = {n: int((x[:, i, j] >= thr).sum()) for n, i, j in cell}
        for m in range(12):
            F = np.asarray(days[months == m], dtype=np.float32)
            F.sort(axis=0)
            sel = np.where(month == m)[0]
            S = x[sel]
            order = np.argsort(S, axis=0, kind="stable")
            ranks = np.empty_like(order)
            np.put_along_axis(ranks, order, np.arange(len(sel))[:, None, None], 0)
            idx = np.minimum(((ranks + 0.5) / len(sel) * F.shape[0]).astype(np.int64), F.shape[0] - 1)
            x[sel] = np.where(np.isnan(S), np.nan, np.take_along_axis(F, idx, 0))
        smp["snow"] = x
        print("full-period snow cover days (>= 1 in): " + ", ".join(f"{n} {before[n]} -> {int((x[:, i, j] >= thr).sum())}" for n, i, j in cell))


def month_weights(m: int, half: float, days: int = 365) -> np.ndarray:
    mid = (MONTH_START[m] + MONTH_START[m + 1]) / 2
    dist = np.abs((np.arange(days) + 0.5 - mid + days / 2) % days - days / 2)
    w = np.clip(1 - dist / half, 0, None)
    return w / w.sum()


# ---------------------------------------------------------------------------
# Elevation levels for precipitation and snow
#
# A 1-degree cell can hold a valley floor and the mountains above it (Fresno and
# the Sierra Nevada share one). The finder already shifts temperatures to each
# pixel's elevation; these factors do the same for precipitation, snowfall and
# snow depth. From 0.25-degree normals (era5_climate.py --only-hires), each
# level's value is the average of the cell's 0.25-degree points near that
# level's elevation (Gaussian in elevation, sigma LEVEL_SIGMA), relative to
# the cell mean. Factors are per calendar month. Above the highest point the
# value stays that point's; below the lowest, snow keeps falling off at the
# rate seen over the lowest LEVEL_SIGMA * 2 m (up to 500 m), so a valley floor
# just below the cell's lowest 0.25-degree point isn't credited with its snow.
LEVELS, DZ0, DZ_STEP = 9, -2000.0, 500.0  # mirrors src/climate/types.ts
LEVEL_VARS = ("precip", "snowfall", "snow")
LEVEL_SIGMA = 150.0  # m
TAPER_VARS = ("snowfall", "snow")
LEVEL_EPS = {"precip": 0.05, "snowfall": 0.01, "snow": 0.1}  # below this cell mean the factor is 1
FACTOR_STEPS = 21  # uint8 code = 128 + 21 * log2(factor); 0 = none


def level_factors(work: str, st, mask: np.ndarray) -> dict | None:
    """{var: (12, LEVELS, ncells) float32} multiplicative factors, or None without hi-res normals."""
    path = os.path.join(work, "full_normals.npz")  # every day of the period (era5_climate.py --only-full)
    if not os.path.exists(path):
        path = os.path.join(work, "hires_normals.npz")  # the sample days only
    if not os.path.exists(path):
        print("no hires_normals.npz: precipitation and snow without elevation levels")
        return None
    import sys
    sys.path.insert(0, os.path.dirname(__file__))
    from era5_climate import Coarsener

    hn = np.load(path)
    cz = Coarsener(1.0)
    f, R, C = cz.f, cz.rows, cz.cols

    def stencil(a: np.ndarray) -> np.ndarray:
        a = cz._crop(a)
        return np.stack([a[di : di + R * f : f, dj : dj + C * f : f] for di in range(f + 1) for dj in range(f + 1)])

    wst = np.array([cz.w[di] * cz.w[dj] for di in range(f + 1) for dj in range(f + 1)])[:, None, None]
    wl = wst * stencil(st["lsm025"])
    z = stencil(st["z025"] if "z025" in st.files else st["z"])
    has = wl > 0
    zmin = np.where(has, z, np.inf).min(0)
    zmax = np.where(has, z, -np.inf).max(0)
    elev = st["elev"]

    def kernel(zl):
        k = wl * np.exp(-0.5 * ((z - zl) / LEVEL_SIGMA) ** 2)
        return k / np.maximum(k.sum(0), 1e-12)

    kern = [kernel(np.clip(elev + DZ0 + lv * DZ_STEP, zmin, zmax)) for lv in range(LEVELS)]
    k_lo = kernel(zmin)
    z_up = np.minimum(zmin + 2 * LEVEL_SIGMA, zmax)
    k_up = kernel(z_up)
    below = [np.clip(zmin - (elev + DZ0 + lv * DZ_STEP), 0, 500) for lv in range(LEVELS)]
    wn = wl / np.maximum(wl.sum(0), 1e-12)
    out = {}
    for v in LEVEL_VARS:
        N = hn[v].astype(np.float64)
        N = 0.25 * np.roll(N, 1, 0) + 0.5 * N + 0.25 * np.roll(N, -1, 0)  # steadier months
        F = np.ones((12, LEVELS, int(mask.sum())), np.float32)
        for m in range(12):
            s = stencil(N[m])
            mean = (wn * s).sum(0)
            if v in TAPER_VARS:
                v_lo = (k_lo * s).sum(0)
                slope = np.where(z_up - zmin > LEVEL_SIGMA, np.maximum(0, (k_up * s).sum(0) - v_lo) / np.maximum(z_up - zmin, 1), 0)
            for lv in range(LEVELS):
                val = (kern[lv] * s).sum(0)
                if v in TAPER_VARS:
                    val = np.where(below[lv] > 0, np.maximum(0, v_lo - slope * below[lv]), val)
                F[m, lv] = np.where(mean > LEVEL_EPS[v], val / np.maximum(mean, 1e-12), 1.0)[mask]
        out[v] = np.clip(F, 0, 60)
        lo = np.percentile(out[v][:, 2], [5, 50, 95])
        print(f"levels {v:8s} factor at -1000 m: p5 {lo[0]:.2f} median {lo[1]:.2f} p95 {lo[2]:.2f}")
    return out


def factor_codes(F: np.ndarray) -> np.ndarray:
    """uint8 codes for (12, LEVELS, n) factors. A cell-month whose levels differ by
    under ~10% is noise, not terrain: it gets one code for all levels, which also
    lets the finder skip per-level work there."""
    with np.errstate(divide="ignore"):
        c = np.round(128 + FACTOR_STEPS * np.log2(np.maximum(F, 1e-9)))
    c = np.where(F < 2 ** (-127 / FACTOR_STEPS), 0, np.clip(c, 1, 255))
    flat = (c.max(1) - c.min(1) <= 3) & (c.min(1) > 0)
    c = np.where(flat[:, None, :], np.median(c, 1, keepdims=True).round(), c)
    return c.astype(np.uint8)


def factor_values(codes: np.ndarray) -> np.ndarray:
    """The factors the browser sees (decoded codes)."""
    return np.where(codes == 0, 0.0, 2.0 ** ((codes.astype(np.float64) - 128) / FACTOR_STEPS))


# ---------------------------------------------------------------------------
# Atlas: daily normals as smooth yearly curves
#
# For every cell (and elevation level, for precipitation and snow) the daily
# series is smoothed with a triangle window (MONTH_NARROW for steady
# quantities, MONTH_WIDE for noisy ones) and stored as its mean plus
# HARMONICS yearly harmonics. The browser evaluates the curve for any day,
# averages it over months, and takes the mean term for the year, so day,
# month and year views agree exactly.
HARMONICS = 4
NC = 2 * HARMONICS + 1
NODATA16 = -32768


def basis(days: int = 365) -> np.ndarray:
    """(NC, days): 1, cos(2 pi k t), sin(2 pi k t) at day centres; mirrors atlasBasis() in atlasData.ts."""
    t = (np.arange(days) + 0.5) / days
    rows = [np.ones(days)]
    for k in range(1, HARMONICS + 1):
        rows += [np.cos(2 * np.pi * k * t), np.sin(2 * np.pi * k * t)]
    return np.array(rows)


def transfer(half: float, days: int = 365) -> np.ndarray:
    """Gain of the triangle window on each coefficient."""
    j = np.arange(-int(half), int(half) + 1)
    w = np.maximum(0, 1 - np.abs(j) / half)
    g = [1.0]
    for k in range(1, HARMONICS + 1):
        h = (w * np.cos(2 * np.pi * k * j / days)).sum() / w.sum()
        g += [h, h]
    return np.array(g)


def harmonics(x: np.ndarray, half: float) -> np.ndarray:
    """x (days, n) with NaN gaps -> (NC, n) coefficients of the smoothed series; NaN where no data."""
    days = x.shape[0]
    with np.errstate(invalid="ignore"):
        mean = np.nanmean(x, 0)
    ok = np.isfinite(mean)
    x = np.where(np.isnan(x), mean[None, :], x)
    B = basis(days)
    norm = np.array([1.0] + [2.0] * (NC - 1)) / days
    c = (B @ np.where(ok[None, :], x, 0)) * norm[:, None]
    c *= transfer(half, days)[:, None]
    c[:, ~ok] = np.nan
    return c


def pack16(c: np.ndarray) -> tuple[bytes, float]:
    """int16 with a power-of-ten-ish scale; NODATA16 where NaN."""
    m = np.nanmax(np.abs(c)) if np.isfinite(c).any() else 1.0
    scale = 10.0 ** np.ceil(np.log10(max(m, 1e-9) / 32000))
    for k in (0.2, 0.5):
        if m / (scale * k) < 32000:
            scale *= k
            break
    q = np.where(np.isnan(c), NODATA16, np.clip(np.round(c / scale), -32767, 32767)).astype("<i2")
    return q.tobytes(), float(scale)


def sea_fill(c: np.ndarray, valid: np.ndarray, steps: int = 2) -> tuple[np.ndarray, np.ndarray]:
    """Extend sea values a few cells onto land (8-neighbour mean) so coastlines interpolate cleanly."""
    c = c.copy()
    filled = valid.copy()
    for _ in range(steps):
        s = np.zeros_like(c)
        n = np.zeros(valid.shape)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if di == dj == 0:
                    continue
                sh = np.roll(np.roll(filled, di, 0), dj, 1)
                if di == 1:
                    sh[0] = False
                if di == -1:
                    sh[-1] = False
                s += np.where(sh[None], np.roll(np.roll(np.nan_to_num(c), di, 1), dj, 2), 0)
                n += sh
        new = ~filled & (n > 0)
        c[:, new] = (s / np.maximum(n, 1)[None])[:, new]
        filled |= new
    return c, filled


def atlas(smp: dict, mask: np.ndarray, out: str, F: dict | None) -> dict:
    """Atlas files: int16 [NC][levels][ncells] harmonic coefficients (sea temperature: [NC][rows*cols] + flags)."""
    os.makedirs(out, exist_ok=True)
    days = smp["tmax"].shape[0]
    month_of = np.searchsorted(MONTH_START, np.arange(days), side="right") - 1
    n = int(mask.sum())

    def lev(v):
        """monthly factors (12, LEVELS, n) for a level variable, as the browser decodes them; or None"""
        return None if F is None else factor_values(factor_codes(F[v]))

    Fp, Fs, Fd = lev("precip"), lev("snowfall"), lev("snow")
    cell = lambda key: smp[key][:, mask].astype(np.float64)  # noqa: E731
    with np.errstate(invalid="ignore"):
        defs = {
            # id: (kind, window, series or per-level function)
            "tmean": ("mean", MONTH_NARROW, lambda: (cell("tmax") + cell("tmin")) / 2),
            "tmax": ("mean", MONTH_NARROW, lambda: cell("tmax")),
            "tmin": ("mean", MONTH_NARROW, lambda: cell("tmin")),
            "feels": ("mean", MONTH_NARROW, lambda: cell("feels_max")),
            "sun": ("sum", MONTH_NARROW, lambda: cell("sun")),
            "uv": ("mean", MONTH_NARROW, lambda: cell("uv")),
            "cloud": ("mean", MONTH_WIDE, lambda: cell("cloud")),
            "precip": ("sum", MONTH_WIDE, (lambda: cell("precip"), Fp)),
            # wet days as the finder counts them (>= 1 mm after the drizzle correction)
            "wetdays": ("sum", MONTH_WIDE, (lambda: np.maximum(cell("precip") - DRIZZLE_OFFSET_MM, 0), Fp, 1.0)),
            "snowfall": ("sum", MONTH_WIDE, (lambda: cell("snowfall"), Fs)),
            "snowdays": ("sum", MONTH_WIDE, (lambda: cell("snow"), Fd, 1.0)),
            "dew": ("mean", MONTH_NARROW, lambda: cell("dew")),
            "rh": ("mean", MONTH_WIDE, lambda: cell("rh")),
            "wind": ("mean", MONTH_WIDE, lambda: cell("wind")),
            "aqi": ("mean", MONTH_WIDE, lambda: cell("aqi")),
            "goodair": ("sum", MONTH_WIDE, lambda: (cell("aqi") <= 50).astype(np.float64)),
            "badair": ("sum", MONTH_WIDE, lambda: (cell("aqi") > 100).astype(np.float64)),
        }
    needs = {"sun": "sun", "uv": "uv", "snowfall": "snowfall", "rh": "rh", "aqi": "aqi", "goodair": "aqi", "badair": "aqi"}
    meta = {}
    for vid, (kind, half, src) in defs.items():
        if needs.get(vid, "tmax") not in smp:
            print(f"atlas: skipping {vid}")
            continue
        if callable(src):
            coefs = harmonics(src(), half)[:, None, :]  # (NC, 1, n)
        else:
            get, fac, *thr = src
            x = get()
            if fac is None:
                ser = [x >= thr[0] if thr else x]
            else:
                ser = [(x * fac[month_of, lv] >= thr[0]) if thr else x * fac[month_of, lv] for lv in range(LEVELS)]
            coefs = np.stack([harmonics(np.where(np.isnan(x), np.nan, s.astype(np.float64)), half) for s in ser], 1)
        blob, scale = pack16(coefs)
        gz = gzip.compress(blob, 9, mtime=0)
        with open(os.path.join(out, f"{vid}.bin"), "wb") as f:
            f.write(gz)
        meta[vid] = {"file": f"atlas/{vid}.bin", "kind": kind, "scale": scale, "levels": coefs.shape[1], "bytes": len(gz)}
        print(f"atlas {vid:9s} levels {coefs.shape[1]} {len(gz)/1e3:6.0f} kB")

    # sea temperature over the sea itself: the full grid, extended two cells onto land
    sst = smp["sst"].reshape(days, -1).astype(np.float64)
    enough = (~np.isnan(sst)).mean(0) >= 0.5
    c = harmonics(np.where(enough[None], sst, np.nan), MONTH_NARROW)
    R, C = mask.shape
    sea = np.isfinite(c[0]).reshape(R, C)
    cf, filled = sea_fill(c.reshape(NC, R, C), sea)
    flags = np.where(sea, 1, np.where(filled, 2, 0)).astype(np.uint8)
    blob, scale = pack16(np.where(filled[None], cf, np.nan).reshape(NC, -1))
    gz = gzip.compress(blob + flags.tobytes(), 9, mtime=0)
    with open(os.path.join(out, "sst.bin"), "wb") as f:
        f.write(gz)
    meta["sst"] = {"file": "atlas/sst.bin", "kind": "mean", "scale": scale, "levels": 1, "grid": "sea", "bytes": len(gz)}
    print(f"atlas sst (sea)  {len(gz)/1e3:6.0f} kB")
    return meta


if __name__ == "__main__":
    main()
