/**
 * The climate finder's location card: a plain-language summary, the chance
 * of a matching day through the year (with what rules days out), and the
 * monthly normals as a colour-coded table.
 */
import { AQI, colorAt, SCORE, TEMPERATURE, UV_INDEX } from '../map/palettes';
import { h } from '../ui/dom';
import { MONTHS, doyLabel } from '../ui/format';
import { fmt, unitLabel, units } from '../units';
import { CRITERIA, type CritState } from './criteria';
import type { CritVar, DetailResult, MonthStats, Obstacle } from './types';

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START = DAYS_IN_MONTH.map((_, i) => DAYS_IN_MONTH.slice(0, i).reduce((a, b) => a + b, 0));
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** What a failed condition means, as [long phrase, short label] for each side. */
const WHY: Record<CritVar, Record<Obstacle['dir'], [string, string]>> = {
  feels: { low: ['too cold', 'cold'], high: ['too hot', 'hot'] },
  tmax: { low: ['too cold', 'cold'], high: ['too hot', 'hot'] },
  tmin: { low: ['nights too cold', 'cold'], high: ['nights too warm', 'warm'] },
  dew: { low: ['air too dry', 'dry'], high: ['too humid', 'humid'] },
  rh: { low: ['air too dry', 'dry'], high: ['too humid', 'humid'] },
  aqi: { low: ['air too clean', 'clean'], high: ['air too polluted', 'smog'] },
  cloud: { low: ['too clear', 'clear'], high: ['too cloudy', 'cloudy'] },
  sun: { low: ['not sunny enough', 'dull'], high: ['too sunny', 'sunny'] },
  uv: { low: ['UV too low', 'UV'], high: ['UV too high', 'UV'] },
  precip: { low: ['too dry', 'dry'], high: ['too wet', 'wet'] },
  wind: { low: ['too calm', 'calm'], high: ['too windy', 'windy'] },
  snow: { low: ['not enough snow', 'thin'], high: ['too much snow', 'deep'] },
  snowfall: { low: ['no fresh snow', 'no new'], high: ['too much new snow', 'snowy'] },
  sst: { low: ['sea too cold', 'sea'], high: ['sea too warm', 'sea'] },
  daylight: { low: ['days too short', 'dark'], high: ['days too long', 'long'] },
};

/** A month counts as good when at least this share of its days match. */
const GOOD = 0.25;

const monthFrac = (r: DetailResult, m: number) => (r.months[m].match ?? 0) / DAYS_IN_MONTH[m];

/** The condition's limit on the failing side, e.g. "feels-like high above 81°F". */
function limitText(o: Obstacle, state: CritState): string {
  const def = CRITERIA.find((d) => d.v === o.v);
  const r = state[o.v];
  if (!def || !r) return '';
  const v = o.dir === 'high' ? r[1] : r[0];
  if (!Number.isFinite(v)) return '';
  const val = def.q === 'temp' ? `${fmt('temp', v)}${unitLabel('temp').slice(1)}` : fmt(def.q, v);
  return `${def.label.toLowerCase()} ${o.dir === 'high' ? 'above' : 'below'} ${val}`;
}

function monthRange(a: number, b: number): string {
  return a === b ? MONTHS[a] : `${MONTHS[a]}\u2060–\u2060${MONTHS[b]}`; // keep ranges on one line
}

/** Per month: 'good', or the long phrase of what rules most days out. */
function monthVerdicts(r: DetailResult): (string | null)[] {
  return r.months.map((m, i) => {
    if (monthFrac(r, i) >= GOOD) return 'good';
    const top = m.why?.[0];
    return top ? WHY[top.v][top.dir][0] : null;
  });
}

/** Two lines under the big number: how often, when it's best, and what gets in the way. */
export function summary(r: DetailResult): HTMLElement {
  const lines: string[] = [];
  const per = r.perYear;
  const often = per < 0.5 ? 'Almost never' : per < 183 ? `About 1 day in ${Math.max(2, Math.round(365 / per))}` : `About ${Math.round((per / 365) * 100)}% of days`;
  const best = MONTHS.map((_, i) => ({ i, v: monthFrac(r, i) }))
    .filter((x) => x.v > 0.05)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => MONTHS[x.i]);
  lines.push(best.length ? `${often} · best in ${listJoin(best)}` : often);

  // group consecutive months (wrapping Dec→Jan) that fail for the same reason
  const v = monthVerdicts(r);
  const groups: { label: string; a: number; b: number; n: number }[] = [];
  const start = v.findIndex((x, i) => x !== v[(i + 11) % 12]);
  if (start < 0 && v[0] && v[0] !== 'good') groups.push({ label: v[0], a: 0, b: 11, n: 12 });
  else if (start >= 0) {
    for (let k = 0; k < 12; k++) {
      const i = (start + k) % 12;
      const g = groups[groups.length - 1];
      if (g && g.label === v[i]) {
        g.b = i;
        g.n++;
      } else groups.push({ label: v[i] ?? '', a: i, b: i, n: 1 });
    }
  }
  const bad = groups.filter((g) => g.label && g.label !== 'good').sort((a, b) => b.n - a.n).slice(0, 2);
  if (bad.length) {
    const parts = bad.map((g) => (g.n === 12 ? `${g.label} all year` : `${g.label} in ${monthRange(g.a, g.b)}`));
    lines.push(`Usually ${listJoin(parts)}.`);
  }
  return h('div', { class: 'desc summary' }, ...lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
}

function listJoin(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// ---------------- tooltip ----------------

let tipEl: HTMLDivElement | null = null;

function showTip(text: string, x: number, y: number) {
  if (!tipEl) {
    tipEl = h('div', { class: 'tip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const r = tipEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

/** Show `data-tip` of whatever is under the pointer inside `root`. */
function bindTips(root: HTMLElement | SVGElement) {
  root.addEventListener('pointermove', (e) => {
    const t = (e.target as Element).closest('[data-tip]');
    if (t && root.contains(t)) showTip(t.getAttribute('data-tip')!, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
    else hideTip();
  });
  root.addEventListener('pointerleave', hideTip);
}

// ---------------- chart ----------------

const SVG = 'http://www.w3.org/2000/svg';
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Chance of a matching day through the year, on a fixed 0–100% axis, with
 * the main reason days are ruled out marked under each stretch of months.
 */
export function yearChart(r: DetailResult, mark: number, state: CritState): SVGSVGElement {
  const W = 348, plotTop = 7, plotH = 72, left = 32;
  const axisY = plotTop + plotH;
  const stripY = axisY + 22;
  const H = stripY + 16;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  svg.setAttribute('aria-label', `Chance of a matching day through the year; ${Math.round(r.perYear)} days a year in all`);
  const x = (d: number) => left + (d / 365) * (W - left);
  const y = (v: number) => plotTop + (1 - v) * plotH;

  // recessive grid: 0, 50 and 100%
  for (const g of [0, 0.5, 1]) {
    svg.append(sv('line', { x1: left, x2: W, y1: y(g), y2: y(g), stroke: g === 0 ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.08)', 'stroke-width': 1 }));
    const t = sv('text', { x: left - 4, y: y(g) + 3, 'text-anchor': 'end', class: 'ax' });
    t.textContent = `${g * 100}%`;
    svg.append(t);
  }
  // month labels
  MONTHS.forEach((m, i) => {
    const t = sv('text', { x: x(MONTH_START[i] + DAYS_IN_MONTH[i] / 2), y: axisY + 12, 'text-anchor': 'middle', class: 'ax' });
    t.textContent = m[0];
    svg.append(t);
  });

  // the curve: 2px line over a light wash
  const daily = r.daily;
  let line = '';
  for (let i = 0; i < daily.length; i++) line += `${i ? 'L' : 'M'}${x(i + 0.5).toFixed(1)},${y(daily[i]).toFixed(1)}`;
  svg.append(sv('path', { d: `${line}L${x(365)},${y(0)}L${x(0)},${y(0)}Z`, fill: '#1f6fe0', 'fill-opacity': 0.12 }));
  svg.append(sv('path', { d: line, fill: 'none', stroke: '#1f6fe0', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  if (mark >= 0) svg.append(sv('line', { x1: x(mark + 0.5), x2: x(mark + 0.5), y1: plotTop - 4, y2: axisY, stroke: '#1d1d1f', 'stroke-width': 1.5 }));

  // what rules days out, per stretch of months
  const v = monthVerdicts(r);
  for (let a = 0; a < 12; ) {
    let b = a;
    while (b + 1 < 12 && v[b + 1] === v[a]) b++;
    const x0 = x(MONTH_START[a]) + 2, x1 = x(MONTH_START[b] + DAYS_IN_MONTH[b]) - 2;
    if (v[a]) {
      const good = v[a] === 'good';
      svg.append(sv('line', { x1: x0, x2: x1, y1: stripY - 8, y2: stripY - 8, stroke: good ? '#2e9e4a' : 'rgba(0,0,0,0.28)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      const top = r.months[a].why?.[0];
      const [long, short] = good ? ['best', 'best'] : top ? WHY[top.v][top.dir] : ['', ''];
      const fits = (s: string) => s.length * 5.2 <= x1 - x0 + 4;
      const label = fits(long) ? long : fits(short) ? short : '';
      if (label) {
        const t = sv('text', { x: (x0 + x1) / 2, y: stripY + 3, 'text-anchor': 'middle', class: good ? 'why good' : 'why' });
        t.textContent = label;
        svg.append(t);
      }
    }
    a = b + 1;
  }

  // hover: a crosshair that snaps to the day, and a readout
  const cross = sv('line', { y1: plotTop - 2, y2: axisY, stroke: 'rgba(0,0,0,0.45)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = sv('circle', { r: 4, fill: '#1f6fe0', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = sv('rect', { x: left, y: 0, width: W - left, height: H, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const d = Math.max(0, Math.min(364, Math.floor(((px - left) / (W - left)) * 365)));
    const m = MONTHS.findIndex((_, i) => d < MONTH_START[i] + DAYS_IN_MONTH[i]);
    cross.setAttribute('x1', String(x(d + 0.5)));
    cross.setAttribute('x2', String(x(d + 0.5)));
    dot.setAttribute('cx', String(x(d + 0.5)));
    dot.setAttribute('cy', String(y(daily[d])));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    const why = (r.months[m].why ?? [])
      .slice(0, 2)
      .map((o) => `${Math.round(o.frac * 100)}% of ${LONG_MONTHS[m]} days ${WHY[o.v][o.dir][0]}${limitText(o, state) ? ` (${limitText(o, state)})` : ''}`);
    showTip([`${doyLabel(d)}: ${Math.round(daily[d] * 100)}% chance of a matching day`, ...why].join('\n'), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  });
  return svg;
}

// ---------------- monthly table ----------------

/** Cell colour for "none". */
const NONE = 'rgb(244,244,241)';

/** Mix an rgb() colour toward white. */
function soften(rgb: string, k: number): string {
  return `rgb(${rgb.match(/\d+/g)!.map((v) => Math.round(+v + (255 - +v) * k)).join(',')})`;
}

/** A single-hue scale from the card surface to `hex`, for t in 0..1. */
function ramp(hex: string, t: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const k = Math.min(1, Math.max(0, t)) * 0.92 + 0.04;
  return `rgb(${c.map((v) => Math.round(255 + (v - 255) * k)).join(',')})`;
}

/** Ink that stays readable on a cell colour. */
function inkOn(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.32 ? '#fff' : '#1d1d1f';
}

interface Row {
  key: keyof MonthStats;
  label: string;
  text: (v: number, m: number) => string;
  tip: (v: number, m: number) => string;
  color: (v: number, m: number) => string;
}

function dewWord(c: number): string {
  return c < 10 ? 'dry' : c < 16 ? 'comfortable' : c < 20 ? 'humid' : c < 24 ? 'muggy' : 'oppressive';
}
function aqiWord(a: number): string {
  return a <= 50 ? 'good' : a <= 100 ? 'moderate' : a <= 150 ? 'unhealthy for sensitive groups' : a <= 200 ? 'unhealthy' : a <= 300 ? 'very unhealthy' : 'hazardous';
}
function uvWord(u: number): string {
  return u < 3 ? 'low' : u < 6 ? 'moderate' : u < 8 ? 'high' : u < 11 ? 'very high' : 'extreme';
}

function sections(): { title: string; rows: Row[] }[] {
  const T = unitLabel('temp');
  const temp = (v: number) => fmt('temp', v);
  const tc = (v: number) => colorAt(TEMPERATURE, v);
  const mm = units.imperial ? 'in' : 'mm';
  return [
    {
      title: 'Your conditions',
      rows: [
        {
          key: 'match',
          label: 'Matches',
          text: (v) => String(Math.round(v)),
          tip: (v, m) => `${LONG_MONTHS[m]}: ${Math.round(v)} of ${DAYS_IN_MONTH[m]} days match your conditions (${Math.round((v / DAYS_IN_MONTH[m]) * 100)}%)`,
          color: (v, m) => (v < 0.5 ? NONE : colorAt(SCORE, Math.sqrt(v / DAYS_IN_MONTH[m]))),
        },
      ],
    },
    {
      title: `Temperature ${T}`,
      rows: [
        { key: 'feels', label: 'Feels like', text: temp, tip: (v, m) => `${LONG_MONTHS[m]}: the afternoon feels like ${temp(v)}${T.slice(1)} on average`, color: tc },
        { key: 'tmax', label: 'High', text: temp, tip: (v, m) => `${LONG_MONTHS[m]}: average daytime high ${temp(v)}${T.slice(1)}`, color: tc },
        { key: 'tmin', label: 'Low', text: temp, tip: (v, m) => `${LONG_MONTHS[m]}: average overnight low ${temp(v)}${T.slice(1)}`, color: tc },
        {
          key: 'dew',
          label: 'Dew point',
          text: temp,
          tip: (v, m) => `${LONG_MONTHS[m]}: dew point ${temp(v)}${T.slice(1)}, ${dewWord(v)}`,
          color: (v) => ramp('#0f8a7e', (v - 4) / 20),
        },
        {
          key: 'rh',
          label: 'Humidity %',
          text: (v) => String(Math.round(v)),
          tip: (v, m) => `${LONG_MONTHS[m]}: relative humidity averages ${Math.round(v)}% in the daytime`,
          color: (v) => ramp('#0f8a7e', (v - 20) / 75),
        },
      ],
    },
    {
      title: 'Sun',
      rows: [
        { key: 'sun', label: 'Sunshine h', text: (v) => v.toFixed(v < 9.95 ? 1 : 0), tip: (v, m) => `${LONG_MONTHS[m]}: ${v.toFixed(1)} hours of sunshine a day`, color: (v) => ramp('#e89a00', v / 12) },
        { key: 'uv', label: 'UV peak', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: UV index peaks around ${Math.round(v)} (${uvWord(v)})`, color: (v) => (v < 0.5 ? NONE : soften(colorAt(UV_INDEX, v), 0.3)) },
        { key: 'sunnyDays', label: 'Clear days', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: ${Math.round(v)} days with little cloud (25% or less)`, color: (v, m) => ramp('#e8b400', v / DAYS_IN_MONTH[m]) },
      ],
    },
    {
      title: 'Rain & snow',
      rows: [
        { key: 'rainDays', label: 'Wet days', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: ${Math.round(v)} days with ${fmt('precip', 1)} or more of rain or snow`, color: (v, m) => ramp('#2f78c4', (v / DAYS_IN_MONTH[m]) * 1.6) },
        { key: 'precip', label: `Total ${mm}`, text: (v) => fmt('precip', v, false), tip: (v, m) => `${LONG_MONTHS[m]}: ${fmt('precip', v)} of rain and melted snow in all`, color: (v) => ramp('#2f78c4', v / 200) },
        { key: 'snowfall', label: `Snowfall ${units.imperial ? 'in' : 'cm'}`, text: (v) => fmt('snow', v, false), tip: (v, m) => `${LONG_MONTHS[m]}: ${fmt('snow', v)} of snow falls in all`, color: (v) => ramp('#7a6fe0', v / 60) },
        { key: 'snowDays', label: 'Snow cover', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: snow on the ground on ${Math.round(v)} days`, color: (v, m) => ramp('#7a6fe0', v / DAYS_IN_MONTH[m]) },
      ],
    },
    {
      title: 'Air quality (estimate)',
      rows: [
        { key: 'aqi', label: 'Air quality', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: US AQI averages ${Math.round(v)} (${aqiWord(v)}), from PM2.5`, color: (v) => soften(colorAt(AQI, v), 0.25) },
        { key: 'goodAirDays', label: 'Good-air days', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: ${Math.round(v)} days with good air (AQI 50 or less)`, color: (v, m) => ramp('#3fa35f', v / DAYS_IN_MONTH[m]) },
        { key: 'badAirDays', label: 'Unhealthy days', text: (v) => String(Math.round(v)), tip: (v, m) => `${LONG_MONTHS[m]}: ${Math.round(v)} days with AQI over 100 (unhealthy for sensitive groups or worse)`, color: (v, m) => ramp('#c4553c', v / DAYS_IN_MONTH[m]) },
      ],
    },
    {
      title: 'Wind & sea',
      rows: [
        { key: 'wind', label: `Wind ${unitLabel('speed')}`, text: (v) => fmt('speed', v, false), tip: (v, m) => `${LONG_MONTHS[m]}: strongest daytime wind ${fmt('speed', v)} on average`, color: (v) => ramp('#5f7486', (v - 5) / 40) },
        { key: 'sst', label: 'Sea', text: temp, tip: (v, m) => `${LONG_MONTHS[m]}: nearby sea ${temp(v)}${T.slice(1)}`, color: tc },
      ],
    },
  ];
}

/** Monthly normals as a heatmap: every value printed, coloured on its own scale. */
export function monthTable(r: DetailResult): HTMLTableElement {
  const t = h('table', { class: 'normals heat' });
  const head = h('tr', {}, h('th', {}, ''));
  MONTHS.forEach((m) => head.append(h('th', { scope: 'col' }, m[0])));
  t.append(h('thead', {}, head));
  const body = h('tbody');
  for (const sec of sections()) {
    const rows = sec.rows.filter((row) => r.months.some((m) => typeof m[row.key] === 'number'));
    if (!rows.length) continue;
    body.append(h('tr', { class: 'sec' }, h('th', { colspan: 13, scope: 'rowgroup' }, sec.title)));
    for (const row of rows) {
      const tr = h('tr', {}, h('th', { scope: 'row' }, row.label));
      r.months.forEach((m, i) => {
        const v = m[row.key] as number | undefined;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          tr.append(h('td', { class: 'na' }, '—'));
          return;
        }
        const bg = row.color(v, i);
        const td = h('td', { 'data-tip': row.tip(v, i) }, row.text(v, i));
        td.style.background = bg;
        td.style.color = inkOn(bg);
        tr.append(td);
      });
      body.append(tr);
    }
  }
  t.append(body);
  bindTips(t);
  return t;
}

/** Where the numbers come from, in plain words (technical detail on hover). */
export function sourceNote(r: DetailResult, elev: number): HTMLElement {
  const shift = units.imperial ? r.shift * 1.8 : r.shift;
  const detail = `${r.cells > 1 ? `Blend of ${r.cells} nearby ERA5 grid cells, mainly the one at` : 'ERA5 grid cell at'} ${r.cellLat.toFixed(2)}°, ${r.cellLon.toFixed(2)}° (avg. ${r.cellElev} m); temperatures shifted ${shift >= 0 ? '+' : '−'}${Math.abs(shift).toFixed(1)}° for this spot; rain and snow scaled from 0.25° data at this elevation.`;
  const el = h(
    'div',
    { class: 'note', 'data-tip': detail },
    `From 25 years of weather (ERA5 reanalysis, 2001–2025): one real day for each date, from nearby ~100 km grid cells, with temperatures, rain and snow adjusted to this spot's elevation (${Math.round(units.imperial ? elev * 3.281 : elev)} ${units.imperial ? 'ft' : 'm'}). Air quality: NOAA's aerosol model matched to satellite and ground-monitor estimates (2021–2025). Hover a cell or the chart for details.`,
  );
  bindTips(el);
  return el;
}

