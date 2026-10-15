#!/usr/bin/env python3
"""Areas whose place names the location cards set themselves (src/regions.ts).

Pins in the West Bank and Gaza are labelled by who administers the spot:
  C                          -> "Judea and Samaria Area, Israel"
  A, B (incl. Hebron H1/H2   -> "West Bank, State of Palestine"
  and the Wye nature reserve)
  Gaza Strip                 -> "Gaza Strip, State of Palestine"
East Jerusalem and the 1949 no man's land keep the geocoder's name.

Sources (OCHA oPt via HDX):
  Oslo Agreement areas in the West Bank (PA Ministry of Planning), classes A, A
  (OBJECTID 2 is Area B: Abu Dis, al-Eizariya, Sinjil...), C, H1, H2, Nature
  Reserve, Israeli Declared East Jerusalem, No Man's Land.
  Subnational administrative boundaries (COD-AB, CC BY-IGO) for the Gaza Strip.

Output: public/data/regions.json: {"bbox": [w, s, e, n], "areas": [{"id", "polygons": [[ring, ...], ...]}]},
rings as [lon, lat] pairs (5 decimals), simplified by ~5 m. Areas: AB, KEEP (East
Jerusalem, no man's land), WB (the outline of all Oslo classes: what is inside
it and in neither AB nor KEEP is Area C) and GAZA.
"""
import argparse
import io
import json
import zipfile

import requests
import shapefile  # pyshp
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

OSLO = "https://data.humdata.org/dataset/d3a843df-a640-4e9d-b867-8ca974c2aa74/resource/86f2707a-dc64-46af-bd41-b31e95611b45/download/osloagreement.zip"
CODAB = "https://data.humdata.org/dataset/2caf8373-816f-458c-9913-71bddb9cab7c/resource/ca372385-4c79-4378-abf1-cb506fb98023/download/pse_admin_boundaries.geojson.zip"
AREA = {"A": "AB", "H1": "AB", "H2": "AB", "Nature Reserve": "AB", "Israeli Declared East Jerusalem": "KEEP", "No Man's Land": "KEEP"}
TOL = 0.00005  # degrees, ~5 m


def polygons(g, holes=True):
    g = g.simplify(TOL, preserve_topology=True)
    parts = g.geoms if isinstance(g, MultiPolygon) else [g] if isinstance(g, Polygon) else []
    out = []
    for p in parts:
        if p.area < 1e-8:
            continue
        rings = [p.exterior] + (list(p.interiors) if holes else [])
        out.append([[[round(x, 5), round(y, 5)] for x, y in r.coords] for r in rings])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/regions.json")
    a = ap.parse_args()
    z = zipfile.ZipFile(io.BytesIO(requests.get(OSLO, timeout=300).content))
    name = next(n for n in z.namelist() if n.endswith(".shp"))[:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(name + ".shp")), dbf=io.BytesIO(z.read(name + ".dbf")))
    areas, every = {}, []
    for sh, rec in zip(r.shapes(), r.records()):
        g = shape(sh.__geo_interface__).buffer(0)
        every.append(g)
        if rec["CLASS"] in AREA:
            areas.setdefault(AREA[rec["CLASS"]], []).extend(polygons(g))
    # the West Bank's outline (no holes: gaps inside are slivers between classes)
    areas["WB"] = polygons(unary_union(every).buffer(0.00002).buffer(-0.00002), holes=False)
    z = zipfile.ZipFile(io.BytesIO(requests.get(CODAB, timeout=300).content))
    adm1 = json.loads(z.read(next(n for n in z.namelist() if n.endswith("admin1.geojson"))))
    gaza = next(f for f in adm1["features"] if f["properties"]["adm1_name"] == "Gaza Strip")
    areas["GAZA"] = polygons(shape(gaza["geometry"]))
    xs = [x for ps in areas.values() for p in ps for x, _ in p[0]]
    ys = [y for ps in areas.values() for p in ps for _, y in p[0]]
    out = {"bbox": [min(xs), min(ys), max(xs), max(ys)], "areas": [{"id": k, "polygons": v} for k, v in areas.items()]}
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    for k, v in areas.items():
        print(k, len(v), "polygons,", sum(len(r) for p in v for r in p), "points")


if __name__ == "__main__":
    main()
