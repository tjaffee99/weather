import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { baseStyle, WATER, WEATHER_BEFORE } from './map/style';
import { FieldLayer } from './map/fieldLayer';
import { landDemTile, LocalDem } from './map/localDem';
import { radarTile, satelliteTile } from './live/observed';
import { reverseGeocode } from './geocode';
import { WindParticles } from './map/windParticles';
import { loadCities, loadDem, type City, type Dem } from './data';
import { LiveController } from './live/liveController';
import { LiveUI } from './live/liveUi';
import { $, h, clear } from './ui/dom';
import { units } from './units';
import { ClimateUI } from './climate/climateUi';
import { AtlasUI } from './climate/atlasUi';
import { Microclimate } from './climate/micro';

const BASE = import.meta.env.BASE_URL;
type Mode = 'climate' | 'atlas' | 'live';

const els = {
  panel: $('#panel'),
  bottom: $('#bottombar'),
  legend: $('#legend'),
  card: $('#card'),
};

// ---------- status toast ----------
const statusEl = $('#status');
const progressEl = h('div', { class: 'progress hidden' }, h('div'));
statusEl.append(progressEl);
function setStatus(msg: string, busy = true, error = false, progress?: number) {
  statusEl.classList.toggle('hidden', !msg);
  statusEl.classList.toggle('error', error);
  $('#statusText').textContent = msg;
  if (!busy) statusEl.querySelector('.spinner')?.classList.add('hidden');
  else statusEl.querySelector('.spinner')?.classList.remove('hidden');
  progressEl.classList.toggle('hidden', progress === undefined);
  if (progress !== undefined) (progressEl.firstChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
}

// terrain shading without the sea floor
maplibregl.addProtocol('landdem', async (params) => ({ data: await landDemTile(params.url) }));
maplibregl.addProtocol('radar', async (params) => ({ data: await radarTile(params.url) }));
maplibregl.addProtocol('satir', async (params) => ({ data: await satelliteTile(params.url) }));

// ---------- map ----------
const map: MlMap = new maplibregl.Map({
  container: 'map',
  // absolute URL: MapLibre fetches GeoJSON from a worker
  style: baseStyle(new URL(`${BASE}data/coastline.json`, location.href).href),
  center: [0, 28],
  zoom: Math.max(0.6, Math.log2(Math.max(320, window.innerWidth - (window.innerWidth > 760 ? 340 : 0)) / 512) + 0.15),
  minZoom: 0,
  maxZoom: 12,
  hash: 'map',
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      'Map forecast: <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast">NOAA GFS</a>, <a href="https://rapidrefresh.noaa.gov/hrrr/">HRRR</a> and <a href="https://registry.opendata.aws/noaa-gefs/">GEFS-Aerosols</a> · Radar: <a href="https://www.rainviewer.com/">RainViewer</a> · Satellite: <a href="https://view.eumetsat.int/">EUMETSAT</a> · Air-quality correction: <a href="https://sites.wustl.edu/acag/surface-pm2-5/">ACAG V6.GL.03</a> · Point forecasts: <a href="https://open-meteo.com/">Open-Meteo</a> · Places: <a href="https://nominatim.org/">Nominatim</a> · Climate: <a href="https://cds.climate.copernicus.eu/">Copernicus ERA5</a> via <a href="https://github.com/google-research/arco-era5">ARCO-ERA5</a> · Microclimates: <a href="https://www.worldclim.org/">WorldClim</a> · Towns: <a href="https://www.geonames.org/">GeoNames</a> · <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
  }),
  'bottom-right',
);
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const field = new FieldLayer('weather');
const particles = new WindParticles('wind-particles');
let marker: maplibregl.Marker | null = null;
let mode: Mode | null = null;
let live: LiveController;
let liveUi: LiveUI;
let climateUi: ClimateUI;
let atlasUi: AtlasUI;
let micro: Microclimate;
let liveReadyResolve: () => void = () => {};
const liveReady = new Promise<void>((r) => (liveReadyResolve = r));
let cities: City[] = [];
let dem: Dem;

function closeCard() {
  els.card.classList.add('hidden');
  els.card.classList.remove('compact');
  clear(els.card);
  marker?.remove();
  marker = null;
}

function cityLayer() {
  map.addSource('cities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'city-labels',
    type: 'symbol',
    source: 'cities',
    filter: ['<=', ['get', 'minzoom'], ['+', ['zoom'], 2.4]],
    layout: {
      'symbol-sort-key': ['get', 'rank'],
      'text-field': [
        'case',
        ['!=', ['get', 'label'], ''],
        ['format', ['get', 'label'], { 'font-scale': 1.18, 'text-font': ['literal', ['Noto Sans Bold']] }, '\n', {}, ['get', 'name'], { 'font-scale': 0.8 }],
        ['get', 'name'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 5, 13, 9, 15],
      'text-line-height': 1.05,
      // just below the place, so the marker of an opened city sits above its number
      'text-anchor': 'top',
      'text-offset': [0, 0.85],
      'text-padding': 6,
      'text-max-width': 8,
    },
    paint: {
      'text-color': '#1b1d21',
      'text-halo-color': 'rgba(255,255,255,0.88)',
      'text-halo-width': 1.6,
      'text-halo-blur': 0.4,
    },
  });
}

/** Water opacity: translucent over live fields, opaque in climate modes to clip results to land. */
function setWaterForMode(m: Mode) {
  if (!map.getLayer('water')) return;
  // < 1 keeps the fill in MapLibre's translucent pass so it draws after (above) the custom layer
  map.setPaintProperty('water', 'fill-opacity', m === 'live' ? 0.18 : 0.995);
  map.setPaintProperty('water', 'fill-color', WATER);
  // softer terrain highlights over climate results so their colours stay saturated
  map.setPaintProperty('hillshade', 'hillshade-highlight-color', m === 'live' ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.1)');
  map.setPaintProperty('hillshade', 'hillshade-shadow-color', m === 'live' ? 'rgba(40,48,60,0.42)' : 'rgba(30,36,50,0.3)');
}

async function setMode(m: Mode) {
  if (m === mode) return;
  const prev = mode;
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  closeCard();
  // fade the current field out instead of flashing stale data in the new mode's colours
  await field.fadeTo(0, 160);
  if (mode !== m) return;
  if (prev === 'live') {
    live.deactivate();
    liveUi.exit();
  }
  if (prev === 'climate') climateUi.exit();
  if (prev === 'atlas') atlasUi.exit();
  setWaterForMode(m);
  updateUrlMode();
  micro?.setActive(m !== 'live');
  if (m === 'live') {
    liveUi.enter();
    await liveReady;
    if (mode !== 'live') return;
    live.activate();
    liveUi.enter();
    live.updateCities();
  } else if (m === 'atlas') {
    await atlasUi.enter();
  } else {
    await climateUi.enter();
  }
}

function updateUrlMode() {
  const u = new URL(location.href);
  if (mode === 'live' || mode === 'atlas') u.searchParams.set('mode', mode);
  else u.searchParams.delete('mode');
  history.replaceState(null, '', u);
}

function placeMarker(lon: number, lat: number) {
  marker?.remove();
  marker = new maplibregl.Marker({ element: h('div', { class: 'pin' }) }).setLngLat([lon, lat]).addTo(map);
}

function openAt(lon: number, lat: number) {
  placeMarker(lon, lat);
  const placeP = reverseGeocode(lon, lat, cities);
  if (mode === 'live') liveUi.showCard(lon, lat, placeP);
  else if (mode === 'atlas') atlasUi.showCard(lon, lat, placeP);
  else climateUi?.showCard(lon, lat, false, placeP);
}

// ---------- UI wiring ----------
document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
);

const unitsBtn = $('#units');
const paintUnits = () => (unitsBtn.textContent = units.imperial ? '°F' : '°C');
paintUnits();
unitsBtn.addEventListener('click', () => units.set(units.imperial ? 'metric' : 'imperial'));
units.onChange(() => {
  paintUnits();
  if (mode === 'live') liveUi?.refreshUnits();
  else if (mode === 'climate') climateUi?.refreshUnits();
  else if (mode === 'atlas') atlasUi?.refreshUnits();
  if (marker) {
    const ll = marker.getLngLat();
    openAt(ll.lng, ll.lat);
  }
});

const globeBtn = $('#globe');
globeBtn.addEventListener('click', () => {
  const globe = map.getProjection()?.type !== 'globe';
  map.setProjection({ type: globe ? 'globe' : 'mercator' });
  globeBtn.setAttribute('aria-pressed', String(globe));
});

$('#panelToggle').addEventListener('click', () => els.panel.classList.toggle('open'));

// search
const searchInput = $<HTMLInputElement>('#search');
const results = $('#searchResults');
let sel = 0;
let matches: City[] = [];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function renderResults() {
  clear(results);
  matches.forEach((c, i) =>
    results.append(
      h('li', { role: 'option', 'aria-selected': String(i === sel), onmousedown: (e: Event) => (e.preventDefault(), choose(c)) }, c.name, h('small', {}, c.country)),
    ),
  );
}
function choose(c: City) {
  searchInput.value = c.name;
  matches = [];
  renderResults();
  searchInput.blur();
  map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 6.5), speed: 1.6 });
  openAt(c.lon, c.lat);
}
searchInput.addEventListener('input', () => {
  const q = norm(searchInput.value.trim());
  sel = 0;
  if (q.length < 2) matches = [];
  else {
    const starts = cities.filter((c) => norm(c.name).startsWith(q));
    const contains = cities.filter((c) => !norm(c.name).startsWith(q) && norm(`${c.name} ${c.country}`).includes(q));
    matches = [...starts, ...contains].slice(0, 8);
  }
  renderResults();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') sel = Math.min(sel + 1, matches.length - 1);
  else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
  else if (e.key === 'Enter' && matches[sel]) choose(matches[sel]);
  else if (e.key === 'Escape') matches = [];
  else return;
  e.preventDefault();
  renderResults();
});
searchInput.addEventListener('blur', () => setTimeout(() => ((matches = []), renderResults()), 150));
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === 'Escape') closeCard();
});

map.on('click', (e) => {
  // a tap on a city's label opens that city (its label and card then show the same forecast)
  const hit = map.getLayer('city-labels') ? map.queryRenderedFeatures(e.point, { layers: ['city-labels'] })[0] : undefined;
  const c = typeof hit?.properties?.i === 'number' ? cities[hit.properties.i] : undefined;
  if (c) openAt(c.lon, c.lat);
  else openAt(e.lngLat.lng, e.lngLat.lat);
});
// value labels are only computed for cities on screen: refresh them after each move
map.on('moveend', () => {
  if (mode === 'climate') climateUi?.updateCities();
  else if (mode === 'atlas') atlasUi?.updateCities();
  else if (mode === 'live') live?.updateCities();
});

// keep the visible map centred in the area not covered by the side panel
function applyPadding() {
  const wide = window.innerWidth > 760;
  map.setPadding({ left: wide ? 340 : 0, top: 0, right: 0, bottom: 0 });
}
applyPadding();
window.addEventListener('resize', applyPadding);

// ---------- boot ----------
map.on('load', async () => {
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  try {
    map.addLayer(field, WEATHER_BEFORE);
    map.addLayer(particles, 'boundary-state');
    cityLayer();
    setStatus('Loading terrain…');
    const [d, cs] = await Promise.all([loadDem(BASE), loadCities(BASE)]);
    cities = cs;
    dem = d;
    field.setDem(dem.w, dem.h, dem.q);
    new LocalDem(map, (d) => field.setLocalDem(d));
    live = new LiveController(map, field, dem, cities);
    live.particles = particles;
    live.onStatus = (msg, busy) => {
      if (mode === 'live') setStatus(msg, busy, !busy && !!msg);
    };
    liveUi = new LiveUI(live, els, dem, closeCard);
    climateUi = new ClimateUI(map, field, els, cities, dem, setStatus, closeCard, BASE);
    // "Right now" in the climate finder checks conditions against the live forecast
    climateUi.live = live;
    climateUi.liveReady = liveReady;
    climateUi.nowCard = (lon, lat, placeP) => liveUi.showCard(lon, lat, placeP ?? reverseGeocode(lon, lat, cities));
    atlasUi = new AtlasUI(map, field, els, climateUi, cities, dem, setStatus, BASE);
    // microclimates (fog coasts, inland heat, ...) for the finder and atlas when zoomed in
    micro = new Microclimate(BASE, map);
    micro.onUpdate = (m) => {
      field.setMicro(m, micro.scale);
      if (mode === 'climate') climateUi.updateCities();
      else if (mode === 'atlas') atlasUi.updateCities();
    };
    climateUi.micro = micro;
    atlasUi.micro = micro;
    const startLive = () =>
      live
        .init()
        .catch((e) => {
          console.warn(e);
          if (mode === 'live') setStatus(`Live data unavailable: ${(e as Error).message}`, false, true);
        })
        .finally(liveReadyResolve);
    // the climate finder is the home page; the live forecast warms up behind it
    const start = new URL(location.href).searchParams.get('mode');
    if (start === 'live') {
      startLive();
      await setMode('live');
    } else {
      await setMode(start === 'atlas' ? 'atlas' : 'climate');
      startLive();
    }
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${(e as Error).message}`, false, true);
  }
});

// expose for debugging / tests
(window as unknown as { __wa: unknown }).__wa = { map, field, get live() { return live; }, get climate() { return climateUi; }, get atlas() { return atlasUi; } };
