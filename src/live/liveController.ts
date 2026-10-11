/**
 * Live mode: latest NOAA GFS run, rendered as a smooth field with a forecast
 * timeline (hourly steps cross-faded), city temperature labels and a
 * point-forecast card on click.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { findLatestCycle, type Cycle, type LiveVar } from './gfs';
import type { LiveRequest, LiveResponse } from './live.worker';
import type { FieldLayer, GridSpec } from '../map/fieldLayer';
import type { WindParticles } from '../map/windParticles';
import { CLOUD, HUMIDITY, PRECIP, SNOWFALL, SNOW_DEPTH, TEMPERATURE, WIND, type Palette } from '../map/palettes';
import { demAt, type City, type Dem } from '../data';
import { pointElevation } from '../map/localDem';
import { fmt, type Quantity } from '../units';

const HOUR = 3600_000;
const LAPSE = 0.0065; // K per m

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
}

export const LIVE_LAYERS: LayerDef[] = [
  { id: 'temp', label: 'Temperature', icon: '🌡', palette: TEMPERATURE, q: 'temp', lapse: true, legend: [-40, -20, 0, 20, 40], legendImperial: [-40, 0, 32, 60, 90, 115] },
  { id: 'feels', label: 'Feels like', icon: '🧍', palette: TEMPERATURE, q: 'temp', lapse: true, legend: [-40, -20, 0, 20, 40], legendImperial: [-40, 0, 32, 60, 90, 115] },
  { id: 'precip', label: 'Precipitation', icon: '☔', palette: PRECIP, alt: SNOWFALL, q: 'rate', lapse: false, legend: [0.1, 1, 5, 25], legendImperial: [0.01, 0.05, 0.2, 1] },
  { id: 'cloud', label: 'Clouds', icon: '☁', palette: CLOUD, q: 'percent', lapse: false, legend: [0, 50, 100] },
  { id: 'wind', label: 'Wind', icon: '🌬', palette: WIND, q: 'speed', lapse: false, legend: [0, 20, 50, 100], legendImperial: [0, 10, 30, 60] },
  { id: 'humidity', label: 'Humidity', icon: '💧', palette: HUMIDITY, q: 'percent', lapse: false, legend: [0, 50, 100] },
  { id: 'snow', label: 'Snow depth', icon: '❄', palette: SNOW_DEPTH, q: 'snow', lapse: false, legend: [1, 10, 50, 200], legendImperial: [1, 4, 20, 80] },
];

const GRID: GridSpec = { nx: 1440, ny: 721, lon0: 0, lat0: 90, dx: 0.25, dy: 0.25 };

type FieldData = { values: Float32Array; u?: Float32Array; v?: Float32Array };

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
  request(cycle: Cycle, fh: number, v: LiveVar): Promise<LiveResponse> {
    const id = ++this.seq;
    const w = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
      w.postMessage({ id, cycle, fh, v } satisfies LiveRequest);
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
  private orog?: Float32Array;
  private shown = { a: '', b: '', alt: '' };
  private current: { a?: Float32Array; b?: Float32Array; mix: number } = { mix: 0 };
  private loadToken = 0;
  private cityTimer = 0;
  active = false;
  onStatus: (msg: string, busy: boolean) => void = () => {};
  onTimeRange: () => void = () => {};
  onFrame: () => void = () => {};

  constructor(
    private map: MlMap,
    private field: FieldLayer,
    private dem: Dem,
    private cities: City[],
  ) {}

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
    this.field.mode = 0;
    this.applyPalette();
    this.show(this.time);
  }

  deactivate() {
    this.active = false;
    this.particles?.setEnabled(false);
  }

  applyPalette() {
    this.particles?.setEnabled(this.layer.id === 'wind');
    this.field.setPalette(this.layer.palette, this.layer.alt);
    this.field.lapse = this.layer.lapse ? LAPSE : 0;
    this.field.useAlt = this.layer.alt ? 1 : 0;
    this.field.opacity = this.layer.id === 'cloud' ? 1 : this.layer.id === 'wind' ? 0.72 : 0.92;
  }

  setLayer(id: LiveVar) {
    this.layer = LIVE_LAYERS.find((l) => l.id === id)!;
    this.shown = { a: '', b: '', alt: '' };
    this.applyPalette();
    this.show(this.time);
  }

  /** Display valid time t (ms); cross-fades between the two bracketing hours. */
  async show(t: number) {
    if (!this.cycle) return;
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
        this.field.setField('fieldA', GRID, a.values);
        this.field.setField('fieldB', GRID, b.values);
        if (this.particles && a.u && a.v && b.u && b.v) this.particles.setWind(GRID, { u: a.u, v: a.v }, { u: b.u, v: b.v });
        if (alt) this.field.setField('alt', GRID, alt.values);
        this.shown = { a: ka, b: kb, alt: '' };
        this.current.a = a.values;
        this.current.b = b.values;
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
    this.field.repaint();
    this.scheduleCityUpdate();
    this.onFrame();
  }

  /** Sample the displayed field at a point (with the same downscaling as the shader). */
  sample(lon: number, lat: number, a = this.current.a, b = this.current.b, mix = this.current.mix, lapse = this.layer.lapse, elev?: number): number {
    if (!a || !b) return NaN;
    const va = bilinear(a, lon, lat), vb = bilinear(b, lon, lat);
    let v = va + (vb - va) * mix;
    if (lapse && this.orog) v += LAPSE * (bilinear(this.orog, lon, lat) - (elev ?? demAt(this.dem, lon, lat)));
    return v;
  }

  /** Values of several variables at a point for the point-forecast card. */
  async pointForecast(lon: number, lat: number) {
    const rel = (this.time - this.cycle!.time) / HOUR;
    const fh = Math.max(0, Math.round(rel));
    const vars: LiveVar[] = ['temp', 'feels', 'precip', 'cloud', 'wind', 'humidity', 'csnow'];
    const [res, pe] = await Promise.all([Promise.all(vars.map((v) => this.get(v, fh).catch(() => null))), pointElevation(lon, lat)]);
    const elev = pe ?? demAt(this.dem, lon, lat);
    const out: Partial<Record<LiveVar, number>> = {};
    vars.forEach((v, i) => {
      const r = res[i];
      if (!r) return;
      out[v] = this.sample(lon, lat, r.values, r.values, 0, v === 'temp' || v === 'feels', elev);
    });
    // 24 h temperature trend for a sparkline
    const trend: { t: number; v: number }[] = [];
    const hours = [] as number[];
    for (let k = 0; k <= 24; k += 3) if (fh + k <= 120) hours.push(fh + k);
    const tr = await Promise.all(hours.map((f) => this.get('temp', f).catch(() => null)));
    tr.forEach((r, i) => {
      if (r) trend.push({ t: this.cycle!.time + hours[i] * HOUR, v: this.sample(lon, lat, r.values, r.values, 0, true, elev) });
    });
    return { values: out, trend, time: this.cycle!.time + fh * HOUR, elev };
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
    const features = this.cities.map((c) => {
      const v = show ? this.sample(c.lon, c.lat, undefined, undefined, undefined, undefined, c.elev ?? undefined) : NaN;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
        properties: { name: c.name, label: Number.isFinite(v) ? fmt('temp', v) : '', rank: c.rank, minzoom: c.minzoom },
      };
    });
    src.setData({ type: 'FeatureCollection', features });
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
