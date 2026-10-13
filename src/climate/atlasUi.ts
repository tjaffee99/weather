/**
 * Climate atlas: the map coloured by a climate normal (average temperature,
 * yearly sunshine, rainfall, snowfall, ...) for the whole year, one month or
 * any day, with a slider to scrub through the year. Normals come from the same
 * 2001-2025 ERA5 sample as the finder, stored as smooth yearly curves
 * (atlasData.ts). Cells are blended exactly as in the finder (blend.ts),
 * temperatures are adjusted to each pixel's elevation, and rain and snow use
 * the finder's per-elevation factors. Sea temperature is drawn on the sea.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FieldLayer } from '../map/fieldLayer';
import { AQI, CLOUD, HUMIDITY, TEMPERATURE, UV_INDEX, WIND, cssGradient, type Palette } from '../map/palettes';
import { WATER } from '../map/style';
import { demAt, fetchBinary, type City, type Dem } from '../data';
import type { Place } from '../geocode';
import { pointElevation } from '../map/localDem';
import { h, clear } from '../ui/dom';
import { renderLegend } from '../ui/legend';
import { MONTHS, coordLabel, doyLabel } from '../ui/format';
import { fmt, fromDisplay, units } from '../units';
import { blendTaps, levelOf } from './blend';
import { hideTip, monthTable } from './card';
import type { ClimateUI } from './climateUi';
import { DAYS_IN_MONTH, MONTH_START, decodeAtlas, evalAt, evalField, periodDays, periodWeights, type AtlasField, type Period, type PeriodKind } from './atlasData';
import { DZ0, DZ_STEP, LAPSE, LEVELS, type DetailResult, type MonthStats } from './types';

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** sums are designed per month; a day is about 1/30 of one, a year 12 */
const PER_DAY = 1 / 30.44;

interface AtlasVar {
  id: string;
  label: string;
  group: string;
  hint: string;
  /** shifted with elevation like the finder's temperatures */
  temp?: boolean;
  /** added up over the period (hours, mm, days); otherwise averaged */
  sum?: boolean;
  /** days on which something happens: a single day shows its chance */
  count?: boolean;
  /** range of a daily value */
  clip: [number, number];
  /** colours for a month (sums) or any period (averages) */
  palette: Palette;
  /** a year's palette relative to a month's (sums; default 12) */
  yearScale?: number;
  ticks: Partial<Record<PeriodKind, number[]>> & { month: number[] };
  /** imperial ticks in display units, and their conversion to metric */
  ticksImperial?: Partial<Record<PeriodKind, number[]>> & { month: number[] };
  fromImperial?: (t: number) => number;
  /** a value for a period kind (sums: the total; counts on a day: the chance 0-1) */
  fmt: (v: number, k: PeriodKind, unit?: boolean) => string;
  unit: (k: PeriodKind) => string;
}

/** Scale a palette's stops. */
const scaled = (p: Palette, k: number): Palette => ({ ...p, stops: p.stops.map(([v, c, a]) => [v * k, c, a] as [number, string, number?]) });

const SUN_M: Palette = { stops: [[0, '#dfe5ee'], [80, '#f3ebc4'], [160, '#f7d873'], [240, '#f5b324'], [320, '#ec8a12'], [400, '#c95f0b']] };
const PRECIP_M: Palette = {
  transform: 'log',
  stops: [[3, '#efe2c2'], [12, '#e3e5bd'], [30, '#bfe0b1'], [60, '#86ccb0'], [110, '#49aec6'], [200, '#2f78c4'], [380, '#3a3aa8'], [700, '#5a1f8f']],
};
const DAYS_BLUE: Palette = { stops: [[0, '#efe2c2'], [4, '#d7e3bb'], [8, '#9fd2b2'], [13, '#4fb3c6'], [19, '#2f6fc0'], [26, '#3a2a90']] };
const SNOWFALL_M: Palette = {
  transform: 'log',
  stops: [[0.3, '#eef2ff', 0], [1, '#e2e9ff', 0.55], [5, '#c2d2ff', 0.8], [15, '#97adfb', 0.92], [40, '#7a7ff0', 1], [90, '#8c5ad8', 1], [200, '#4b2390', 1]],
};
const SNOWDAYS_M: Palette = { stops: [[0, '#eef2ff', 0], [1, '#dfe7ff', 0.6], [8, '#b4c8ff', 0.9], [16, '#8ea6fb', 1], [24, '#7a6fe0', 1], [31, '#4b2390', 1]] };
const DEW: Palette = { stops: [[-20, '#e7dcc4'], [0, '#dfe5bf'], [10, '#a8d8a4'], [16, '#4fb3a6'], [20, '#2f7fa8'], [24, '#3a3a96']] };
const GOOD_AIR_M: Palette = { stops: [[0, '#c45a3c'], [8, '#efb04a'], [16, '#e6dd7a'], [24, '#8fcf7a'], [31, '#2e9e4a']] };
const BAD_AIR_M: Palette = { stops: [[0, '#e3eedc'], [2, '#eee6a6'], [6, '#f2c06a'], [12, '#e8834a'], [20, '#c9483c'], [31, '#7e1f5a']] };
const AQI_SOLID: Palette = { stops: AQI.stops.map(([v, c]) => [v, c] as [number, string]) };

const tempUnit = () => (units.imperial ? '°F' : '°C');
const tempFmt = (v: number, _k?: PeriodKind, unit = true) => `${fmt('temp', v)}${unit ? (units.imperial ? 'F' : 'C') : ''}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const daysFmt = (v: number, k: PeriodKind, unit = true) => (k === 'day' ? pct(v) : `${Math.round(v)}${unit ? ' days' : ''}`);
const daysUnit = (k: PeriodKind) => (k === 'day' ? 'chance' : k === 'month' ? 'days' : 'days a year');
const COUNT_TICKS = { day: [0, 0.25, 0.5, 0.75], month: [0, 10, 20, 31], year: [0, 100, 200, 365] };
const amount = (v: number, k: PeriodKind, metricUnit: string, imperialUnit: string, perInch: number, unit: boolean) => {
  const x = units.imperial ? v / perInch : v;
  const digits = x < 0.995 ? 2 : x < 9.95 && k !== 'year' ? 1 : 0;
  return `${digits ? x.toFixed(digits) : Math.round(x).toLocaleString()}${unit ? ` ${units.imperial ? imperialUnit : metricUnit}` : ''}`;
};
const per = (k: PeriodKind, u: string) => (k === 'day' ? `${u} a day` : k === 'year' ? `${u} a year` : u);
const tempVar = (id: string, label: string, hint: string): AtlasVar => ({
  id, label, group: 'Temperature', hint, temp: true, clip: [-Infinity, Infinity],
  palette: TEMPERATURE,
  ticks: { month: [-20, 0, 10, 20, 30] },
  ticksImperial: { month: [0, 32, 50, 70, 90] },
  fromImperial: (t) => fromDisplay('temp', t),
  fmt: tempFmt,
  unit: tempUnit,
});

export const ATLAS_VARS: AtlasVar[] = [
  tempVar('tmean', 'Average temperature', 'Midway between the day’s high and low'),
  tempVar('tmax', 'Daytime high', 'Average afternoon high'),
  tempVar('tmin', 'Overnight low', 'Average coldest part of the night'),
  tempVar('feels', 'Feels-like high', 'Afternoon feels-like, with humidity and wind'),
  {
    id: 'sun', label: 'Sunshine', group: 'Sun & sky', hint: 'Hours of direct sun', sum: true, clip: [0, 24],
    palette: SUN_M, ticks: { day: [0, 4, 8, 12], month: [0, 100, 200, 300, 400], year: [0, 1000, 2000, 3000, 4000] },
    fmt: (v, k, u = true) => (k === 'day' ? `${v.toFixed(1)}${u ? ' h' : ''}` : `${Math.round(v).toLocaleString()}${u ? ' h' : ''}`),
    unit: (k) => per(k, 'hours'),
  },
  {
    id: 'uv', label: 'UV index', group: 'Sun & sky', hint: 'Average daily peak', clip: [0, 20],
    palette: UV_INDEX, ticks: { month: [0, 3, 6, 8, 11] },
    fmt: (v) => v.toFixed(v < 9.95 ? 1 : 0), unit: () => 'daily peak',
  },
  {
    id: 'cloud', label: 'Cloud cover', group: 'Sun & sky', hint: 'Daytime average (counts thin high cloud too)', clip: [0, 100],
    palette: CLOUD, ticks: { month: [0, 25, 50, 75, 100] },
    fmt: (v, _k, u = true) => `${Math.round(v)}${u ? '%' : ''}`, unit: () => '%',
  },
  {
    id: 'precip', label: 'Precipitation', group: 'Rain & snow', hint: 'Rain plus melted snow', sum: true, clip: [0, Infinity],
    palette: PRECIP_M,
    ticks: { day: [0.5, 1, 2, 5, 10, 20], month: [10, 50, 100, 200, 400], year: [100, 500, 1000, 2000, 4000] },
    ticksImperial: { day: [0.02, 0.05, 0.1, 0.2, 0.5], month: [0.5, 2, 4, 8, 16], year: [5, 20, 40, 80, 160] },
    fromImperial: (t) => t * 25.4,
    fmt: (v, k, u = true) => amount(v, k, 'mm', 'in', 25.4, u),
    unit: (k) => per(k, units.imperial ? 'in' : 'mm'),
  },
  {
    id: 'wetdays', label: 'Wet days', group: 'Rain & snow', hint: 'Days with 1 mm (0.04 in) or more', sum: true, count: true, clip: [0, 1],
    palette: DAYS_BLUE, ticks: { day: [0, 0.2, 0.4, 0.6, 0.8], month: [0, 5, 10, 15, 20, 25], year: [0, 50, 100, 150, 200, 250, 300] },
    fmt: daysFmt, unit: daysUnit,
  },
  {
    id: 'snowfall', label: 'Snowfall', group: 'Rain & snow', hint: 'Fresh snow (10 cm of snow per cm of water)', sum: true, clip: [0, Infinity],
    palette: SNOWFALL_M, yearScale: 5,
    ticks: { day: [0.1, 0.3, 1, 3], month: [1, 10, 30, 100], year: [5, 50, 150, 500] },
    ticksImperial: { day: [0.05, 0.1, 0.5, 1], month: [0.5, 4, 12, 40], year: [2, 20, 60, 200] },
    fromImperial: (t) => t * 2.54,
    fmt: (v, k, u = true) => amount(v, k, 'cm', 'in', 2.54, u),
    unit: (k) => per(k, units.imperial ? 'in' : 'cm'),
  },
  {
    id: 'snowdays', label: 'Snow on the ground', group: 'Rain & snow', hint: 'Days with at least 1 cm of snow cover', sum: true, count: true, clip: [0, 1],
    palette: SNOWDAYS_M, ticks: COUNT_TICKS, fmt: daysFmt, unit: daysUnit,
  },
  {
    id: 'dew', label: 'Dew point', group: 'Air', hint: 'Daytime: under 10° dry, 16° sticky, 20°+ muggy', clip: [-Infinity, Infinity],
    palette: DEW, ticks: { month: [-10, 0, 10, 16, 20] }, ticksImperial: { month: [15, 32, 50, 61, 68] }, fromImperial: (t) => fromDisplay('temp', t),
    fmt: tempFmt, unit: tempUnit,
  },
  {
    id: 'rh', label: 'Relative humidity', group: 'Air', hint: 'Daytime average', clip: [0, 100],
    palette: HUMIDITY, ticks: { month: [20, 40, 60, 80, 100] },
    fmt: (v, _k, u = true) => `${Math.round(v)}${u ? '%' : ''}`, unit: () => '%',
  },
  {
    id: 'wind', label: 'Wind', group: 'Air', hint: 'Average strongest daytime wind', clip: [0, Infinity],
    palette: WIND, ticks: { month: [5, 15, 25, 35] }, ticksImperial: { month: [5, 10, 15, 20] }, fromImperial: (t) => fromDisplay('speed', t),
    fmt: (v, _k, u = true) => fmt('speed', v, u), unit: () => (units.imperial ? 'mph' : 'km/h'),
  },
  {
    id: 'aqi', label: 'Air quality', group: 'Air', hint: 'Average US AQI from PM2.5 (estimate, 2021–2025)', clip: [0, 500],
    palette: AQI_SOLID, ticks: { month: [0, 50, 100, 150, 200] },
    fmt: (v) => String(Math.round(v)), unit: () => 'US AQI',
  },
  {
    id: 'goodair', label: 'Good-air days', group: 'Air', hint: 'Days with AQI 50 or less (PM2.5 ≤ 9 µg/m³, the strict 2024 US standard)', sum: true, count: true, clip: [0, 1],
    palette: GOOD_AIR_M, ticks: COUNT_TICKS, fmt: daysFmt, unit: daysUnit,
  },
  {
    id: 'badair', label: 'Unhealthy-air days', group: 'Air', hint: 'Days with AQI over 100: unhealthy for sensitive groups or worse', sum: true, count: true, clip: [0, 1],
    palette: BAD_AIR_M, ticks: COUNT_TICKS, fmt: daysFmt, unit: daysUnit,
  },
  {
    id: 'sst', label: 'Sea temperature', group: 'Sea', hint: 'Sea surface temperature', clip: [-2, 40],
    palette: TEMPERATURE, ticks: { month: [0, 10, 20, 25, 30] }, ticksImperial: { month: [32, 50, 68, 77, 86] }, fromImperial: (t) => fromDisplay('temp', t),
    fmt: tempFmt, unit: tempUnit,
  },
];

const SHIFTS = Array.from({ length: LEVELS }, (_, k) => -LAPSE * (DZ0 + k * DZ_STEP));
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
const monthOfDay = (d: number) => MONTH_START.findIndex((s, i) => d >= s && d < MONTH_START[i + 1]);

function parsePeriod(s: string | null): Period {
  if (s && /^\d+$/.test(s) && +s < 12) return { kind: 'month', m: +s, d: MONTH_START[+s] + 14 }; // older links: a month number
  const m = /^([md])(\d+)$/.exec(s ?? '');
  if (m && m[1] === 'm' && +m[2] < 12) return { kind: 'month', m: +m[2], d: MONTH_START[+m[2]] + 14 };
  if (m && m[1] === 'd' && +m[2] < 365) return { kind: 'day', m: monthOfDay(+m[2]), d: +m[2] };
  return { kind: 'year', m: 0, d: 0 };
}

export class AtlasUI {
  private varId = 'tmean';
  private period: Period = { kind: 'year', m: 0, d: 0 };
  private active = false;
  private cache = new Map<string, Promise<AtlasField>>();
  private cellPos?: Int32Array; // raster index of each land cell
  private rasterIndex?: Int32Array;
  private current?: { def: AtlasVar; f: AtlasField; w: Float64Array; days: number };
  private palKind: PeriodKind | null = null;
  private playTimer = 0;
  private cardAt: [number, number] | null = null;
  private token = 0;
  private sea = false;
  private seaTex?: Float32Array;
  private dayInput?: HTMLInputElement;
  private label?: HTMLElement;
  private seg?: HTMLElement;
  private labelTimer = 0;

  constructor(
    private map: MlMap,
    private field: FieldLayer,
    private els: { panel: HTMLElement; bottom: HTMLElement; legend: HTMLElement; card: HTMLElement },
    private climate: ClimateUI,
    private cities: City[],
    private dem: Dem,
    private setStatus: (msg: string, busy?: boolean, error?: boolean) => void,
    private base: string,
  ) {
    const u = new URL(location.href);
    const a = u.searchParams.get('a');
    if (a && ATLAS_VARS.some((v) => v.id === a)) this.varId = a;
    this.period = parsePeriod(u.searchParams.get('p'));
  }

  private get def() {
    return ATLAS_VARS.find((v) => v.id === this.varId)!;
  }

  async enter() {
    this.active = true;
    this.field.fade = 0;
    this.field.mode = 1;
    this.field.climateSqrt = false;
    this.field.cut = 0;
    this.field.lapse = 0;
    this.field.useAlt = 0;
    this.field.opacity = 1;
    this.current = undefined;
    this.renderPanel();
    this.renderBottom();
    try {
      await this.climate.ready;
    } catch (e) {
      this.setStatus(`Climate data unavailable: ${(e as Error).message}`, false, true);
      return;
    }
    if (!this.active) return;
    this.renderPanel();
    await this.show();
  }

  exit() {
    this.active = false;
    this.stopPlay();
    this.cardAt = null;
    this.setSea(false);
    this.field.climateSqrt = true;
    const u = new URL(location.href);
    u.searchParams.delete('a');
    u.searchParams.delete('p');
    history.replaceState(null, '', u);
  }

  refreshUnits() {
    this.renderPanel();
    this.renderLegend();
    this.updateCities();
    if (this.cardAt) this.showCard(...this.cardAt);
  }

  private writeUrl() {
    const u = new URL(location.href);
    u.searchParams.set('a', this.varId);
    const p = this.period;
    if (p.kind === 'year') u.searchParams.delete('p');
    else u.searchParams.set('p', p.kind === 'month' ? `m${p.m}` : `d${p.d}`);
    history.replaceState(null, '', u);
  }

  /** A variable's curves: land cells, or the sea grid for sea temperature. */
  private load(id: string): Promise<AtlasField> {
    let p = this.cache.get(id);
    if (!p) {
      const meta = this.climate.meta!;
      const m = meta.atlas?.[id];
      if (!m || m.levels === undefined) return Promise.reject(new Error(`no atlas data for ${id}`));
      const n = m.grid === 'sea' ? meta.grid.nx * meta.grid.ny : this.cells().length;
      p = fetchBinary(`${this.base}data/climate/${m.file}`).then((b) => decodeAtlas(b, m, meta.atlasHarmonics ?? 4, n));
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return p;
  }

  private cells(): Int32Array {
    if (!this.cellPos) {
      const et = this.climate.cellElevTex!;
      const pos: number[] = [];
      for (let p = 0; p < et.length / 2; p++) if (et[p * 2 + 1]) pos.push(p);
      this.cellPos = Int32Array.from(pos);
    }
    return this.cellPos;
  }

  private rasterToCell(): Int32Array {
    if (!this.rasterIndex) {
      const g = this.climate.meta!.grid;
      this.rasterIndex = new Int32Array(g.nx * g.ny).fill(-1);
      this.cells().forEach((p, k) => (this.rasterIndex![p] = k));
    }
    return this.rasterIndex;
  }

  /** Sea temperature is drawn over the sea: its own grid of cells, masked to the water. */
  private setSea(on: boolean, f?: AtlasField) {
    const g = this.climate.meta?.grid;
    if (!g) return;
    const spec = { ...g, levels: LEVELS, dz0: DZ0, dzStep: DZ_STEP };
    if (on && f?.flags) {
      if (!this.seaTex) {
        this.seaTex = new Float32Array(g.nx * g.ny * 2);
        for (let p = 0; p < g.nx * g.ny; p++) this.seaTex[p * 2 + 1] = f.flags[p] ? 1 : 0;
      }
      if (!this.sea) this.field.setClimateGrid(spec, this.seaTex);
      this.field.waterOnly = hex(WATER);
      // opaque water is drawn before the weather layer, which then paints only over it
      if (this.map.getLayer('water')) this.map.setPaintProperty('water', 'fill-opacity', 1);
    } else if (this.sea) {
      this.field.setClimateGrid(spec, this.climate.cellElevTex!);
      this.field.waterOnly = null;
      if (this.map.getLayer('water') && this.active) this.map.setPaintProperty('water', 'fill-opacity', 0.995);
    }
    this.sea = on && !!f?.flags;
  }

  private async show() {
    const token = ++this.token;
    const def = this.def;
    const slow = setTimeout(() => this.setStatus(`Loading ${def.label.toLowerCase()}…`), 200);
    let f: AtlasField;
    try {
      f = await this.load(def.id);
    } catch (e) {
      clearTimeout(slow);
      this.setStatus(`Could not load: ${(e as Error).message}`, false, true);
      return;
    }
    clearTimeout(slow);
    this.setStatus('');
    if (!this.active || token !== this.token) return;
    this.draw(def, f);
    if (this.field.fade < 1) this.field.fadeTo(1, 260);
    this.writeUrl();
  }

  /** Evaluate the period and upload it (fast enough to run while scrubbing; `quick` defers the labels). */
  private draw(def: AtlasVar, f: AtlasField, quick = false) {
    const g = this.climate.meta!.grid;
    const plane = g.nx * g.ny;
    const w = periodWeights(this.period, f.nc);
    const days = def.sum ? periodDays(this.period) : 1;
    const vals = evalField(f, w, def.clip[0], def.clip[1]);
    const out = new Float32Array(LEVELS * plane * 2);
    if (f.flags) {
      for (let p = 0; p < plane; p++) {
        const v = vals[p];
        if (!f.flags[p] || Number.isNaN(v)) continue;
        for (let l = 0; l < LEVELS; l++) {
          out[(l * plane + p) * 2] = v;
          out[(l * plane + p) * 2 + 1] = 1;
        }
      }
    } else {
      const pos = this.cells();
      const n = pos.length;
      for (let k = 0; k < n; k++) {
        for (let l = 0; l < LEVELS; l++) {
          const v = f.levels > 1 ? vals[l * n + k] : vals[k] + (def.temp ? SHIFTS[l] : 0);
          if (Number.isNaN(v)) continue;
          const o = (l * plane + pos[k]) * 2;
          out[o] = v * days;
          out[o + 1] = 1;
        }
      }
    }
    this.setSea(!!f.flags, f);
    const changed = this.current?.def !== def || this.palKind !== this.period.kind;
    this.current = { def, f, w, days };
    this.palKind = this.period.kind;
    this.field.mode = 1;
    this.field.climateSqrt = false;
    if (changed) {
      this.field.setPalette(this.palette());
      this.renderLegend();
    }
    this.field.setClimateResult(out);
    // labels are the slow part while scrubbing
    clearTimeout(this.labelTimer);
    if (quick || this.playTimer) this.labelTimer = window.setTimeout(() => this.updateCities(), 80);
    else this.updateCities();
  }

  private palette(): Palette {
    const d = this.def, k = this.period.kind;
    if (!d.sum || k === 'month') return d.palette;
    return scaled(d.palette, k === 'day' ? PER_DAY : (d.yearScale ?? 12));
  }

  /** A variable's period value at a point, blended like the map (NaN where there is none). */
  private sample(def: AtlasVar, f: AtlasField, w: Float64Array, lon: number, lat: number, elev: number, days: number): number {
    const g = this.climate.meta!.grid;
    if (f.flags) {
      const { taps, cover } = blendTaps(g, (p) => (f.flags![p] ? 0 : undefined), lon, lat, 0);
      if (cover < 0.04) return NaN;
      let s = 0, ws = 0;
      for (const t of taps) {
        const v = evalAt(f, w, 0, t.p, def.clip[0], def.clip[1]);
        if (Number.isNaN(v)) continue;
        s += t.q * v;
        ws += t.q;
      }
      return ws > 0 ? s / ws : NaN;
    }
    const et = this.climate.cellElevTex!;
    const index = this.rasterToCell();
    const { taps, cover } = blendTaps(g, (p) => (et[p * 2 + 1] ? et[p * 2] : undefined), lon, lat, elev);
    if (cover < 0.04) return NaN;
    let s = 0, ws = 0;
    for (const t of taps) {
      const k = index[t.p];
      let v: number;
      if (f.levels > 1) {
        const lvl = levelOf(t.dz), l0 = Math.floor(lvl), l1 = Math.min(LEVELS - 1, l0 + 1), fr = lvl - l0;
        v = (1 - fr) * evalAt(f, w, l0, k, def.clip[0], def.clip[1]) + fr * evalAt(f, w, l1, k, def.clip[0], def.clip[1]);
      } else v = evalAt(f, w, 0, k, def.clip[0], def.clip[1]) + (def.temp ? -LAPSE * t.dz : 0);
      if (Number.isNaN(v)) continue;
      s += t.q * v;
      ws += t.q;
    }
    return ws > 0 ? (s / ws) * days : NaN;
  }

  /** Is there sea right by this point (within ~30 km, for sea-temperature labels and cards)? */
  private nearSea(f: AtlasField, lon: number, lat: number): boolean {
    // the elevation model is 0 over the sea
    const d = this.dem;
    const cx = Math.floor(((lon + 180) / 360) * d.w), cy = Math.floor(((90 - lat) / 180) * d.h);
    const r = Math.max(1, Math.round((0.3 / 360) * d.w));
    let coast = false;
    for (let dy = -r; dy <= r && !coast; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= d.h) continue;
        if (d.q[y * d.w + (((cx + dx) % d.w) + d.w) % d.w] === 0) {
          coast = true;
          break;
        }
      }
    if (!coast) return false;
    const g = this.climate.meta!.grid;
    const i = Math.floor((g.lat0 + g.dy / 2 - lat) / g.dy);
    const j = Math.floor(((((lon - g.lon0 + g.dx / 2) % 360) + 360) % 360) / g.dx);
    for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = (j + dj + g.nx) % g.nx;
      if (ii >= 0 && ii < g.ny && f.flags![ii * g.nx + jj] === 1) return true;
    }
    return false;
  }

  // ---------- panel, bottom bar, legend, labels ----------
  private renderPanel() {
    const p = this.els.panel;
    clear(p);
    p.append(h('h2', {}, 'Climate atlas'));
    const list = h('div', { class: 'layer-list atlas-list' });
    let group = '';
    for (const v of ATLAS_VARS) {
      if (v.group !== group) {
        group = v.group;
        list.append(h('div', { class: 'menu-group' }, group));
      }
      const sw = h('span', { class: 'sw' });
      sw.style.background = cssGradient(v.palette);
      list.append(
        h(
          'button',
          {
            class: 'layer-btn compact',
            title: v.hint,
            'aria-pressed': String(v.id === this.varId),
            onclick: () => {
              this.varId = v.id;
              this.renderPanel();
              this.show();
            },
          },
          v.label,
          sw,
        ),
      );
    }
    p.append(
      list,
      h('div', { class: 'run-info' }, 'Normals from 25 years of ERA5 weather (2001–2025). Air quality: NOAA’s aerosol model matched to satellite and ground-monitor estimates (2021–2025). Tap anywhere for the month-by-month climate.'),
    );
  }

  private shortPeriod(): string {
    const p = this.period;
    return p.kind === 'month' ? MONTHS[p.m] : p.kind === 'day' ? doyLabel(p.d) : '';
  }

  private periodLabel(): string {
    const p = this.period;
    return p.kind === 'year' ? 'Whole year' : p.kind === 'month' ? LONG_MONTHS[p.m] : doyLabel(p.d, true);
  }

  private renderBottom() {
    const b = this.els.bottom;
    clear(b);
    b.classList.remove('hidden');
    const p = this.period;
    this.seg = h('div', { class: 'seg period-seg', role: 'group', 'aria-label': 'Period' });
    const btn = (k: PeriodKind, m: number, label: string, title: string) =>
      h(
        'button',
        {
          'aria-selected': String(p.kind === k && (k === 'year' || p.m === m)),
          title,
          onclick: () => {
            this.stopPlay();
            this.setPeriod(k === 'year' ? { kind: 'year', m: 0, d: this.period.d } : { kind: 'month', m, d: MONTH_START[m] + 14 });
          },
        },
        label,
      );
    this.seg.append(btn('year', 0, 'Year', 'The whole year'), ...MONTHS.map((m, i) => btn('month', i, m[0], LONG_MONTHS[i])));
    this.dayInput = h('input', {
      type: 'range',
      class: `single-range day-range${p.kind === 'day' ? '' : ' idle'}`,
      min: 0,
      max: 364,
      step: 1,
      value: p.kind === 'year' ? 0 : p.d,
      'aria-label': 'Day of the year',
      oninput: () => {
        this.stopPlay();
        const d = +this.dayInput!.value;
        this.setPeriod({ kind: 'day', m: monthOfDay(d), d }, false);
      },
    });
    const ticks = h('div', { class: 'ticks' });
    MONTHS.forEach((m, i) => {
      const s = h('span', {}, m);
      s.style.left = `${((MONTH_START[i] + 15) / 364) * 100}%`;
      ticks.append(s);
    });
    const play = h('button', { class: 'play', 'aria-label': 'Play through the year' }, this.playTimer ? '❚❚' : '▶');
    play.onclick = () => (this.playTimer ? this.stopPlay() : this.play());
    this.label = h('span', { class: 'timeline-label' }, this.periodLabel());
    b.append(
      play,
      h(
        'div',
        { class: 'timeline' },
        h('div', { class: 'timeline-top' }, this.label, h('span', { class: 'timeline-sub' }, '2001–2025 normals')),
        this.seg,
        h('div', { class: 'day-scrub' }, this.dayInput, ticks),
      ),
    );
  }

  /** Change the period; while scrubbing, the bar is updated in place instead of rebuilt. */
  private setPeriod(p: Period, rebuild = true) {
    this.period = p;
    if (rebuild) this.renderBottom();
    else {
      if (this.label) this.label.textContent = this.periodLabel();
      this.dayInput?.classList.toggle('idle', p.kind !== 'day');
      if (this.dayInput && p.kind === 'day') this.dayInput.value = String(p.d);
      this.seg?.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === 0 ? p.kind === 'year' : p.kind === 'month' && p.m === i - 1)));
    }
    if (this.current && this.current.def === this.def) {
      this.draw(this.def, this.current.f, !rebuild);
      if (!this.playTimer) this.writeUrl();
    } else this.show();
  }

  /** Animate day by day through the year from the current date. */
  private play() {
    let d = this.period.kind === 'year' ? 0 : this.period.d;
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '❚❚';
    const step = () => {
      d = (d + 2) % 365;
      this.setPeriod({ kind: 'day', m: monthOfDay(d), d }, false);
      this.playTimer = window.setTimeout(step, 70);
    };
    this.playTimer = window.setTimeout(step, 0);
  }

  private stopPlay() {
    if (!this.playTimer) return;
    clearTimeout(this.playTimer);
    this.playTimer = 0;
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '▶';
    this.updateCities();
    if (this.active) this.writeUrl();
  }

  private renderLegend() {
    const d = this.def;
    const k = this.period.kind;
    const pal = this.palette();
    const imperial = units.imperial && !!d.ticksImperial;
    const set = imperial ? d.ticksImperial! : d.ticks;
    const raw = (d.sum ? set[k] : undefined) ?? set.month;
    const ticks = raw.map((t) => ({
      value: imperial ? (d.fromImperial ?? ((x: number) => x))(t) : t,
      label: d.count && k === 'day' ? pct(t) : t >= 1000 ? `${t / 1000}k` : String(t),
    }));
    const when = k === 'year' ? '' : ` · ${this.shortPeriod()}`;
    renderLegend(this.els.legend, d.label, `${d.unit(k)}${when}`, pal, ticks);
  }

  updateCities() {
    const src = this.map.getSource('cities') as GeoJSONSource | undefined;
    const cur = this.current;
    if (!src || !this.active || !cur) return;
    const { def, f, w, days } = cur;
    const k = this.period.kind;
    if (k !== 'year') this.renderLegendWhen();
    src.setData({
      type: 'FeatureCollection',
      features: this.cities.map((c) => {
        const ok = !f.flags || this.nearSea(f, c.lon, c.lat);
        const v = ok ? this.sample(def, f, w, c.lon, c.lat, c.elev ?? demAt(this.dem, c.lon, c.lat), days) : NaN;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
          properties: { name: c.name, label: Number.isFinite(v) ? def.fmt(v, k) : '', rank: c.rank, minzoom: c.minzoom },
        };
      }),
    });
  }

  /** Keep the legend's date in step while scrubbing. */
  private renderLegendWhen() {
    const unit = this.els.legend.querySelector('.legend-title span');
    if (unit) unit.textContent = `${this.def.unit(this.period.kind)} · ${this.shortPeriod()}`;
  }

  // ---------- location card ----------
  async showCard(lon: number, lat: number, placeP?: Promise<Place | null>) {
    this.cardAt = [lon, lat];
    const card = this.els.card;
    hideTip();
    clear(card);
    card.classList.remove('hidden');
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => ((this.cardAt = null), card.classList.add('hidden')) }, '✕');
    const title = h('div', { class: 'place' }, '…');
    const sub = h('div', { class: 'coords' }, coordLabel(lon, lat));
    const body = h('div', {}, h('div', { class: 'desc' }, 'Loading climate…'));
    card.append(close, title, sub, body);
    const [elevP, place] = await Promise.all([pointElevation(lon, lat).catch(() => null), (placeP ?? Promise.resolve(null)).catch(() => null)]);
    if (this.cardAt?.[0] !== lon || this.cardAt?.[1] !== lat) return;
    const elev = elevP ?? demAt(this.dem, lon, lat);
    title.textContent = place?.name ?? 'Selected location';
    sub.textContent = [place?.detail, coordLabel(lon, lat), units.imperial ? `${Math.round(elev * 3.281)} ft` : `${Math.round(elev)} m`].filter(Boolean).join(' · ');

    const ids = ['tmean', 'tmax', 'tmin', 'feels', 'sun', 'uv', 'precip', 'wetdays', 'snowfall', 'snowdays', 'dew', 'rh', 'wind', 'aqi', 'goodair', 'badair', 'sst'];
    const loaded = await Promise.all(ids.map((id) => this.load(id).catch(() => null)));
    if (this.cardAt?.[0] !== lon || this.cardAt?.[1] !== lat) return;
    const def = (id: string) => ATLAS_VARS.find((v) => v.id === id)!;
    /** total (sums) or average for a period */
    const at = (id: string, p: Period) => {
      const f = loaded[ids.indexOf(id)];
      if (!f) return NaN;
      const d = def(id);
      if (f.flags && !this.nearSea(f, lon, lat)) return NaN;
      return this.sample(d, f, periodWeights(p, f.nc), lon, lat, elev, d.sum ? periodDays(p) : 1);
    };
    const YEAR: Period = { kind: 'year', m: 0, d: 0 };
    const y = (id: string) => at(id, YEAR);
    if (!Number.isFinite(y('tmax'))) {
      body.replaceChildren(h('div', { class: 'desc' }, 'No climate data here (open ocean or Antarctica).'));
      return;
    }
    const stat = (k: string, v: string, n?: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n ? h('div', { class: 'n' }, n) : null);
    const fin = (v: number) => Number.isFinite(v);
    const tiles = [
      stat('Average', def('tmean').fmt(y('tmean'), 'year'), `high ${def('tmax').fmt(y('tmax'), 'year', false)} · low ${def('tmin').fmt(y('tmin'), 'year', false)}`),
      stat('Sunshine', `${def('sun').fmt(y('sun'), 'year')} a year`, fin(y('uv')) ? `UV peak ${Math.round(y('uv'))} on average` : undefined),
      stat('Precipitation', `${def('precip').fmt(y('precip'), 'year')} a year`, `${Math.round(y('wetdays'))} wet days`),
      y('snowfall') < 0.5 && y('snowdays') < 0.5
        ? stat('Snowfall', 'None', 'in a typical year')
        : stat('Snowfall', `${def('snowfall').fmt(y('snowfall'), 'year')} a year`, `snow on the ground ${Math.round(y('snowdays'))} days`),
      ...(fin(y('aqi')) ? [stat('Air quality', `${Math.round(y('goodair'))} good days`, `${Math.round(y('badair'))} unhealthy · average AQI ${Math.round(y('aqi'))}`)] : []),
      ...(fin(y('sst')) ? [stat('Sea', def('sst').fmt(y('sst'), 'year'), 'average sea temperature nearby')] : []),
    ];
    // month-by-month table, in the same layout as the climate finder's card
    const months: Partial<MonthStats>[] = MONTHS.map((_, m) => {
      const p: Period = { kind: 'month', m, d: MONTH_START[m] + 14 };
      const v = (id: string) => {
        const x = at(id, p);
        return fin(x) ? x : undefined;
      };
      const sun = v('sun');
      return {
        feels: v('feels'), tmax: v('tmax'), tmin: v('tmin'), dew: v('dew'), rh: v('rh'),
        sun: sun === undefined ? undefined : sun / DAYS_IN_MONTH[m], uv: v('uv'),
        rainDays: v('wetdays'), precip: v('precip'), snowfall: v('snowfall'), snowDays: v('snowdays'),
        aqi: v('aqi'), goodAirDays: v('goodair'), badAirDays: v('badair'), wind: v('wind'), sst: v('sst'),
      };
    });
    body.replaceChildren(
      h('div', { class: 'stats' }, ...tiles),
      h('h3', {}, 'Month by month'),
      monthTable({ months } as DetailResult),
      h(
        'div',
        { class: 'note' },
        'Normals from 25 years of weather (ERA5 reanalysis, 2001–2025), blended from nearby ~100 km grid cells with temperatures, rain and snow adjusted to this spot’s elevation. Air quality: NOAA’s aerosol model matched to satellite and ground-monitor estimates (2021–2025). Hover a cell for details.',
      ),
    );
  }
}
