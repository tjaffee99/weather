/** Panel, timeline, legend and point card for live mode. */
import { LIVE_LAYERS, type LiveController } from './liveController';
import { h, clear } from '../ui/dom';
import { renderLegend } from '../ui/legend';
import { cssGradient } from '../map/palettes';
import { coordLabel, timeLabel } from '../ui/format';
import { GLACIER } from '../map/palettes';
import { anchorForecast, openMeteo, type PointForecast } from './pointForecast';
import { pm25FromAqi } from './aerosol';
import { CARD_TITLES, layerCard, placeClock, type CardKind } from './layerCard';
import { pointElevation } from '../map/localDem';
import { demAt, type Dem } from '../data';
import type { Place } from '../geocode';
import { fmt, fromDisplay, unitLabel, units } from '../units';
import type { LiveVar } from './gfs';

const HOUR = 3600_000;

export class LiveUI {
  private playing = 0;
  private range?: HTMLInputElement;
  private label?: HTMLElement;
  private cardToken = 0;
  /** last chosen variant per layer (e.g. temperature → feels like); clouds open on the satellite view */
  private variant = new Map<LiveVar, LiveVar>([['cloud', 'satellite']]);
  private obsTimer = 0;
  /** the open location card: its forecast is kept so switching layers redraws it instantly */
  private card?: {
    lon: number;
    lat: number;
    at: number;
    fc?: PointForecast;
    /** the map's temperature and feels-like here at `at` */
    now?: { temp: number; feels: number };
    error?: string;
    title: HTMLElement;
    sub: HTMLElement;
    body: HTMLElement;
    /** the full forecast, opened from a layer's card */
    full: boolean;
    air?: [number, number][];
    airLoading?: boolean;
  };

  constructor(
    private c: LiveController,
    private els: { panel: HTMLElement; bottom: HTMLElement; legend: HTMLElement; card: HTMLElement },
    private dem: Dem,
    private onCardClose: () => void,
  ) {
    c.onFrame = () => this.syncTime();
    c.onSwap = () => this.renderLegend();
    c.onTimeRange = () => {
      if (c.active) this.renderTimeline();
    };
  }

  enter() {
    this.renderPanel();
    this.renderTimeline();
    this.renderLegend();
    this.els.bottom.classList.remove('hidden');
  }

  exit() {
    this.stop();
    this.stopObs();
  }

  refreshUnits() {
    this.renderLegend();
    this.c.updateCities();
  }

  renderPanel() {
    const p = this.els.panel;
    clear(p);
    p.append(h('h2', {}, 'Live weather'));
    const list = h('div', { class: 'layer-list' });
    const cur = this.c.layer;
    for (const l of LIVE_LAYERS) {
      if (l.variantOf) continue;
      const variants = LIVE_LAYERS.filter((x) => x.variantOf === l.id);
      const active = cur.id === l.id || cur.variantOf === l.id;
      const sw = h('span', { class: 'sw' });
      sw.style.background = cssGradient(l.palette);
      list.append(
        h(
          'button',
          {
            class: 'layer-btn',
            'aria-pressed': String(active),
            onclick: () => {
              if (active) return;
              this.c.setLayer(variants.length ? this.variant.get(l.id) ?? l.id : l.id);
              this.renderPanel();
              this.refreshCard(true);
            },
          },
          h('span', { class: 'ic', 'aria-hidden': 'true' }, l.icon),
          l.label,
          sw,
        ),
      );
      if (active && variants.length) {
        const pick = (id: LiveVar) => {
          this.variant.set(l.id, id);
          if (id !== this.c.layer.id) this.c.setLayer(id);
          this.renderPanel();
          this.refreshCard(true);
        };
        list.append(
          h(
            'div',
            { class: 'seg layer-variant', role: 'group', 'aria-label': `${l.label} type` },
            ...[l, ...variants].map((x) =>
              h('button', { 'aria-selected': String(cur.id === x.id), onclick: () => pick(x.id) }, x.toggleLabel ?? x.label),
            ),
          ),
        );
      }
    }
    p.append(list);
    const cyc = this.c.cycle;
    p.append(
      h(
        'div',
        { class: 'run-info' },
        'NOAA GFS 0.25° global model',
        h('br'),
        ...(this.c.layer.id === 'snow' ? ['US & Alaska snow: NOAA HRRR 3 km', h('br')] : []),
        cyc ? `Run ${cyc.date.slice(0, 4)}-${cyc.date.slice(4, 6)}-${cyc.date.slice(6)} ${String(cyc.hour).padStart(2, '0')}Z · downscaled to terrain` : 'Loading…',
        h('br'),
        'Tap anywhere for a point forecast.',
      ),
    );
  }

  renderLegend() {
    const l = this.c.layer;
    if (l.id === 'satellite') {
      // infrared shows cloud-top temperature: thin or low cloud is faint, high storm tops brightest
      renderLegend(this.els.legend, 'Satellite clouds', 'infrared', l.palette, [
        { value: 0, label: 'clear' },
        { value: 50, label: 'cloud' },
        { value: 100, label: 'high, thick' },
      ]);
      return;
    }
    let note: Node | undefined;
    if (l.id === 'snow') {
      const sw = h('i');
      sw.style.background = GLACIER;
      note = h('span', { class: 'legend-key' }, sw, 'Glacier');
    }
    renderLegend(
      this.els.legend,
      l.label,
      l.id === 'aqi' ? 'US AQI · PM2.5' : unitLabel(l.q),
      l.palette,
      units.imperial && l.legendImperial
        ? l.legendImperial.map((d) => ({ value: fromDisplay(l.q, d), label: l.q === 'temp' ? `${d}°` : String(d) }))
        : l.legend.map((v) => ({ value: v, label: fmt(l.q, v, false) })),
      note,
    );
  }

  renderTimeline() {
    const b = this.els.bottom;
    clear(b);
    const c = this.c;
    if (c.layer.observed) return this.renderObsTimeline();
    this.stopObs();
    if (!c.cycle) return;
    const steps = Math.round((c.maxTime - c.minTime) / (HOUR / 4));
    this.range = h('input', {
      type: 'range',
      class: 'single-range',
      min: 0,
      max: steps,
      step: 1,
      value: Math.round((c.time - c.minTime) / (HOUR / 4)),
      'aria-label': 'Forecast time',
      oninput: () => {
        this.stop();
        c.show(c.minTime + +this.range!.value * (HOUR / 4));
      },
    });
    this.label = h('span', { class: 'timeline-label' }, timeLabel(c.time));
    const ticks = h('div', { class: 'ticks' });
    // label local midnights
    const start = new Date(c.minTime);
    start.setHours(24, 0, 0, 0);
    for (let t = start.getTime(); t < c.maxTime; t += 24 * HOUR) {
      const s = h('span', {}, new Date(t).toLocaleDateString(undefined, { weekday: 'short' }));
      s.style.left = `${((t - c.minTime) / (c.maxTime - c.minTime)) * 100}%`;
      ticks.append(s);
    }
    const nowS = h('span', { class: 'now' }, '▲ now');
    nowS.style.left = `${((Date.now() - c.minTime) / (c.maxTime - c.minTime)) * 100}%`;
    ticks.append(nowS);
    const play = h('button', { class: 'play', 'aria-label': 'Play forecast', onclick: () => (this.playing ? this.stop() : this.play()) }, '▶');
    b.append(
      play,
      h(
        'div',
        { class: 'timeline' },
        h('div', { class: 'timeline-top' }, this.label, h('span', { class: 'timeline-sub' }, 'Forecast · your local time')),
        this.range,
        ticks,
      ),
    );
  }

  /** Radar / satellite: step through the observed frames (past 2 h of radar, 24 h of satellite). */
  private renderObsTimeline() {
    const b = this.els.bottom;
    const o = this.c.obs;
    this.stop();
    if (!o.frames.length) {
      b.append(h('div', { class: 'timeline' }, h('div', { class: 'timeline-top' }, h('span', { class: 'timeline-label' }, 'Loading…'))));
      return;
    }
    const n = o.frames.length;
    const label = h('span', { class: 'timeline-label' });
    const ago = (t: number) => {
      const m = Math.round((Date.now() - t) / 60000);
      return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
    };
    const setLabel = () => (label.textContent = `${timeLabel(o.frames[o.index].time)} · ${ago(o.frames[o.index].time)}`);
    const range = h('input', {
      type: 'range',
      class: 'single-range',
      min: 0,
      max: n - 1,
      step: 1,
      value: o.index,
      'aria-label': o.kind === 'radar' ? 'Radar time' : 'Satellite time',
      oninput: () => {
        this.stopObs();
        o.show(+range.value);
        setLabel();
      },
    });
    setLabel();
    const ticks = h('div', { class: 'ticks' });
    const first = h('span', {}, ago(o.frames[0].time));
    first.style.left = '0%';
    first.classList.add('edge-l');
    const last = h('span', { class: 'now' }, 'latest ▲');
    last.style.left = '100%';
    last.classList.add('edge-r');
    ticks.append(first, last);
    const play = h('button', { class: 'play', 'aria-label': 'Play' }, '▶');
    play.onclick = () => {
      if (this.obsTimer) return this.stopObs();
      play.textContent = '❚❚';
      const step = async () => {
        // loop through the frames; each waits until its imagery has loaded
        await o.show(o.index >= n - 1 ? 0 : o.index + 1);
        if (!this.obsTimer) return;
        range.value = String(o.index);
        setLabel();
        this.obsTimer = window.setTimeout(step, o.index === n - 1 ? 1200 : o.kind === 'radar' ? 350 : 500);
      };
      this.obsTimer = window.setTimeout(step, 0);
    };
    const src = o.kind === 'radar' ? 'Radar · RainViewer' : 'Infrared satellites · EUMETSAT';
    b.append(play, h('div', { class: 'timeline' }, h('div', { class: 'timeline-top' }, label, h('span', { class: 'timeline-sub' }, src)), range, ticks));
  }

  private stopObs() {
    if (this.obsTimer) clearTimeout(this.obsTimer);
    this.obsTimer = 0;
    const btn = this.els.bottom.querySelector('.play');
    if (btn && this.c.layer.observed) btn.textContent = '▶';
  }

  private syncTime() {
    if (this.label) this.label.textContent = timeLabel(this.c.time);
    if (this.range && !this.playing) this.range.value = String(Math.round((this.c.time - this.c.minTime) / (HOUR / 4)));
  }

  play() {
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '❚❚';
    let last = performance.now();
    if (this.c.time >= this.c.maxTime - HOUR) this.c.time = this.c.minTime;
    const tick = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(100, now - last);
      last = now;
      // 1 forecast hour per 400 ms
      const t = this.c.time + (dt / 400) * HOUR;
      if (t >= this.c.maxTime) {
        this.stop();
        return;
      }
      this.c.show(t);
      if (this.range) this.range.value = String(Math.round((t - this.c.minTime) / (HOUR / 4)));
      this.playing = requestAnimationFrame(tick);
    };
    this.playing = requestAnimationFrame(tick);
  }

  stop() {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = 0;
    const btn = this.els.bottom.querySelector('.play');
    if (btn) btn.textContent = '▶';
  }

  /** Which card the current layer gets: null = the full forecast (temperature layers). */
  private cardKind(): CardKind | null {
    const id = this.c.layer.variantOf ?? this.c.layer.id;
    switch (id) {
      case 'precip':
      case 'cloud':
      case 'uv':
      case 'aqi':
      case 'snow':
      case 'wind':
      case 'humidity':
        return id;
      default:
        return null;
    }
  }

  async showCard(lon: number, lat: number, placeP: Promise<Place | null>) {
    const card = this.els.card;
    const token = ++this.cardToken;
    const at = this.c.time;
    clear(card);
    card.classList.remove('hidden');
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => ((this.card = undefined), this.onCardClose()) }, '✕');
    const title = h('div', { class: 'place' }, '…');
    const sub = h('div', { class: 'coords' }, coordLabel(lon, lat));
    const clock = h('div', {});
    const body = h('div', { class: 'card-body' }, h('div', { class: 'desc' }, 'Loading forecast…'));
    card.append(close, title, sub, clock, body);
    this.card = { lon, lat, at, title, sub, body, full: false };
    this.refreshCard();

    const elevP = pointElevation(lon, lat).catch(() => null);
    placeP
      .then((p) => {
        if (token !== this.cardToken) return;
        title.textContent = p?.name ?? 'Selected location';
        sub.textContent = [p?.detail, coordLabel(lon, lat)].filter(Boolean).join(' · ');
      })
      .catch(() => (title.textContent = 'Selected location'));

    let fc: PointForecast | null = null;
    // the map's own temperatures here: the card starts from them (anchorForecast)
    const nowP = this.c.pointNow(lon, lat, at).catch(() => null);
    // the same corrected aerosol forecast as the map's air-quality layer
    const airP = this.c.aqiAt(lon, lat, at).then((aqi) => (Number.isFinite(aqi) ? { aqi, pm25: pm25FromAqi(aqi) } : null)).catch(() => null);
    try {
      fc = await openMeteo(lat, lon);
    } catch {
      try {
        const elev = (await elevP) ?? demAt(this.dem, lon, lat);
        fc = await this.c.gfsPoint(lon, lat, elev);
      } catch (e) {
        if (token === this.cardToken && this.card) {
          this.card.error = `Forecast unavailable: ${(e as Error).message}`;
          this.refreshCard();
        }
        return;
      }
    }
    if (token !== this.cardToken || !fc.hours.length || !this.card) return;
    fc.air = (await airP) ?? undefined;
    const now = await nowP;
    if (token !== this.cardToken || !this.card) return;
    this.card.now = now ?? undefined;
    clock.replaceWith(placeClock(lon, lat, fc.timezone));
    this.card.fc = now && fc.source === 'Open-Meteo' ? anchorForecast(fc, at, now) : fc;
    const elev = await elevP;
    if (elev !== null && token === this.cardToken) sub.textContent += ` · ${Math.round(elev)} m`;
    this.refreshCard();
  }

  /** Draw the open card for the current layer (layerChanged: back to that layer's own card). */
  private refreshCard(layerChanged = false) {
    const st = this.card;
    if (!st || this.els.card.classList.contains('hidden')) return;
    if (layerChanged) st.full = false;
    const kind = this.cardKind();
    const compact = kind !== null && !st.full;
    this.els.card.classList.add('compact');
    if (st.error) {
      st.body.replaceChildren(h('div', { class: 'desc' }, st.error));
      return;
    }
    if (!st.fc) {
      st.body.replaceChildren(h('div', { class: 'desc' }, 'Loading forecast…'));
      return;
    }
    if (kind === 'aqi' && !st.air && !st.airLoading) this.loadAirSeries();
    if (!compact) {
      // the main card: temperature and the full forecast
      const feels = this.c.layer.id === 'feels';
      const back = kind ? h('button', { class: 'lc-switch back', onclick: () => ((st.full = false), this.refreshCard()) }, `‹ ${CARD_TITLES[kind]}`) : null;
      st.body.replaceChildren(
        ...(back ? [back] : []),
        h('div', { class: 'lc-title' }, feels ? 'Feels like' : CARD_TITLES.temp),
        ...layerCard('temp', { fc: st.fc, at: st.at, feels, now: st.now }),
      );
      return;
    }
    st.body.replaceChildren(
      h('div', { class: 'lc-title' }, CARD_TITLES[kind!]),
      ...layerCard(kind!, { fc: st.fc, at: st.at, air: st.air }),
      h('button', { class: 'lc-switch', onclick: () => ((st.full = true), this.refreshCard()) }, 'Full forecast ›'),
    );
  }

  /** Air quality every 6 hours for two days, from the corrected aerosol forecast (filled in as it loads). */
  private async loadAirSeries() {
    const st = this.card;
    if (!st) return;
    st.airLoading = true;
    const start = Math.floor(st.at / (3 * HOUR)) * 3 * HOUR;
    const series: [number, number][] = [];
    for (let k = 0; k <= 8; k++) {
      const t = start + k * 6 * HOUR;
      if (this.c.maxTime && t > this.c.maxTime) break;
      const a = await this.c.aqiAt(st.lon, st.lat, t).catch(() => NaN);
      if (this.card !== st) return;
      if (Number.isFinite(a)) series.push([t, a]);
      if (series.length >= 2 && (k % 2 === 0 || k === 8)) {
        st.air = [...series];
        if (this.cardKind() === 'aqi') this.refreshCard();
      }
    }
    st.air = series;
    if (this.cardKind() === 'aqi') this.refreshCard();
  }
}
