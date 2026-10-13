/**
 * Atlas normals as smooth yearly curves (pipeline/encode_climate.py atlas()).
 * Each cell, and each elevation level for rain and snow, stores the mean of a
 * smoothed daily series plus HARMONICS yearly harmonics. A day's normal is the
 * curve at that day, a month's is its average over the month, and the year's
 * is the mean term, so the three views always agree.
 */
import type { AtlasMeta } from './types';

export const DAYS = 365;
export const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export type PeriodKind = 'year' | 'month' | 'day';
export interface Period {
  kind: PeriodKind;
  /** month 0-11 (kind 'month') */
  m: number;
  /** day of the year 0-364 (kind 'day') */
  d: number;
}

export interface AtlasField {
  kind: 'mean' | 'sum';
  levels: number;
  /** values per level: land cells, or every grid point for the sea */
  n: number;
  nc: number;
  /** [coef][level][n]; NaN = no data */
  coef: Float32Array;
  /** sea grid: 0 = none, 1 = sea, 2 = extended onto the coast */
  flags?: Uint8Array;
}

export function decodeAtlas(buf: Uint8Array, m: AtlasMeta, harmonics: number, n: number): AtlasField {
  const nc = 2 * harmonics + 1;
  const count = nc * m.levels * n;
  // copy to an aligned buffer for the int16 view
  const raw = new Int16Array(buf.slice(0, count * 2).buffer);
  const coef = new Float32Array(count);
  for (let i = 0; i < count; i++) coef[i] = raw[i] === -32768 ? NaN : raw[i] * m.scale;
  return { kind: m.kind, levels: m.levels, n, nc, coef, flags: m.grid === 'sea' ? buf.slice(count * 2, count * 2 + n) : undefined };
}

/** The curve's basis at day d: 1, cos(2πkt), sin(2πkt) at the day's centre (mirrors basis() in the encoder). */
function basisAt(d: number, nc: number, out: Float64Array, scale = 1) {
  const t = (d + 0.5) / DAYS;
  out[0] += scale;
  for (let k = 1; 2 * k < nc; k++) {
    out[2 * k - 1] += scale * Math.cos(2 * Math.PI * k * t);
    out[2 * k] += scale * Math.sin(2 * Math.PI * k * t);
  }
}

/** Weights on the coefficients giving the period's average per day. */
export function periodWeights(p: Period, nc: number): Float64Array {
  const w = new Float64Array(nc);
  if (p.kind === 'year') w[0] = 1;
  else if (p.kind === 'day') basisAt(p.d, nc, w);
  else {
    const a = MONTH_START[p.m], b = MONTH_START[p.m + 1];
    for (let d = a; d < b; d++) basisAt(d, nc, w, 1 / (b - a));
  }
  return w;
}

/** Days in the period (sums are the average per day times this). */
export function periodDays(p: Period): number {
  return p.kind === 'year' ? DAYS : p.kind === 'month' ? DAYS_IN_MONTH[p.m] : 1;
}

/** Average per day over the period for every level and cell: [level][n], clipped to the variable's range. */
export function evalField(f: AtlasField, w: Float64Array, lo = -Infinity, hi = Infinity): Float32Array {
  const len = f.levels * f.n;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < f.nc; c++) {
      const wc = w[c];
      if (wc !== 0) s += wc * f.coef[c * len + i];
    }
    out[i] = Math.min(hi, Math.max(lo, s));
  }
  return out;
}

/** The same for one entry (level l, index i). */
export function evalAt(f: AtlasField, w: Float64Array, l: number, i: number, lo = -Infinity, hi = Infinity): number {
  const len = f.levels * f.n;
  const o = l * f.n + i;
  let s = 0;
  for (let c = 0; c < f.nc; c++) if (w[c] !== 0) s += w[c] * f.coef[c * len + o];
  return Math.min(hi, Math.max(lo, s));
}
