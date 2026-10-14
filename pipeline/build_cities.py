#!/usr/bin/env python3
"""Cities for map labels and search, from Natural Earth (public domain).

Elevations come from the nearest GeoNames cities15000 entry (its SRTM-based
`dem` column, CC BY 4.0) so city temperatures can be lapse-rate adjusted.
Towns from GeoNames with at least --town-pop people that Natural Earth leaves
out (Walnut Creek, Livermore, Palo Alto, ...) are added too; they only show
when zoomed in, so the map can show how climate changes from town to town.
"""
import argparse
import io
import json
import unicodedata
import zipfile

import requests
import shapefile  # pyshp

URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip"
GEONAMES = "https://download.geonames.org/export/dump/cities15000.zip"


def geonames():
    """(lat, lon, population, elevation or None, name, country code, feature code) for every GeoNames city."""
    z = zipfile.ZipFile(io.BytesIO(requests.get(GEONAMES, timeout=300).content))
    rows = []
    for line in z.read("cities15000.txt").decode("utf8").splitlines():
        f = line.split("\t")
        dem = f[16] or f[15]
        el = float(dem) if dem and dem != "-9999" else None
        rows.append((float(f[4]), float(f[5]), int(f[14] or 0), el, f[1], f[8], f[7]))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/cities.json")
    ap.add_argument("--min-pop", type=int, default=40000)
    ap.add_argument("--town-pop", type=int, default=40000)
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BytesIO(requests.get(URL, timeout=120).content))
    base = "ne_10m_populated_places_simple"
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")))
    import math
    gn = geonames()
    grid = {}
    for la, lo, pop, dem, *_ in gn:
        if dem is not None:
            grid.setdefault((int(la // 1), int(lo // 1)), []).append((la, lo, pop, dem))

    def elevation(la, lo):
        best, bd = None, 15.0  # km
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for gla, glo, pop, dem in grid.get((int(la // 1) + di, int(lo // 1) + dj), []):
                    d = math.hypot((gla - la) * 111, (glo - lo) * 111 * math.cos(math.radians(la)))
                    # prefer big places when nearly as close (NE points are city centres)
                    score = d - 2 * math.log10(pop + 10)
                    if d < 15 and (best is None or score < bd):
                        best, bd = dem, score
        return best

    out = []
    countries = {}
    for rec in r.records():
        d = rec.as_dict()
        if d.get("iso_a2") and d["iso_a2"] != "-99":
            countries.setdefault(d["iso_a2"], d["adm0name"])
        d = rec.as_dict()
        pop = int(d["pop_max"] or 0)
        cap = d["adm0cap"] == 1
        if pop < a.min_pop and not cap:
            continue
        el = elevation(d["latitude"], d["longitude"])
        out.append([d["name"], d["adm0name"], round(d["latitude"], 3), round(d["longitude"], 3), pop,
                    round(float(d["min_zoom"] or 9), 1), 1 if cap else 0, None if el is None else round(el)])
    # towns Natural Earth leaves out; skip the same place (same name within 15 km, or anything within 3 km)
    near = {}
    for c in out:
        near.setdefault((int(c[2] // 1), int(c[3] // 1)), []).append(c)
    simple = lambda n: "".join(ch for ch in unicodedata.normalize("NFD", n.lower()) if ch.isalnum())  # noqa: E731

    def listed(la, lo, name):
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for c in near.get((int(la // 1) + di, int(lo // 1) + dj), []):
                    d = math.hypot((c[2] - la) * 111, (c[3] - lo) * 111 * math.cos(math.radians(la)))
                    if d < 3 or (d < 15 and simple(c[0]) == simple(name)):
                        return True
        return False

    added = 0
    for la, lo, pop, dem, name, cc, fcode in sorted(gn, key=lambda g: -g[2]):
        if pop < a.town_pop or fcode in ("PPLX", "PPLH", "PPLQ", "PPLW") or listed(la, lo, name):
            continue
        minzoom = 6.0 if pop >= 500_000 else 6.6 if pop >= 200_000 else 7.2 if pop >= 100_000 else 7.8
        row = [name, countries.get(cc, cc), round(la, 3), round(lo, 3), pop, minzoom, 0, None if dem is None else round(dem)]
        out.append(row)
        near.setdefault((int(la // 1), int(lo // 1)), []).append(row)
        added += 1
    print("added", added, "GeoNames towns")
    # importance: capitals and big cities first so the label collision keeps them
    out.sort(key=lambda c: (-(c[6] * 5_000_000 + c[4])))
    with open(a.out, "w") as f:
        json.dump({"fields": ["name", "country", "lat", "lon", "pop", "minzoom", "capital", "elev"], "rows": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", len(out), "cities;", sum(c[7] is not None for c in out), "with elevation")


if __name__ == "__main__":
    main()
