#!/usr/bin/env python3
"""Small towns for the map labels, loaded by area when zoomed in (src/towns.ts).

cities.json holds every Natural Earth city and GeoNames town of 40,000 or more.
This adds every other GeoNames place of 1,000 or more people (cities1000,
CC BY 4.0), skipping neighbourhoods and places already listed (the same name
within 15 km, or anything within 2 km). They are written in 5-degree tiles,
public/data/towns/<row>_<col>.json (row from 90N, col from 180W), with the
same fields as cities.json plus a global rank (biggest first), and an index.

Each town gets its SRTM elevation from GeoNames and the microclimate offsets
at its pixel from public/data/micro (as microclimate.py does for cities.json),
so finder, atlas and live labels treat it like any other city.

Arabic and Hebrew names transliterated with diacritics (Ţūlkarm, Petaẖ Tiqva)
use GeoNames' plain ASCII name instead; --fix-city-names applies the same to
the GeoNames towns already in cities.json.
"""
import argparse
import gzip
import io
import json
import math
import os
import unicodedata
import zipfile

import numpy as np
import requests

CITIES1000 = "https://download.geonames.org/export/dump/cities1000.zip"
COUNTRIES = "https://download.geonames.org/export/dump/countryInfo.txt"
TILE = 5
SKIP = ("PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH")
# letters only scholarly transliterations of Arabic and Hebrew use (Rafaḩ, Reẖovot, H̱olon, Ţūlkarm, Al ‘Ayn)
MARKS = {"\u1e24", "\u1e25", "\u1e28", "\u1e29", "\u1e96", "\u1e94", "\u1e95", "\u1e6c", "\u1e6d", "\u1e62", "\u1e63", "\u1e0c", "\u1e0d",
         "\u1e10", "\u1e11", "\u1e92", "\u1e93", "\u0162", "\u0163", "\u02bb", "\u02bc", "\u2018", "\u02bf", "\u02be",
         "\u0331", "\u0323", "\u0327"}


# Ţ also spells Romanian and Moldovan names (Galaţi, Rîbniţa): only plain it where Arabic, Hebrew or Persian is spoken
CEDILLA_T = {"\u0162", "\u0163"}
ARABIC_HEBREW = set("AE BH DZ EG IQ JO KW LB LY MA OM PS QA SA SD SY TN YE IL IR AF MR EH SO DJ ER".split())


def clean(name: str, ascii_name: str, cc: str = "") -> str:
    """The plain ASCII name for scholarly transliterations of Arabic and Hebrew, else the name."""
    chars = set(unicodedata.normalize("NFC", name)) | ({"\u0331"} if "\u0331" in unicodedata.normalize("NFD", name) else set())
    marks = chars & MARKS
    if cc not in ARABIC_HEBREW:
        marks -= CEDILLA_T
    return ascii_name if ascii_name and marks else name


def minzoom(pop: int) -> float:
    # the label layer shows a place from zoom (minzoom - 2.4)
    return 9.0 if pop >= 20000 else 9.6 if pop >= 10000 else 10.2 if pop >= 5000 else 10.8 if pop >= 2000 else 11.4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", default="public/data/cities.json")
    ap.add_argument("--micro", default="public/data/micro")
    ap.add_argument("--out", default="public/data/towns")
    ap.add_argument("--fix-city-names", action="store_true")
    a = ap.parse_args()

    countries = {}
    for line in requests.get(COUNTRIES, timeout=120).text.splitlines():
        if line and not line.startswith("#"):
            f = line.split("\t")
            countries[f[0]] = f[4]
    z = zipfile.ZipFile(io.BytesIO(requests.get(CITIES1000, timeout=600).content))
    gn = []
    for line in z.read("cities1000.txt").decode("utf8").splitlines():
        f = line.split("\t")
        dem = f[16] or f[15]
        gn.append({"name": f[1], "ascii": f[2], "lat": float(f[4]), "lon": float(f[5]), "fcode": f[7], "cc": f[8],
                   "pop": int(f[14] or 0), "elev": float(dem) if dem and dem not in ("-9999", "") else None})

    cj = json.load(open(a.cities))
    rows = cj["rows"]
    simple = lambda n: "".join(ch for ch in unicodedata.normalize("NFD", n.lower()) if ch.isalnum())  # noqa: E731
    near = {}

    def add_near(name, la, lo):
        near.setdefault((int(la // 1), int(lo // 1)), []).append((simple(name), la, lo))

    def listed(name, la, lo):
        s = simple(name)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for n, cla, clo in near.get((int(la // 1) + di, int(lo // 1) + dj), []):
                    d = math.hypot((cla - la) * 111, (clo - lo) * 111 * math.cos(math.radians(la)))
                    if d < 2 or (d < 15 and n == s):
                        return True
        return False

    for r in rows:
        add_near(r[0], r[2], r[3])

    if a.fix_city_names:
        by_name = {}
        for g in gn:
            by_name.setdefault(g["name"], []).append(g)
        fixed = 0
        for r in rows:
            for g in by_name.get(r[0], []):
                if abs(g["lat"] - r[2]) < 0.05 and abs(g["lon"] - r[3]) < 0.05:
                    new = clean(g["name"], g["ascii"], g["cc"])
                    if new != r[0]:
                        r[0], fixed = new, fixed + 1
                    break
        with open(a.cities, "w") as f:
            json.dump(cj, f, ensure_ascii=False, separators=(",", ":"))
        print("renamed", fixed, "cities in", a.cities)

    # microclimate offsets at each town's pixel (raw stored integers, as in cities.json)
    mi = json.load(open(os.path.join(a.micro, "index.json")))
    px, tdeg, top, left = mi["px"], mi["tile"], mi["top"], mi["left"]
    have = {tuple(t) for t in mi["tiles"]}
    n = tdeg * px
    cache = {}

    def tile(ty, tx):
        if (ty, tx) not in cache:
            if (ty, tx) in have:
                raw = open(os.path.join(a.micro, f"{ty}_{tx}.bin"), "rb").read()
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                cache[(ty, tx)] = np.frombuffer(raw, np.int8).reshape(-1, n, n)
            else:
                cache[(ty, tx)] = None
        return cache[(ty, tx)]

    def micro(la, lo):
        i, j = int((top - la) * px), int(((lo - left) % 360) * px)
        if i < 0:
            return None
        t = tile(i // n, j // n)
        if t is None:
            return None
        v = t[:, i % n, j % n]
        return [int(x) for x in v] if v.any() else None

    towns = []
    for g in sorted(gn, key=lambda g: -g["pop"]):
        if g["pop"] < 1000 or g["fcode"] in SKIP or listed(g["name"], g["lat"], g["lon"]):
            continue
        add_near(g["name"], g["lat"], g["lon"])
        towns.append(g)
    print(len(towns), "towns")
    tiles = {}
    for rank, g in enumerate(towns):
        key = (int((90 - g["lat"]) // TILE), int((g["lon"] + 180) // TILE) % (360 // TILE))
        tiles.setdefault(key, []).append([clean(g["name"], g["ascii"], g["cc"]), countries.get(g["cc"], g["cc"]), round(g["lat"], 4),
                                          round(g["lon"], 4), g["pop"], minzoom(g["pop"]), rank,
                                          None if g["elev"] is None else round(g["elev"]), micro(g["lat"], g["lon"])])
    os.makedirs(a.out, exist_ok=True)
    for f in os.listdir(a.out):
        os.remove(os.path.join(a.out, f))
    total = 0
    for (ty, tx), rs in tiles.items():
        blob = json.dumps({"fields": ["name", "country", "lat", "lon", "pop", "minzoom", "rank", "elev", "mc"], "rows": rs},
                          ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(a.out, f"{ty}_{tx}.json"), "w") as f:
            f.write(blob)
        total += len(blob)
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump({"tile": TILE, "tiles": sorted([ty, tx, len(rs)] for (ty, tx), rs in tiles.items())}, f, separators=(",", ":"))
    print(len(tiles), "tiles,", round(total / 1e6, 1), "MB; biggest", max(len(r) for r in tiles.values()), "towns")


if __name__ == "__main__":
    main()
