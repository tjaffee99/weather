/**
 * City temperatures on the live map from the same point forecast as the
 * location card (Open-Meteo, the best model for each spot), so a city's label
 * and its card agree. The GFS field underneath is coarser (25 km); around the
 * labelled cities it is nudged to their values (correctionField) so the
 * colours agree with the numbers too.
 */
import type { City } from '../data';
import { apparentTemp } from './feels';

const HOUR = 3600_000;
const FRESH = 45 * 60_000; // refetch after this
const BATCH = 100; // locations per request

interface Series {
  t0: number; // ms of the first hour
  temp: Float32Array; // °C
  dew: Float32Array; // °C
  wind: Float32Array; // m/s
  fetched: number;
}

export class PointLabels {
  private data = new Map<City, Series>();
  private pending = new Set<City>();
  private pausedUntil = 0;
  /** new forecasts arrived */
  onData: () => void = () => {};

  /** Fetch forecasts for these cities where missing or stale, in the background. */
  want(cities: City[]) {
    const now = Date.now();
    if (now < this.pausedUntil) return;
    const need = cities.filter((c) => !this.pending.has(c) && !((this.data.get(c)?.fetched ?? 0) > now - FRESH));
    for (let i = 0; i < need.length; i += BATCH) this.load(need.slice(i, i + BATCH));
  }

  private async load(cs: City[]) {
    cs.forEach((c) => this.pending.add(c));
    try {
      // same coordinates as the card's request, so both get the same forecast
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${cs.map((c) => c.lat.toFixed(4)).join(',')}` +
        `&longitude=${cs.map((c) => c.lon.toFixed(4)).join(',')}` +
        `&hourly=temperature_2m,dew_point_2m,wind_speed_10m&wind_speed_unit=ms&past_days=1&forecast_days=4&timeformat=unixtime`;
      const res = await fetch(url);
      if (!res.ok) {
        // over the free API's limits (or down): labels stay on the map's own field for a while
        this.pausedUntil = Date.now() + (res.status === 429 ? 20 : 5) * 60_000;
        return;
      }
      const j = await res.json();
      const list: { hourly?: Record<string, (number | null)[]> }[] = Array.isArray(j) ? j : [j];
      const now = Date.now();
      list.forEach((r, i) => {
        const h = r.hourly;
        if (!h?.time?.length || !cs[i]) return;
        const arr = (k: string) => Float32Array.from(h[k] ?? [], (v) => (v == null ? NaN : v));
        this.data.set(cs[i], { t0: (h.time[0] as number) * 1000, temp: arr('temperature_2m'), dew: arr('dew_point_2m'), wind: arr('wind_speed_10m'), fetched: now });
      });
      this.onData();
    } catch {
      this.pausedUntil = Date.now() + 2 * 60_000;
    } finally {
      cs.forEach((c) => this.pending.delete(c));
    }
  }

  /** Temperature or feels-like (°C) at a city and time; NaN when not loaded or out of range. */
  value(c: City, t: number, feels: boolean): number {
    const s = this.data.get(c);
    if (!s) return NaN;
    const f = (t - s.t0) / HOUR;
    const i = Math.floor(f);
    if (i < 0 || i + 1 >= s.temp.length) return NaN;
    const w = f - i;
    const at = (k: number) => (feels ? apparentTemp(s.temp[k], s.dew[k], s.wind[k]) : s.temp[k]);
    return at(i) * (1 - w) + at(i + 1) * w;
  }
}

export interface Nudge {
  lon: number;
  lat: number;
  /** label value minus the map's own value there (°C) */
  r: number;
}

/**
 * A smooth surface through the residuals at the labelled cities that fades to
 * zero away from them (Gaussian-process regression with a squared-exponential
 * kernel of length scale `km`), on a lon/lat grid over `extent` (west, north,
 * width, height in degrees). Values are clamped to the residuals' range so
 * close cities that disagree can't overshoot.
 */
export function correctionField(pts: Nudge[], extent: [number, number, number, number], km: number, w = 192, h = 192): Float32Array {
  const out = new Float32Array(w * h);
  const n = pts.length;
  if (!n) return out;
  const [west, north, width, height] = extent;
  const lat0 = north - height / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const px = pts.map((p) => ((((p.lon - west) % 360) + 360) % 360) * kx);
  const py = pts.map((p) => (north - p.lat) * ky);
  const inv = 1 / (2 * km * km);
  // K + nugget, Cholesky
  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      const dx = px[i] - px[j], dy = py[i] - py[j];
      K[i * n + j] = K[j * n + i] = Math.exp(-(dx * dx + dy * dy) * inv) + (i === j ? 0.05 : 0);
    }
  for (let j = 0; j < n; j++) {
    let d = K[j * n + j];
    for (let k = 0; k < j; k++) d -= K[j * n + k] ** 2;
    d = Math.sqrt(Math.max(d, 1e-9));
    K[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = K[i * n + j];
      for (let k = 0; k < j; k++) s -= K[i * n + k] * K[j * n + k];
      K[i * n + j] = s / d;
    }
  }
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = pts[i].r;
    for (let k = 0; k < i; k++) s -= K[i * n + k] * a[k];
    a[i] = s / K[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = a[i];
    for (let k = i + 1; k < n; k++) s -= K[k * n + i] * a[k];
    a[i] = s / K[i * n + i];
  }
  let lo = 0, hi = 0;
  for (const p of pts) {
    lo = Math.min(lo, p.r);
    hi = Math.max(hi, p.r);
  }
  // evaluate on the grid, visiting only cities within 3 length scales (binned)
  const cw = (width * kx) / w, ch = (height * ky) / h; // km per texel
  const reach = 3 * km, bin = reach;
  const key = (bx: number, by: number) => (bx + 4096) * 8192 + by + 4096;
  const bins = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(px[i] / bin), Math.floor(py[i] / bin));
    let b = bins.get(k);
    if (!b) bins.set(k, (b = []));
    b.push(i);
  }
  const r2 = reach * reach;
  for (let y = 0; y < h; y++) {
    const yy = (y + 0.5) * ch, by = Math.floor(yy / bin);
    for (let x = 0; x < w; x++) {
      const xx = (x + 0.5) * cw, bx = Math.floor(xx / bin);
      let v = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const b = bins.get(key(bx + ox, by + oy));
          if (!b) continue;
          for (const i of b) {
            const dx = xx - px[i], dy = yy - py[i], d2 = dx * dx + dy * dy;
            if (d2 < r2) v += a[i] * Math.exp(-d2 * inv);
          }
        }
      out[y * w + x] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}
