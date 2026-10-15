/**
 * Location cards for the live layers. Each is a box about one thing: the value
 * now, what it will do over the next day in plain words, a 24-hour chart and
 * the next few days. Temperature is the main card (the full forecast: also
 * wind, humidity, rain, UV and air at a glance); every other layer's card has
 * the full forecast one tap away.
 */
import { h } from '../ui/dom';
import { AQI, CLOUD, HUMIDITY, PRECIP, SNOWFALL, TEMPERATURE, UV_INDEX, WIND, colorAt, type Palette } from '../map/palettes';
import { fmt, toDisplay, units } from '../units';
import { condition, type Hour, type PointForecast } from './pointForecast';

export type CardKind = 'temp' | 'precip' | 'cloud' | 'uv' | 'aqi' | 'snow' | 'wind' | 'humidity';

export interface CardContext {
  fc: PointForecast;
  /** the map's time */
  at: number;
  /** US AQI series for the air card: [time, aqi], filled in as it loads */
  air?: [number, number][];
  /** temperature card: lead with the feels-like temperature */
  feels?: boolean;
}

const HOUR = 3600_000;

function fmtLocal(t: number, tz: string | undefined, o: Intl.DateTimeFormatOptions) {
  try {
    return new Date(t).toLocaleString(undefined, { ...o, timeZone: tz });
  } catch {
    return new Date(t).toLocaleString(undefined, o);
  }
}
const hourName = (t: number, tz?: string) => fmtLocal(t, tz, { hour: 'numeric' });
const dayName = (t: number, tz?: string) => fmtLocal(t, tz, { weekday: 'short' });

/** The hour at the map's time and the 24 after it. */
function window24(fc: PointForecast, at: number): { cur: Hour; next: Hour[] } {
  let i0 = fc.hours.findIndex((x) => x.t > at - HOUR / 2);
  if (i0 < 0) i0 = 0;
  return { cur: fc.hours[i0], next: fc.hours.slice(i0, i0 + 24) };
}

/** Hours of the local day containing t. */
function localDay(fc: PointForecast, t: number): Hour[] {
  const key = (x: number) => fmtLocal(x, fc.timezone, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const k = key(t);
  return fc.hours.filter((x) => key(x.t) === k);
}

/** Following days (from the day after `at`), grouped from the hourly data. */
function nextDays(fc: PointForecast, at: number, n = 4): { t: number; hours: Hour[] }[] {
  const key = (x: number) => fmtLocal(x, fc.timezone, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const today = key(at);
  const out: { t: number; hours: Hour[] }[] = [];
  for (const x of fc.hours) {
    if (x.t <= at) continue;
    const k = key(x.t);
    if (k === today) continue;
    if (!out.length || key(out[out.length - 1].t) !== k) out.push({ t: x.t, hours: [] });
    out[out.length - 1].hours.push(x);
  }
  return out.filter((d) => d.hours.length >= 12).slice(0, n);
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
const num = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

// ---------- pieces ----------

function headline(value: string, word: string, sub?: string, chip?: string): HTMLElement {
  const dot = chip ? h('span', { class: 'lc-chip' }) : null;
  if (dot && chip) dot.style.background = chip;
  return h(
    'div',
    { class: 'lc-head' },
    h('span', { class: 'lc-value' }, value),
    h('div', { class: 'lc-words' }, h('div', { class: 'lc-word' }, dot, word), sub ? h('div', { class: 'lc-sub' }, sub) : null),
  );
}

const sentence = (text: string) => h('div', { class: 'lc-say' }, text);

/**
 * A bar per hour (or per step) with time labels every few bars. `back` draws a
 * faint bar behind (e.g. rain chance); values are in display units already.
 */
function bars(
  items: { t: number; v: number; color: string; back?: number; label?: string; mark?: boolean }[],
  opts: { tz?: string; max: number; every?: number; height?: number; unit?: string },
): HTMLElement {
  const n = items.length;
  const W = 340, H = opts.height ?? 74, top = 12, bottom = 16;
  const bw = W / Math.max(n, 1);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'lc-bars');
  const ch = H - top - bottom;
  const every = opts.every ?? 3;
  items.forEach((it, i) => {
    const x = i * bw;
    if (it.back !== undefined && it.back > 0) {
      const r = document.createElementNS(ns, 'rect');
      const bh = Math.min(1, it.back) * ch;
      r.setAttribute('x', String(x + 1));
      r.setAttribute('width', String(Math.max(1, bw - 2)));
      r.setAttribute('y', String(top + ch - bh));
      r.setAttribute('height', String(bh));
      r.setAttribute('class', 'lc-back');
      svg.append(r);
    }
    const f = Math.max(0, Math.min(1, it.v / (opts.max || 1)));
    const bh = it.v > 0 ? Math.max(1.5, f * ch) : 0;
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', String(x + 1.5));
    r.setAttribute('width', String(Math.max(1, bw - 3)));
    r.setAttribute('y', String(top + ch - bh));
    r.setAttribute('height', String(bh));
    r.setAttribute('rx', '1.5');
    r.setAttribute('fill', it.color);
    if (it.mark) r.setAttribute('class', 'lc-now');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${hourName(it.t, opts.tz)}: ${it.label ?? it.v.toFixed(1)}`;
    r.append(title);
    svg.append(r);
    if (it.label && (i % every === 0 || it.mark) && it.v > 0) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(x + bw / 2));
      t.setAttribute('y', String(top + ch - bh - 3));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'lc-val');
      t.textContent = it.label;
      svg.append(t);
    }
    if (i % every === 0) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(x + bw / 2));
      t.setAttribute('y', String(H - 3));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'lc-axis');
      t.textContent = i === 0 && !opts.tz ? 'now' : hourName(it.t, opts.tz).replace(/\s?([AP])M/, (_, p) => p.toLowerCase());
      svg.append(t);
    }
  });
  return h('div', { class: 'lc-chart' }, svg);
}

function days(rows: { t: number; icon?: string; main: string; note?: string; color?: string }[], tz?: string): HTMLElement {
  return h(
    'div',
    { class: 'lc-days' },
    ...rows.map((r) =>
      tint(h('div', { class: 'lc-day' }, h('div', { class: 'lc-day-name' }, dayName(r.t, tz)), r.icon ? h('div', { class: 'lc-day-icon' }, r.icon) : null, h('div', { class: 'lc-day-main' }, r.main), r.note ? h('div', { class: 'lc-day-note' }, r.note) : null), r.color),
    ),
  );
}

/** Colours for tiles without a map palette of their own. */
const SUN_TILE: Palette = { stops: [[0, '#dfe5ee'], [4, '#f3ebc4'], [8, '#f7d873'], [11, '#f5b324'], [14, '#ec8a12']] };
const CHANCE_TILE: Palette = { stops: [[0, '#eef1f5'], [30, '#cfe0f2'], [60, '#8fb8e6'], [100, '#3f7fd0']] };

/** A soft tint of a palette colour for a tile, with readable ink. */
function tint(el: HTMLElement, rgb: string | undefined, k = 0.55) {
  if (!rgb) return el;
  const c = rgb.match(/\d+/g)!.map(Number);
  const bg = c.map((v) => Math.round(v + (255 - v) * k));
  const lum = bg.reduce((s, v, i) => s + [0.2126, 0.7152, 0.0722][i] * Math.pow(v / 255, 2.2), 0);
  el.style.background = `rgb(${bg.join(',')})`;
  el.style.color = lum < 0.3 ? '#fff' : '#1d1d1f';
  el.classList.add('tint');
  return el;
}

/** Fact tiles: label, value, note and an optional colour (rgb) to tint the tile. */
const facts = (...items: [string, string, string?, string?][]) =>
  h(
    'div',
    { class: `lc-facts${items.filter(([, v]) => v).length > 3 ? ' grid' : ''}` },
    ...items.filter(([, v]) => v).map(([k, v, n, c]) => tint(h('div', { class: 'lc-fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n ? h('div', { class: 'n' }, n) : null), c)),
  );

/** Worst weather code over some hours, for a day icon. */
function dayIcon(hs: Hour[]): string {
  const day = hs.filter((x) => x.isDay);
  const pick = (day.length ? day : hs).reduce((a, b) => (b.code > a.code ? b : a));
  return condition(pick.code, true).icon;
}

// ---------- the cards ----------

/** The next day's temperatures in words: where it goes and when, plus rain or snow if likely. */
function tempSay(next: Hour[], tz: string | undefined, feels: boolean): string {
  const v = (x: Hour) => (feels ? x.feels ?? x.temp : x.temp);
  if (next.length < 2) return '';
  const hi = next.reduce((a, b) => (v(b) > v(a) ? b : a)), lo = next.reduce((a, b) => (v(b) < v(a) ? b : a));
  const deg = (x: Hour) => fmt('temp', v(x));
  let say: string;
  if (toDisplay('temp', v(hi)) - toDisplay('temp', v(lo)) < 3) say = `Steady around ${deg(next[0])} for the next day.`;
  else if (hi === next[0]) say = `Cooling to ${deg(lo)} by ${hourName(lo.t, tz)}.`;
  else if (lo === next[0]) say = `Warming to ${deg(hi)} by ${hourName(hi.t, tz)}.`;
  else if (hi.t < lo.t) say = `Up to ${deg(hi)} around ${hourName(hi.t, tz)}, then down to ${deg(lo)} by ${hourName(lo.t, tz)}.`;
  else say = `Down to ${deg(lo)} around ${hourName(lo.t, tz)}, then up to ${deg(hi)} by ${hourName(hi.t, tz)}.`;
  const wet = next.find((x, i) => i > 0 && ((x.precip ?? 0) >= 0.2 || (x.pop ?? 0) >= 50));
  if (wet && !((next[0].precip ?? 0) >= 0.2)) say += ` ${[71, 73, 75, 77, 85, 86].includes(wet.code) ? 'Snow' : 'Rain'} likely from about ${hourName(wet.t, tz)}.`;
  else if ((next[0].precip ?? 0) >= 0.2) say += ` ${condition(next[0].code, next[0].isDay).label} now.`;
  return say;
}

/** 24-hour temperature curve, coloured by temperature, with the weather every 3 hours above it. */
function tempCurve(next: Hour[], tz: string | undefined, feels: boolean): HTMLElement {
  const W = 340, H = 112, top = 30, bottom = 16;
  const v = (x: Hour) => toDisplay('temp', feels ? x.feels ?? x.temp : x.temp);
  const vs = next.map(v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = Math.max(1, (hi - lo) * 0.18);
  const n = next.length;
  const x = (i: number) => (W * (i + 0.5)) / n;
  const y = (t: number) => top + 10 + (1 - (t - (lo - pad)) / (hi + pad - (lo - pad) || 1)) * (H - top - bottom - 14);
  const step = n > 12 ? 3 : 1; // hourly data: label every 3 hours
  // the value labels of the windows holding the high and the low move onto them, so the
  // numbers in the sentence above are on the chart
  const at = next.map((_, i) => i);
  for (const e of [vs.indexOf(hi), vs.indexOf(lo)]) {
    let m = Math.round(e / step) * step;
    if (m >= n) m -= step;
    if (m > 0 && e !== m) at[m] = e;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'lc-bars');
  const gid = `tc${Math.random().toString(36).slice(2, 8)}`;
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = gid;
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', '0');
  grad.setAttribute('x2', String(W));
  grad.setAttribute('y1', '0');
  grad.setAttribute('y2', '0');
  next.forEach((hr, i) => {
    const st = document.createElementNS(ns, 'stop');
    st.setAttribute('offset', String(x(i) / W));
    st.setAttribute('stop-color', colorAt(TEMPERATURE, feels ? hr.feels ?? hr.temp : hr.temp));
    grad.append(st);
  });
  const defs = document.createElementNS(ns, 'defs');
  defs.append(grad);
  svg.append(defs);
  let d = `M${x(0)},${y(vs[0])}`;
  for (let i = 1; i < n; i++) {
    const cx = (x(i - 1) + x(i)) / 2;
    d += ` C${cx},${y(vs[i - 1])} ${cx},${y(vs[i])} ${x(i)},${y(vs[i])}`;
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', `url(#${gid})`);
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  next.forEach((hr, i) => {
    if (i % step) return;
    const j = at[i];
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(x(j)));
    c.setAttribute('cy', String(y(vs[j])));
    c.setAttribute('r', i === 0 ? '3.6' : '2.4');
    c.setAttribute('fill', colorAt(TEMPERATURE, feels ? next[j].feels ?? next[j].temp : next[j].temp));
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '1.2');
    const val = document.createElementNS(ns, 'text');
    val.setAttribute('x', String(x(j)));
    val.setAttribute('y', String(y(vs[j]) - 7));
    val.setAttribute('text-anchor', 'middle');
    val.setAttribute('class', 'lc-val');
    val.textContent = `${Math.round(vs[j])}°`;
    // the weather in this 3-hour window (its most significant hour), with rain chance
    const win = next.slice(i, i + step);
    const worst = win.reduce((a, b) => (b.code > a.code ? b : a));
    const pop = Math.max(...win.map((w) => w.pop ?? 0));
    const icon = document.createElementNS(ns, 'text');
    icon.setAttribute('x', String(x(i)));
    icon.setAttribute('y', '13');
    icon.setAttribute('text-anchor', 'middle');
    icon.setAttribute('class', 'lc-icon');
    icon.textContent = condition(worst.code, worst.isDay).icon;
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${hourName(hr.t, tz)}: ${condition(worst.code, worst.isDay).label}`;
    icon.append(title);
    svg.append(c, val, icon);
    if (pop >= 20) {
      const p = document.createElementNS(ns, 'text');
      p.setAttribute('x', String(x(i)));
      p.setAttribute('y', '25');
      p.setAttribute('text-anchor', 'middle');
      p.setAttribute('class', 'lc-pop');
      p.textContent = `${Math.round(pop / 10) * 10}%`;
      svg.append(p);
    }
    const ax = document.createElementNS(ns, 'text');
    ax.setAttribute('x', String(x(i)));
    ax.setAttribute('y', String(H - 3));
    ax.setAttribute('text-anchor', 'middle');
    ax.setAttribute('class', 'lc-axis');
    ax.textContent = i === 0 ? 'Now' : hourName(hr.t, tz).replace(/\s?([AP])M/, (_, q) => q.toLowerCase());
    svg.append(ax);
  });
  return h('div', { class: 'lc-chart' }, svg);
}

const windShort = (kmh: number) => (kmh < 2 ? 'calm' : kmh < 12 ? 'light' : kmh < 29 ? 'breezy' : kmh < 39 ? 'windy' : kmh < 62 ? 'very windy' : 'stormy');

function tempCard({ fc, at, feels }: CardContext): Node[] {
  const tz = fc.timezone;
  const { cur, next } = window24(fc, at);
  const lead = feels ? cur.feels ?? cur.temp : cur.temp;
  const cond = condition(cur.code, cur.isDay);
  const day = [...fc.daily].reverse().find((d) => d.t <= cur.t + 2 * HOUR) ?? fc.daily[0];
  // high and low in the same terms as the headline: feels-like or actual
  const hiLo = (d: PointForecast['daily'][number]): [number, number] => (feels && num(d.fmax) && num(d.fmin) ? [d.fmax, d.fmin] : [d.max, d.min]);
  const sub = [
    feels ? `actual ${fmt('temp', cur.temp)}` : num(cur.feels) ? `feels ${fmt('temp', cur.feels)}` : '',
    day ? `H ${fmt('temp', hiLo(day)[0])} · L ${fmt('temp', hiLo(day)[1])}` : '',
  ].filter(Boolean).join(' · ');
  const head = headline(fmt('temp', lead), cond.label, sub, colorAt(TEMPERATURE, lead));
  head.querySelector('.lc-word')?.prepend(h('span', { class: 'lc-cond', 'aria-hidden': 'true' }, cond.icon));
  head.querySelector('.lc-chip')?.remove();
  const popMax = max(next.map((x) => x.pop ?? 0));
  const rain24 = sum(next.map((x) => x.precip ?? 0));
  const dew = cur.dew;
  const followDays = fc.daily.filter((d) => d.t > cur.t + 2 * HOUR).slice(0, 4);
  const hoursOf = (d: { t: number }) => fc.hours.filter((x) => x.t >= d.t && x.t < d.t + 24 * HOUR); // t: local midnight
  return [
    head,
    sentence(tempSay(next, tz, !!feels)),
    tempCurve(next, tz, !!feels),
    facts(
      ['Wind', num(cur.wind) ? fmt('speed', cur.wind) : '—', num(cur.gust) ? `gusts ${fmt('speed', cur.gust, false)}` : num(cur.wind) ? windShort(cur.wind) : undefined, num(cur.wind) ? colorAt(WIND, cur.wind) : undefined],
      ['Humidity', num(cur.humidity) ? fmt('percent', cur.humidity) : '—', num(dew) ? `dew point ${fmt('temp', dew)}` : undefined, num(cur.humidity) ? colorAt(HUMIDITY, cur.humidity) : undefined],
      ['Rain', `${Math.round(popMax || 0)}%`, rain24 >= 0.1 ? `total ${fmt('precip', rain24)}` : 'next 24 h', colorAt(CHANCE_TILE, popMax || 0)],
      ...(num(day?.uv) ? [['UV today', String(Math.round(day!.uv!)), uvLevel(day!.uv!).toLowerCase(), colorAt(UV_INDEX, Math.round(day!.uv!))] as [string, string, string, string]] : []),
      ...(num(day?.sun) ? [['Sunshine', `${day!.sun!.toFixed(1)} h`, 'today', colorAt(SUN_TILE, day!.sun!)] as [string, string, string, string]] : []),
      ...(fc.air ? [['Air quality', String(Math.round(fc.air.aqi)), aqiWord(fc.air.aqi).toLowerCase(), colorAt(AQI, fc.air.aqi)] as [string, string, string, string]] : []),
    ),
    followDays.length
      ? days(
          followDays.map((d) => {
            const hs = hoursOf(d);
            const [hi, lo] = hiLo(d);
            return { t: d.t + 12 * HOUR, icon: hs.length ? dayIcon(hs) : undefined, main: `${fmt('temp', hi)}`, note: `low ${fmt('temp', lo)}`, color: colorAt(TEMPERATURE, hi) };
          }),
          tz,
        )
      : null,
    h(
      'div',
      { class: 'note' },
      fc.source === 'Open-Meteo'
        ? `Point forecast: Open-Meteo (best model for this spot)${tz ? ` · times in ${tz.replace(/_/g, ' ')}` : ''}. Map: NOAA GFS.`
        : 'Point forecast: NOAA GFS, adjusted to local terrain elevation.',
    ),
  ].filter(Boolean) as Node[];
}

function precipCard({ fc, at }: CardContext): Node[] {
  const { cur, next } = window24(fc, at);
  const tz = fc.timezone;
  const rate = cur.precip ?? 0;
  const wet = (x: Hour) => (x.precip ?? 0) >= 0.1;
  const likely = (x: Hour) => wet(x) || (x.pop ?? 0) >= 50;
  const snow = (x: Hour) => [71, 73, 75, 77, 85, 86].includes(x.code);
  const what = (x: Hour) => (snow(x) ? 'Snow' : 'Rain');
  let say: string;
  if (wet(cur)) {
    const stop = next.findIndex((x, i) => i > 0 && !wet(x) && (x.pop ?? 0) < 40);
    say = stop > 0 ? `${what(cur)} easing around ${hourName(next[stop].t, tz)}.` : `${what(cur)} continuing through the next day.`;
  } else {
    const start = next.findIndex(likely);
    say = start < 0 ? 'No rain expected in the next 24 hours.' : `${what(next[start])} likely from about ${hourName(next[start].t, tz)}.`;
  }
  const total = sum(next.map((x) => x.precip ?? 0));
  const peak = max(next.map((x) => x.precip ?? 0));
  const dd = nextDays(fc, at);
  return [
    headline(wet(cur) ? fmt('rate', rate) : 'Dry', wet(cur) ? condition(cur.code, cur.isDay).label : 'No rain right now', num(cur.pop) ? `${Math.round(cur.pop)}% chance this hour` : undefined, wet(cur) ? colorAt(PRECIP, rate) : undefined),
    sentence(say),
    bars(
      next.map((x, i) => ({ t: x.t, v: x.precip ?? 0, back: (x.pop ?? 0) / 100, color: colorAt(snow(x) ? SNOWFALL : PRECIP, Math.max(0.2, x.precip ?? 0)), label: (x.precip ?? 0) >= 0.1 ? fmt('precip', x.precip ?? 0, false) : undefined, mark: i === 0 })),
      { tz, max: Math.max(2, peak), every: 3 },
    ),
    h('div', { class: 'lc-legend' }, 'Bars: amount each hour · shading: chance of rain'),
    facts(
      ['Next 24 hours', total >= 0.1 ? fmt('precip', total) : 'none', undefined, total >= 0.1 ? colorAt(PRECIP, Math.max(0.2, total / 6)) : undefined],
      ['Highest chance', `${Math.round(max(next.map((x) => x.pop ?? 0)) || 0)}%`, undefined, colorAt(CHANCE_TILE, max(next.map((x) => x.pop ?? 0)) || 0)],
    ),
    days(
      dd.map((d) => ({ t: d.t, icon: dayIcon(d.hours), main: `${Math.round(max(d.hours.map((x) => x.pop ?? 0)) || 0)}%`, note: sum(d.hours.map((x) => x.precip ?? 0)) >= 0.1 ? fmt('precip', sum(d.hours.map((x) => x.precip ?? 0))) : 'dry', color: colorAt(CHANCE_TILE, max(d.hours.map((x) => x.pop ?? 0)) || 0) })),
      tz,
    ),
  ];
}

const cloudWord = (pct: number) => (pct < 10 ? 'Clear' : pct < 35 ? 'Mostly clear' : pct < 70 ? 'Partly cloudy' : pct < 90 ? 'Mostly cloudy' : 'Overcast');

function cloudCard({ fc, at }: CardContext): Node[] {
  const { cur, next } = window24(fc, at);
  const tz = fc.timezone;
  const c = cur.cloud ?? NaN;
  const daylight = next.filter((x) => x.isDay && num(x.cloud));
  let say = '';
  if (daylight.length) {
    const avg = sum(daylight.map((x) => x.cloud!)) / daylight.length;
    const clearest = daylight.reduce((a, b) => (b.cloud! < a.cloud! ? b : a));
    say = avg < 25 ? 'Mostly sunny daylight hours ahead.' : avg > 75 ? 'Mostly grey skies in the daylight hours ahead.' : `Sun and cloud; brightest around ${hourName(clearest.t, tz)}.`;
  }
  const today = [...fc.daily].reverse().find((d) => d.t <= at + 12 * HOUR);
  const dd = nextDays(fc, at);
  const sunDays = fc.daily.filter((d) => d.t > at && num(d.sun)).slice(0, 4);
  return [
    headline(num(c) ? fmt('percent', c) : '—', num(c) ? cloudWord(c) : '', cur.isDay ? undefined : 'night', num(c) ? colorAt(CLOUD, c) : undefined),
    say ? sentence(say) : null,
    bars(next.map((x, i) => ({ t: x.t, v: x.cloud ?? 0, color: x.isDay ? colorAt(CLOUD, x.cloud ?? 0) : '#9aa6b8', label: num(x.cloud) ? `${Math.round(x.cloud)}` : undefined, mark: i === 0 })), { tz, max: 100, every: 3 }),
    h('div', { class: 'lc-legend' }, 'Cloud cover each hour (%) · darker bars: night'),
    facts(
      ['Sunshine today', num(today?.sun) ? `${today!.sun!.toFixed(1)} h` : '', undefined, num(today?.sun) ? colorAt(SUN_TILE, today!.sun!) : undefined],
      ['Now', condition(cur.code, cur.isDay).label, undefined, num(c) ? colorAt(CLOUD, c) : undefined],
    ),
    sunDays.length
      ? days(sunDays.map((d) => ({ t: d.t + 12 * HOUR, icon: '☀️', main: `${d.sun!.toFixed(1)} h`, note: 'sunshine', color: colorAt(SUN_TILE, d.sun!) })), tz)
      : days(
          dd.map((d) => {
            const lit = d.hours.filter((x) => x.isDay);
            const pct = sum(lit.map((x) => x.cloud ?? 0)) / Math.max(1, lit.length);
            return { t: d.t, icon: dayIcon(d.hours), main: `${Math.round(pct)}%`, color: colorAt(CLOUD, pct) };
          }),
          tz,
        ),
  ].filter(Boolean) as Node[];
}

const uvLevel = (raw: number) => { const uv = Math.round(raw); return uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme'; };
const uvTip = (uv: number) =>
  uv < 3 ? 'No protection needed.' : uv < 6 ? 'Sunscreen and sunglasses if you are out for long.' : uv < 8 ? 'Cover up, hat and sunscreen; seek shade around midday.' : uv < 11 ? 'Extra protection: avoid the midday sun.' : 'Avoid the sun around midday; unprotected skin burns in minutes.';

function uvCard({ fc, at }: CardContext): Node[] {
  const tz = fc.timezone;
  const { cur } = window24(fc, at);
  const uv = cur.uv ?? NaN;
  const today = localDay(fc, cur.t);
  const withUv = today.filter((x) => num(x.uv));
  const peak = withUv.length ? withUv.reduce((a, b) => (b.uv! > a.uv! ? b : a)) : null;
  const strong = withUv.filter((x) => x.uv! >= 3);
  const span = strong.length ? `${hourName(strong[0].t, tz)} – ${hourName(strong[strong.length - 1].t + HOUR, tz)}` : '';
  const tomorrow = fc.daily.find((d) => d.t > cur.t + 6 * HOUR);
  let say: string;
  if (!num(uv) && !withUv.length) say = 'No UV forecast for this spot right now.';
  else if (!cur.isDay || !num(uv) || uv < 0.5) say = peak && peak.t > cur.t ? `Peaks at ${Math.round(peak.uv!)} (${uvLevel(peak.uv!).toLowerCase()}) around ${hourName(peak.t, tz)}.` : num(tomorrow?.uv) ? `Sun is down. Tomorrow's peak: ${Math.round(tomorrow!.uv!)} (${uvLevel(tomorrow!.uv!).toLowerCase()}).` : 'Sun is down.';
  else say = `${uvTip(Math.max(uv, peak?.uv ?? 0))}${span ? ` Protect yourself ${span}.` : ''}`;
  const daylight = today.filter((x) => x.isDay || (x.uv ?? 0) > 0);
  const chartHours = daylight.length >= 4 ? daylight : today;
  return [
    headline(num(uv) ? String(Math.round(uv)) : '—', num(uv) ? uvLevel(uv) : '', peak ? `today's peak ${Math.round(peak.uv!)} at ${hourName(peak.t, tz)}` : undefined, num(uv) ? colorAt(UV_INDEX, uv) : undefined),
    sentence(say),
    bars(chartHours.map((x) => ({ t: x.t, v: x.uv ?? 0, color: colorAt(UV_INDEX, x.uv ?? 0), label: (x.uv ?? 0) >= 0.5 ? String(Math.round(x.uv!)) : undefined, mark: x.t === cur.t })), { tz, max: Math.max(8, peak?.uv ?? 0), every: 2 }),
    h('div', { class: 'lc-legend' }, 'UV index through today (local time) · 3+ needs protection'),
    days(fc.daily.filter((d) => d.t > cur.t && num(d.uv)).slice(0, 4).map((d) => ({ t: d.t + 12 * HOUR, main: String(Math.round(d.uv!)), note: uvLevel(d.uv!).toLowerCase(), color: colorAt(UV_INDEX, Math.round(d.uv!)) })), tz),
  ];
}

const aqiWord = (a: number) => (a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Unhealthy for sensitive groups' : a <= 200 ? 'Unhealthy' : a <= 300 ? 'Very unhealthy' : 'Hazardous');
const aqiTip = (a: number) =>
  a <= 50
    ? 'Air quality is fine for everyone.'
    : a <= 100
      ? 'Fine for most; unusually sensitive people may want to take it easy outdoors.'
      : a <= 150
        ? 'Children, older adults and people with heart or lung conditions should limit long or heavy exertion outside.'
        : a <= 200
          ? 'Everyone should cut back on long or heavy exertion outdoors.'
          : 'Avoid exertion outdoors; consider staying inside with windows closed.';

function airCard({ fc, air }: CardContext): Node[] {
  const tz = fc.timezone;
  const now = fc.air?.aqi ?? air?.[0]?.[1];
  const series = air ?? [];
  const worst = series.length ? series.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const best = series.length ? series.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
  return [
    headline(num(now) ? String(Math.round(now)) : '—', num(now) ? aqiWord(now) : 'Loading…', fc.air ? `US AQI · PM2.5 ${Math.round(fc.air.pm25)} µg/m³` : 'US AQI', num(now) ? colorAt(AQI, now) : undefined),
    num(now) ? sentence(aqiTip(now)) : null,
    series.length > 1
      ? bars(series.map(([t, a], i) => ({ t, v: a, color: colorAt(AQI, a), label: String(Math.round(a)), mark: i === 0 })), { tz, max: Math.max(150, worst?.[1] ?? 0), every: 1, height: 84 })
      : h('div', { class: 'lc-legend' }, 'Loading the next two days…'),
    series.length > 1 ? h('div', { class: 'lc-legend' }, 'Next 48 hours, every 6 hours') : null,
    worst && best
      ? facts(
          ['Worst', `${Math.round(worst[1])} · ${dayName(worst[0], tz)} ${hourName(worst[0], tz)}`, undefined, colorAt(AQI, worst[1])],
          ['Best', `${Math.round(best[1])} · ${dayName(best[0], tz)} ${hourName(best[0], tz)}`, undefined, colorAt(AQI, best[1])],
        )
      : null,
    h('div', { class: 'note' }, 'NOAA aerosol forecast (GEFS-Aerosols), matched to satellite and ground-monitor estimates. Fine particles (PM2.5) only.'),
  ].filter(Boolean) as Node[];
}

function snowCard({ fc, at }: CardContext): Node[] {
  const tz = fc.timezone;
  const { cur, next } = window24(fc, at);
  const depth = cur.snowDepth;
  const fresh = sum(next.map((x) => x.snowfall ?? 0));
  const dd = fc.daily.filter((d) => d.t > at - 12 * HOUR && num(d.snowfall)).slice(0, 5);
  const any = fresh >= 0.1 || dd.some((d) => (d.snowfall ?? 0) >= 0.1);
  return [
    headline(num(depth) && depth >= 0.5 ? fmt('snow', depth) : 'None', num(depth) && depth >= 0.5 ? 'of snow on the ground' : 'no snow on the ground', undefined, num(depth) && depth >= 0.5 ? '#9fb4ff' : undefined),
    sentence(fresh >= 0.1 ? `${fmt('snow', fresh)} of fresh snow in the next 24 hours.` : any ? 'Snow on the way in the coming days.' : 'No snow in the forecast.'),
    any ? bars(next.map((x, i) => ({ t: x.t, v: x.snowfall ?? 0, color: colorAt(SNOWFALL, Math.max(0.05, (x.snowfall ?? 0) / 10)), label: (x.snowfall ?? 0) >= 0.1 ? fmt('snow', x.snowfall!, false) : undefined, mark: i === 0 })), { tz, max: Math.max(1, max(next.map((x) => x.snowfall ?? 0))), every: 3 }) : null,
    dd.length ? days(dd.map((d) => ({ t: d.t + 12 * HOUR, icon: (d.snowfall ?? 0) >= 0.1 ? '❄️' : '·', main: (d.snowfall ?? 0) >= 0.1 ? fmt('snow', d.snowfall!) : '—', note: 'fresh snow', color: (d.snowfall ?? 0) >= 0.1 ? colorAt(SNOWFALL, Math.max(0.05, d.snowfall! / 10)) : undefined })), tz) : null,
    h('div', { class: 'note' }, 'Point forecast: Open-Meteo. The map shows snow depth from NOAA GFS, and HRRR over the US.'),
  ].filter(Boolean) as Node[];
}

const windWord = (kmh: number) => (kmh < 2 ? 'Calm' : kmh < 12 ? 'Light air' : kmh < 29 ? 'Breezy' : kmh < 39 ? 'Windy' : kmh < 62 ? 'Very windy' : 'Stormy');
const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function windCard({ fc, at }: CardContext): Node[] {
  const tz = fc.timezone;
  const { cur, next } = window24(fc, at);
  const w = cur.wind ?? NaN;
  const strongest = next.filter((x) => num(x.gust ?? x.wind)).reduce<Hour | null>((a, b) => (!a || (b.gust ?? b.wind!) > (a.gust ?? a.wind!) ? b : a), null);
  const arrow = num(cur.windDir) ? h('span', { class: 'lc-arrow', title: `from the ${compass(cur.windDir)}` }, '↓') : null;
  if (arrow && num(cur.windDir)) arrow.style.transform = `rotate(${cur.windDir}deg)`;
  const head = headline(num(w) ? fmt('speed', w) : '—', num(w) ? windWord(w) : '', [num(cur.windDir) ? `from the ${compass(cur.windDir)}` : '', num(cur.gust) ? `gusts ${fmt('speed', cur.gust)}` : ''].filter(Boolean).join(' · '), num(w) ? colorAt(WIND, w) : undefined);
  if (arrow) head.querySelector('.lc-value')!.append(arrow);
  const dd = nextDays(fc, at);
  return [
    head,
    strongest ? sentence(`Strongest ${num(strongest.gust) ? 'gusts' : 'wind'} around ${hourName(strongest.t, tz)}: ${fmt('speed', strongest.gust ?? strongest.wind!)}.`) : null,
    bars(next.map((x, i) => ({ t: x.t, v: x.wind ?? 0, back: num(x.gust) ? x.gust / Math.max(40, max(next.map((y) => y.gust ?? y.wind ?? 0))) : undefined, color: colorAt(WIND, x.wind ?? 0), label: num(x.wind) ? fmt('speed', x.wind, false) : undefined, mark: i === 0 })), { tz, max: Math.max(40, max(next.map((y) => y.gust ?? y.wind ?? 0))), every: 3 }),
    h('div', { class: 'lc-legend' }, `Wind each hour (${units.imperial ? 'mph' : 'km/h'}) · shading: gusts`),
    days(dd.map((d) => ({ t: d.t, main: fmt('speed', max(d.hours.map((x) => x.wind ?? 0))), note: `gusts ${fmt('speed', max(d.hours.map((x) => x.gust ?? 0)), false)}`, color: colorAt(WIND, max(d.hours.map((x) => x.wind ?? 0))) })), tz),
  ].filter(Boolean) as Node[];
}

function dewOf(tempC: number, rh: number) {
  const a = 17.62, b = 243.12;
  const g = Math.log(Math.max(1, rh) / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}
const feelWord = (dew: number) => (dew < 10 ? 'Dry' : dew < 16 ? 'Comfortable' : dew < 20 ? 'Humid' : dew < 24 ? 'Muggy' : 'Oppressive');

function humidityCard({ fc, at }: CardContext): Node[] {
  const tz = fc.timezone;
  const { cur, next } = window24(fc, at);
  const rh = cur.humidity ?? NaN;
  const dew = cur.dew ?? (num(rh) ? dewOf(cur.temp, rh) : NaN);
  const dews = next.map((x) => x.dew ?? (num(x.humidity) ? dewOf(x.temp, x.humidity) : NaN)).filter(num);
  const hi = max(dews);
  return [
    headline(num(rh) ? fmt('percent', rh) : '—', num(dew) ? feelWord(dew) : '', num(dew) ? `dew point ${fmt('temp', dew)}` : undefined, num(rh) ? colorAt(HUMIDITY, rh) : undefined),
    sentence(num(hi) ? (hi >= 20 ? 'Sticky air: the dew point stays high.' : hi >= 16 ? 'Humid at times over the next day.' : hi < 5 ? 'Very dry air over the next day.' : 'Comfortable air over the next day.') : ''),
    bars(next.map((x, i) => ({ t: x.t, v: x.humidity ?? 0, color: colorAt(HUMIDITY, x.humidity ?? 0), label: num(x.humidity) ? `${Math.round(x.humidity)}` : undefined, mark: i === 0 })), { tz, max: 100, every: 3 }),
    h('div', { class: 'lc-legend' }, 'Relative humidity each hour (%). How sticky it feels depends on the dew point: under 10° dry, 16° humid, 20°+ muggy.'),
  ];
}

export function layerCard(kind: CardKind, ctx: CardContext): Node[] {
  switch (kind) {
    case 'temp':
      return tempCard(ctx);
    case 'precip':
      return precipCard(ctx);
    case 'cloud':
      return cloudCard(ctx);
    case 'uv':
      return uvCard(ctx);
    case 'aqi':
      return airCard(ctx);
    case 'snow':
      return snowCard(ctx);
    case 'wind':
      return windCard(ctx);
    case 'humidity':
      return humidityCard(ctx);
  }
}

export const CARD_TITLES: Record<CardKind, string> = {
  temp: 'Temperature',
  precip: 'Precipitation',
  cloud: 'Clouds',
  uv: 'UV index',
  aqi: 'Air quality',
  snow: 'Snow',
  wind: 'Wind',
  humidity: 'Humidity',
};
