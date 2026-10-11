# Weather Atlas

An interactive world weather map with three modes:

- **Live**: the latest NOAA GFS model run as a smooth temperature field (plus feels-like, precipitation, clouds, wind with animated streaks, humidity and snow depth). It has an hourly forecast scrubber with cross-fading, city temperature labels, and a point forecast when you tap the map. When you zoom in, temperatures are downscaled to the terrain, so individual valleys and ridges show up.
- **Climate finder**: switch on conditions such as feels-like high, overnight low, humidity, cloud cover, precipitation, wind, snow on the ground, sea temperature and daylight. The map shows how many days a year each place meets all of them, based on 2001–2025 ERA5 reanalysis. A cutoff slider answers "where do I get at least N such days a year?" by dimming everything below it.
- **Best time to go**: the same conditions, but for a chosen day of the year. The map shows the chance that a day around that date matches. Press play to animate through the year.

Tap anywhere in a climate mode to get a location card. It shows the chance through the year, the best months, and monthly normals (highs, lows, sunny days, rain days, precipitation, snow days, wind and sea temperature).

## How it works

### Rendering

`src/map/fieldLayer.ts` is a MapLibre custom WebGL layer. For each pixel it computes latitude and longitude and samples the data grid with cubic B-spline filtering, which gives smooth Apple-Weather-style gradients without grid artifacts. Temperature is then downscaled with a 0.1° elevation model (−6.5 °C per km), so valleys and mountain ranges stand out even though the model grid is coarser. Once you zoom past level 5, the global elevation model is replaced by a mosaic of AWS terrain tiles for the current viewport (`src/map/localDem.ts`), which brings the detail down to about 100 m. Water and borders are drawn on top from vector tiles, so coastlines stay sharp at every zoom. In climate modes the water layer also clips the results to land. The layer supports both the mercator and globe projections.

### Live data

GFS 0.25° GRIB2 files are fetched directly from NOAA's public AWS bucket, which allows CORS range requests. The app reads the `.idx` inventory and downloads only the bytes for the fields it needs, about 0.5–1 MB per global field. It decodes them in a Web Worker with a small GRIB2 decoder (`src/live/grib2.ts`, complex packing with spatial differencing), which is tested against ecCodes. No server or API key is needed, and the data is always current.

### Climate data

`pipeline/era5_climate.py` streams hourly ERA5 fields from Google's public [ARCO-ERA5](https://github.com/google-research/arco-era5) Zarr store and builds one real day of weather for every day of the year. It uses 3-day blocks from years that rotate through 2001–2025, so a ±10-day window mixes about 7 different years. For each 1° land cell it computes daily metrics in local solar time:

- feels-like high (Steadman/BoM apparent temperature)
- high and low
- daytime dew point
- daytime cloud cover
- daily precipitation
- strongest daytime wind
- snow depth
- nearby sea-surface temperature

Coastal cells use land-weighted averages. ERA5 reports light rain far too often (its well-known "drizzle bias"), so 1 mm/day is subtracted before encoding. With that correction, the app's rain days (≥ 1 mm) match station counts within about 10% in the mid-latitudes (London, Paris, Sydney, Miami, Seattle). The tropics still come out too wet.

`pipeline/encode_climate.py` quantizes each variable and compresses it with spatial and temporal predictive coding plus gzip. Each variable is its own file (0.5–2.6 MB), so the browser only downloads the variables the active conditions need. `src/climate/climate.worker.ts` evaluates queries over all ~19,000 cells × 365 days in about 30–170 ms. It returns results at 9 elevation offsets, and the shader picks the right one for each pixel from the DEM.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # GRIB2 decoder + climate codec round-trip tests
npm run build      # static site in dist/
```

The generated data in `public/data/` is committed, so the app runs without the pipeline.

### Regenerating data

```bash
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/build_dem.py                      # public/data/dem.bin
.venv/bin/python pipeline/build_cities.py                   # public/data/cities.json
.venv/bin/python pipeline/era5_climate.py --work work/      # ~30 min, streams ~85 GB from GCS
.venv/bin/python pipeline/encode_climate.py --work work/    # public/data/climate/*
```

## Deploy

`.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages on every push to `main`. To turn it on, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The build uses relative paths, so it works under any sub-path.

## Data & credits

- Forecast: NOAA Global Forecast System (public domain), via the NOAA Open Data Dissemination program on AWS
- Climate: Copernicus Climate Change Service ERA5 reanalysis (Hersbach et al. 2020), via Google's ARCO-ERA5
- Basemap: OpenFreeMap / OpenMapTiles / © OpenStreetMap contributors
- Terrain: AWS Terrain Tiles (Mapzen terrarium)
- Cities: Natural Earth (public domain)
