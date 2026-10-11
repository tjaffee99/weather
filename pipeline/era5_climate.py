#!/usr/bin/env python3
"""Build a stratified sample of daily weather from ERA5 for the climate explorer.

Source: Google's public analysis-ready ERA5 (ARCO-ERA5), hourly, 0.25 deg:
  gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3
Each zarr chunk is one hourly global field, so we fetch chunks straight over
HTTPS and decode them with numcodecs (no zarr/xarray/gcsfs needed).

Sampling design
---------------
For every day of the (365-day) year we want one real day of weather. Days are
taken in blocks of BLOCK consecutive days from a single year; years rotate with
a stride so that neighbouring blocks come from different years. Over the year
the sample therefore spans every year in YEARS, and a +-15 day window around
any date mixes ~10 different years.

For every sampled day and every output cell we compute *local solar time*
daily metrics (feels-like high, low, daytime cloud, ...). Because local days
straddle UTC days, each block fetches 12 extra hours either side.

Values are averaged from 0.25 deg to RES deg using land-weighted means (so a
coastal cell reports the climate of its land part, not the sea).

Output: <work>/samples_pass<P>.npz with float32 arrays [365, rows, cols].
"""
import argparse
import datetime as dt
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numcodecs
import numpy as np
import requests

BASE = "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
T0 = dt.datetime(1900, 1, 1)  # zarr time index = hours since this epoch
NLAT, NLON = 721, 1440
LAT_TOP, LAT_BOTTOM = 84.0, -60.0  # Antarctica is excluded from the explorer

_codec = numcodecs.Blosc()
_tls = threading.local()


def hidx(d: dt.datetime) -> int:
    return int((d - T0).total_seconds() // 3600)


def session() -> requests.Session:
    s = getattr(_tls, "s", None)
    if s is None:
        s = requests.Session()
        a = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4)
        s.mount("https://", a)
        _tls.s = s
    return s


def fetch(var: str, t: int) -> np.ndarray:
    url = f"{BASE}/{var}/{t}.0.0"
    for attempt in range(6):
        try:
            r = session().get(url, timeout=60)
            if r.status_code == 200:
                return np.frombuffer(_codec.decode(r.content), dtype="<f4").reshape(NLAT, NLON)
            if r.status_code == 404:
                raise FileNotFoundError(url)
        except (requests.RequestException, RuntimeError) as e:  # network / truncated chunk
            err = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to fetch {url}: {err if 'err' in dir() else r.status_code}")


class Coarsener:
    """Box-average the 0.25 deg global grid to RES deg cells between LAT_TOP and LAT_BOTTOM.

    0.25 deg ERA5 points sit on cell edges of the coarse grid, so each coarse
    cell uses an (f+1)x(f+1) stencil with half weights on the edge points.
    """

    def __init__(self, res: float):
        f = int(round(res / 0.25))
        self.f = f
        self.rows = int(round((LAT_TOP - LAT_BOTTOM) / res))
        self.cols = int(round(360 / res))
        self.r0 = int(round((90 - LAT_TOP) / 0.25))
        self.w = np.array([0.5] + [1.0] * (f - 1) + [0.5], dtype=np.float32)
        self.norm = float(f * f)

    def _crop(self, a: np.ndarray) -> np.ndarray:
        a = a[self.r0 : self.r0 + self.rows * self.f + 1]
        # roll so that column 0 is lon -180 and append the wrap column (+180)
        return np.concatenate([a[:, 720:], a[:, :720], a[:, 720:721]], axis=1)

    def box(self, a: np.ndarray) -> np.ndarray:
        """Weighted sum (not mean) over each coarse cell."""
        a = self._crop(a)
        f, n = self.f, self.rows
        r = sum(self.w[k] * a[k : k + n * f : f] for k in range(f + 1))
        m = self.cols
        return sum(self.w[k] * r[:, k : k + m * f : f] for k in range(f + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--res", type=float, default=1.0)
    ap.add_argument("--years", default="2001-2025")
    ap.add_argument("--block", type=int, default=3)
    ap.add_argument("--stride", type=int, default=7)
    ap.add_argument("--pass", dest="pas", type=int, default=0)
    ap.add_argument("--threads", type=int, default=48)
    ap.add_argument("--limit-blocks", type=int, default=0, help="debug: only process N blocks")
    ap.add_argument("--only-sun", action="store_true",
                    help="compute only daily sunshine hours for the same sample days (samples_sun.npz)")
    args = ap.parse_args()

    y0, y1 = (int(x) for x in args.years.split("-"))
    years = list(range(y0, y1 + 1))
    L = args.block
    os.makedirs(args.work, exist_ok=True)
    cz = Coarsener(args.res)
    R, C = cz.rows, cz.cols
    lon_c = -180 + args.res * (np.arange(C) + 0.5)
    lat_c = LAT_TOP - args.res * (np.arange(R) + 0.5)
    offs = np.round(lon_c / 15).astype(int)  # local solar time offset (hours) per column

    # ---- static fields -------------------------------------------------
    static_path = os.path.join(args.work, f"static_{args.res}.npz")
    if not os.path.exists(static_path):
        t_ref = hidx(dt.datetime(2020, 1, 1))
        lsm = fetch("land_sea_mask", t_ref)
        z = fetch("geopotential_at_surface", t_ref) / 9.80665
        W = cz.box(lsm)
        land = W / cz.norm
        z_land = np.where(W > 0, cz.box(lsm * z) / np.maximum(W, 1e-9), cz.box(z) / cz.norm)
        np.savez(static_path, land=land.astype(np.float32), elev=z_land.astype(np.float32),
                 lat=lat_c, lon=lon_c, lsm025=lsm.astype(np.float32), z025=z.astype(np.float32))
    st = np.load(static_path)
    lsm = st["lsm025"]
    W = cz.box(lsm)
    landw = W > 0.005 * cz.norm  # cells where we use land-weighted means

    def coarse(a: np.ndarray) -> np.ndarray:
        land_mean = cz.box(lsm * a) / np.maximum(W, 1e-9)
        all_mean = cz.box(a) / cz.norm
        return np.where(landw, land_mean, all_mean).astype(np.float32)

    def coarse_sst(a: np.ndarray) -> np.ndarray:
        ok = ~np.isnan(a)
        s = cz.box(np.where(ok, a, 0))
        n = cz.box(ok.astype(np.float32))
        return np.where(n > 0.25, s / np.maximum(n, 1e-9), np.nan).astype(np.float32)

    if args.only_sun:
        return sunshine(args, years, L, cz, coarse, lat_c, lon_c, offs)

    # ---- blocks ----------------------------------------------------------
    nblocks = (365 + L - 1) // L
    out_names = ["tmax", "feels_max", "tmin", "dew", "cloud", "wind", "precip", "rain_hours", "snow", "sst"]
    out_path = os.path.join(args.work, f"samples_pass{args.pas}.npz")
    part_dir = os.path.join(args.work, f"parts_pass{args.pas}")
    os.makedirs(part_dir, exist_ok=True)

    hours_all = list(range(-12, 24 * L + 13))
    hours_3 = [h for h in hours_all if h % 3 == 0]
    loc_h = np.arange(24)

    pool = ThreadPoolExecutor(args.threads)
    t_start = time.time()
    blocks = range(nblocks) if not args.limit_blocks else range(args.limit_blocks)
    for b in blocks:
        part = os.path.join(part_dir, f"b{b:03d}.npz")
        if os.path.exists(part):
            continue
        doy0 = b * L + args.pas % L
        ndays = min(L, 365 - doy0) if args.pas == 0 else L
        year = years[(b * args.stride + args.pas * 13) % len(years)]
        start = dt.datetime(year, 1, 1) + dt.timedelta(days=doy0)
        if year % 4 == 0 and doy0 >= 59:
            start += dt.timedelta(days=1)  # keep month/day aligned with the 365-day calendar
        h0 = hidx(start)

        jobs = {}
        for var, hrs in (("2m_temperature", hours_all), ("total_precipitation", hours_all),
                         ("2m_dewpoint_temperature", hours_3), ("10m_u_component_of_wind", hours_3),
                         ("10m_v_component_of_wind", hours_3), ("total_cloud_cover", hours_3)):
            for h in hrs:
                jobs[(var, h)] = None
        for k in range(ndays):
            for var in ("snow_depth", "snow_density", "sea_surface_temperature"):
                jobs[(var, 24 * k + 12)] = None

        def work(key):
            var, h = key
            a = fetch(var, h0 + h)
            return key, (coarse_sst(a) if var == "sea_surface_temperature" else
                         coarse(np.nan_to_num(a, nan=0.0)))

        futs = [pool.submit(work, k) for k in jobs]
        for fu in as_completed(futs):
            key, val = fu.result()
            jobs[key] = val

        def stack(var, hrs):
            return np.stack([jobs[(var, h)] for h in hrs])

        T = stack("2m_temperature", hours_all) - 273.15
        P = np.maximum(stack("total_precipitation", hours_all), 0) * 1000.0  # mm in previous hour

        def interp3(var):
            a = stack(var, hours_3)
            x = np.array(hours_3, dtype=np.float32)
            out = np.empty((len(hours_all), R, C), np.float32)
            for n, h in enumerate(hours_all):
                i = min(int(np.searchsorted(x, h, side="right")) - 1, len(x) - 2)
                t = (h - x[i]) / 3.0
                out[n] = a[i] * (1 - t) + a[i + 1] * t
            return out

        Td = interp3("2m_dewpoint_temperature") - 273.15
        U = interp3("10m_u_component_of_wind")
        V = interp3("10m_v_component_of_wind")
        CC = interp3("total_cloud_cover")

        res = {n: np.zeros((ndays, R, C), np.float32) for n in out_names}
        for k in range(ndays):
            # index into hours_all for local hour h of local day k in column j
            idx = 24 * k + loc_h[:, None] - offs[None, :] + 12  # (24, C)
            idx = np.broadcast_to(idx[:, None, :], (24, R, C))
            t = np.take_along_axis(T, idx, 0)
            td = np.take_along_axis(Td, idx, 0)
            ws = np.hypot(np.take_along_axis(U, idx, 0), np.take_along_axis(V, idx, 0))
            cc = np.take_along_axis(CC, idx, 0)
            pr = np.take_along_axis(P, idx + 1, 0)  # accumulation over (h, h+1]
            e = 6.105 * np.exp(17.27 * td / (237.7 + td))
            at = t + 0.33 * e - 0.70 * ws - 4.0
            res["tmax"][k] = t.max(0)
            res["feels_max"][k] = at.max(0)
            res["tmin"][k] = t.min(0)
            res["dew"][k] = td[9:18].mean(0)
            res["cloud"][k] = np.clip(cc[9:18].mean(0), 0, 1) * 100
            res["wind"][k] = ws[9:19].max(0) * 3.6
            res["precip"][k] = pr.sum(0)
            res["rain_hours"][k] = (pr[8:20] >= 0.1).sum(0)
            sd = jobs[("snow_depth", 24 * k + 12)]
            rho = jobs[("snow_density", 24 * k + 12)]
            res["snow"][k] = np.where(sd > 1e-5, sd * 1000.0 / np.maximum(rho, 50.0), 0) * 100  # cm
            res["sst"][k] = jobs[("sea_surface_temperature", 24 * k + 12)] - 273.15
        np.savez(part, doy0=doy0, year=year, **res)
        el = time.time() - t_start
        print(f"block {b+1}/{nblocks} {start:%Y-%m-%d} x{ndays} fields={len(jobs)} elapsed={el:.0f}s", flush=True)

    if args.limit_blocks:
        return
    full = {n: np.full((365, R, C), np.nan, np.float32) for n in out_names}
    years_used = np.zeros(365, np.int16)
    for b in range(nblocks):
        d = np.load(os.path.join(part_dir, f"b{b:03d}.npz"))
        doy0 = int(d["doy0"])
        nd = d["tmax"].shape[0]
        for n in out_names:
            for k in range(nd):
                full[n][(doy0 + k) % 365] = d[n][k]
        years_used[[(doy0 + k) % 365 for k in range(nd)]] = int(d["year"])
    np.savez(out_path, years=years_used, **full)
    print("wrote", out_path)


def block_start(b, L, years, args):
    doy0 = b * L + args.pas % L
    ndays = min(L, 365 - doy0) if args.pas == 0 else L
    year = years[(b * args.stride + args.pas * 13) % len(years)]
    start = dt.datetime(year, 1, 1) + dt.timedelta(days=doy0)
    if year % 4 == 0 and doy0 >= 59:
        start += dt.timedelta(days=1)
    return doy0, ndays, year, start


def cos_zenith(t: dt.datetime, lat_c, lon_c):
    """Cosine of the solar zenith angle on the (rows, cols) grid at UTC time t."""
    doy = t.timetuple().tm_yday
    g = 2 * np.pi / 365 * (doy - 1 + (t.hour - 12) / 24)
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g)
                    - 0.040849 * np.sin(2 * g))  # minutes
    minutes = t.hour * 60 + t.minute + t.second / 60
    ha = np.radians((minutes + eqt + 4 * lon_c[None, :]) / 4 - 180)
    phi = np.radians(lat_c)[:, None]
    return np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)


# Ratios of direct to clear-sky direct radiation below this count as no sunshine.
# Calibrated against annual sunshine at 18 stations worldwide (Phoenix to
# Reykjavik): median ratio 1.03, mean error 7%. A plain ratio (floor 0) was 9%
# too sunny overall and 15-30% too sunny in cloudy climates, where ERA5 lets
# too much direct light through; floors of 0.2 and above or powers of the
# ratio fitted worse.
SUN_FLOOR = 0.1


def sunshine(args, years, L, cz, coarse, lat_c, lon_c, offs):
    """Daily sunshine hours per local day.

    WMO sunshine = direct normal irradiance >= 120 W/m2. On 1-degree cell means
    a threshold would count a half-cloudy hour as fully sunny, so each hour
    counts the share of clear-sky direct radiation that got through (rescaled
    above SUN_FLOOR), in hours where the clear-sky beam exceeds 120 W/m2.
    """
    R, C = cz.rows, cz.cols
    nblocks = (365 + L - 1) // L
    part_dir = os.path.join(args.work, "parts_sun")
    os.makedirs(part_dir, exist_ok=True)
    hours_all = list(range(-12, 24 * L + 13))
    loc_h = np.arange(24)
    pool = ThreadPoolExecutor(args.threads)
    t_start = time.time()
    blocks = range(nblocks) if not args.limit_blocks else range(args.limit_blocks)
    for b in blocks:
        part = os.path.join(part_dir, f"b{b:03d}.npz")
        if os.path.exists(part):
            continue
        doy0, ndays, year, start = block_start(b, L, years, args)
        h0 = hidx(start)

        def work(key):
            var, h = key
            a = fetch(var, h0 + h)
            return key, coarse(np.nan_to_num(np.maximum(a, 0), nan=0.0))

        keys = [(v, h) for v in ("total_sky_direct_solar_radiation_at_surface",
                                 "clear_sky_direct_solar_radiation_at_surface") for h in hours_all]
        got = dict(pool.map(work, keys))
        ratio = np.zeros((len(hours_all), R, C), np.float32)
        for n, h in enumerate(hours_all):
            t_end = start + dt.timedelta(hours=h)
            mu = np.mean([np.maximum(cos_zenith(t_end - dt.timedelta(minutes=m), lat_c, lon_c), 0)
                          for m in (7.5, 22.5, 37.5, 52.5)], axis=0)
            fdir = got[("total_sky_direct_solar_radiation_at_surface", h)]
            cdir = got[("clear_sky_direct_solar_radiation_at_surface", h)]
            possible = (mu > 0.03) & (cdir / 3600.0 / np.maximum(mu, 0.03) >= 120.0)
            ratio[n] = np.where(possible, np.clip(fdir / np.maximum(cdir, 1.0), 0, 1), -1)
        frac = np.where(ratio < 0, 0, np.clip((ratio - SUN_FLOOR) / (1 - SUN_FLOOR), 0, 1))
        sun = np.zeros((ndays, R, C), np.float32)
        for k in range(ndays):
            idx = 24 * k + loc_h[:, None] - offs[None, :] + 12
            idx = np.broadcast_to(idx[:, None, :], (24, R, C))
            sun[k] = np.take_along_axis(frac, idx + 1, 0).sum(0)
        np.savez(part, doy0=doy0, year=year, sun=sun)
        print(f"sun block {b+1}/{nblocks} {start:%Y-%m-%d} elapsed={time.time()-t_start:.0f}s", flush=True)

    if args.limit_blocks:
        return
    o = np.full((365, R, C), np.nan, np.float32)
    for b in range(nblocks):
        d = np.load(os.path.join(part_dir, f"b{b:03d}.npz"))
        for k in range(d["sun"].shape[0]):
            o[(int(d["doy0"]) + k) % 365] = d["sun"][k]
    np.savez(os.path.join(args.work, "samples_sun.npz"), sun=o)
    print("wrote samples_sun.npz")


if __name__ == "__main__":
    main()
