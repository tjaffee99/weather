# Weather Atlas

An interactive world weather map with three views:

- **Climate finder** (the home page): add conditions such as feels-like high, daytime high, overnight low, dew point, relative humidity, hours of sunshine, UV index, cloud cover, precipitation, fresh snowfall, wind, snow on the ground, air quality, sea temperature and daylight. Start from a preset (perfect day, beach, skiing…) or use the grouped "Add condition" menu. Each condition starts from a sensible range (e.g. feels-like 18–27 °C, at least 7 hours of sunshine, a dry day ≤ 1 mm, wind below a fresh breeze, sea ≥ 24 °C). A three-way switch at the top of the panel chooses what the colours show:
  - **Days per year**: how many days a year each place meets all of your conditions, based on 2001–2025 ERA5 reanalysis. The colour scale is fixed (0 · 7 · 30 · 90 · 180 · 365 days, on a square-root curve so rare matches stay visible), so a colour means the same thing for every selection. "Highlight at least" answers "where do I get at least N such days a year?" by dimming everything below it.
  - **Chance by date**: the chance that a day around the chosen date matches. Drag the date slider or press play to animate through the year.
  - **Right now**: the same conditions checked against the latest NOAA GFS forecast, at the current hour or any hour in the next 3 days, to show where it is nice right now. Temperatures are the current reading (terrain-adjusted), precipitation is the current rate, and sea temperature comes from the model's sea surface. Sliders update the map instantly on the GPU, and matching cities get a ✓ with their temperature.

  Tap anywhere to get a location card. It shows the chance through the year, the best months, and monthly normals (highs, lows, humidity, sunshine, UV, rain days, precipitation, snowfall, snow days, air quality, wind and sea temperature). Slider values mean what they show: 70 °F matches any day that rounds to 70 °F.
- **Atlas**: the map coloured by a climate normal: average temperature, daytime high, overnight low, feels-like high, sunshine hours, UV index, cloud cover, precipitation, wet days, snowfall, days with snow on the ground, dew point, relative humidity, wind, air quality, good-air days and sea temperature. Each is shown for the whole year or for any month, and play animates through the months. City labels show the values. Tap anywhere for a card with the yearly totals and a month-by-month table.
- **Live weather**: the latest NOAA GFS model run as a smooth temperature field, with an Actual / Feels like toggle. The other layers are:
  - precipitation, with a Forecast / Radar toggle (observed radar from the last 2 hours);
  - clouds, with a Satellite / Forecast toggle (observed infrared cloud imagery from the last 24 hours, the default). Both show blue where the sky is clear and white where it is overcast;
  - UV index (standard UV colours, following the sun);
  - air quality (US AQI from PM2.5, 5-day forecast);
  - snow depth, wind with animated streaks, and humidity.
   It has an hourly forecast scrubber with cross-fading and city temperature labels. When you zoom in, temperatures are downscaled to the terrain, so individual valleys and ridges show up. Snow depth uses the 3 km HRRR model over the US and Alaska, is shaped by terrain elsewhere, and shows glaciers worldwide. Tap the map for a point forecast: current conditions (including air quality) plus the next 24 hours in 3-hour steps.

## How it works

### Rendering

`src/map/fieldLayer.ts` is a MapLibre custom WebGL layer. For each pixel it computes latitude and longitude and samples the data grid with cubic B-spline filtering, which gives smooth Apple-Weather-style gradients without grid artifacts. Temperature is then downscaled with a 0.1° elevation model (−6.5 °C per km), so valleys and mountain ranges stand out even though the model grid is coarser. Once you zoom past level 5, the global elevation model is replaced by a mosaic of AWS terrain tiles for the current viewport (`src/map/localDem.ts`), which brings the detail down to about 100 m. Water and borders are drawn on top from vector tiles, so coastlines stay sharp at every zoom. In the climate finder and atlas the water layer also clips the results to land. The layer supports both the mercator and globe projections.

### Live data

GFS 0.25° GRIB2 files are fetched directly from NOAA's public AWS bucket, which allows CORS range requests. The app reads the `.idx` inventory and downloads only the bytes for the fields it needs, about 0.5–1 MB per global field. It decodes them in a Web Worker with a small GRIB2 decoder (`src/live/grib2.ts`, complex packing with spatial differencing), which is tested against ecCodes. No server or API key is needed, and the data is always current.

Observed layers are raster tiles recoloured in the browser (`src/live/observed.ts`) so they match the forecast palettes:

- **Radar** is [RainViewer](https://www.rainviewer.com/)'s global composite (10-minute frames, past 2 hours). Its tiles stop at zoom 7, so they get blurry when you zoom in closer. Each tile colour is mapped back to reflectivity (dBZ) and then to a rain rate (Marshall–Palmer, Z = 200 R^1.6) or a snow rate (Z = 2000 R²).
- **Satellite** is [EUMETSAT](https://view.eumetsat.int/)'s world cloud map: 10.8 µm infrared from all geostationary weather satellites, mosaicked every 3 hours and usually 2–3 hours behind real time. Cold cloud tops are bright in infrared, so brightness is mapped onto the cloud palette. Low, warm cloud and fog show up weakly or not at all.

**Air quality** comes from NOAA's global aerosol model, [GEFS-Aerosols](https://registry.opendata.aws/noaa-gefs/) (0.25°, a new run every 6 hours, 3-hourly out to 5 days, `src/live/aerosol.ts`). Surface PM2.5 is converted to the US AQI with EPA's 2024 breakpoints. The model includes dust, sea salt, sulphate, organic and black carbon (smoke), but not nitrate or local traffic pollution. It therefore reads low in places like Delhi and Cairo and high in some others (Beijing). The location card's air-quality line uses [CAMS](https://atmosphere.copernicus.eu/) via Open-Meteo instead, which models chemistry in more detail.

Snow depth over the contiguous US and Alaska comes from NOAA's 3 km [HRRR](https://rapidrefresh.noaa.gov/hrrr/) model, fetched the same way (`src/live/hrrr.ts`). Its grids are Lambert conformal and polar stereographic, so the shader projects each pixel onto the native grid instead of resampling, and fades it into GFS at the domain edges. Elsewhere, GFS snow is shaped by terrain within each model cell: about e times deeper for every 700 m above the cell's mean elevation, capped at 4× and floored at 0.1×. Glaciers come from the basemap's vector tiles (Natural Earth at low zoom, OpenStreetMap outlines when zoomed in), because 0.25° models miss most of them.

### Climate data

`pipeline/era5_climate.py` streams hourly ERA5 fields from Google's public [ARCO-ERA5](https://github.com/google-research/arco-era5) Zarr store and builds one real day of weather for every day of the year. It uses 3-day blocks from years that rotate through 2001–2025, so a ±10-day window mixes about 7 different years. For each 1° land cell it computes daily metrics in local solar time:

- feels-like high (Steadman/BoM apparent temperature)
- high and low
- daytime dew point
- daytime cloud cover
- daily peak UV index. ERA5's surface UV (200–440 nm) is mostly UV-A, so it can't be scaled to a UV index directly. Each hour instead takes the standard clear-sky UV index for the sun angle and ERA5's ozone column (Madronich: 12.5 μ^2.42 (O₃/300 DU)^−1.23), times ERA5's UV relative to its own clear-sky level, which brings in clouds, haze, altitude and snow (`--only-uv`). Live UV uses the same formula with GFS ozone and GFS all-sky/clear-sky UV-B.
- hours of sunshine (WMO definition: direct normal irradiance ≥ 120 W/m²). It is estimated from ERA5 direct and clear-sky direct radiation and the sun angle, and calibrated against annual totals at 18 stations from Phoenix to Reykjavik (median ratio 1.03, typical error 7%). `--only-sun` adds it to an existing sample.
- daily precipitation
- daily snowfall (fresh snow at a 10:1 snow-to-water ratio)
- daytime relative humidity (9 am–6 pm mean, from hourly temperature and dew point)
- strongest daytime wind
- snow depth
- nearby sea-surface temperature

`--only-sun`, `--only-uv` and `--only-extra` (humidity and snowfall) add those metrics to an existing sample without re-running the rest. `pipeline/gefs_aq.py` adds daily air quality from the GEFS-Aerosols archive. It uses the same 3-day blocks rotating through 2021–2025, because the archive only starts in late 2020, and it carries the model biases described under live data.

Coastal cells use land-weighted averages. ERA5 reports light rain far too often (its well-known "drizzle bias"), so 1 mm/day is subtracted before encoding. With that correction, the app's rain days (≥ 1 mm) match station counts within about 10% in the mid-latitudes (London, Paris, Sydney, Miami, Seattle). The tropics still come out too wet. ERA5 cloud cover also counts thin high cloud that barely dims the sun, so sunshine hours are the better measure of a sunny day.

`pipeline/encode_climate.py` quantizes each variable and compresses it with spatial and temporal predictive coding plus gzip. Each variable is its own file (0.5–2.6 MB), so the browser only downloads the variables the active conditions need. `src/climate/climate.worker.ts` evaluates queries over all ~19,000 cells × 365 days in about 30–210 ms. It returns results at 9 elevation offsets, and the shader picks the right one for each pixel from the DEM.

The same script writes the atlas normals (`public/data/climate/atlas/<variable>.bin`: int16, 12 months plus the year for every cell, 60–340 kB each). The sample holds about one real day per calendar date, so a plain calendar month would be only ~30 days of weather. Instead, monthly normals use a triangular window centred mid-month: ±30 days for temperature, sunshine and UV, and ±45 days for noisy quantities like rain, cloud, snow, wind and air quality. Location cards in the finder use the same windows. Map pixels, city labels and cards all blend the nearby 1° cells the same way (`src/climate/blend.ts`), with temperatures adjusted to each pixel's elevation.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # GRIB2 decoder (GFS + HRRR grids) + climate codec round-trip tests
npm run build      # static site in dist/
```

The generated data in `public/data/` is committed, so the app runs without the pipeline.

### Regenerating data

```bash
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/build_dem.py                      # public/data/dem.bin
.venv/bin/python pipeline/build_cities.py                   # public/data/cities.json
.venv/bin/python pipeline/era5_climate.py --work work/      # ~30 min, streams ~85 GB from GCS
.venv/bin/python pipeline/era5_climate.py --work work/ --only-sun     # sunshine hours
.venv/bin/python pipeline/era5_climate.py --work work/ --only-uv      # UV index
.venv/bin/python pipeline/era5_climate.py --work work/ --only-extra   # humidity + snowfall
.venv/bin/python pipeline/gefs_aq.py --work work/           # air quality (needs eccodes)
.venv/bin/python pipeline/encode_climate.py --work work/    # public/data/climate/*
```

## Deploy

Live at **https://weather.theojaffee.net** (`public/CNAME`; DNS: `weather` CNAME → `tjaffee99.github.io`).

`.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages on every push to `main`. To turn it on, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The build uses relative paths, so it works under any sub-path.

## Data & credits

- Forecast: NOAA Global Forecast System, High-Resolution Rapid Refresh and GEFS-Aerosols (public domain), via the NOAA Open Data Dissemination program on AWS
- Radar: RainViewer; satellite cloud imagery: EUMETSAT (View Service world cloud map)
- Air quality in the location card: Copernicus Atmosphere Monitoring Service (CAMS) via Open-Meteo
- Climate: Copernicus Climate Change Service ERA5 reanalysis (Hersbach et al. 2020), via Google's ARCO-ERA5
- Point forecasts in the location card: Open-Meteo (CC BY 4.0); place names and boundaries: OpenStreetMap Nominatim
- Basemap: OpenFreeMap / OpenMapTiles / © OpenStreetMap contributors; low-zoom coastlines: Natural Earth
- Terrain: AWS Terrain Tiles (Mapzen terrarium)
- Cities: Natural Earth (public domain)
