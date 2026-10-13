#!/usr/bin/env python3
"""Daily air quality samples for the climate finder, from NOAA GEFS-Aerosols.

ERA5 has no air quality, so this uses the archive of NOAA's global aerosol
model (GEFS-Aerosols, 0.25 deg, on AWS since late 2020): surface PM2.5 at
00, 06, 12 and 18 UTC from each day's 00Z run, averaged to a daily mean and
converted to the US AQI. One day per calendar date, with the same 3-day
blocks as era5_climate.py, rotating through 2021-2025 so a +-10-day window
mixes all five years.

  python pipeline/gefs_aq.py --work work/     # -> work/samples_aq.npz (aqi, pm25)

The model includes dust, sea salt, sulphate, organic and black carbon (smoke)
but not nitrate, so it reads low where nitrate is a big part of the
pollution (winter haze in northern India and China).
"""
import argparse
import datetime as dt
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import eccodes
import numpy as np
import requests

sys.path.insert(0, os.path.dirname(__file__))
from era5_climate import Coarsener  # noqa: E402

BUCKET = "https://noaa-gefs-pds.s3.amazonaws.com"
YEARS = [2021, 2022, 2023, 2024, 2025]
HOURS = [0, 6, 12, 18]
_s = requests.Session()

# US EPA PM2.5 breakpoints (2024 revision): (C_lo, C_hi, AQI_lo, AQI_hi), 24-hour mean in ug/m3
AQI_PM25 = [(0.0, 9.0, 0, 50), (9.0, 35.4, 50, 100), (35.4, 55.4, 100, 150), (55.4, 125.4, 150, 200),
            (125.4, 225.4, 200, 300), (225.4, 325.4, 300, 500)]


def aqi_pm25(c: np.ndarray) -> np.ndarray:
    out = np.full(c.shape, 500.0, np.float32)
    for clo, chi, alo, ahi in reversed(AQI_PM25):
        m = c <= chi
        out[m] = alo + (np.maximum(c[m], clo) - clo) * (ahi - alo) / (chi - clo)
    return out


def pm25(day: dt.date, fh: int) -> np.ndarray | None:
    """Surface PM2.5 (ug/m3) on the 0.25 deg grid from the 00Z run of `day` at forecast hour fh."""
    url = f"{BUCKET}/gefs.{day:%Y%m%d}/00/chem/pgrb2ap25/gefs.chem.t00z.a2d_0p25.f{fh:03d}.grib2"
    for attempt in range(4):
        try:
            r = _s.get(url + ".idx", timeout=60)
            if r.status_code == 404:
                return None
            rows = [l.split(":") for l in r.text.strip().split("\n")]
            # "Total aerosol" (newer) or "Total Aerosol" (older inventories)
            i = next(k for k, l in enumerate(rows) if "PMTF:surface" in ":".join(l) and "total aerosol" in ":".join(l).lower())
            a, b = int(rows[i][1]), int(rows[i + 1][1]) - 1
            msg = _s.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=120).content
            h = eccodes.codes_new_from_message(msg)
            v = eccodes.codes_get_values(h).reshape(721, 1440)
            eccodes.codes_release(h)
            return np.maximum(v, 0).astype(np.float32)  # already ug/m3
        except StopIteration:
            return None
        except Exception:
            time.sleep(2 ** attempt)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--block", type=int, default=3)
    ap.add_argument("--threads", type=int, default=24)
    ap.add_argument("--limit-blocks", type=int, default=0)
    args = ap.parse_args()

    st = np.load(os.path.join(args.work, "static_1.0.npz"))
    cz = Coarsener(1.0)
    lsm = st["lsm025"]
    W = cz.box(lsm)
    landw = W > 0.005 * cz.norm

    def coarse(a):
        return np.where(landw, cz.box(lsm * a) / np.maximum(W, 1e-9), cz.box(a) / cz.norm).astype(np.float32)

    L = args.block
    nblocks = (365 + L - 1) // L
    part_dir = os.path.join(args.work, "parts_aq")
    os.makedirs(part_dir, exist_ok=True)
    pool = ThreadPoolExecutor(args.threads)
    t0 = time.time()
    blocks = range(args.limit_blocks or nblocks)
    for b in blocks:
        part = os.path.join(part_dir, f"b{b:03d}.npz")
        if os.path.exists(part):
            continue
        doy0 = b * L
        ndays = min(L, 365 - doy0)
        out = np.zeros((ndays, cz.rows, cz.cols), np.float32)
        used = []
        for k in range(ndays):
            doy = doy0 + k
            day_pm = None
            # rotate years by block; fall back to the others if a day is missing from the archive
            for j in range(len(YEARS)):
                year = YEARS[(b + j) % len(YEARS)]
                day = dt.date(year, 1, 1) + dt.timedelta(days=doy + (1 if year % 4 == 0 and doy >= 59 else 0))
                fields = list(pool.map(lambda fh: pm25(day, fh), HOURS))
                if all(f is not None for f in fields):
                    day_pm = np.mean(fields, axis=0)
                    used.append(year)
                    break
            if day_pm is None:
                out[k] = np.nan
                used.append(0)
                continue
            out[k] = coarse(day_pm)
        np.savez(part, doy0=doy0, years=np.array(used), pm25=out)
        print(f"aq block {b+1}/{nblocks} doy {doy0} years {used} elapsed={time.time()-t0:.0f}s", flush=True)

    if args.limit_blocks:
        return
    pm = np.full((365, cz.rows, cz.cols), np.nan, np.float32)
    for b in range(nblocks):
        d = np.load(os.path.join(part_dir, f"b{b:03d}.npz"))
        for k in range(d["pm25"].shape[0]):
            pm[int(d["doy0"]) + k] = d["pm25"][k]
    np.savez(os.path.join(args.work, "samples_aq.npz"), pm25=pm, aqi=aqi_pm25(np.nan_to_num(pm, nan=0.0)))
    print("wrote samples_aq.npz")


if __name__ == "__main__":
    main()
