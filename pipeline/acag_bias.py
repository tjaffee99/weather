#!/usr/bin/env python3
"""Correct the model air quality with satellite + ground-monitor PM2.5.

GEFS-Aerosols (gefs_aq.py) gets the day-to-day weather of pollution right
(dust storms, smoke plumes, stagnant winter air) but its emission inventory
predates the large cuts of the last decade, so it reads about twice too high
in China and too low where it lacks nitrate and local sources (South Asia,
Cairo). The Washington University ACAG V6.GL.03 product fuses satellite
aerosol, GEOS-Chem and ground monitors (including China's national network)
into monthly PM2.5 at 0.1 deg; it matches city averages to within ~10-20%.

For every 1-degree cell and day of the year the model PM2.5 is scaled so its
smoothed seasonal mean equals ACAG's 2021-2024 monthly climatology. The
model's day-to-day variation is kept, so "good-air days" still reflect real
episodes. The monthly ratios are also written for the live map
(public/data/aq_bias.bin), which applies them to the live GEFS forecast.

  python pipeline/acag_bias.py --work work/     # rewrites work/samples_aq.npz

Data: van Donkelaar et al., ACAG Surface PM2.5 V6.GL.03 (CC BY 4.0),
s3://satpmdata/V6GL03/CNNPM25c0p10/Monthly/GL/ (anonymous access).
"""
import argparse
import gzip
import os
import sys

import h5py
import numpy as np
import requests

sys.path.insert(0, os.path.dirname(__file__))
from encode_climate import MONTH_START, MONTH_WIDE, month_weights  # noqa: E402
from gefs_aq import aqi_pm25  # noqa: E402

URL = "https://satpmdata.s3.amazonaws.com/V6GL03/CNNPM25c0p10/Monthly/GL/V6GL03.CNNPM25.0p10.GL.{ym}-{ym}.nc"
YEARS = [2021, 2022, 2023, 2024]
LAT_TOP = 84.0  # finder grid: 1 deg cells from 84N to 60S
ROWS, COLS = 144, 360
RATIO_MIN, RATIO_MAX = 1 / 16, 16


def acag_climatology(cache: str) -> np.ndarray:
    """Monthly mean PM2.5 (12, 144, 360) on the finder's 1 deg grid; NaN where ACAG has no data."""
    os.makedirs(cache, exist_ok=True)
    s = np.zeros((12, 1300, 3600))
    n = np.zeros((12, 1300, 3600))
    for y in YEARS:
        for m in range(12):
            ym = f"{y}{m + 1:02d}"
            path = os.path.join(cache, f"acag_{ym}.nc")
            if not os.path.exists(path):
                r = requests.get(URL.format(ym=ym), timeout=300)
                r.raise_for_status()
                with open(path + ".tmp", "wb") as f:
                    f.write(r.content)
                os.replace(path + ".tmp", path)
            a = h5py.File(path)["PM25"][:].astype(np.float64)  # (1300, 3600), lat -60..70, lon -180..180
            ok = a >= 0
            s[m] += np.where(ok, a, 0)
            n[m] += ok
    # 10x10 blocks of 0.1 deg pixels -> 1 deg; block row b covers lat [-60 + b, -59 + b]
    bs = s.reshape(12, 130, 10, 360, 10).sum((2, 4))
    bn = n.reshape(12, 130, 10, 360, 10).sum((2, 4))
    blk = np.where(bn >= 10, bs / np.maximum(bn, 1), np.nan)  # need ~10% of the block on land
    out = np.full((12, ROWS, COLS), np.nan)
    for i in range(ROWS):
        b = int(LAT_TOP) - i - 1 + 60
        if 0 <= b < 130:
            out[:, i] = blk[:, b]
    return out


def smooth(daily: np.ndarray) -> np.ndarray:
    """Seasonal mean for each day: triangle window of +-MONTH_WIDE days, wrapping round the year."""
    days = daily.shape[0]
    half = int(MONTH_WIDE)
    k = np.array([1 - abs(j) / (half + 1) for j in range(-half, half + 1)])
    valid = ~np.isnan(daily)
    x = np.where(valid, daily, 0)
    s = np.zeros_like(x, dtype=np.float64)
    w = np.zeros_like(x, dtype=np.float64)
    for j, kj in zip(range(-half, half + 1), k):
        s += kj * np.roll(x, -j, axis=0)
        w += kj * np.roll(valid, -j, axis=0)
    return np.where(w > 0, s / np.maximum(w, 1e-9), np.nan)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", default="public/data")
    a = ap.parse_args()

    path = os.path.join(a.work, "samples_aq.npz")
    z = dict(np.load(path))
    model = z.get("pm25_model", z["pm25"]).astype(np.float64)  # (365, 144, 360); re-runs start from the model
    days = model.shape[0]

    clim = acag_climatology(os.path.join(a.work, "acag"))
    # observed climatology as a daily series (each day its month's mean), smoothed like the model
    month_of = np.searchsorted(MONTH_START, np.arange(days), side="right") - 1
    obs = smooth(clim[month_of])
    mod = smooth(model)
    ratio = np.where(np.isnan(obs) | ~(mod > 0.5), 1.0, obs / np.maximum(mod, 1e-9))
    ratio = np.clip(ratio, RATIO_MIN, RATIO_MAX)
    pm = model * ratio

    # monthly ratios for the live map, at mid-month
    mids = [(MONTH_START[m] + MONTH_START[m + 1]) // 2 for m in range(12)]
    r_month = np.log2(ratio[mids])
    # carry the land factors a few cells out to sea (where ACAG has no data), so coasts have no seam
    have = ~np.isnan(clim)
    for _ in range(3):
        acc = np.zeros_like(r_month)
        cnt = np.zeros(have.shape)
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(have, di, 1), dj, 2)
            acc += np.where(sh, np.roll(np.roll(r_month, di, 1), dj, 2), 0)
            cnt += sh
        new = ~have & (cnt > 0)
        r_month = np.where(new, acc / np.maximum(cnt, 1), r_month)
        have |= new
    r_month = np.where(have, 2 ** r_month, 1.0).astype(np.float32)
    code = np.clip(np.round(128 + 32 * np.log2(r_month)), 1, 255).astype(np.uint8)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "aq_bias.bin"), "wb") as f:
        f.write(gzip.compress(code.tobytes(), 9, mtime=0))

    z.update(pm25=pm.astype(np.float32), aqi=aqi_pm25(np.nan_to_num(pm, nan=0.0)), pm25_model=model.astype(np.float32))
    np.savez(path, **z)
    w = np.cos(np.radians(LAT_TOP - 0.5 - np.arange(ROWS)))[:, None] * np.ones(COLS)
    land = ~np.isnan(clim[0])
    print(f"wrote {path}; median ratio {np.median(ratio[:, land]):.2f}, "
          f"area-weighted mean {np.average(ratio.mean(0)[land], weights=w[land]):.2f}")


if __name__ == "__main__":
    main()
