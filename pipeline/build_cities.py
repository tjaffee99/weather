#!/usr/bin/env python3
"""Cities for map labels and search, from Natural Earth (public domain)."""
import argparse
import io
import json
import zipfile

import requests
import shapefile  # pyshp

URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/cities.json")
    ap.add_argument("--min-pop", type=int, default=40000)
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BytesIO(requests.get(URL, timeout=120).content))
    base = "ne_10m_populated_places_simple"
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")))
    out = []
    for rec in r.records():
        d = rec.as_dict()
        pop = int(d["pop_max"] or 0)
        cap = d["adm0cap"] == 1
        if pop < a.min_pop and not cap:
            continue
        out.append([d["name"], d["adm0name"], round(d["latitude"], 3), round(d["longitude"], 3), pop,
                    round(float(d["min_zoom"] or 9), 1), 1 if cap else 0])
    # importance: capitals and big cities first so the label collision keeps them
    out.sort(key=lambda c: (-(c[6] * 5_000_000 + c[4])))
    with open(a.out, "w") as f:
        json.dump({"fields": ["name", "country", "lat", "lon", "pop", "minzoom", "capital"], "rows": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", len(out), "cities")


if __name__ == "__main__":
    main()
