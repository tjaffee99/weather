/**
 * Climate finder UI: conditions panel (presets, active conditions, grouped
 * "add condition" menu), one "when" control (all year, or a date on the
 * slider), legend, city labels with results, and a location card with
 * monthly normals.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FieldLayer } from '../map/fieldLayer';
import { MATCH, SCORE, cssGradient } from '../map/palettes';
import type { LiveController } from '../live/liveController';
import { bilinear, GFS_GRID } from '../live/liveController';
import type { LiveVar } from '../live/gfs';
import { demAt, type City, type Dem } from '../data';
import type { Place } from '../geocode';
import { pointElevation } from '../map/localDem';
import { h, clear } from '../ui/dom';
import { RangeSlider } from '../ui/rangeSlider';
import { renderLegend } from '../ui/legend';
import { MONTHS, MONTH_START, coordLabel, doyLabel, timeLabel, todayDoy } from '../ui/format';
import { fmt, fromDisplay, toDisplay, unitLabel, units } from '../units';
import { CRITERIA, GROUPS, PRESETS, type CritDef, type CritState } from './criteria';
import { blendTaps, levelOf } from './blend';
import { cityFeatures } from '../map/labels';
import { hideTip, monthTable, sourceNote, summary, yearChart } from './card';
import { SEASON_WEIGHTS, cityCoefs, microOffset, seasonOf, type MicroCoefs, type MicroVar, type Microclimate } from './micro';
import { DZ0, DZ_STEP, LEVELS, type ClimVar, type ClimateMeta, type CritVar, type Criterion, type DetailResult } from './types';

type Els = { panel: HTMLElement; bottom: HTMLElement; legend: HTMLElement; card: HTMLElement };
type Mode = 'days' | 'date' | 'now';
const HALF_WINDOW = 10;
const HOUR = 3600_000;
const LAPSE = 0.0065;

/**
 * "Right now": which live GFS field each condition is checked against.
 * kind: 0 plain, 1 temperature (terrain-adjusted), 2 rate in mm/h compared as a
 * daily total, 3 daylight hours computed from latitude and date.
 */
const NOW: Record<CritVar, { v: LiveVar | null; kind: number; soft: number; label?: string }> = {
  feels: { v: 'feels', kind: 1, soft: 0.8, label: 'Feels like' },
  tmax: { v: 'temp', kind: 1, soft: 0.8, label: 'Temperature' },
  tmin: { v: 'temp', kind: 1, soft: 0.8, label: 'Temperature' },
  dew: { v: 'dew', kind: 0, soft: 0.8 },
  cloud: { v: 'cloud', kind: 0, soft: 4 },
  precip: { v: 'precip', kind: 2, soft: 0.25 },
  wind: { v: 'wind', kind: 0, soft: 1.5 },
  snow: { v: 'snow', kind: 0, soft: 1 },
  sst: { v: 'sst', kind: 0, soft: 0.5 },
  sun: { v: 'sun', kind: 0, soft: 0.3, label: 'Sunshine today' },
  uv: { v: 'uvmax', kind: 0, soft: 0.4, label: 'UV index today' },
  rh: { v: 'humidity', kind: 0, soft: 3, label: 'Humidity now' },
  aqi: { v: 'aqi', kind: 0, soft: 4, label: 'Air quality now' },
  snowfall: { v: 'snowfall', kind: 0, soft: 0.5, label: 'Snowing now (per day)' },
  daylight: { v: null, kind: 3, soft: 0.2 },
};

function daylightHours(lat: number, doy: number) {
  const phi = (lat * Math.PI) / 180;
  const decl = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (285 + doy)) / 365);
  const c = (Math.sin((-0.833 * Math.PI) / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
  return c <= -1 ? 24 : c >= 1 ? 0 : (24 / Math.PI) * Math.acos(c);
}

const utcDoy = (t: number) => {
  const d = new Date(t);
  return Math.min(364, Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400_000));
};

export class ClimateUI {
  private worker: Worker;
  meta?: ClimateMeta;
  readonly ready: Promise<void>;
  private mode: Mode = 'days';
  private state: CritState;
  private preset: string | null = 'perfect';
  private doy = todayDoy();
  private seq = 0;
  private inflight = false;
  private dirty = false;
  private result?: { data: Float32Array; groups: number; scaleMax: number; mode: Mode; doy: number };
  cellElevTex?: Float32Array;
  private pending = new Map<number, (m: any) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private progress = new Map<string, [number, number]>();
  private playing = 0;
  private active = false;
  private cardAt: [number, number] | null = null;
  private cut = { days: 0, date: 0 }; // minimum days/yr, minimum probability (0..1)
  private lastMode: Mode | null = null;
  private cardPlace: Promise<Place | null> = Promise.resolve(null);
  private dateLabel?: HTMLElement;
  private dateRange?: HTMLInputElement;
  // "right now" state
  private nowTime = Date.now();
  private nowKey = '';
  private nowToken = 0;
  private nowSlots: { c: Criterion; data: Float32Array | null }[] = [];
  private nowTemp?: Float32Array;
  private nowTimer = 0;
  live?: LiveController;
  micro?: Microclimate;
  liveReady: Promise<void> = Promise.resolve();
  nowCard?: (lon: number, lat: number, placeP?: Promise<Place | null>) => void;

  constructor(
    private map: MlMap,
    private field: FieldLayer,
    private els: Els,
    private cities: City[],
    private dem: Dem,
    private setStatus: (m: string, busy?: boolean, err?: boolean, progress?: number) => void,
    private closeCard: () => void,
    base: string,
  ) {
    this.state = this.readUrl() ?? structuredClone(PRESETS[0].state);
    this.worker = new Worker(new URL('./climate.worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.meta = m.meta;
          this.cellElevTex = m.elevTex;
          const g = m.meta.grid;
          field.setClimateGrid({ ...g, levels: LEVELS, dz0: DZ0, dzStep: DZ_STEP }, m.elevTex);
          resolve();
        } else if (m.type === 'progress') {
          this.progress.set(m.v, [m.loaded, m.total]);
          this.showProgress();
        } else if (m.type === 'error' && m.id === undefined) {
          reject(new Error(m.error));
        } else {
          const cb = this.pending.get(m.id);
          if (cb) {
            this.pending.delete(m.id);
            cb(m);
          }
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message));
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.menuOpen && !(e.target as Element).closest?.('.add-wrap')) {
        this.menuOpen = false;
        this.renderPanel();
      }
    });
    // workers resolve relative URLs against their own script, so pass an absolute base
    this.worker.postMessage({ type: 'init', base: new URL(base, location.href).href });
  }

  private call<T = any>(msg: Record<string, unknown>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.type === 'error' ? reject(new Error(m.error)) : resolve(m)));
      this.worker.postMessage({ ...msg, id });
    });
  }

  private showProgress() {
    if (!this.active) return;
    let l = 0, t = 0;
    for (const [a, b] of this.progress.values()) {
      l += a;
      t += b;
    }
    if (t && l < t) this.setStatus(`Downloading 25 years of weather history… ${(l / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB`, true, false, l / t);
    else if (t) this.setStatus('Crunching 25 years of weather…');
  }

  async enter() {
    this.active = true;
    this.field.fade = 0;
    this.field.mode = 1;
    this.field.climateSqrt = true;
    this.field.lapse = 0;
    this.field.useAlt = 0;
    this.field.opacity = 1;
    this.field.setPalette(SCORE);
    this.lastMode = null;
    this.renderPanel();
    this.renderBottom();
    if (!this.meta) this.setStatus('Loading climate data…');
    try {
      await this.ready;
    } catch (e) {
      this.setStatus(`Climate data unavailable: ${(e as Error).message}`, false, true);
      return;
    }
    if (!this.active) return;
    this.renderPanel();
    this.lastMode = null;
    this.requery();
  }

  exit() {
    this.active = false;
    this.stopPlay();
    this.writeUrl(true);
  }

  refreshUnits() {
    this.renderPanel();
    this.renderBottom();
    this.renderLegendBox();
    this.updateCities();
    if (this.cardAt) this.showCard(...this.cardAt);
  }

  // ---------- criteria ----------
  /** The conditions as tested: slider values widened to what they display (see testedRange). */
  private criteria(): Criterion[] {
    return (Object.entries(this.state) as [CritVar, [number, number]][]).map(([v, r]) => {
      const [lo, hi] = testedRange(CRITERIA.find((d) => d.v === v)!, r);
      return { v, lo, hi };
    });
  }

  private setState(s: CritState, preset: string | null) {
    this.state = structuredClone(s);
    this.preset = preset;
    this.renderPanel();
    this.requery();
  }

  private requery() {
    if (this.mode === 'now') {
      this.refreshNow();
      this.writeUrl();
      return;
    }
    if (!this.meta || !this.active) return;
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    const mode = this.mode as 'days' | 'date', doy = this.doy;
    const crit = this.criteria();
    const slow = setTimeout(() => this.setStatus('Crunching 25 years of weather…'), 400);
    this.call({ type: 'query', crit, mode, doy, half: HALF_WINDOW })
      .then((m) => {
        if (!this.active) return;
        console.debug(`climate query (${mode}) ${m.ms.toFixed(0)} ms`);
        this.result = { data: m.data, groups: m.groups ?? 1, scaleMax: m.scaleMax, mode, doy };
        if (this.mode !== mode) return;
        if (this.lastMode !== mode) this.field.setPalette(SCORE);
        this.field.mode = 1;
        this.field.climateSqrt = true;
        this.applyMicro();
        this.field.setClimateResult(m.data, this.result.groups);
        this.applyCut();
        if (this.field.fade < 1 && this.lastMode !== mode) this.field.fadeTo(1, 280);
        this.lastMode = mode;
        this.updateCities();
        this.setStatus('');
        if (this.cardAt) this.showCard(...this.cardAt, true);
      })
      .catch((e) => this.setStatus(`Query failed: ${e.message}`, false, true))
      .finally(() => {
        clearTimeout(slow);
        this.progress.clear();
        this.inflight = false;
        if (this.dirty) {
          this.dirty = false;
          this.requery();
        }
      });
    this.writeUrl();
  }

  // ---------- panel ----------
  private menuOpen = false;

  private renderPanel() {
    const p = this.els.panel;
    const scroll = p.scrollTop;
    clear(p);
    // what the colours mean
    const tab = (m: Mode, label: string, title: string) =>
      h('button', { role: 'tab', title, 'aria-selected': String(this.mode === m), onclick: () => this.setWhen(m) }, label);
    const view = h(
      'div',
      { class: 'seg view-seg', role: 'tablist', 'aria-label': 'Show' },
      tab('days', 'Per year', 'How many days a year match (2001–2025)'),
      tab('date', 'By date', 'Chance that a day around a date matches'),
      tab('now', 'Right now', 'Where the live forecast matches now or in the next 3 days'),
    );
    const presets = h('div', { class: 'presets' });
    for (const pr of PRESETS)
      presets.append(
        h('button', { class: 'chip', 'aria-pressed': String(this.preset === pr.id), onclick: () => this.setState(pr.state, pr.id) }, `${pr.icon} ${pr.label}`),
      );
    const list = h('div', { class: 'conds' });
    const active = CRITERIA.filter((d) => d.v in this.state);
    for (const def of active) list.append(this.condRow(def));
    if (!active.length) list.append(h('div', { class: 'empty' }, 'No conditions: every day counts.'));
    const about = h(
      'details',
      { class: 'about' },
      h('summary', {}, 'About the data'),
      h(
        'p',
        {},
        'Per year / By date: ERA5 reanalysis, 2001–2025, one real day per calendar day at every 1° land cell, in local solar time. Right now: the latest NOAA GFS forecast, comparing current temperatures and the current precipitation rate. Temperatures are adjusted to the local terrain (−6.5 °C per km).',
      ),
    );
    p.append(view, presets, list, this.addMenu());
    if (this.mode !== 'now') p.append(this.cutRow());
    p.append(about);
    p.scrollTop = scroll;
  }

  /** One active condition: name, current range, remove button and slider. */
  private condRow(def: CritDef): HTMLElement {
    const cur = this.state[def.v]!;
    const val = h('span', { class: 'val' }, describe(def, cur));
    const remove = h(
      'button',
      {
        class: 'remove',
        'aria-label': `Remove ${def.label}`,
        title: 'Remove',
        onclick: () => {
          const s = structuredClone(this.state);
          delete s[def.v];
          this.setState(s, null);
        },
      },
      '✕',
    );
    const sl = this.makeSlider(def, cur, (r) => (val.textContent = describe(def, r)));
    const name = this.mode === 'now' ? NOW[def.v].label ?? def.label : def.label;
    return h('div', { class: 'cond', title: def.hint }, h('div', { class: 'cond-head' }, h('span', { class: 'cond-name' }, name), val, remove), sl.el);
  }

  /** "+ Add condition" dropdown, grouped by theme. */
  private addMenu(): HTMLElement {
    const wrap = h('div', { class: 'add-wrap' });
    const btn = h(
      'button',
      {
        class: 'add-btn',
        'aria-expanded': String(this.menuOpen),
        onclick: () => {
          this.menuOpen = !this.menuOpen;
          this.renderPanel();
        },
      },
      h('span', { 'aria-hidden': 'true' }, '+'),
      ' Add condition',
      h('span', { class: 'caret', 'aria-hidden': 'true' }, this.menuOpen ? '▴' : '▾'),
    );
    wrap.append(btn);
    if (!this.menuOpen) return wrap;
    const menu = h('div', { class: 'add-menu', role: 'menu' });
    for (const g of GROUPS) {
      const items = CRITERIA.filter((d) => d.group === g);
      menu.append(h('div', { class: 'menu-group' }, g));
      for (const def of items) {
        const on = def.v in this.state;
        const size = def.file && this.meta && !on ? `${(this.meta.vars[def.file as ClimVar].bytes / 1e6).toFixed(1)} MB` : '';
        menu.append(
          h(
            'button',
            {
              class: 'menu-item',
              role: 'menuitemcheckbox',
              'aria-checked': String(on),
              onclick: () => {
                const s = structuredClone(this.state);
                if (on) delete s[def.v];
                else s[def.v] = this.defaultRange(def);
                this.menuOpen = false;
                this.setState(s, null);
              },
            },
            h('span', { class: 'check', 'aria-hidden': 'true' }, on ? '✓' : ''),
            h('span', { class: 'mi-text' }, h('span', { class: 'mi-label' }, def.label), h('span', { class: 'mi-hint' }, def.hint)),
            h('span', { class: 'mi-size' }, size),
          ),
        );
      }
    }
    wrap.append(menu);
    return wrap;
  }

  /** "Only highlight places with at least N days" — answers 'where do I get > n days a year?' */
  private cutRow(): HTMLElement {
    const days = this.mode === 'days';
    const v = days ? this.cut.days : this.cut.date;
    const fmtCut = (x: number) => (x <= 0 ? 'off' : days ? `${x} days/yr` : `${Math.round(x * 100)}%`);
    const val = h('span', { class: 'val' }, fmtCut(v));
    const input = h('input', {
      type: 'range',
      class: 'single-range',
      min: 0,
      max: days ? 365 : 1,
      step: days ? 5 : 0.05,
      value: v,
      'aria-label': 'Minimum to highlight',
      oninput: () => {
        const x = +input.value;
        if (days) this.cut.days = x;
        else this.cut.date = x;
        val.textContent = fmtCut(x);
        this.applyCut();
      },
    });
    return h(
      'div',
      { class: 'cut' },
      h('div', { class: 'cond-head' }, h('span', { class: 'cond-name' }, 'Highlight at least'), val),
      h('div', { class: 'cut-range' }, input),
    );
  }

  private applyCut() {
    const r = this.result;
    if (!r) return;
    this.field.cut = r.mode === 'days' ? (this.cut.days > 0 ? this.cut.days / r.scaleMax : 0) : this.cut.date;
    this.field.repaint();
    this.renderLegendBox();
    clearTimeout(this.cutTimer);
    this.cutTimer = window.setTimeout(() => this.updateCities(), 150);
  }
  private cutTimer = 0;

  private defaultRange(def: CritDef): [number, number] {
    return [...def.def] as [number, number];
  }

  private makeSlider(def: CritDef, cur: [number, number], onLabel: (r: [number, number]) => void) {
    let toPos: (v: number, end: 0 | 1) => number;
    let fromPos: (p: number, end: 0 | 1) => number;
    let min: number, max: number, step: number;
    if (def.kind === 'bins') {
      const stops = [0, ...def.edges!, Infinity];
      min = 0;
      max = stops.length - 1;
      step = 1;
      toPos = (v, end) => {
        if (!Number.isFinite(v)) return end === 0 ? 0 : max;
        let best = 0;
        for (let k = 0; k < stops.length; k++) if (Math.abs(stops[k] - v) < Math.abs(stops[best] - v)) best = k;
        return best;
      };
      fromPos = (p, end) => (p === 0 && end === 0 ? -Infinity : stops[p]);
    } else {
      const r = units.imperial ? def.imperial! : def.metric!;
      ({ min, max, step } = r);
      toPos = (v, end) => (!Number.isFinite(v) ? (end === 0 ? min : max) : Math.min(max, Math.max(min, Math.round(toDisplay(def.q, v) / step) * step)));
      fromPos = (p, end) => (end === 0 && p <= min ? -Infinity : end === 1 && p >= max ? Infinity : fromDisplay(def.q, p));
    }
    const conv = (v: [number, number]): [number, number] => [fromPos(v[0], 0), fromPos(v[1], 1)];
    const apply = (v: [number, number], final: boolean) => {
      const r = conv(v);
      onLabel(r);
      this.state[def.v] = r;
      this.preset = null;
      if (final) {
        this.els.panel.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      }
      this.requery();
    };
    return new RangeSlider({
      min,
      max,
      step,
      // bin stops are edges: two thumbs on one edge would select no bin at all
      minGap: def.kind === 'bins' ? 1 : 0,
      value: [toPos(cur[0], 0), toPos(cur[1], 1)],
      label: def.label,
      onInput: (v) => apply(v, false),
      onChange: (v) => apply(v, true),
    });
  }

  // ---------- bottom bar: "when" ----------
  private renderBottom() {
    const b = this.els.bottom;
    clear(b);
    this.dateRange = undefined;
    this.dateLabel = undefined;
    if (this.mode === 'now') {
      this.renderNowBar();
      return;
    }
    if (this.mode !== 'date') {
      b.classList.add('hidden');
      return;
    }
    b.classList.remove('hidden');
    this.dateRange = h('input', {
      type: 'range',
      class: 'single-range',
      min: 0,
      max: 364,
      step: 1,
      value: this.doy,
      'aria-label': 'Date',
      oninput: () => {
        this.stopPlay();
        this.setDoy(+this.dateRange!.value);
      },
    });
    this.dateLabel = h('span', { class: 'timeline-label' }, doyLabel(this.doy, true));
    const ticks = h('div', { class: 'ticks' });
    MONTHS.forEach((m, i) => {
      const s = h('span', {}, m);
      s.style.left = `${((MONTH_START[i] + 15) / 364) * 100}%`;
      ticks.append(s);
    });
    const play = h('button', { class: 'play', 'aria-label': 'Play through the year', onclick: () => (this.playing ? this.stopPlay() : this.play()) }, '▶');
    b.append(
      play,
      h(
        'div',
        { class: 'timeline' },
        h('div', { class: 'timeline-top' }, this.dateLabel, h('span', { class: 'timeline-sub' }, 'chance of a matching day, ± 10 days')),
        this.dateRange,
        ticks,
      ),
    );
  }

  /** Switch between "days per year", "chance on a date" and "right now". */
  private async setWhen(m: Mode) {
    if (m !== 'date') this.stopPlay();
    if (this.mode === m) return;
    this.mode = m;
    this.renderPanel();
    this.renderBottom();
    await this.field.fadeTo(0, 120);
    if (this.mode !== m) return;
    this.lastMode = null;
    this.requery();
  }

  // ---------- right now (live forecast) ----------
  private nowRange(): [number, number] {
    const start = Math.floor(Date.now() / HOUR) * HOUR;
    const end = this.live?.cycle ? Math.min(this.live.maxTime, start + 72 * HOUR) : start + 72 * HOUR;
    return [start, end];
  }

  private renderNowBar() {
    const b = this.els.bottom;
    b.classList.remove('hidden');
    const [t0, t1] = this.nowRange();
    this.nowTime = Math.min(t1, Math.max(t0, this.nowTime));
    const label = h('span', { class: 'timeline-label' }, timeLabel(this.nowTime));
    const range = h('input', {
      type: 'range',
      class: 'single-range',
      min: 0,
      max: Math.round((t1 - t0) / HOUR),
      step: 1,
      value: Math.round((this.nowTime - t0) / HOUR),
      'aria-label': 'Forecast time',
      oninput: () => {
        this.nowTime = t0 + +range.value * HOUR;
        label.textContent = timeLabel(this.nowTime);
        clearTimeout(this.nowTimer);
        this.nowTimer = window.setTimeout(() => this.refreshNow(), 120);
      },
    });
    const ticks = h('div', { class: 'ticks' });
    const midnight = new Date(t0);
    midnight.setHours(24, 0, 0, 0);
    for (let t = midnight.getTime(); t < t1; t += 24 * HOUR) {
      const sp = h('span', {}, new Date(t).toLocaleDateString(undefined, { weekday: 'short' }));
      sp.style.left = `${((t - t0) / (t1 - t0)) * 100}%`;
      ticks.append(sp);
    }
    b.append(
      h('div', { class: 'now-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'timeline' }, h('div', { class: 'timeline-top' }, label, h('span', { class: 'timeline-sub' }, 'live forecast · NOAA GFS')), range, ticks),
    );
  }

  private nowRanges(): [number, number, number, number][] {
    return this.nowSlots.map(({ c }) => {
      const n = NOW[c.v];
      return [c.lo, c.hi, n.soft, n.kind];
    });
  }

  /** Load the live fields the conditions need for the chosen hour, then update the map. */
  private async refreshNow() {
    if (!this.active || this.mode !== 'now') return;
    const token = ++this.nowToken;
    const crit = this.criteria();
    const slow = setTimeout(() => this.setStatus('Loading the live forecast…'), 250);
    try {
      await this.liveReady;
      const live = this.live;
      if (!live?.cycle) throw new Error('live forecast unavailable');
      const fh = Math.max(0, Math.min(120, Math.round((this.nowTime - live.cycle.time) / HOUR)));
      const key = `${live.cycle.time}:${fh}:${crit.map((c) => NOW[c.v].v).join(',')}`;
      if (key !== this.nowKey) {
        const vars = crit.map((c) => NOW[c.v].v);
        const [fields, temp] = await Promise.all([
          Promise.all(vars.map((v) => (v ? live.get(v, fh).then((f) => f.values) : Promise.resolve(null)))),
          live.get('temp', fh).then((f) => f.values),
        ]);
        if (token !== this.nowToken || this.mode !== 'now') return;
        this.field.setMatchFields(GFS_GRID, fields);
        this.nowKey = key;
        this.nowTemp = temp;
        this.nowSlots = crit.map((c, i) => ({ c, data: fields[i] }));
      } else {
        // same fields: only the ranges changed
        this.nowSlots = crit.map((c, i) => ({ c, data: this.nowSlots[i]?.data ?? null }));
      }
      live.time = this.nowTime;
      this.field.setMatchRanges(this.nowRanges(), utcDoy(this.nowTime));
      if (this.lastMode !== 'now') {
        this.field.setPalette(MATCH);
        this.field.mode = 2;
        this.field.opacity = 1;
        this.lastMode = 'now';
        this.field.fadeTo(1, 280);
      }
      this.renderLegendBox();
      clearTimeout(this.cutTimer);
      this.cutTimer = window.setTimeout(() => this.updateCities(), 150);
      this.setStatus('');
    } catch (e) {
      if (token === this.nowToken) this.setStatus(`Live forecast unavailable: ${(e as Error).message}`, false, true);
    } finally {
      clearTimeout(slow);
    }
  }

  /** Does the live forecast meet every condition at this city? (hard bounds) */
  private nowMatches(c: City): boolean {
    const orog = this.live?.orog;
    const doy = utcDoy(this.nowTime);
    for (const { c: cr, data } of this.nowSlots) {
      const n = NOW[cr.v];
      let v: number;
      if (n.kind === 3) v = daylightHours(c.lat, doy);
      else if (!data) return false;
      else v = bilinear(data, c.lon, c.lat);
      if (n.kind === 1 && orog) v += LAPSE * (bilinear(orog, c.lon, c.lat) - (c.elev ?? demAt(this.dem, c.lon, c.lat)));
      if (n.kind === 2) v = Math.max(0, v) * 24;
      if (v < cr.lo || v > cr.hi) return false;
    }
    return true;
  }


  private setDoy(d: number) {
    this.doy = ((Math.round(d) % 365) + 365) % 365;
    if (this.mode !== 'date') {
      this.setWhen('date');
      return;
    }
    if (this.dateLabel) this.dateLabel.textContent = doyLabel(this.doy, true);
    if (this.dateRange) this.dateRange.value = String(this.doy);
    this.requery();
  }

  private play() {
    if (this.mode !== 'date') this.setWhen('date');
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '❚❚';
    let last = performance.now();
    let pos = this.doy;
    const tick = (now: number) => {
      if (!this.playing) return;
      pos += ((now - last) / 1000) * 12; // 12 days per second
      last = now;
      if (Math.round(pos) !== this.doy && !this.inflight) this.setDoy(pos);
      this.playing = requestAnimationFrame(tick);
    };
    this.playing = requestAnimationFrame(tick);
  }

  private stopPlay() {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = 0;
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '▶';
  }

  // ---------- legend & labels ----------
  private renderLegendBox() {
    if (this.mode === 'now') {
      renderLegend(this.els.legend, 'Matches', timeLabel(this.nowTime), MATCH, [
        { value: 0, label: 'no' },
        { value: 1, label: 'yes' },
      ]);
      return;
    }
    if (!this.result) return;
    // fixed square-root scale of the fraction of days (see the shader)
    if (this.result.mode === 'days') {
      const ticks = [0, 7, 30, 90, 180, 365].map((d) => ({ value: Math.sqrt(d / 365), label: `${d}` }));
      renderLegend(this.els.legend, 'Matching days', 'per year', SCORE, ticks);
    } else {
      const ticks = [0, 0.1, 0.25, 0.5, 1].map((p) => ({ value: Math.sqrt(p), label: `${p * 100}%` }));
      renderLegend(this.els.legend, 'Chance of a matching day', doyLabel(this.result.doy), SCORE, ticks);
    }
    if (this.field.cut > 0) {
      const bar = this.els.legend.querySelector('.legend-bar') as HTMLElement;
      const mk = h('div', { class: 'legend-cut' });
      mk.style.left = `${Math.sqrt(Math.min(1, this.field.cut)) * 100}%`;
      bar.append(mk);
    }
  }

  /** Sample the result at a point, blending cells exactly like the shader (see blend.ts). */
  private sampleResult(lon: number, lat: number, elev?: number, mc?: MicroCoefs | null): number {
    const r = this.result, g = this.meta?.grid, et = this.cellElevTex;
    if (!r || !g || !et) return NaN;
    const z = elev ?? demAt(this.dem, lon, lat);
    const n = g.nx * g.ny;
    // a blend at elevation zz from result group gi (as the shader's climBlend)
    const blend = (zz: number, gi: number) => {
      const { taps, cover } = blendTaps(g, (p) => (et[p * 2 + 1] ? et[p * 2] : undefined), lon, lat, zz);
      if (cover < 0.04) return NaN;
      let v = 0, sq = 0;
      const o = gi * LEVELS;
      for (const t of taps) {
        const lvl = levelOf(t.dz);
        const l0 = Math.floor(lvl), l1 = Math.min(LEVELS - 1, l0 + 1), f = lvl - l0;
        v += t.q * ((1 - f) * r.data[((o + l0) * n + t.p) * 2] + f * r.data[((o + l1) * n + t.p) * 2]);
        sq += t.q;
      }
      return v / Math.max(sq, 1e-20);
    };
    // microclimate: a spot warmer than its cells matches like a lower one (same rules as the shader)
    const mv = this.microVar();
    let v: number;
    if (mc && mv && r.groups > 1) {
      const annual = microOffset(mc, mv, [1, 0, 0, 0, 0]);
      const rs = SEASON_WEIGHTS.map((w) => microOffset(mc, mv, w));
      v = Math.max(...rs.map((x) => Math.abs(x - annual))) > 0.25 ? rs.reduce((s, x, i) => s + blend(z - x / LAPSE, 1 + i), 0) : blend(z - annual / LAPSE, 0);
    } else if (mc && mv) {
      v = blend(z - microOffset(mc, mv, SEASON_WEIGHTS[seasonOf(r.doy)]) / LAPSE, 0);
    } else v = blend(z, 0);
    return v * (r.mode === 'days' ? r.scaleMax : 1);
  }

  /** Which microclimate offset the conditions use: highs (feels-like, highs), lows, or both. */
  private microVar(): MicroVar {
    const vs = Object.keys(this.state);
    const hi = vs.includes('feels') || vs.includes('tmax'), lo = vs.includes('tmin');
    return hi && lo ? 3 : hi ? 1 : lo ? 2 : 0;
  }

  /** Hand the microclimate settings for the current conditions and date to the map. */
  private applyMicro() {
    this.field.microVar = this.microVar();
    this.field.microW.set(SEASON_WEIGHTS[seasonOf(this.doy)]);
    SEASON_WEIGHTS.forEach((w, s) => this.field.microSeasonW.set(w, s * 5));
  }

  /** Offsets used for labels: only while the map shows them (zoomed in), so labels match the colours. */
  private cityMicro(c: City): MicroCoefs | null {
    return this.micro?.shown ? cityCoefs(c.mc, this.micro.scale) : null;
  }

  private formatScore(v: number) {
    if (!Number.isFinite(v)) return '';
    return this.result?.mode === 'days' ? `${Math.round(v)} d` : `${Math.round(v * 100)}%`;
  }

  private cityLabel(c: City): string {
    if (this.mode === 'now') {
      if (!this.nowTemp || !this.nowMatches(c)) return '';
      let t = bilinear(this.nowTemp, c.lon, c.lat);
      const orog = this.live?.orog;
      if (orog) t += LAPSE * (bilinear(orog, c.lon, c.lat) - (c.elev ?? demAt(this.dem, c.lon, c.lat)));
      return `✓ ${fmt('temp', t)}`;
    }
    const v = this.sampleResult(c.lon, c.lat, c.elev ?? undefined, this.cityMicro(c));
    const r = this.result;
    if (r && Number.isFinite(v)) {
      const below = r.mode === 'days' ? this.cut.days > 0 && v < this.cut.days : this.cut.date > 0 && v < this.cut.date;
      if (below) return '';
    }
    return this.formatScore(v);
  }

  updateCities() {
    const src = this.map.getSource('cities') as GeoJSONSource | undefined;
    if (!src || !this.active) return;
    src.setData(cityFeatures(this.map, this.cities, (c) => this.cityLabel(c)));
  }

  // ---------- location card ----------
  async showCard(lon: number, lat: number, quiet = false, placeP?: Promise<Place | null>) {
    if (this.mode === 'now' && this.nowCard) {
      if (!quiet) {
        this.cardAt = null;
        if (this.live) this.live.time = this.nowTime;
        this.nowCard(lon, lat, placeP);
      }
      return;
    }
    this.cardAt = [lon, lat];
    const card = this.els.card;
    if (placeP) this.cardPlace = placeP.catch(() => null);
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => ((this.cardAt = null), hideTip(), this.closeCard()) }, '✕');
    let title = '…';
    let detail = '';
    if (!quiet) {
      clear(card);
      card.classList.remove('hidden');
      card.append(close, h('div', { class: 'place' }, title), h('div', { class: 'coords' }, coordLabel(lon, lat)), h('div', { class: 'desc' }, 'Loading climate…'));
    }
    await this.ready;
    const [pe, place] = await Promise.all([pointElevation(lon, lat).catch(() => null), this.cardPlace]);
    const dem = pe ?? demAt(this.dem, lon, lat);
    title = place?.name ?? 'Selected location';
    detail = place?.detail ?? '';
    const crit = this.criteria();
    const base = crit.filter((c) => c.v !== 'daylight').map((c) => c.v as ClimVar);
    const render = (res: DetailResult | null) => {
      if (this.cardAt?.[0] !== lon || this.cardAt?.[1] !== lat) return;
      hideTip();
      clear(card);
      card.classList.remove('hidden');
      card.append(close, h('div', { class: 'place' }, title), h('div', { class: 'coords' }, [detail, coordLabel(lon, lat), units.imperial ? `${Math.round(dem * 3.281)} ft` : `${Math.round(dem)} m`].filter(Boolean).join(' · ')));
      if (!res) {
        card.append(h('div', { class: 'desc' }, 'No climate data here (open ocean or Antarctica).'));
        return;
      }
      const date = this.mode === 'date';
      const big = date ? `${Math.round(res.daily[this.doy] * 100)}%` : `${Math.round(res.perYear)}`;
      card.append(
        h('div', { class: 'big' }, big, h('small', {}, date ? `chance around ${doyLabel(this.doy)}` : 'matching days a year')),
        summary(res),
        h('h3', {}, 'Chance of a matching day'),
        yearChart(res, date ? this.doy : -1, this.state),
        h('h3', {}, 'Month by month'),
        monthTable(res),
      );
      const missing = (['cloud', 'dew', 'rh', 'uv', 'aqi', 'wind', 'snow', 'snowfall', 'sst'] as ClimVar[]).filter((v) => !res.loaded.includes(v));
      if (missing.length && this.meta) {
        const mb = missing.reduce((s, v) => s + this.meta!.vars[v].bytes, 0) / 1e6;
        card.append(
          h(
            'button',
            { class: 'chip', style: 'margin-top:10px', onclick: () => this.detail(lon, lat, dem, crit, [...base, ...missing, 'feels', 'tmax', 'tmin', 'precip', 'sun', 'cloud']).then(render) },
            `+ Clouds, humidity, UV, air, wind, snow & sea (${mb.toFixed(1)} MB)`,
          ),
        );
      }
      card.append(sourceNote(res, dem));
    };
    try {
      // fast pass with what is already loaded, then fill in the normals
      render(await this.detail(lon, lat, dem, crit, base));
      render(await this.detail(lon, lat, dem, crit, [...base, 'feels', 'tmax', 'tmin', 'precip', 'sun']));
    } catch (e) {
      card.querySelector('.desc')?.replaceChildren(`Could not load: ${(e as Error).message}`);
    }
  }

  private async detail(lon: number, lat: number, dem: number, crit: Criterion[], vars: ClimVar[]): Promise<DetailResult | null> {
    const mc = (await this.micro?.at(lon, lat).catch(() => null)) ?? null;
    const micro = mc ? { coefs: Array.from(mc), v: this.microVar() } : null;
    const m = await this.call({ type: 'detail', lon, lat, dem, crit, vars: [...new Set(vars)], micro });
    this.setStatus('');
    return m.result;
  }

  // ---------- URL state ----------
  private writeUrl(clearIt = false) {
    const u = new URL(location.href);
    if (clearIt) {
      u.searchParams.delete('c');
      u.searchParams.delete('d');
      u.searchParams.delete('view');
    } else {
      const enc = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '');
      u.searchParams.set('c', Object.entries(this.state).map(([k, [a, b]]) => `${k}:${enc(a)}:${enc(b)}`).join(','));
      if (this.mode === 'date') u.searchParams.set('d', String(this.doy));
      else u.searchParams.delete('d');
      if (this.mode === 'now') u.searchParams.set('view', 'now');
      else u.searchParams.delete('view');
    }
    history.replaceState(null, '', u);
  }

  private readUrl(): CritState | null {
    const u = new URL(location.href);
    const d = u.searchParams.get('d');
    if (d !== null && Number.isFinite(+d)) {
      this.doy = Math.min(364, Math.max(0, +d));
      this.mode = 'date';
    }
    if (u.searchParams.get('mode') === 'date') this.mode = 'date';
    if (u.searchParams.get('view') === 'now') this.mode = 'now';
    const c = u.searchParams.get('c');
    if (c === null) return null;
    const s: CritState = {};
    for (const part of c.split(',')) {
      const [k, a, b] = part.split(':');
      if (!CRITERIA.some((x) => x.v === k)) continue;
      s[k as CritVar] = [a === '' || a === undefined ? -Infinity : +a, b === '' || b === undefined ? Infinity : +b];
    }
    this.preset = null;
    return s;
  }
}

// ---------- helpers ----------
/**
 * The range a condition actually tests. Sliders move in whole display steps,
 * so "70–70 °F" means any day that rounds to 70 °F: each finite bound is
 * widened by half a step in the units on screen. Binned conditions
 * (precipitation, wind, snow) stop on bin edges and are used as they are.
 */
function testedRange(def: CritDef, [lo, hi]: [number, number]): [number, number] {
  if (def.kind === 'bins') return [lo, hi];
  const step = (units.imperial ? def.imperial! : def.metric!).step;
  const snap = (v: number) => Math.round(toDisplay(def.q, v) / step) * step;
  return [
    Number.isFinite(lo) ? fromDisplay(def.q, snap(lo) - step / 2) : lo,
    Number.isFinite(hi) ? fromDisplay(def.q, snap(hi) + step / 2) : hi,
  ];
}

function describe(def: CritDef, [lo, hi]: [number, number]): string {
  const f = (v: number) => (def.q === 'percent' ? `${Math.round(v)}%` : def.q === 'temp' ? fmt('temp', v) : fmt(def.q, v));
  const u = def.q === 'temp' ? unitLabel('temp').slice(1) : '';
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return 'any';
  if (!Number.isFinite(lo)) return `≤ ${f(hi)}${u}`;
  if (!Number.isFinite(hi)) return `≥ ${f(lo)}${u}`;
  if (f(lo) === f(hi)) return `${f(lo)}${u}`;
  if (def.q === 'temp') return `${Math.round(toDisplay('temp', lo))}–${f(hi)}${u}`;
  return `${f(lo)} – ${f(hi)}`;
}

export { cssGradient };
