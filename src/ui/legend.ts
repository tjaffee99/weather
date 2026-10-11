import { cssGradient, domain, tf, type Palette } from '../map/palettes';
import { h, clear } from './dom';

export interface LegendTick {
  value: number; // in palette units
  label: string;
}

export function renderLegend(el: HTMLElement, title: string, unit: string, p: Palette, ticks: LegendTick[], note?: Node) {
  clear(el);
  const [d0, d1] = domain(p);
  const pos = (v: number) => Math.min(100, Math.max(0, ((tf(p, v) - d0) / (d1 - d0)) * 100));
  const tickEl = h('div', { class: 'legend-ticks' });
  for (const t of ticks) {
    const x = pos(t.value);
    const s = h('span', { class: x < 6 ? 'edge-l' : x > 94 ? 'edge-r' : '' }, t.label);
    s.style.left = `${x}%`;
    tickEl.append(s);
  }
  const bar = h('div', { class: 'legend-bar' });
  bar.style.background = cssGradient(p);
  el.append(h('div', { class: 'legend-title' }, h('b', {}, title), h('span', {}, ...(note ? [note] : []), unit)), bar, tickEl);
}
