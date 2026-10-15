/**
 * Live mode: latest NOAA GFS run, rendered as a smooth field with a forecast
 * timeline (hourly steps cross-faded), city temperature labels and a
 * point-forecast card on click.
 */
import { labelFilter } from '../map/labels';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { findLatestCycle, type Cycle, type LiveVar } from './gfs';
import { HRRR_DOMAINS, type ConicGrid, type HrrrDomain } from './hrrr';
import { ObservedLayers, type ObsKind } from './observed';
import { WEATHER_BEFORE } from '../map/style';
import type { LiveRequest, LiveResponse } from './live.worker';
import type { FieldLayer, GridSpec } from '../map/fieldLayer';
import type { WindParticles } from '../map/windParticles';
import { AQI, CLOUD, HUMIDITY, PRECIP, SNOWFALL, SNOW_DEPTH, TEMPERATURE, UV_INDEX, WIND, type Palette } from '../map/palettes';
import { demAt, type City, type Dem } from '../data';
import { codeFromFields, isDaytime, type Hour, type PointForecast } from './pointForecast';
import { fmt, type Quantity } from '../units';

const HOUR = 3600_000;
const LAPSE = 0.0065; // K per m
/** GFS snow depth is shaped by terrain: e times deeper per this many metres above the model cell's mean elevation */
const SNOW_SCALE_HEIGHT = 700;

export interface LayerDef {
  id: LiveVar;
  label: string;
  icon: string;
  palette: Palette;
  alt?: Palette;
  q: Quantity;
  lapse: boolean;
  legend: number[]; // metric tick values
  legendImperial?: number[]; // tick values in imperial display units
  /** shown as a toggle under that layer's button instead of its own button */
  variantOf?: LiveVar;
  /** this layer's name in its variant toggle (default: its label) */
  toggleLabel?: string;
  /** observed imagery (radar, satellite) instead of a forecast field */
  observed?: ObsKind;
}

export const LIVE_LAYERS: LayerDef[] = [
  { id: 'temp', label: 'Temperature', toggleLabel: 'Actual', icon: '🌡', palette: TEMPERATURE, q: 'temp', lapse: true, legend: [-40, -20, 0, 20, 40], legendImperial: [-40, 0, 32, 60, 90] },
  { id: 'feels', label: 'Feels like', icon: '🌡', palette: TEMPERATURE, q: 'temp', lapse: true, legend: [-40, -20, 0, 20, 40], legendImperial: [-40, 0, 32, 60, 90], variantOf: 'temp' },
  { id: 'precip', label: 'Precipitation', toggleLabel: 'Forecast', icon: '☔', palette: PRECIP, alt: SNOWFALL, q: 'rate', lapse: false, legend: [0.1, 1, 5, 25], legendImperial: [0.01, 0.05, 0.2, 1] },
  { id: 'radar', label: 'Radar', icon: '☔', palette: PRECIP, alt: SNOWFALL, q: 'rate', lapse: false, legend: [0.1, 1, 5, 25], legendImperial: [0.01, 0.05, 0.2, 1], variantOf: 'precip', observed: 'radar' },
  { id: 'cloud', label: 'Clouds', toggleLabel: 'Forecast', icon: '☁', palette: CLOUD, q: 'percent', lapse: false, legend: [0, 50, 100] },
  { id: 'satellite', label: 'Satellite', icon: '☁', palette: CLOUD, q: 'percent', lapse: false, legend: [0, 50, 100], variantOf: 'cloud', observed: 'satellite' },
  { id: 'uv', label: 'UV index', icon: '🔆', palette: UV_INDEX, q: 'index', lapse: false, legend: [0, 3, 6, 8, 11] },
  { id: 'aqi', label: 'Air quality', icon: '🌫', palette: AQI, q: 'index', lapse: false, legend: [0, 50, 100, 150, 200, 300] },
  { id: 'snow', label: 'Snow depth', icon: '❄', palette: SNOW_DEPTH, q: 'snow', lapse: false, legend: [1, 10, 50, 200], legendImperial: [1, 4, 20, 80] },
  { id: 'wind', label: 'Wind', icon: '🌬', palette: WIND, q: 'speed', lapse: false, legend: [0, 20, 50, 100], legendImperial: [0, 10, 30, 60] },
  { id: 'humidity', label: 'Humidity', icon: '💧', palette: HUMIDITY, q: 'percent', lapse: false, legend: [0, 50, 100] },
];

export const GFS_GRID: GridSpec = { nx: 1440, ny: 721, lon0: 0, lat0: 90, dx: 0.25, dy: 0.25 };
const GRID = GFS_GRID;

type FieldData = { values: Float32Array; u?: Float32Array; v?: Float32Array };
/** absolute URL of data/ (workers resolve relative URLs against their own script) */
const DATA_BASE = new URL(`${import.meta.env.BASE_URL}data/`, location.href).href;

class LivePool {
  private workers: Worker[] = [];
  private next = 0;
  private seq = 0;
  private pending = new Map<number, (r: LiveResponse) => void>();
  constructor(n = 2) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./live.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<LiveResponse>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        cb?.(e.data);
      };
      this.workers.push(w);
    }
  }
  request(cycle: Cycle, fh: number, v: LiveVar, hrrr?: LiveRequest['hrrr']): Promise<LiveResponse> {
    const id = ++this.seq;
    const w = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
      w.postMessage({ id, cycle, fh, v, hrrr, dataBase: DATA_BASE } satisfies LiveRequest);
    });
  }
}

export class LiveController {
  cycle?: Cycle;
  layer: LayerDef = LIVE_LAYERS[0];
  /** current valid time (ms) shown on the map */
  time = Date.now();
  minTime = 0;
  maxTime = 0;
  private pool = new LivePool(2);
  private cache = new Map<string, Promise<FieldData>>();
  orog?: Float32Array;
  private shown = { a: '', b: '', alt: '' };
  private current: { a?: Float32Array; b?: Float32Array; mix: number } = { mix: 0 };
  private loadToken = 0;
  private hrrrCache = new Map<string, Promise<{ grid: ConicGrid; values: Float32Array } | null>>();
  /** HRRR field currently wanted per domain ('' = none) */
  private regKey = ['', ''];
  private cityTimer = 0;
  active = false;
  onStatus: (msg: string, busy: boolean) => void = () => {};
  onTimeRange: () => void = () => {};
  onFrame: () => void = () => {};
  /** called when a new layer's data replaces the old one on screen */
  onSwap: () => void = () => {};

  constructor(
    private map: MlMap,
    private field: FieldLayer,
    private dem: Dem,
    private cities: City[],
  ) {
    this.obs = new ObservedLayers(map, WEATHER_BEFORE);
  }

  async init() {
    this.onStatus('Finding the latest GFS model run…', true);
    this.cycle = await findLatestCycle(Date.now(), 72);
    const now = Date.now();
    this.minTime = Math.max(this.cycle.time, Math.floor(now / HOUR) * HOUR - 6 * HOUR);
    this.maxTime = Math.min(this.cycle.time + 120 * HOUR, Math.floor(now / HOUR) * HOUR + 72 * HOUR);
    this.time = now;
    this.onTimeRange();
    const orog = await this.get('orog', 0);
    this.orog = orog.values;
    this.field.setField('orog', GRID, orog.values);
  }

  private key(v: LiveVar, fh: number) {
    return `${this.cycle!.date}${this.cycle!.hour}:${v}:${fh}`;
  }

  get(v: LiveVar, fh: number): Promise<FieldData> {
    const k = this.key(v, fh);
    let p = this.cache.get(k);
    if (!p) {
      p = this.pool.request(this.cycle!, fh, v).then((r) => ({ values: r.values!, u: r.u, v: r.vv }));
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      // bound the cache (~4 MB per field, 12 MB for wind)
      const weight = (key: string) => (key.includes(':wind:') ? 3 : 1);
      let total = 0;
      for (const key of this.cache.keys()) total += weight(key);
      while (total > 60) {
        const oldest = this.cache.keys().next().value!;
        total -= weight(oldest);
        this.cache.delete(oldest);
      }
    }
    return p;
  }

  particles?: WindParticles;

  activate() {
    this.active = true;
    // force a fresh upload so the field fades in with the right palette
    this.shown = { a: '', b: '', alt: '' };
    if (this.layer.observed) this.showObserved();
    else this.show(this.time, true);
  }

  deactivate() {
    this.active = false;
    this.particles?.setEnabled(false);
    this.setGlaciers(false);
    this.obs.deactivate();
  }

  /** Radar / satellite imagery: the forecast field fades out and the frames take over. */
  obs: ObservedLayers;

  private async showObserved() {
    const kind = this.layer.observed!;
    this.loadToken++;
    this.particles?.setEnabled(false);
    this.setGlaciers(false);
    this.updateRegional();
    this.field.fadeTo(0, 160);
    this.onSwap();
    const slow = setTimeout(() => this.onStatus(`Loading ${this.layer.label.toLowerCase()}…`, true), 150);
    try {
      await this.obs.activate(kind);
      if (!this.active || this.layer.observed !== kind) return;
      this.onStatus('', false);
      this.onTimeRange();
    } catch (e) {
      this.onStatus(`Could not load ${this.layer.label.toLowerCase()}: ${(e as Error).message}`, false);
    } finally {
      clearTimeout(slow);
    }
  }

  private setGlaciers(on: boolean) {
    if (this.map.getLayer('glaciers')) this.map.setLayoutProperty('glaciers', 'visibility', on ? 'visible' : 'none');
  }

  applyPalette() {
    this.particles?.setEnabled(this.layer.id === 'wind');
    this.setGlaciers(this.layer.id === 'snow');
    this.field.mode = 0;
    this.field.setPalette(this.layer.palette, this.layer.alt);
    this.field.lapse = this.layer.lapse ? LAPSE : 0;
    this.field.snowH = this.layer.id === 'snow' ? SNOW_SCALE_HEIGHT : 0;
    this.field.useAlt = this.layer.alt ? 1 : 0;
    this.field.opacity = this.layer.id === 'cloud' ? 1 : this.layer.id === 'wind' ? 0.75 : 0.88;
  }

  /** Switch layer: the old layer stays on screen until the new data is ready, then cross-fades. */
  setLayer(id: LiveVar) {
    const was = this.layer;
    this.layer = LIVE_LAYERS.find((l) => l.id === id)!;
    this.shown = { a: '', b: '', alt: '' };
    if (this.layer.observed) return this.showObserved();
    if (was.observed) {
      this.obs.deactivate();
      this.onTimeRange();
    }
    this.show(this.time, true);
  }

  /** Display valid time t (ms); cross-fades between the two bracketing hours. */
  async show(t: number, swap = false) {
    if (!this.cycle || this.layer.observed) return;
    this.time = Math.min(this.maxTime, Math.max(this.minTime, t));
    const rel = (this.time - this.cycle.time) / HOUR;
    const fhA = Math.max(0, Math.floor(rel));
    const fhB = Math.min(fhA + 1, 120);
    const mix = Math.min(1, Math.max(0, rel - fhA));
    const v = this.layer.id;
    const token = ++this.loadToken;
    const ka = this.key(v, fhA), kb = this.key(v, fhB);
    if (this.shown.a !== ka || this.shown.b !== kb) {
      const slow = setTimeout(() => this.onStatus(`Loading ${this.layer.label.toLowerCase()}…`, true), 150);
      try {
        const [a, b] = await Promise.all([this.get(v, fhA), this.get(v, fhB)]);
        let alt: FieldData | undefined;
        if (this.layer.alt) alt = await this.get('csnow', mix < 0.5 ? fhA : fhB);
        if (token !== this.loadToken || !this.active) return;
        if (swap) {
          await this.field.fadeTo(0, 140);
          if (token !== this.loadToken || !this.active) return;
          this.applyPalette();
          this.onSwap();
        }
        this.field.setField('fieldA', GRID, a.values);
        this.field.setField('fieldB', GRID, b.values);
        if (this.particles && a.u && a.v && b.u && b.v) this.particles.setWind(GRID, { u: a.u, v: a.v }, { u: b.u, v: b.v });
        if (alt) this.field.setField('alt', GRID, alt.values);
        this.shown = { a: ka, b: kb, alt: '' };
        this.updateRegional();
        this.current.a = a.values;
        this.current.b = b.values;
        this.field.mix = mix;
        if (swap) this.field.fadeTo(1, 260);
        this.onStatus('', false);
      } catch (e) {
        if (token === this.loadToken) this.onStatus(`Could not load GFS data: ${(e as Error).message}`, false);
        return;
      } finally {
        clearTimeout(slow);
      }
      // prefetch the next hours for smooth playback
      for (let k = 2; k <= 3; k++) if (fhA + k <= 120) this.get(v, fhA + k).catch(() => {});
    }
    if (token !== this.loadToken && this.shown.a !== ka) return;
    this.current.mix = mix;
    this.field.mix = mix;
    if (this.particles) this.particles.mix = mix;
    this.updateRegional();
    this.field.repaint();
    this.scheduleCityUpdate();
    this.onFrame();
  }

  /**
   * Snow depth: NOAA HRRR (3 km) over the contiguous US and Alaska, for the
   * hour nearest the shown time. Other layers have no regional field.
   */
  private updateRegional() {
    const snow = this.layer.id === 'snow';
    const t = Math.round(this.time / HOUR) * HOUR;
    HRRR_DOMAINS.forEach(async (d, i) => {
      const slot = i as 0 | 1;
      const key = snow ? `${d}:${t}` : '';
      if (this.regKey[i] === key) return;
      this.regKey[i] = key;
      if (!snow) return this.field.setRegional(slot, null);
      const r = await this.hrrr(d, t).catch(() => null);
      if (this.regKey[i] !== key || !this.active) return;
      // keep the previous hour on screen if this one is missing, unless out of range
      if (r || t > Date.now() + 47 * HOUR) this.field.setRegional(slot, r);
    });
  }

  private hrrr(d: HrrrDomain, t: number) {
    const k = `${d}:${t}`;
    let p = this.hrrrCache.get(k);
    if (!p) {
      p = this.pool.request(this.cycle!, 0, 'snow', { domain: d, t }).then((r) => (r.values && r.grid ? { grid: r.grid, values: r.values } : null));
      p.catch(() => this.hrrrCache.delete(k));
      this.hrrrCache.set(k, p);
      while (this.hrrrCache.size > 8) this.hrrrCache.delete(this.hrrrCache.keys().next().value!);
    }
    return p;
  }

  /** Sample the displayed field at a point (with the same downscaling as the shader). */
  sample(lon: number, lat: number, a = this.current.a, b = this.current.b, mix = this.current.mix, lapse = this.layer.lapse, elev?: number): number {
    if (!a || !b) return NaN;
    const va = bilinear(a, lon, lat), vb = bilinear(b, lon, lat);
    let v = va + (vb - va) * mix;
    if (lapse && this.orog) v += LAPSE * (bilinear(this.orog, lon, lat) - (elev ?? demAt(this.dem, lon, lat)));
    return v;
  }

  /** US AQI at a point for a time, from the bias-corrected aerosol forecast (NaN if unavailable). */
  async aqiAt(lon: number, lat: number, t: number): Promise<number> {
    if (!this.cycle) return NaN;
    const fh = Math.max(0, Math.round((t - this.cycle.time) / (3 * HOUR)) * 3);
    const r = await this.get('aqi', fh);
    return bilinear(r.values, lon, lat);
  }

  /**
   * Fallback point forecast from the GFS fields (used when Open-Meteo is
   * unreachable): conditions at the shown hour, temperatures every 3 hours.
   */
  async gfsPoint(lon: number, lat: number, elev: number): Promise<PointForecast> {
    const rel = (this.time - this.cycle!.time) / HOUR;
    const fh = Math.max(0, Math.round(rel));
    const vars: LiveVar[] = ['temp', 'feels', 'precip', 'cloud', 'wind', 'humidity', 'csnow'];
    const res = await Promise.all(vars.map((v) => this.get(v, fh).catch(() => null)));
    const now: Partial<Record<LiveVar, number>> = {};
    vars.forEach((v, i) => {
      const r = res[i];
      if (r) now[v] = this.sample(lon, lat, r.values, r.values, 0, v === 'temp' || v === 'feels', elev);
    });
    const t0 = this.cycle!.time + fh * HOUR;
    const hours: Hour[] = [
      {
        t: t0,
        temp: now.temp ?? NaN,
        feels: now.feels,
        code: codeFromFields(now.cloud ?? 0, now.precip ?? 0, (now.csnow ?? 0) > 0.5),
        isDay: isDaytime(lon, lat, t0),
        precip: now.precip,
        cloud: now.cloud,
        humidity: now.humidity,
        wind: now.wind,
      },
    ];
    const later: number[] = [];
    for (let k = 3; k <= 24; k += 3) if (fh + k <= 120) later.push(fh + k);
    const tr = await Promise.all(later.map((f) => this.get('temp', f).catch(() => null)));
    tr.forEach((r, i) => {
      if (!r) return;
      const t = this.cycle!.time + later[i] * HOUR;
      hours.push({ t, temp: this.sample(lon, lat, r.values, r.values, 0, true, elev), code: -1, isDay: isDaytime(lon, lat, t) });
    });
    return { source: 'NOAA GFS', hours, daily: [] };
  }

  // ---------- city labels ----------
  private scheduleCityUpdate() {
    if (this.cityTimer) return;
    this.cityTimer = window.setTimeout(() => {
      this.cityTimer = 0;
      this.updateCities();
    }, 120);
  }

  updateCities() {
    if (!this.active) return;
    const src = this.map.getSource('cities') as GeoJSONSource | undefined;
    if (!src) return;
    const show = this.layer.id === 'temp' || this.layer.id === 'feels';
    const visible = labelFilter(this.map);
    const features = this.cities.map((c, i) => {
      const v = show && visible(c) ? this.sample(c.lon, c.lat, undefined, undefined, undefined, undefined, c.elev ?? undefined) : NaN;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
        properties: { i, name: c.name, label: Number.isFinite(v) ? fmt('temp', v) : '', rank: c.rank, minzoom: c.minzoom },
      };
    });
    src.setData({ type: 'FeatureCollection', features });
  }

  /**
   * The map's temperature and feels-like at a point and time, computed exactly
   * like its labels (a city's own elevation when the point is that city). The
   * location card starts its temperatures from these, so the two agree.
   */
  async pointNow(lon: number, lat: number, t: number): Promise<{ temp: number; feels: number } | null> {
    if (!this.cycle) return null;
    const rel = (Math.min(this.maxTime, Math.max(this.minTime, t)) - this.cycle.time) / HOUR;
    const fhA = Math.max(0, Math.floor(rel)), fhB = Math.min(fhA + 1, 120);
    const mix = Math.min(1, Math.max(0, rel - fhA));
    const [ta, tb, fa, fb] = await Promise.all([this.get('temp', fhA), this.get('temp', fhB), this.get('feels', fhA), this.get('feels', fhB)]);
    const elev = this.cities.find((c) => c.lon === lon && c.lat === lat)?.elev ?? undefined;
    const temp = this.sample(lon, lat, ta.values, tb.values, mix, true, elev);
    const feels = this.sample(lon, lat, fa.values, fb.values, mix, true, elev);
    return Number.isFinite(temp) && Number.isFinite(feels) ? { temp, feels } : null;
  }
}

/** Bilinear sample of a GFS 0.25° grid (lon 0..360, lat 90..-90). */
export function bilinear(f: Float32Array, lon: number, lat: number): number {
  const nx = GRID.nx, ny = GRID.ny;
  const x = ((((lon - GRID.lon0) / GRID.dx) % nx) + nx) % nx;
  const y = Math.min(ny - 1, Math.max(0, (GRID.lat0 - lat) / GRID.dy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % nx, y1 = Math.min(ny - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return (
    f[y0 * nx + x0] * (1 - fx) * (1 - fy) +
    f[y0 * nx + x1] * fx * (1 - fy) +
    f[y1 * nx + x0] * (1 - fx) * fy +
    f[y1 * nx + x1] * fx * fy
  );
}
