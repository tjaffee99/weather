/**
 * Climate atlas: the map coloured by a climate normal (average temperature,
 * yearly sunshine, rainfall, snowfall, ...) for the whole year or one month.
 * Normals come from the same 2001-2025 ERA5 sample as the finder
 * (pipeline/encode_climate.py writes atlas/<id>.bin: int16 [13][cells]).
 * Cells are blended exactly as in the finder (blend.ts), and temperatures are
 * adjusted to each pixel's elevation.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FieldLayer } from '../map/fieldLayer';
import { AQI, CLOUD, HUMIDITY, TEMPERATURE, UV_INDEX, WIND, cssGradient, type Palette } from '../map/palettes';
import { demAt, fetchBinary, type City, type Dem } from '../data';
import type { Place } from '../geocode';
import { pointElevation } from '../map/localDem';
import { h, clear } from '../ui/dom';
import { renderLegend } from '../ui/legend';
import { MONTHS, coordLabel } from '../ui/format';
import { fmt, fromDisplay, units } from '../units';
import { blendTaps } from './blend';
import { hideTip, monthTable } from './card';
import type { ClimateUI } from './climateUi';
import { DZ0, DZ_STEP, LAPSE, LEVELS, type DetailResult, type MonthStats } from './types';

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const YEAR = 12;

interface AtlasVar {
  id: string;
  label: string;
  group: string;
  hint: string;
  /** shifted with elevation like the finder's temperatures */
  temp?: boolean;
  /** palettes for a month and for the whole year (sums are larger over a year) */
  palette: [Palette, Palette];
  /** legend ticks in metric units, [month, year]; imperial versions in display units */
  ticks: [number[], number[]];
  ticksImperial?: [number[], number[]];
  fmt: (v: number, unit?: boolean) => string;
  /** legend unit, [month, year] */
  unit: () => [string, string];
}

/** Scale a palette's stops (a year's sum is roughly 12 months' worth). */
const scaled = (p: Palette, k: number): Palette => ({ ...p, stops: p.stops.map(([v, c, a]) => [v * k, c, a] as [number, string, number?]) });

const SUN_M: Palette = {
  stops: [
    [0, '#dfe5ee'],
    [80, '#f3ebc4'],
    [160, '#f7d873'],
    [240, '#f5b324'],
    [320, '#ec8a12'],
    [400, '#c95f0b'],
  ],
};
const PRECIP_M: Palette = {
  transform: 'log',
  stops: [
    [3, '#efe2c2'],
    [12, '#e3e5bd'],
    [30, '#bfe0b1'],
    [60, '#86ccb0'],
    [110, '#49aec6'],
    [200, '#2f78c4'],
    [380, '#3a3aa8'],
    [700, '#5a1f8f'],
  ],
};
const DAYS_BLUE: Palette = {
  stops: [
    [0, '#efe2c2'],
    [4, '#d7e3bb'],
    [8, '#9fd2b2'],
    [13, '#4fb3c6'],
    [19, '#2f6fc0'],
    [26, '#3a2a90'],
  ],
};
const SNOWFALL_M: Palette = {
  transform: 'log',
  stops: [
    [0.3, '#eef2ff', 0],
    [1, '#e2e9ff', 0.55],
    [5, '#c2d2ff', 0.8],
    [15, '#97adfb', 0.92],
    [40, '#7a7ff0', 1],
    [90, '#8c5ad8', 1],
    [200, '#4b2390', 1],
  ],
};
const SNOWDAYS_M: Palette = {
  stops: [
    [0, '#eef2ff', 0],
    [1, '#dfe7ff', 0.6],
    [8, '#b4c8ff', 0.9],
    [16, '#8ea6fb', 1],
    [24, '#7a6fe0', 1],
    [31, '#4b2390', 1],
  ],
};
const DEW: Palette = {
  stops: [
    [-20, '#e7dcc4'],
    [0, '#dfe5bf'],
    [10, '#a8d8a4'],
    [16, '#4fb3a6'],
    [20, '#2f7fa8'],
    [24, '#3a3a96'],
  ],
};
const GOOD_AIR_M: Palette = {
  stops: [
    [0, '#c45a3c'],
    [8, '#efb04a'],
    [16, '#e6dd7a'],
    [24, '#8fcf7a'],
    [31, '#2e9e4a'],
  ],
};
const AQI_SOLID: Palette = { stops: AQI.stops.map(([v, c]) => [v, c] as [number, string]) };

const tempFmt = (v: number, unit = true) => `${fmt('temp', v)}${unit ? (units.imperial ? 'F' : 'C') : ''}`;
const days = (v: number, unit = true) => `${Math.round(v)}${unit ? ' days' : ''}`;
const tempVar = (id: string, label: string, hint: string): AtlasVar => ({
  id, label, group: 'Temperature', hint, temp: true,
  palette: [TEMPERATURE, TEMPERATURE],
  ticks: [[-20, 0, 10, 20, 30], [-20, 0, 10, 20, 30]],
  ticksImperial: [[0, 32, 50, 70, 90], [0, 32, 50, 70, 90]],
  fmt: tempFmt,
  unit: () => [units.imperial ? '°F' : '°C', units.imperial ? '°F' : '°C'],
});

export const ATLAS_VARS: AtlasVar[] = [
  tempVar('tmean', 'Average temperature', 'Midway between the day’s high and low'),
  tempVar('tmax', 'Daytime high', 'Average afternoon high'),
  tempVar('tmin', 'Overnight low', 'Average coldest part of the night'),
  tempVar('feels', 'Feels-like high', 'Afternoon feels-like, with humidity and wind'),
  {
    id: 'sun', label: 'Sunshine', group: 'Sun & sky', hint: 'Hours of direct sun',
    palette: [SUN_M, scaled(SUN_M, 11)], ticks: [[0, 100, 200, 300, 400], [0, 1000, 2000, 3000, 4000]],
    fmt: (v, u = true) => `${Math.round(v).toLocaleString()}${u ? ' h' : ''}`,
    unit: () => ['hours', 'hours a year'],
  },
  {
    id: 'uv', label: 'UV index', group: 'Sun & sky', hint: 'Average daily peak',
    palette: [UV_INDEX, UV_INDEX], ticks: [[0, 3, 6, 8, 11], [0, 3, 6, 8, 11]],
    fmt: (v) => v.toFixed(v < 9.95 ? 1 : 0), unit: () => ['daily peak', 'daily peak'],
  },
  {
    id: 'cloud', label: 'Cloud cover', group: 'Sun & sky', hint: 'Daytime average (counts thin high cloud too)',
    palette: [CLOUD, CLOUD], ticks: [[0, 25, 50, 75, 100], [0, 25, 50, 75, 100]],
    fmt: (v, u = true) => `${Math.round(v)}${u ? '%' : ''}`, unit: () => ['%', '%'],
  },
  {
    id: 'precip', label: 'Precipitation', group: 'Rain & snow', hint: 'Rain plus melted snow',
    palette: [PRECIP_M, scaled(PRECIP_M, 12)],
    ticks: [[10, 50, 100, 200, 400], [100, 500, 1000, 2000, 4000]],
    ticksImperial: [[0.5, 2, 4, 8, 16], [5, 20, 40, 80, 160]],
    fmt: (v, u = true) => (units.imperial ? `${(v / 25.4).toFixed(v / 25.4 < 10 ? 1 : 0)}${u ? ' in' : ''}` : `${Math.round(v).toLocaleString()}${u ? ' mm' : ''}`),
    unit: () => [units.imperial ? 'in' : 'mm', units.imperial ? 'in a year' : 'mm a year'],
  },
  {
    id: 'wetdays', label: 'Wet days', group: 'Rain & snow', hint: 'Days with 1 mm (0.04 in) or more',
    palette: [DAYS_BLUE, scaled(DAYS_BLUE, 12)], ticks: [[0, 5, 10, 15, 20, 25], [0, 50, 100, 150, 200, 250]],
    fmt: days, unit: () => ['days', 'days a year'],
  },
  {
    id: 'snowfall', label: 'Snowfall', group: 'Rain & snow', hint: 'Fresh snow (10 cm of snow per cm of water)',
    palette: [SNOWFALL_M, scaled(SNOWFALL_M, 5)], ticks: [[1, 10, 30, 100], [5, 50, 150, 500]],
    ticksImperial: [[0.5, 4, 12, 40], [2, 20, 60, 200]],
    fmt: (v, u = true) => (units.imperial ? `${Math.round(v / 2.54)}${u ? ' in' : ''}` : `${Math.round(v)}${u ? ' cm' : ''}`),
    unit: () => [units.imperial ? 'in' : 'cm', units.imperial ? 'in a year' : 'cm a year'],
  },
  {
    id: 'snowdays', label: 'Snow on the ground', group: 'Rain & snow', hint: 'Days with at least 1 cm of snow cover',
    palette: [SNOWDAYS_M, scaled(SNOWDAYS_M, 11.8)], ticks: [[0, 10, 20, 31], [0, 100, 200, 365]],
    fmt: days, unit: () => ['days', 'days a year'],
  },
  {
    id: 'dew', label: 'Dew point', group: 'Air', hint: 'Daytime: under 10° dry, 16° sticky, 20°+ muggy', temp: false,
    palette: [DEW, DEW], ticks: [[-10, 0, 10, 16, 20], [-10, 0, 10, 16, 20]], ticksImperial: [[15, 32, 50, 61, 68], [15, 32, 50, 61, 68]],
    fmt: tempFmt, unit: () => [units.imperial ? '°F' : '°C', units.imperial ? '°F' : '°C'],
  },
  {
    id: 'rh', label: 'Relative humidity', group: 'Air', hint: 'Daytime average',
    palette: [HUMIDITY, HUMIDITY], ticks: [[20, 40, 60, 80, 100], [20, 40, 60, 80, 100]],
    fmt: (v, u = true) => `${Math.round(v)}${u ? '%' : ''}`, unit: () => ['%', '%'],
  },
  {
    id: 'wind', label: 'Wind', group: 'Air', hint: 'Average strongest daytime wind',
    palette: [WIND, WIND], ticks: [[5, 15, 25, 35], [5, 15, 25, 35]], ticksImperial: [[5, 10, 15, 20], [5, 10, 15, 20]],
    fmt: (v, u = true) => fmt('speed', v, u), unit: () => [units.imperial ? 'mph' : 'km/h', units.imperial ? 'mph' : 'km/h'],
  },
  {
    id: 'aqi', label: 'Air quality', group: 'Air', hint: 'Average US AQI from PM2.5 (model estimate, 2021–2025)',
    palette: [AQI_SOLID, AQI_SOLID], ticks: [[0, 50, 100, 150, 200], [0, 50, 100, 150, 200]],
    fmt: (v) => String(Math.round(v)), unit: () => ['US AQI', 'US AQI'],
  },
  {
    id: 'goodair', label: 'Good-air days', group: 'Air', hint: 'Days with AQI 50 or less (model estimate)',
    palette: [GOOD_AIR_M, scaled(GOOD_AIR_M, 11.8)], ticks: [[0, 10, 20, 31], [0, 100, 200, 365]],
    fmt: days, unit: () => ['days', 'days a year'],
  },
  {
    id: 'sst', label: 'Sea temperature', group: 'Sea', hint: 'Nearby ocean; coastal places only',
    palette: [TEMPERATURE, TEMPERATURE], ticks: [[0, 10, 20, 25, 30], [0, 10, 20, 25, 30]], ticksImperial: [[32, 50, 68, 77, 86], [32, 50, 68, 77, 86]],
    fmt: tempFmt, unit: () => [units.imperial ? '°F' : '°C', units.imperial ? '°F' : '°C'],
  },
];

const SHIFTS = Array.from({ length: LEVELS }, (_, k) => -LAPSE * (DZ0 + k * DZ_STEP));

export class AtlasUI {
  private varId = 'tmean';
  private period = YEAR;
  private active = false;
  private cache = new Map<string, Promise<Float32Array>>();
  private cellPos?: Int32Array; // raster index of each cell
  private current?: { id: string; period: number; values: Float32Array };
  private playTimer = 0;
  private cardAt: [number, number] | null = null;
  private token = 0;

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
    const p = Number(u.searchParams.get('p'));
    if (u.searchParams.has('p') && p >= 0 && p < 12) this.period = p;
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
    if (this.period === YEAR) u.searchParams.delete('p');
    else u.searchParams.set('p', String(this.period));
    history.replaceState(null, '', u);
  }

  /** Normals for one variable: 13 periods x cells, in natural units (NaN = no data). */
  private load(id: string): Promise<Float32Array> {
    let p = this.cache.get(id);
    if (!p) {
      const m = this.climate.meta!.atlas?.[id];
      if (!m) return Promise.reject(new Error(`no atlas data for ${id}`));
      p = fetchBinary(`${this.base}data/climate/${m.file}`).then((b) => {
        const raw = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
        const out = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw[i] === -32768 ? NaN : raw[i] * m.scale;
        return out;
      });
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

  private async show() {
    const token = ++this.token;
    const def = this.def, period = this.period;
    const slow = setTimeout(() => this.setStatus(`Loading ${def.label.toLowerCase()}…`), 200);
    let vals: Float32Array;
    try {
      vals = await this.load(def.id);
    } catch (e) {
      clearTimeout(slow);
      this.setStatus(`Could not load: ${(e as Error).message}`, false, true);
      return;
    }
    clearTimeout(slow);
    this.setStatus('');
    if (!this.active || token !== this.token) return;
    const g = this.climate.meta!.grid;
    const pos = this.cells();
    const n = pos.length;
    const plane = g.nx * g.ny;
    const out = new Float32Array(LEVELS * plane * 2);
    for (let k = 0; k < n; k++) {
      const v = vals[period * n + k];
      if (Number.isNaN(v)) continue;
      for (let l = 0; l < LEVELS; l++) {
        const o = (l * plane + pos[k]) * 2;
        out[o] = v + (def.temp ? SHIFTS[l] : 0);
        out[o + 1] = 1;
      }
    }
    this.current = { id: def.id, period, values: vals };
    this.field.mode = 1;
    this.field.climateSqrt = false;
    this.field.setPalette(def.palette[period === YEAR ? 1 : 0]);
    this.field.setClimateResult(out);
    if (this.field.fade < 1) this.field.fadeTo(1, 260);
    this.renderLegend();
    this.updateCities();
    this.writeUrl();
  }

  /** A variable's value at a point for a period, blended like the map (NaN where there is none). */
  private sample(vals: Float32Array, period: number, temp: boolean, lon: number, lat: number, elev: number): number {
    const g = this.climate.meta!.grid;
    const et = this.climate.cellElevTex!;
    const pos = this.cells();
    const index = this.rasterToCell();
    const { taps, cover } = blendTaps(g, (p) => (et[p * 2 + 1] ? et[p * 2] : undefined), lon, lat, elev);
    if (cover < 0.04) return NaN;
    let s = 0, w = 0;
    for (const t of taps) {
      const v = vals[period * pos.length + index[t.p]];
      if (Number.isNaN(v)) continue;
      s += t.q * (v + (temp ? -LAPSE * t.dz : 0));
      w += t.q;
    }
    return w > 0 ? s / w : NaN;
  }

  private rasterIndex?: Int32Array;
  private rasterToCell(): Int32Array {
    if (!this.rasterIndex) {
      const g = this.climate.meta!.grid;
      this.rasterIndex = new Int32Array(g.nx * g.ny).fill(-1);
      this.cells().forEach((p, k) => (this.rasterIndex![p] = k));
    }
    return this.rasterIndex;
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
      sw.style.background = cssGradient(v.palette[0]);
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
    p.append(list, h('div', { class: 'run-info' }, 'Normals from 25 years of ERA5 weather (2001–2025); air quality from NOAA’s aerosol model (2021–2025). Tap anywhere for the month-by-month climate.'));
  }

  private renderBottom() {
    const b = this.els.bottom;
    clear(b);
    b.classList.remove('hidden');
    const seg = h('div', { class: 'seg period-seg', role: 'group', 'aria-label': 'Period' });
    const btn = (p: number, label: string, title: string) =>
      h(
        'button',
        {
          'aria-selected': String(p === this.period),
          title,
          onclick: () => {
            this.stopPlay();
            this.setPeriod(p);
          },
        },
        label,
      );
    seg.append(btn(YEAR, 'Year', 'The whole year'), ...MONTHS.map((m, i) => btn(i, m[0], m)));
    const play = h('button', { class: 'play', 'aria-label': 'Play through the months' }, '▶');
    play.onclick = () => {
      if (this.playTimer) return this.stopPlay();
      play.textContent = '❚❚';
      const step = () => {
        this.setPeriod(this.period >= 11 ? 0 : this.period + 1);
        this.playTimer = window.setTimeout(step, 900);
      };
      step();
    };
    b.append(play, h('div', { class: 'timeline' }, h('div', { class: 'timeline-top' }, h('span', { class: 'timeline-label' }, this.period === YEAR ? 'Whole year' : MONTHS[this.period]), h('span', { class: 'timeline-sub' }, '2001–2025 normals')), seg));
  }

  private setPeriod(p: number) {
    this.period = p;
    this.renderBottom();
    if (this.playTimer) this.els.bottom.querySelector('.play')!.textContent = '❚❚';
    this.show();
  }

  private stopPlay() {
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = 0;
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '▶';
  }

  private renderLegend() {
    const d = this.def;
    const year = this.period === YEAR;
    const i = year ? 1 : 0;
    const pal = d.palette[i];
    const ticks = units.imperial && d.ticksImperial ? d.ticksImperial[i].map((t) => ({ value: d.temp || d.id === 'dew' || d.id === 'sst' ? fromDisplay('temp', t) : d.id === 'wind' ? fromDisplay('speed', t) : d.id === 'precip' ? t * 25.4 : d.id === 'snowfall' ? t * 2.54 : t, label: String(t) })) : d.ticks[i].map((t) => ({ value: t, label: t >= 1000 ? `${t / 1000}k` : String(t) }));
    renderLegend(this.els.legend, d.label, `${d.unit()[i]}${year ? '' : ` · ${MONTHS[this.period]}`}`, pal, ticks);
  }

  updateCities() {
    const src = this.map.getSource('cities') as GeoJSONSource | undefined;
    const cur = this.current;
    if (!src || !this.active || !cur) return;
    const d = this.def;
    src.setData({
      type: 'FeatureCollection',
      features: this.cities.map((c) => {
        const v = this.sample(cur.values, cur.period, !!d.temp, c.lon, c.lat, c.elev ?? demAt(this.dem, c.lon, c.lat));
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
          properties: { name: c.name, label: Number.isFinite(v) ? d.fmt(v) : '', rank: c.rank, minzoom: c.minzoom },
        };
      }),
    });
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

    const ids = ['tmean', 'tmax', 'tmin', 'feels', 'sun', 'uv', 'precip', 'wetdays', 'snowfall', 'snowdays', 'dew', 'rh', 'wind', 'aqi', 'goodair', 'sst'];
    const loaded = await Promise.all(ids.map((id) => this.load(id).catch(() => null)));
    if (this.cardAt?.[0] !== lon || this.cardAt?.[1] !== lat) return;
    const at = (id: string, p: number) => {
      const vals = loaded[ids.indexOf(id)];
      const def = ATLAS_VARS.find((v) => v.id === id);
      return vals && def ? this.sample(vals, p, !!def.temp, lon, lat, elev) : NaN;
    };
    if (!Number.isFinite(at('tmax', YEAR))) {
      body.replaceChildren(h('div', { class: 'desc' }, 'No climate data here (open ocean or Antarctica).'));
      return;
    }
    const def = (id: string) => ATLAS_VARS.find((v) => v.id === id)!;
    const stat = (k: string, v: string, n?: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n ? h('div', { class: 'n' }, n) : null);
    const fin = (v: number) => Number.isFinite(v);
    const tiles = [
      stat('Average', def('tmean').fmt(at('tmean', YEAR)), `high ${def('tmax').fmt(at('tmax', YEAR), false)} · low ${def('tmin').fmt(at('tmin', YEAR), false)}`),
      stat('Sunshine', `${def('sun').fmt(at('sun', YEAR))} a year`, fin(at('uv', YEAR)) ? `UV peak ${Math.round(at('uv', YEAR))} on average` : undefined),
      stat('Precipitation', `${def('precip').fmt(at('precip', YEAR))} a year`, `${Math.round(at('wetdays', YEAR))} wet days`),
      stat('Snowfall', `${def('snowfall').fmt(at('snowfall', YEAR))} a year`, `snow on the ground ${Math.round(at('snowdays', YEAR))} days`),
      ...(fin(at('aqi', YEAR)) ? [stat('Air quality', `${Math.round(at('goodair', YEAR))} good days`, `average AQI ${Math.round(at('aqi', YEAR))} (model estimate)`)] : []),
      ...(fin(at('sst', YEAR)) ? [stat('Sea', def('sst').fmt(at('sst', YEAR)), 'average nearby sea temperature')] : []),
    ];
    // month-by-month table, in the same layout as the climate finder's card
    const months: Partial<MonthStats>[] = MONTHS.map((_, m) => {
      const v = (id: string) => (fin(at(id, m)) ? at(id, m) : undefined);
      const sun = v('sun');
      return {
        feels: v('feels'), tmax: v('tmax'), tmin: v('tmin'), dew: v('dew'), rh: v('rh'),
        sun: sun === undefined ? undefined : sun / DAYS_IN_MONTH[m], uv: v('uv'),
        rainDays: v('wetdays'), precip: v('precip'), snowfall: v('snowfall'), snowDays: v('snowdays'),
        aqi: v('aqi'), goodAirDays: v('goodair'), wind: v('wind'), sst: v('sst'),
      };
    });
    body.replaceChildren(
      h('div', { class: 'stats' }, ...tiles),
      h('h3', {}, 'Month by month'),
      monthTable({ months } as DetailResult),
      h('div', { class: 'note' }, 'Normals from 25 years of weather (ERA5 reanalysis, 2001–2025), blended from nearby ~100 km grid cells with temperatures adjusted to this spot’s elevation. Air quality is a model estimate (NOAA GEFS-Aerosols, 2021–2025). Hover a cell for details.'),
    );
  }
}
