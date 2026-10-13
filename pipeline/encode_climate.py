#!/usr/bin/env python3
"""Quantise + compress the ERA5 daily samples for the browser.

Input : <work>/samples_pass0.npz (from era5_climate.py) and static_<res>.npz, plus
        samples_sun / _uv / _extra (era5_climate.py --only-...) and samples_aq (gefs_aq.py)
Output: public/data/climate/meta.json, cells.bin, <var>.bin (gzip) for the finder,
        and atlas/<id>.bin: monthly and annual normals per cell for the atlas view

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
    meta["atlas"] = atlas(smp, mask, os.path.join(a.out, "atlas"))
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"cells {ncells}, total {total/1e6:.2f} MB")


# monthly normals: triangle windows round mid-month (mirrors monthWeights() in src/climate/types.ts)
MONTH_NARROW, MONTH_WIDE = 30.4, 45.0


def month_weights(m: int, half: float, days: int = 365) -> np.ndarray:
    mid = (MONTH_START[m] + MONTH_START[m + 1]) / 2
    dist = np.abs((np.arange(days) + 0.5 - mid + days / 2) % days - days / 2)
    w = np.clip(1 - dist / half, 0, None)
    return w / w.sum()


def atlas(smp: dict, mask: np.ndarray, out: str) -> dict:
    """Monthly and annual normals per cell, from the raw (unquantised) daily samples.

    Each file is int16 [13][ncells] (Jan..Dec, then the year), value = stored * scale,
    -32768 where there is no data (sea temperature inland). "mean" variables are
    averaged over the period, "sum" variables added up over it (hours, mm, days).
    The sample has about one real day per calendar date, so months are taken
    over smoothed windows (month_weights): narrow for temperature and sun,
    wider for noisy day-to-day quantities like rain, cloud and snow.
    """
    os.makedirs(out, exist_ok=True)
    days = smp["tmax"].shape[0]
    defs = {
        "tmean": ("mean", 0.1, lambda: (smp["tmax"] + smp["tmin"]) / 2),
        "tmax": ("mean", 0.1, lambda: smp["tmax"]),
        "tmin": ("mean", 0.1, lambda: smp["tmin"]),
        "feels": ("mean", 0.1, lambda: smp["feels_max"]),
        "sun": ("sum", 1.0, lambda: smp["sun"]),
        "uv": ("mean", 0.1, lambda: smp["uv"]),
        "cloud": ("mean", 0.1, lambda: smp["cloud"]),
        "precip": ("sum", 1.0, lambda: smp["precip"]),
        # wet days as the finder counts them (>= 1 mm after the drizzle correction)
        "wetdays": ("sum", 0.1, lambda: (smp["precip"] - DRIZZLE_OFFSET_MM >= 1).astype(np.float32)),
        "snowfall": ("sum", 1.0, lambda: smp["snowfall"]),
        "snowdays": ("sum", 0.1, lambda: (smp["snow"] >= 1).astype(np.float32)),
        "dew": ("mean", 0.1, lambda: smp["dew"]),
        "rh": ("mean", 0.1, lambda: smp["rh"]),
        "wind": ("mean", 0.1, lambda: smp["wind"]),
        "sst": ("mean", 0.1, lambda: smp["sst"]),
        "aqi": ("mean", 0.1, lambda: smp["aqi"]),
        "goodair": ("sum", 0.1, lambda: (smp["aqi"] <= 50).astype(np.float32)),
    }
    narrow = {"tmean", "tmax", "tmin", "feels", "dew", "sst", "sun", "uv"}
    needs = {"sun": "sun", "uv": "uv", "snowfall": "snowfall", "rh": "rh", "aqi": "aqi", "goodair": "aqi"}
    meta = {}
    for vid, (kind, scale, get) in defs.items():
        if needs.get(vid, "tmax") not in smp:
            print(f"atlas: skipping {vid}")
            continue
        x = get().astype(np.float64)[:, mask]  # (days, ncells)
        valid = ~np.isnan(x)
        x0 = np.where(valid, x, 0)
        periods = []
        for m in range(13):
            w = np.ones(days) if m == 12 else month_weights(m, MONTH_NARROW if vid in narrow else MONTH_WIDE, days)
            ws = w @ valid
            with np.errstate(invalid="ignore", divide="ignore"):
                v = np.where(ws > 0, (w @ x0) / ws, np.nan)  # weighted mean of the valid days
            if kind == "sum":
                v = v * (days if m == 12 else MONTH_START[m + 1] - MONTH_START[m])
            periods.append(v)
        q = np.stack(periods) / scale
        q = np.where(np.isnan(q), -32768, np.clip(np.round(q), -32767, 32767)).astype("<i2")
        blob = gzip.compress(q.tobytes(), 9, mtime=0)
        with open(os.path.join(out, f"{vid}.bin"), "wb") as f:
            f.write(blob)
        meta[vid] = {"file": f"atlas/{vid}.bin", "kind": kind, "scale": scale, "bytes": len(blob)}
        print(f"atlas {vid:9s} {len(blob)/1e3:6.0f} kB")
    return meta


if __name__ == "__main__":
    main()
