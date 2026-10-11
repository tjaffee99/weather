/** Panel, timeline, legend and point card for live mode. */
import { LIVE_LAYERS, type LiveController } from './liveController';
import { h, clear } from '../ui/dom';
import { renderLegend } from '../ui/legend';
import { cssGradient } from '../map/palettes';
import { coordLabel, timeLabel } from '../ui/format';
import { colorAt, TEMPERATURE } from '../map/palettes';
import { condition, openMeteo, type Hour, type PointForecast } from './pointForecast';
import { pointElevation } from '../map/localDem';
import { demAt, type Dem } from '../data';
import type { Place } from '../geocode';
import { fmt, fromDisplay, toDisplay, unitLabel, units } from '../units';
import type { LiveVar } from './gfs';

const HOUR = 3600_000;

export class LiveUI {
  private playing = 0;
  private range?: HTMLInputElement;
  private label?: HTMLElement;
  private cardToken = 0;

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
    for (const l of LIVE_LAYERS) {
      const sw = h('span', { class: 'sw' });
      sw.style.background = cssGradient(l.palette);
      list.append(
        h(
          'button',
          {
            class: 'layer-btn',
            'aria-pressed': String(l.id === this.c.layer.id),
            onclick: () => {
              this.c.setLayer(l.id as LiveVar);
              this.renderPanel();
            },
          },
          h('span', { class: 'ic', 'aria-hidden': 'true' }, l.icon),
          l.label,
          sw,
        ),
      );
    }
    p.append(list);
    const cyc = this.c.cycle;
    p.append(
      h(
        'div',
        { class: 'run-info' },
        'NOAA GFS 0.25° global model',
        h('br'),
        cyc ? `Run ${cyc.date.slice(0, 4)}-${cyc.date.slice(4, 6)}-${cyc.date.slice(6)} ${String(cyc.hour).padStart(2, '0')}Z · downscaled to terrain` : 'Loading…',
        h('br'),
        'Tap anywhere for a point forecast.',
      ),
    );
  }

  renderLegend() {
    const l = this.c.layer;
    renderLegend(
      this.els.legend,
      l.label,
      unitLabel(l.q),
      l.palette,
      units.imperial && l.legendImperial
        ? l.legendImperial.map((d) => ({ value: fromDisplay(l.q, d), label: l.q === 'temp' ? `${d}°` : String(d) }))
        : l.legend.map((v) => ({ value: v, label: fmt(l.q, v, false) })),
    );
  }

  renderTimeline() {
    const b = this.els.bottom;
    clear(b);
    const c = this.c;
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

  async showCard(lon: number, lat: number, placeP: Promise<Place | null>) {
    const card = this.els.card;
    const token = ++this.cardToken;
    const at = this.c.time;
    clear(card);
    card.classList.remove('hidden');
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => this.onCardClose() }, '✕');
    const title = h('div', { class: 'place' }, '…');
    const sub = h('div', { class: 'coords' }, coordLabel(lon, lat));
    const body = h('div', { class: 'card-body' }, h('div', { class: 'desc' }, 'Loading forecast…'));
    card.append(close, title, sub, body);

    const elevP = pointElevation(lon, lat).catch(() => null);
    placeP
      .then((p) => {
        if (token !== this.cardToken) return;
        title.textContent = p?.name ?? 'Open water';
        sub.textContent = [p?.detail, coordLabel(lon, lat)].filter(Boolean).join(' · ');
      })
      .catch(() => (title.textContent = 'Selected location'));

    let fc: PointForecast | null = null;
    try {
      fc = await openMeteo(lat, lon);
    } catch {
      try {
        const elev = (await elevP) ?? demAt(this.dem, lon, lat);
        fc = await this.c.gfsPoint(lon, lat, elev);
      } catch (e) {
        if (token === this.cardToken) body.replaceChildren(h('div', { class: 'desc' }, `Forecast unavailable: ${(e as Error).message}`));
        return;
      }
    }
    if (token !== this.cardToken || !fc.hours.length) return;
    const elev = await elevP;
    if (elev !== null && token === this.cardToken) sub.textContent += ` · ${Math.round(elev)} m`;
    body.replaceChildren(...renderForecast(fc, at));
  }
}

const HOUR_MS = 3600_000;

function renderForecast(fc: PointForecast, at: number): Node[] {
  const tz = fc.timezone;
  // first hour at/after the time shown on the map
  let i0 = fc.hours.findIndex((x) => x.t > at - HOUR_MS / 2);
  if (i0 < 0) i0 = 0;
  const cur = fc.hours[i0];
  const live = Math.abs(at - Date.now()) < 45 * 60_000;
  const cond = cur.code >= 0 ? condition(cur.code, cur.isDay) : null;
  const day = [...fc.daily].reverse().find((d) => d.t <= cur.t);
  const hl = day ? `H ${fmt('temp', day.max)}  L ${fmt('temp', day.min)}` : '';
  const stat = (k: string, v: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const hrs = threeHourly(fc, i0);
  const hourLabel = (t: number, i: number) => {
    if (i === 0) return live ? 'Now' : fmtLocal(t, tz, { hour: 'numeric' });
    const d = new Date(t);
    const hh = Number(fmtLocal(t, tz, { hour: 'numeric', hourCycle: 'h23' }));
    return hh === 0 ? fmtLocal(d.getTime(), tz, { weekday: 'short' }) : fmtLocal(t, tz, { hour: 'numeric' });
  };
  const precipTxt = cur.pop !== undefined ? `${Math.round(cur.pop)}% · ${fmt('precip', cur.precip ?? 0)}` : fmt('rate', cur.precip ?? 0);
  return [
    h(
      'div',
      { class: 'now' },
      h('span', { class: 'now-icon', 'aria-hidden': 'true' }, cond?.icon ?? ''),
      h('span', { class: 'big' }, fmt('temp', cur.temp)),
      h(
        'div',
        { class: 'now-text' },
        h('div', { class: 'now-cond' }, cond?.label ?? ''),
        h('div', { class: 'now-sub' }, [cur.feels !== undefined ? `Feels ${fmt('temp', cur.feels)}` : '', hl].filter(Boolean).join(' · ')),
        h('div', { class: 'now-sub' }, live ? 'Now' : timeLabel(cur.t)),
      ),
    ),
    h('h3', {}, 'Next 24 hours'),
    hourlyStrip(hrs, hourLabel),
    h(
      'div',
      { class: 'stats' },
      stat('Wind', cur.wind !== undefined ? `${fmt('speed', cur.wind)}${cur.gust ? ` · gusts ${fmt('speed', cur.gust, false)}` : ''}` : '—'),
      stat('Humidity', cur.humidity !== undefined ? fmt('percent', cur.humidity) : '—'),
      stat('Cloud cover', cur.cloud !== undefined ? fmt('percent', cur.cloud) : '—'),
      stat('Precipitation', precipTxt),
      ...(day?.sun !== undefined ? [stat('Sunshine today', `${day.sun.toFixed(1)} h`)] : []),
      ...(day?.uv !== undefined ? [stat('UV index', `${Math.round(day.uv)}${day.uv >= 8 ? ' · very high' : day.uv >= 6 ? ' · high' : day.uv >= 3 ? ' · moderate' : ' · low'}`)] : []),
    ),
    h(
      'div',
      { class: 'note' },
      fc.source === 'Open-Meteo'
        ? `Point forecast: Open-Meteo (best model for this spot)${tz ? ` · times in ${tz.replace(/_/g, ' ')}` : ''}. Map: NOAA GFS.`
        : 'Point forecast: NOAA GFS, adjusted to local terrain elevation.',
    ),
  ];
}

/**
 * Eight widgets, one per 3 hours. Each shows the temperature at the start of
 * its window and the most significant weather (and highest rain chance) in it.
 */
function threeHourly(fc: PointForecast, i0: number): Hour[] {
  const src = fc.hours;
  // GFS fallback is already 3-hourly
  const step = src.length > 1 && src[1].t - src[0].t >= 3 * HOUR_MS ? 1 : 3;
  const out: Hour[] = [];
  for (let k = 0; k < 8; k++) {
    const i = i0 + k * step;
    if (i >= src.length) break;
    const win = src.slice(i, Math.min(src.length, i + step));
    const worst = win.reduce((a, b) => (b.code > a.code ? b : a), win[0]);
    const pops = win.map((x) => x.pop).filter((x): x is number => x !== undefined);
    out.push({ ...src[i], code: worst.code, isDay: src[i].isDay, pop: pops.length ? Math.max(...pops) : undefined });
  }
  return out;
}

function fmtLocal(t: number, tz: string | undefined, o: Intl.DateTimeFormatOptions) {
  try {
    return new Date(t).toLocaleString(undefined, { ...o, timeZone: tz });
  } catch {
    return new Date(t).toLocaleString(undefined, o);
  }
}

/** Row of forecast widgets with a temperature curve coloured by temperature. */
function hourlyStrip(hrs: Hour[], label: (t: number, i: number) => string): HTMLElement {
  const COL = 44;
  const W = COL * hrs.length;
  const H = 62;
  const vs = hrs.map((x) => toDisplay('temp', x.temp));
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = Math.max(1, (hi - lo) * 0.15);
  const x = (i: number) => COL * i + COL / 2;
  const y = (v: number) => 18 + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad) || 1)) * (H - 26);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'curve');
  const gid = `tg${Math.random().toString(36).slice(2, 8)}`;
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = gid;
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', '0');
  grad.setAttribute('x2', String(W));
  grad.setAttribute('y1', '0');
  grad.setAttribute('y2', '0');
  hrs.forEach((hr, i) => {
    const st = document.createElementNS(ns, 'stop');
    st.setAttribute('offset', String(x(i) / W));
    st.setAttribute('stop-color', colorAt(TEMPERATURE, hr.temp));
    grad.append(st);
  });
  const defs = document.createElementNS(ns, 'defs');
  defs.append(grad);
  svg.append(defs);
  // smooth path through the points
  let d = `M${x(0)},${y(vs[0])}`;
  for (let i = 1; i < vs.length; i++) {
    const cx = (x(i - 1) + x(i)) / 2;
    d += ` C${cx},${y(vs[i - 1])} ${cx},${y(vs[i])} ${x(i)},${y(vs[i])}`;
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', `url(#${gid})`);
  path.setAttribute('stroke-width', '3.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  vs.forEach((v, i) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(x(i)));
    c.setAttribute('cy', String(y(v)));
    c.setAttribute('r', '2.6');
    c.setAttribute('fill', colorAt(TEMPERATURE, hrs[i].temp));
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '1.2');
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(x(i)));
    t.setAttribute('y', String(y(v) - 7));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'curve-label');
    t.textContent = `${Math.round(v)}°`;
    svg.append(c, t);
  });
  const cols = h('div', { class: 'hours' });
  hrs.forEach((hr, i) => {
    const cond = hr.code >= 0 ? condition(hr.code, hr.isDay) : null;
    cols.append(
      h(
        'div',
        { class: 'hour', title: cond?.label ?? '' },
        h('div', { class: 'hour-t' }, label(hr.t, i)),
        h('div', { class: 'hour-i' }, cond?.icon ?? ''),
        h('div', { class: 'hour-p' }, hr.pop !== undefined && hr.pop >= 15 ? `${Math.round(hr.pop / 5) * 5}%` : ''),
      ),
    );
  });
  return h('div', { class: 'hourly' }, cols, svg);
}
