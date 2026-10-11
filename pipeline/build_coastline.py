#!/usr/bin/env python3
"""Natural Earth 1:50m coastlines (public domain) for low zoom levels.

Vector-tile ocean polygons are split at the antimeridian at low zooms, so
outlining them draws a false line along 180°. Real coastline lines don't.
"""
import argparse
import io
import json
import zipfile

import requests
import shapefile  # pyshp

URL = "https://naciscdn.org/naturalearth/50m/physical/ne_50m_coastline.zip"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/coastline.json")
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BytesIO(requests.get(URL, timeout=120).content))
    r = shapefile.Reader(shp=io.BytesIO(z.read("ne_50m_coastline.shp")), dbf=io.BytesIO(z.read("ne_50m_coastline.dbf")))
    lines = []
    for shp in r.shapes():
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for i in range(len(parts) - 1):
            seg = [[round(x, 2), round(y, 2)] for x, y in pts[parts[i]:parts[i + 1]]]
            # drop consecutive duplicates created by rounding
            seg = [p for k, p in enumerate(seg) if k == 0 or p != seg[k - 1]]
            if len(seg) > 1:
                lines.append(seg)
    gj = {"type": "Feature", "properties": {}, "geometry": {"type": "MultiLineString", "coordinates": lines}}
    with open(a.out, "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    print("wrote", len(lines), "lines")


if __name__ == "__main__":
    main()
