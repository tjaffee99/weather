/**
 * Microclimates: how much warmer or cooler a spot is than the blended 1° climate
 * cells around it, beyond what its elevation explains (fog-cooled coasts, hot
 * inland valleys, lake shores, cold-air basins, cities). Built from WorldClim
 * at 2.5' by pipeline/microclimate.py and stored as yearly curves in 10° tiles.
 *
 * Offsets are kept for the average daily high (tmax) and low (tmin). The map
 * loads the tiles on screen when zoomed in; cards and city labels use the
 * offsets at their point.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { fetchBinary } from '../data';

export interface MicroIndex {
  px: number; // pixels per degree
  tile: number; // degrees per tile
  top: number; // latitude of the first tile row's top edge
  left: number;
  harmonics: number;
  scale: number; // °C per stored step
  tiles: [number, number][];
}

/** Offsets as yearly-curve coefficients in °C: tmax then tmin, each 2*harmonics+1. */
export type MicroCoefs = Float32Array;

export const MICRO_NC = 5; // coefficients per variable (mean + 2 harmonics)

/** Which offset a set of temperature conditions should use: daytime, night, both, none. */
export type MicroVar = 0 | 1 | 2 | 3;

/** Seasons used for the finder's yearly counts: Dec-Feb, Mar-May, Jun-Aug, Sep-Nov (day-of-year ranges). */
export const SEASONS: [number, number][] = [
  [334, 424], // wraps: Dec 1 to Feb 28
  [59, 151],
  [151, 243],
  [243, 334],
];

/** Basis weights averaged over days [a, b) (b may exceed 365 to wrap), for MICRO_NC coefficients. */
export function rangeWeights(a: number, b: number, nc = MICRO_NC): Float64Array {
  const w = new Float64Array(nc);
  for (let d = a; d < b; d++) {
    const t = ((d % 365) + 0.5) / 365;
    w[0] += 1;
    for (let k = 1; 2 * k < nc; k++) {
      w[2 * k - 1] += Math.cos(2 * Math.PI * k * t);
      w[2 * k] += Math.sin(2 * Math.PI * k * t);
    }
  }
  for (let c = 0; c < nc; c++) w[c] /= b - a;
  return w;
}

export const SEASON_WEIGHTS = SEASONS.map(([a, b]) => rangeWeights(a, b));

export function seasonOf(d: number): number {
  return d >= 334 || d < 59 ? 0 : d < 151 ? 1 : d < 243 ? 2 : 3;
}

/** The offset (°C) for a variable choice and coefficient weights. */
export function microOffset(c: MicroCoefs | null | undefined, v: MicroVar, w: ArrayLike<number>): number {
  if (!c || v === 0) return 0;
  let hi = 0, lo = 0;
  for (let k = 0; k < MICRO_NC; k++) {
    hi += w[k] * c[k];
    lo += w[k] * c[MICRO_NC + k];
  }
  return v === 1 ? hi : v === 2 ? lo : (hi + lo) / 2;
}

/** Coefficients from a city's stored integers. */
export function cityCoefs(mc: number[] | null | undefined, scale: number): MicroCoefs | null {
  return mc ? Float32Array.from(mc, (x) => x * scale) : null;
}

export interface MicroMosaic {
  width: number;
  height: number;
  /** 3 layers of RGBA int8: tmax c0-c3 | tmax c4, tmin c0-c2 | tmin c3-c4, 0, 0 */
  data: Int8Array;
  /** west longitude, north latitude, width and height in degrees */
  extent: [number, number, number, number];
}

export class Microclimate {
  index?: MicroIndex;
  private ready: Promise<void>;
  private have = new Set<string>();
  private cache = new Map<string, Promise<Int8Array | null>>();
  private timer = 0;
  private key = '';
  active = false;
  /** a mosaic is on the map (labels then use offsets too, to match the colours) */
  shown = false;
  onUpdate: (m: MicroMosaic | null) => void = () => {};

  constructor(
    private base: string,
    private map: MlMap,
    private minZoom = 4,
  ) {
    this.ready = fetch(`${base}data/micro/index.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: MicroIndex | null) => {
        if (!j) return;
        this.index = j;
        for (const [ty, tx] of j.tiles) this.have.add(`${ty}_${tx}`);
      })
      .catch(() => {});
    map.on('moveend', () => this.schedule());
  }

  get scale() {
    return this.index?.scale ?? 0.1;
  }

  private tile(ty: number, tx: number): Promise<Int8Array | null> {
    const key = `${ty}_${tx}`;
    if (!this.have.has(key)) return Promise.resolve(null);
    let p = this.cache.get(key);
    if (!p) {
      p = fetchBinary(`${this.base}data/micro/${key}.bin`)
        .then((b) => new Int8Array(b.buffer, b.byteOffset, b.byteLength))
        .catch(() => null);
      this.cache.set(key, p);
      p.then((v) => v || this.cache.delete(key));
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Offsets at a point (bilinear), or null where there are none. */
  async at(lon: number, lat: number): Promise<MicroCoefs | null> {
    await this.ready;
    const ix = this.index;
    if (!ix) return null;
    const n = ix.tile * ix.px, planes = 2 * MICRO_NC;
    const fy = (ix.top - lat) * ix.px - 0.5, fx = ((((lon - ix.left) % 360) + 360) % 360) * ix.px - 0.5;
    const y0 = Math.floor(fy), x0 = Math.floor(fx);
    const out = new Float32Array(planes);
    let any = false;
    for (const [dy, dx, w] of [
      [0, 0, (1 - (fy - y0)) * (1 - (fx - x0))],
      [0, 1, (1 - (fy - y0)) * (fx - x0)],
      [1, 0, (fy - y0) * (1 - (fx - x0))],
      [1, 1, (fy - y0) * (fx - x0)],
    ]) {
      const y = y0 + dy, x = (x0 + dx + 360 * ix.px) % (360 * ix.px);
      if (y < 0) continue;
      const t = await this.tile(Math.floor(y / n), Math.floor(x / n));
      if (!t) continue;
      const o = (y % n) * n + (x % n);
      for (let k = 0; k < planes; k++) out[k] += w * t[k * n * n + o] * ix.scale;
      any = true;
    }
    return any ? out : null;
  }

  /** Turn viewport mosaics on (finder and atlas) or off. */
  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.key = '';
      this.emit(null);
    } else this.schedule();
  }

  private emit(m: MicroMosaic | null) {
    const was = this.shown;
    this.shown = !!m;
    if (m || was) this.onUpdate(m);
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), 150);
  }

  private async update() {
    await this.ready;
    const ix = this.index;
    if (!ix || !this.active) return;
    const map = this.map;
    if (map.getZoom() < this.minZoom) {
      if (this.key) {
        this.key = '';
        this.emit(null);
      }
      return;
    }
    const b = map.getBounds();
    const ty0 = Math.max(0, Math.floor((ix.top - b.getNorth()) / ix.tile));
    const ty1 = Math.floor((ix.top - Math.max(-85, b.getSouth())) / ix.tile);
    const tx0 = Math.floor((b.getWest() - ix.left) / ix.tile);
    const tx1 = Math.floor((b.getEast() - ix.left) / ix.tile);
    const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
    if (nx > 5 || ny > 4 || ny <= 0) {
      if (this.key) {
        this.key = '';
        this.emit(null);
      }
      return;
    }
    const key = `${ty0}/${ty1}/${tx0}/${tx1}`;
    if (key === this.key) return;
    this.key = key;
    const cols = 360 / ix.tile;
    const tiles = await Promise.all(
      Array.from({ length: nx * ny }, (_, k) => this.tile(ty0 + Math.floor(k / nx), (((tx0 + (k % nx)) % cols) + cols) % cols)),
    );
    if (this.key !== key || !this.active) return;
    const n = ix.tile * ix.px, W = nx * n, H = ny * n;
    const data = new Int8Array(W * H * 12);
    tiles.forEach((t, k) => {
      if (!t) return;
      const ox = (k % nx) * n, oy = Math.floor(k / nx) * n;
      for (let p = 0; p < 2 * MICRO_NC; p++) {
        const layer = p >> 2, ch = p & 3;
        const src = p * n * n;
        for (let r = 0; r < n; r++) {
          const row = ((layer * H + oy + r) * W + ox) * 4 + ch;
          for (let c = 0; c < n; c++) data[row + c * 4] = t[src + r * n + c];
        }
      }
    });
    this.emit({ width: W, height: H, data, extent: [ix.left + tx0 * ix.tile, ix.top - ty0 * ix.tile, nx * ix.tile, ny * ix.tile] });
  }
}
