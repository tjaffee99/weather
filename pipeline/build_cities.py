#!/usr/bin/env python3
"""Cities for map labels and search, from Natural Earth (public domain).

Elevations come from the nearest GeoNames cities15000 entry (its SRTM-based
`dem` column, CC BY 4.0) so city temperatures can be lapse-rate adjusted.
"""
import argparse
import io
import json
import zipfile

import requests
import shapefile  # pyshp

URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip"
GEONAMES = "https://download.geonames.org/export/dump/cities15000.zip"


def geonames_elevations():
    z = zipfile.ZipFile(io.BytesIO(requests.get(GEONAMES, timeout=300).content))
    rows = []
    for line in z.read("cities15000.txt").decode("utf8").splitlines():
        f = line.split("\t")
        dem = f[16] or f[15]
        if dem and dem != "-9999":
            rows.append((float(f[4]), float(f[5]), int(f[14] or 0), float(dem)))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/cities.json")
    ap.add_argument("--min-pop", type=int, default=40000)
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BytesIO(requests.get(URL, timeout=120).content))
    base = "ne_10m_populated_places_simple"
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")))
    import math
    gn = geonames_elevations()
    grid = {}
    for la, lo, pop, dem in gn:
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
    for rec in r.records():
        d = rec.as_dict()
        pop = int(d["pop_max"] or 0)
        cap = d["adm0cap"] == 1
        if pop < a.min_pop and not cap:
            continue
        el = elevation(d["latitude"], d["longitude"])
        out.append([d["name"], d["adm0name"], round(d["latitude"], 3), round(d["longitude"], 3), pop,
                    round(float(d["min_zoom"] or 9), 1), 1 if cap else 0, None if el is None else round(el)])
    # importance: capitals and big cities first so the label collision keeps them
    out.sort(key=lambda c: (-(c[6] * 5_000_000 + c[4])))
    with open(a.out, "w") as f:
        json.dump({"fields": ["name", "country", "lat", "lon", "pop", "minzoom", "capital", "elev"], "rows": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", len(out), "cities;", sum(c[7] is not None for c in out), "with elevation")


if __name__ == "__main__":
    main()
