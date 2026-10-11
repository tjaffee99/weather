/** Panel, timeline, legend and point card for live mode. */
import { LIVE_LAYERS, type LiveController } from './liveController';
import { h, clear } from '../ui/dom';
import { renderLegend } from '../ui/legend';
import { cssGradient } from '../map/palettes';
import { coordLabel, timeLabel } from '../ui/format';
import { fmt, toDisplay, unitLabel } from '../units';
import { nearestCity, type City } from '../data';
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
    private cities: City[],
    private onCardClose: () => void,
  ) {
    c.onFrame = () => this.syncTime();
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
              this.renderLegend();
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
      l.legend.map((v) => ({ value: v, label: fmt(l.q, v, false) + (l.q === 'temp' ? '' : '') })),
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

  async showCard(lon: number, lat: number) {
    const card = this.els.card;
    const token = ++this.cardToken;
    const city = nearestCity(this.cities, lon, lat);
    clear(card);
    card.classList.remove('hidden');
    const close = h('button', { class: 'close', 'aria-label': 'Close', onclick: () => this.onCardClose() }, '✕');
    card.append(close, h('div', { class: 'place' }, city ? `${city.name}, ${city.country}` : 'Selected location'), h('div', { class: 'coords' }, coordLabel(lon, lat)), h('div', { class: 'desc' }, 'Loading forecast…'));
    try {
      const f = await this.c.pointForecast(lon, lat);
      if (token !== this.cardToken) return;
      const v = f.values;
      const precip = v.precip ?? 0;
      const snow = (v.csnow ?? 0) > 0.5;
      const cloud = v.cloud ?? 0;
      const cond =
        precip >= 0.1
          ? `${snow ? 'Snow' : precip > 4 ? 'Heavy rain' : precip > 1 ? 'Rain' : 'Light rain'} · ${fmt('rate', precip)}`
          : cloud < 15 ? 'Clear' : cloud < 45 ? 'Mostly clear' : cloud < 75 ? 'Partly cloudy' : 'Cloudy';
      clear(card);
      const stat = (k: string, val: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, val));
      card.append(
        close,
        h('div', { class: 'place' }, city ? `${city.name}, ${city.country}` : 'Selected location'),
        h('div', { class: 'coords' }, `${coordLabel(lon, lat)} · ${timeLabel(f.time)}`),
        h('div', { class: 'big' }, fmt('temp', v.temp ?? NaN), h('small', {}, `feels ${fmt('temp', v.feels ?? NaN)}`)),
        h('div', { class: 'desc' }, cond),
        h(
          'div',
          { class: 'stats' },
          stat('Wind', fmt('speed', v.wind ?? NaN)),
          stat('Humidity', fmt('percent', v.humidity ?? NaN)),
          stat('Cloud cover', fmt('percent', cloud)),
          stat('Precipitation', fmt('rate', precip)),
        ),
        h('h3', {}, 'Next 24 hours'),
        sparkline(f.trend),
        h('div', { class: 'note' }, 'NOAA GFS forecast, temperatures adjusted to local terrain elevation.'),
      );
    } catch (e) {
      if (token === this.cardToken) card.querySelector('.desc')!.textContent = `Forecast unavailable: ${(e as Error).message}`;
    }
  }
}

function sparkline(pts: { t: number; v: number }[]): SVGSVGElement {
  const W = 346, H = 74, pad = 16;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  if (pts.length < 2) return svg;
  const vs = pts.map((p) => toDisplay('temp', p.v));
  const lo = Math.min(...vs) - 1, hi = Math.max(...vs) + 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v: number) => 14 + (1 - (v - lo) / (hi - lo)) * (H - 34);
  const d = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = 'spk';
  grad.innerHTML = '<stop offset="0" stop-color="#63d4c0"/><stop offset="0.5" stop-color="#f8d553"/><stop offset="1" stop-color="#f48a3c"/>';
  const defs = document.createElementNS(ns, 'defs');
  defs.append(grad);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'url(#spk)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(defs, path);
  pts.forEach((p, i) => {
    if (i % 2) return;
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(x(i)));
    t.setAttribute('y', String(y(vs[i]) - 5));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '10');
    t.setAttribute('fill', '#f3f6fb');
    t.textContent = `${Math.round(vs[i])}°`;
    const tl = document.createElementNS(ns, 'text');
    tl.setAttribute('x', String(x(i)));
    tl.setAttribute('y', String(H - 3));
    tl.setAttribute('text-anchor', 'middle');
    tl.setAttribute('font-size', '9.5');
    tl.setAttribute('fill', 'rgba(235,240,250,0.5)');
    tl.textContent = new Date(p.t).toLocaleTimeString(undefined, { hour: 'numeric' });
    svg.append(t, tl);
  });
  return svg;
}
