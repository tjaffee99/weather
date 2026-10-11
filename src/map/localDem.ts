/**
 * High-resolution elevation for the current viewport, mosaicked from AWS
 * Terrain Tiles (terrarium PNGs). The field shader uses it instead of the
 * global 0.1° DEM when zoomed in, so lapse-rate downscaled temperatures resolve
 * individual valleys and ridges.
 */
import type { Map as MlMap } from 'maplibre-gl';

const URL_T = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const MAX_TILES_AXIS = 12;

const cache = new Map<string, Promise<Float32Array | null>>();

async function decodeTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | null> {
  const res = await fetch(URL_T.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = new OffscreenCanvas(256, 256);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) {
    const e = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    out[i] = e > 0 ? e : 0; // sea surface / depressions -> 0, like the global DEM
  }
  return out;
}

export function tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | null> {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = decodeTile(z, x, y, signal).catch(() => null);
    cache.set(key, p);
    p.then((v) => v || cache.delete(key));
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Elevation (m) at a point from a z11 tile (~75 m pixels), bilinear. */
export async function pointElevation(lon: number, lat: number, z = 11): Promise<number | null> {
  const n = 2 ** z;
  const mx = ((lon + 180) / 360) * n;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  const my = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const tx = Math.floor(mx), ty = Math.floor(my);
  const t = await tile(z, tx, ty);
  if (!t) return null;
  const px = Math.min(254.999, Math.max(0, (mx - tx) * 256 - 0.5));
  const py = Math.min(254.999, Math.max(0, (my - ty) * 256 - 0.5));
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const g = (a: number, b: number) => t[b * 256 + a];
  return g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
}

export interface LocalDemData {
  width: number;
  height: number;
  data: Float32Array;
  /** extent in (unwrapped) mercator coordinates: x0, y0, x1, y1 */
  extent: [number, number, number, number];
}

export class LocalDem {
  private timer = 0;
  private key = '';
  private abort?: AbortController;

  constructor(
    private map: MlMap,
    private onUpdate: (d: LocalDemData | null) => void,
    private minZoom = 5,
  ) {
    map.on('moveend', () => this.schedule());
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), 200);
  }

  private async update() {
    const map = this.map;
    const zoom = map.getZoom();
    if (zoom < this.minZoom || map.getProjection()?.type === 'globe' && zoom < 6) {
      if (this.key) {
        this.key = '';
        this.onUpdate(null);
      }
      return;
    }
    let z = Math.min(11, Math.floor(zoom));
    const b = map.getBounds();
    const n0 = () => 2 ** z;
    const toTile = (lon: number, lat: number) => {
      const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
      return [((lon + 180) / 360) * n0(), (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n0()];
    };
    let x0: number, x1: number, y0: number, y1: number;
    for (;;) {
      const [ax, ay] = toTile(b.getWest(), b.getNorth());
      const [bx, by] = toTile(b.getEast(), b.getSouth());
      x0 = Math.floor(ax) - 1;
      x1 = Math.floor(bx) + 1;
      y0 = Math.max(0, Math.floor(ay) - 1);
      y1 = Math.min(n0() - 1, Math.floor(by) + 1);
      if ((x1 - x0 + 1 <= MAX_TILES_AXIS && y1 - y0 + 1 <= MAX_TILES_AXIS) || z <= 3) break;
      z--;
    }
    const key = `${z}/${x0}/${x1}/${y0}/${y1}`;
    if (key === this.key) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    const tiles = await Promise.all(
      Array.from({ length: nx * ny }, (_, k) => tile(z, x0 + (k % nx), y0 + Math.floor(k / nx), ac.signal)),
    );
    if (ac.signal.aborted) return;
    const W = nx * 256, H = ny * 256;
    const data = new Float32Array(W * H);
    tiles.forEach((t, k) => {
      if (!t) return;
      const ox = (k % nx) * 256, oy = Math.floor(k / nx) * 256;
      for (let r = 0; r < 256; r++) data.set(t.subarray(r * 256, r * 256 + 256), (oy + r) * W + ox);
    });
    this.key = key;
    const n = 2 ** z;
    this.onUpdate({ width: W, height: H, data, extent: [x0 / n, y0 / n, (x1 + 1) / n, (y1 + 1) / n] });
  }
}
