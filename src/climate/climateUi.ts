/**
 * Climate finder UI: conditions panel (presets, active conditions, grouped
 * "add condition" menu), one "when" control (all year, or a date on the
 * slider), legend, city labels with results, and a location card with
 * monthly normals.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FieldLayer } from '../map/fieldLayer';
import { SCORE, cssGradient } from '../map/palettes';
import { demAt, type City, type Dem } from '../data';
import type { Place } from '../geocode';
import { pointElevation } from '../map/localDem';
import { h, clear } from '../ui/dom';
import { RangeSlider } from '../ui/rangeSlider';
import { renderLegend } from '../ui/legend';
import { MONTHS, MONTH_START, coordLabel, doyLabel, todayDoy } from '../ui/format';
import { fmt, fromDisplay, toDisplay, unitLabel, units } from '../units';
import { CRITERIA, GROUPS, PRESETS, type CritDef, type CritState } from './criteria';
import { DZ0, DZ_STEP, LEVELS, type ClimVar, type ClimateMeta, type CritVar, type Criterion, type DetailResult } from './types';

type Els = { panel: HTMLElement; bottom: HTMLElement; legend: HTMLElement; card: HTMLElement };
type Mode = 'days' | 'date';
const HALF_WINDOW = 10;

export class ClimateUI {
  private worker: Worker;
  private meta?: ClimateMeta;
  private ready: Promise<void>;
  private mode: Mode = 'days';
  private state: CritState;
  private preset: string | null = 'perfect';
  private doy = todayDoy();
  private seq = 0;
  private inflight = false;
  private dirty = false;
  private result?: { data: Float32Array; scaleMax: number; mode: Mode; doy: number };
  private cellElevTex?: Float32Array;
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
    this.field.lapse = 0;
    this.field.useAlt = 0;
    this.field.opacity = 0.92;
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
  private criteria(): Criterion[] {
    return (Object.entries(this.state) as [CritVar, [number, number]][]).map(([v, [lo, hi]]) => ({ v, lo, hi }));
  }

  private setState(s: CritState, preset: string | null) {
    this.state = structuredClone(s);
    this.preset = preset;
    this.renderPanel();
    this.requery();
  }

  private requery() {
    if (!this.meta || !this.active) return;
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    const mode = this.mode, doy = this.doy;
    const crit = this.criteria();
    const slow = setTimeout(() => this.setStatus('Crunching 25 years of weather…'), 400);
    this.call({ type: 'query', crit, mode, doy, half: HALF_WINDOW })
      .then((m) => {
        if (!this.active) return;
        console.debug(`climate query (${mode}) ${m.ms.toFixed(0)} ms`);
        this.result = { data: m.data, scaleMax: m.scaleMax, mode, doy };
        this.field.mode = 1;
        this.field.setClimateResult(m.data);
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
    const year = this.mode === 'days';
    p.append(
      h('h2', {}, 'Find your climate'),
      h(
        'p',
        { class: 'hint' },
        year
          ? 'Days per year that match all of your conditions, from 25 years of weather history (2001–2025). Pick a date below to see the chance on a given day.'
          : `Chance that a day around ${doyLabel(this.doy, true)} matches all of your conditions (2001–2025).`,
      ),
    );
    const presets = h('div', { class: 'presets' });
    for (const pr of PRESETS)
      presets.append(
        h('button', { class: 'chip', 'aria-pressed': String(this.preset === pr.id), onclick: () => this.setState(pr.state, pr.id) }, `${pr.icon} ${pr.label}`),
      );
    p.append(presets);

    const list = h('div', { class: 'conds' });
    const active = CRITERIA.filter((d) => d.v in this.state);
    for (const def of active) list.append(this.condRow(def));
    if (!active.length) list.append(h('div', { class: 'empty' }, 'No conditions yet — every day counts. Add one below.'));
    p.append(h('div', { class: 'section-title' }, 'Your conditions'), list, this.addMenu());
    p.append(this.cutRow());
    p.append(
      h(
        'div',
        { class: 'run-info' },
        'Mountains are adjusted to local elevation (−6.5 °C per km). Daily values use local solar time. Tap the map for monthly details.',
      ),
    );
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
    return h('div', { class: 'cond', title: def.hint }, h('div', { class: 'cond-head' }, h('span', { class: 'cond-name' }, def.label), val, remove), sl.el);
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
    const fmtCut = (x: number) => (x <= 0 ? 'off' : days ? `≥ ${x} days/yr` : `≥ ${Math.round(x * 100)}%`);
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
      h('div', { class: 'cond-head' }, h('span', { class: 'cond-name' }, days ? 'Only highlight places with at least' : 'Only highlight a chance of at least'), val),
      h('div', { class: 'cut-range' }, input),
    );
  }

  private applyCut() {
    const r = this.result;
    if (!r) return;
    this.field.cut = r.mode === 'days' ? (this.cut.days > 0 ? Math.min(1, this.cut.days / r.scaleMax) : 0) : this.cut.date;
    this.field.repaint();
    this.renderLegendBox();
    clearTimeout(this.cutTimer);
    this.cutTimer = window.setTimeout(() => this.updateCities(), 150);
  }
  private cutTimer = 0;

  private defaultRange(def: CritDef): [number, number] {
    const I = Infinity;
    const d: Partial<Record<CritVar, [number, number]>> = {
      feels: [18, 28], tmax: [18, 28], tmin: [10, 22], dew: [-I, 16], cloud: [-I, 50], precip: [-I, 1],
      wind: [-I, 30], snow: [10, I], sst: [22, I], daylight: [10, I],
    };
    return d[def.v] ?? [-I, I];
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
    b.classList.remove('hidden');
    const year = this.mode === 'days';
    this.dateRange = h('input', {
      type: 'range',
      class: `single-range${year ? ' idle' : ''}`,
      min: 0,
      max: 364,
      step: 1,
      value: this.doy,
      'aria-label': 'Day of year',
      oninput: () => {
        this.stopPlay();
        this.setDoy(+this.dateRange!.value);
      },
    });
    this.dateLabel = h('span', { class: 'timeline-label' }, year ? 'All year' : doyLabel(this.doy, true));
    const ticks = h('div', { class: 'ticks' });
    MONTHS.forEach((m, i) => {
      const s = h('span', {}, m);
      s.style.left = `${((MONTH_START[i] + 15) / 364) * 100}%`;
      ticks.append(s);
    });
    const play = h('button', { class: 'play', 'aria-label': 'Play through the year', onclick: () => (this.playing ? this.stopPlay() : this.play()) }, '▶');
    const seg = h(
      'div',
      { class: 'seg', role: 'tablist', 'aria-label': 'When' },
      h('button', { role: 'tab', 'aria-selected': String(year), onclick: () => this.setWhen('days') }, 'All year'),
      h('button', { role: 'tab', 'aria-selected': String(!year), onclick: () => this.setWhen('date') }, 'On a date'),
    );
    b.append(
      play,
      h(
        'div',
        { class: 'timeline' },
        h('div', { class: 'timeline-top' }, this.dateLabel, h('span', { class: 'timeline-sub' }, year ? 'days per year' : `± ${HALF_WINDOW} days`), seg),
        this.dateRange,
        ticks,
      ),
    );
  }

  /** Switch between "days per year" and "chance on a date". */
  private setWhen(m: Mode) {
    if (m === 'days') this.stopPlay();
    if (this.mode === m) return;
    this.mode = m;
    this.renderPanel();
    this.renderBottom();
    this.requery();
  }

  private setDoy(d: number) {
    this.doy = ((Math.round(d) % 365) + 365) % 365;
    if (this.mode !== 'date') {
      this.setWhen('date');
      return;
    }
    if (this.dateLabel) this.dateLabel.textContent = doyLabel(this.doy, true);
    if (this.dateRange) this.dateRange.value = String(this.doy);
    const hint = this.els.panel.querySelector('.hint');
    if (hint) hint.textContent = `Chance that a day around ${doyLabel(this.doy, true)} matches all of your conditions (2001–2025).`;
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
    if (!this.result) return;
    if (this.result.mode === 'days') {
      const m = this.result.scaleMax;
      const ticks = [0, m / 4, m / 2, (3 * m) / 4, m].map((v) => ({ value: v / m, label: `${Math.round(v)}` }));
      ticks[4].label = m >= 365 ? '365' : `${m}+`;
      renderLegend(this.els.legend, 'Matching days', 'per year', SCORE, ticks);
    } else {
      renderLegend(this.els.legend, 'Chance of a matching day', doyLabel(this.result.doy), SCORE, [0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: `${v * 100}%` })));
    }
    if (this.field.cut > 0) {
      const bar = this.els.legend.querySelector('.legend-bar') as HTMLElement;
      const mk = h('div', { class: 'legend-cut' });
      mk.style.left = `${this.field.cut * 100}%`;
      bar.append(mk);
    }
  }

  /** Bilinear sample of the result (same logic as the shader, minus the cubic smoothing). */
  private sampleResult(lon: number, lat: number, elev?: number): number {
    const r = this.result, g = this.meta?.grid, et = this.cellElevTex;
    if (!r || !g || !et) return NaN;
    const x = (lon - g.lon0) / g.dx, y = (g.lat0 - lat) / g.dy;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let ez = 0, ew = 0;
    const taps: [number, number, number][] = [];
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= g.ny) continue;
      const xx = (((x0 + dx) % g.nx) + g.nx) % g.nx;
      const p = yy * g.nx + xx;
      if (!et[p * 2 + 1]) continue;
      ez += et[p * 2] * w;
      ew += w;
      taps.push([p, w, 0]);
    }
    if (ew < 0.05) return NaN;
    const lvl = Math.min(LEVELS - 1, Math.max(0, ((elev ?? demAt(this.dem, lon, lat)) - ez / ew - DZ0) / DZ_STEP));
    const l0 = Math.floor(lvl), l1 = Math.min(LEVELS - 1, l0 + 1), f = lvl - l0;
    const n = g.nx * g.ny;
    let v = 0;
    for (const [p, w] of taps) v += w * ((1 - f) * r.data[(l0 * n + p) * 2] + f * r.data[(l1 * n + p) * 2]);
    return (v / ew) * (r.mode === 'days' ? r.scaleMax : 1);
  }

  private formatScore(v: number) {
    if (!Number.isFinite(v)) return '';
    return this.result?.mode === 'days' ? `${Math.round(v)} d` : `${Math.round(v * 100)}%`;
  }

  private cityLabel(c: City): string {
    const v = this.sampleResult(c.lon, c.lat, c.elev ?? undefined);
    const r = this.result;
    if (r && Number.isFinite(v)) {
      const below = r.mode === 'days' ? this.cut.days > 0 && v < this.cut.days : this.cut.date > 0 && v < this.cut.date;
      if (below) return '';
    }
    return this.formatScore(v);
  }

  private updateCities() {
    const src = this.map.getSource('cities') as GeoJSONSource | undefined;
    if (!src || !this.active) return;
    src.setData({
      type: 'FeatureCollection',
      features: this.cities.map((c) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
        properties: { name: c.name, label: this.cityLabel(c), rank: c.rank, minzoom: c.minzoom },
      })),
    });
  }

  // ---------- location card ----------
  async showCard(lon: number, lat: number, quiet = false, placeP?: Promise<Place | null>) {
    this.cardAt = [lon, lat];
    const card = this.els.card;
    if (placeP) this.cardPlace = placeP.catch(() => null);
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => ((this.cardAt = null), this.closeCard()) }, '✕');
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
      clear(card);
      card.classList.remove('hidden');
      card.append(close, h('div', { class: 'place' }, title), h('div', { class: 'coords' }, [detail, coordLabel(lon, lat), `${Math.round(dem)} m`].filter(Boolean).join(' · ')));
      if (!res) {
        card.append(h('div', { class: 'desc' }, 'No climate data here (open ocean or Antarctica).'));
        return;
      }
      const date = this.mode === 'date';
      const big = date ? `${Math.round(res.daily[this.doy] * 100)}%` : `${Math.round(res.perYear)}`;
      card.append(
        h('div', { class: 'big' }, big, h('small', {}, date ? `chance around ${doyLabel(this.doy)}` : 'matching days a year')),
        h('div', { class: 'desc' }, bestMonths(res)),
        h('h3', {}, 'Chance of a matching day through the year'),
        yearChart(res.daily, date ? this.doy : -1),
        h('h3', {}, 'Monthly climate'),
        normalsTable(res),
      );
      const missing = (['dew', 'wind', 'snow', 'sst'] as ClimVar[]).filter((v) => !res.loaded.includes(v));
      if (missing.length && this.meta) {
        const mb = missing.reduce((s, v) => s + this.meta!.vars[v].bytes, 0) / 1e6;
        card.append(
          h(
            'button',
            { class: 'chip', style: 'margin-top:10px', onclick: () => this.detail(lon, lat, dem, crit, [...base, ...missing, 'feels', 'tmax', 'tmin', 'precip', 'cloud']).then(render) },
            `+ Humidity, wind, snow & sea (${mb.toFixed(1)} MB)`,
          ),
        );
      }
      card.append(
        h(
          'div',
          { class: 'note' },
          `ERA5 grid cell at ${coordLabel(res.cellLon, res.cellLat)} (avg. ${res.cellElev} m); temperatures shifted ${res.shift >= 0 ? '+' : '−'}${Math.abs(units.imperial ? res.shift * 1.8 : res.shift).toFixed(1)}° for this spot's elevation. One sampled day per calendar day, drawn from 2001–2025.`,
        ),
      );
    };
    try {
      // fast pass with what is already loaded, then fill in the normals
      render(await this.detail(lon, lat, dem, crit, base));
      render(await this.detail(lon, lat, dem, crit, [...base, 'feels', 'tmax', 'tmin', 'precip', 'cloud']));
    } catch (e) {
      card.querySelector('.desc')?.replaceChildren(`Could not load: ${(e as Error).message}`);
    }
  }

  private async detail(lon: number, lat: number, dem: number, crit: Criterion[], vars: ClimVar[]): Promise<DetailResult | null> {
    const m = await this.call({ type: 'detail', lon, lat, dem, crit, vars: [...new Set(vars)] });
    this.setStatus('');
    return m.result;
  }

  // ---------- URL state ----------
  private writeUrl(clearIt = false) {
    const u = new URL(location.href);
    if (clearIt) {
      u.searchParams.delete('c');
      u.searchParams.delete('d');
    } else {
      const enc = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '');
      u.searchParams.set('c', Object.entries(this.state).map(([k, [a, b]]) => `${k}:${enc(a)}:${enc(b)}`).join(','));
      if (this.mode === 'date') u.searchParams.set('d', String(this.doy));
      else u.searchParams.delete('d');
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
function describe(def: CritDef, [lo, hi]: [number, number]): string {
  const f = (v: number) => (def.q === 'percent' ? `${Math.round(v)}%` : def.q === 'temp' ? fmt('temp', v) : fmt(def.q, v));
  const u = def.q === 'temp' ? unitLabel('temp').slice(1) : '';
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return 'any';
  if (!Number.isFinite(lo)) return `≤ ${f(hi)}${u}`;
  if (!Number.isFinite(hi)) return `≥ ${f(lo)}${u}`;
  if (def.q === 'temp') return `${Math.round(toDisplay('temp', lo))}–${f(hi)}${u}`;
  return `${f(lo)} – ${f(hi)}`;
}

function bestMonths(r: DetailResult): string {
  const m = r.months.map((x, i) => ({ i, v: (x.match ?? 0) / (MONTH_START[i + 1] - MONTH_START[i]) }));
  const top = [...m].sort((a, b) => b.v - a.v).filter((x) => x.v > 0.05).slice(0, 3);
  if (!top.length) return 'Rarely matches your conditions at any time of year.';
  return `Best months: ${top.map((x) => `${MONTHS[x.i]} (${Math.round(x.v * 100)}%)`).join(', ')}`;
}

function yearChart(daily: Float32Array, mark: number): SVGSVGElement {
  const W = 346, H = 96, top = 8, bottom = 16;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  let peak = 0;
  for (const v of daily) peak = Math.max(peak, v);
  const ymax = [0.1, 0.2, 0.3, 0.5, 0.75, 1].find((m) => m >= peak * 1.05) ?? 1;
  const x = (d: number) => (d / 364) * W;
  const y = (v: number) => top + (1 - v / ymax) * (H - top - bottom);
  let d = `M0,${y(0)}`;
  for (let i = 0; i < daily.length; i++) d += `L${x(i).toFixed(1)},${y(daily[i]).toFixed(1)}`;
  d += `L${W},${y(0)}Z`;
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = 'yc';
  grad.setAttribute('x1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y1', '1');
  grad.setAttribute('y2', '0');
  grad.innerHTML = '<stop offset="0" stop-color="#b4e0b0"/><stop offset="0.4" stop-color="#3eaec4"/><stop offset="1" stop-color="#1c3a85"/>';
  const defs = document.createElementNS(ns, 'defs');
  defs.append(grad);
  svg.append(defs);
  for (const g of [ymax / 2, ymax]) {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', '0');
    l.setAttribute('x2', String(W));
    l.setAttribute('y1', String(y(g)));
    l.setAttribute('y2', String(y(g)));
    l.setAttribute('stroke', 'rgba(0,0,0,0.08)');
    svg.append(l);
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'url(#yc)');
  path.setAttribute('opacity', '0.9');
  svg.append(path);
  MONTHS.forEach((m, i) => {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(x(MONTH_START[i] + 15)));
    t.setAttribute('y', String(H - 3));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '9');
    t.setAttribute('fill', 'rgba(29,29,31,0.5)');
    t.textContent = m[0];
    svg.append(t);
  });
  if (mark >= 0) {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', String(x(mark)));
    l.setAttribute('x2', String(x(mark)));
    l.setAttribute('y1', String(top - 4));
    l.setAttribute('y2', String(H - bottom));
    l.setAttribute('stroke', '#1d1d1f');
    l.setAttribute('stroke-width', '1.5');
    svg.append(l);
  }
  const lab = document.createElementNS(ns, 'text');
  lab.setAttribute('x', '2');
  lab.setAttribute('y', String(y(ymax) + 9));
  lab.setAttribute('font-size', '9');
  lab.setAttribute('fill', 'rgba(29,29,31,0.45)');
  lab.textContent = `${Math.round(ymax * 100)}%`;
  svg.append(lab);
  return svg;
}

function normalsTable(r: DetailResult): HTMLTableElement {
  const rows: [string, string, (m: DetailResult['months'][number]) => string | undefined][] = [
    ['Matches', 'Days matching your conditions', (m) => (m.match === undefined ? undefined : String(Math.round(m.match)))],
    ['Feels hi', 'Average feels-like high', (m) => (m.feels === undefined ? undefined : fmt('temp', m.feels))],
    ['High', 'Average daytime high', (m) => (m.tmax === undefined ? undefined : fmt('temp', m.tmax))],
    ['Low', 'Average overnight low', (m) => (m.tmin === undefined ? undefined : fmt('temp', m.tmin))],
    ['Dew pt', 'Average daytime dew point (humidity)', (m) => (m.dew === undefined ? undefined : fmt('temp', m.dew))],
    ['Sunny', 'Days with daytime cloud cover ≤ 25%', (m) => (m.sunnyDays === undefined ? undefined : String(m.sunnyDays))],
    ['Rainy', 'Days with ≥ 1 mm of precipitation', (m) => (m.rainDays === undefined ? undefined : String(m.rainDays))],
    [`Precip ${unitLabel('precip')}`, 'Total precipitation in the month', (m) => (m.precip === undefined ? undefined : fmt('precip', m.precip, false))],
    ['Snowy', 'Days with ≥ 1 cm of snow on the ground', (m) => (m.snowDays === undefined ? undefined : String(m.snowDays))],
    [`Wind ${unitLabel('speed')}`, 'Average strongest daytime wind', (m) => (m.wind === undefined ? undefined : fmt('speed', m.wind, false))],
    ['Sea', 'Average nearby sea surface temperature', (m) => (m.sst === undefined ? undefined : fmt('temp', m.sst))],
  ];
  const t = h('table', { class: 'normals' });
  const head = h('tr', {}, h('th', {}, ''));
  MONTHS.forEach((m) => head.append(h('th', {}, m[0])));
  t.append(h('thead', {}, head));
  const body = h('tbody');
  for (const [label, title, f] of rows) {
    const cells = r.months.map(f);
    if (cells.every((c) => c === undefined)) continue;
    const tr = h('tr', { title }, h('td', {}, label));
    cells.forEach((c) => tr.append(h('td', {}, c ?? '—')));
    body.append(tr);
  }
  t.append(body);
  return t;
}

export { cssGradient };
