/**
 * How the climate finder turns 1° cells into a value at a point. The shader
 * (fieldLayer.ts), the city labels and the location card all follow these
 * rules, so the map, its labels and the card agree:
 *
 * - cubic B-spline weights over the 4×4 nearby cells, for smooth gradients;
 * - each cell is evaluated at the point's own elevation (temperatures shifted
 *   by the lapse rate), within ±2000 m of the cell's mean elevation;
 * - a cell that can't reach that elevation, e.g. a high plateau next to a
 *   coastal plain, fades out, by a factor e for every EXCESS_SCALE metres
 *   it falls short.
 */
import { DZ0, DZ_STEP, LEVELS } from './types';

export const EXCESS_SCALE = 300; // m

export interface BlendGrid {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dx: number;
  dy: number;
}

export interface Tap {
  /** raster index (row * nx + col) */
  p: number;
  /** blend weight (B-spline weight × elevation reach) */
  q: number;
  /** elevation shift applied to this cell (m), clamped to the level range */
  dz: number;
}

/** Cubic B-spline weights for cells at offsets -1, 0, 1, 2 from floor(x). */
export function bspline(f: number): [number, number, number, number] {
  const a = 1 - f;
  return [(a * a * a) / 6, (3 * f * f * f - 6 * f * f + 4) / 6, (-3 * f * f * f + 3 * f * f + 3 * f + 1) / 6, (f * f * f) / 6];
}

/**
 * Cells contributing to the point (lon, lat) at elevation z. `elevAt(p)`
 * returns a cell's mean elevation, or undefined where there is no cell.
 * `cover` is the summed B-spline weight of existing cells (fades the map at
 * the edge of the data).
 */
export function blendTaps(g: BlendGrid, elevAt: (p: number) => number | undefined, lon: number, lat: number, z: number): { taps: Tap[]; cover: number } {
  const x = (((lon - g.lon0) / g.dx) % g.nx + g.nx) % g.nx;
  const y = (g.lat0 - lat) / g.dy;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const wx = bspline(x - x0), wy = bspline(y - y0);
  const lo = DZ0, hi = DZ0 + (LEVELS - 1) * DZ_STEP;
  const taps: Tap[] = [];
  let cover = 0;
  for (let j = 0; j < 4; j++) {
    const yy = y0 + j - 1;
    if (yy < 0 || yy >= g.ny || wy[j] === 0) continue;
    for (let i = 0; i < 4; i++) {
      const w = wx[i] * wy[j];
      if (w === 0) continue;
      const p = yy * g.nx + ((((x0 + i - 1) % g.nx) + g.nx) % g.nx);
      const ze = elevAt(p);
      if (ze === undefined) continue;
      cover += w;
      const want = z - ze;
      const dz = Math.min(hi, Math.max(lo, want));
      taps.push({ p, q: w * Math.exp(-Math.abs(want - dz) / EXCESS_SCALE), dz });
    }
  }
  return { taps, cover };
}

/** Fractional level index for an elevation shift. */
export function levelOf(dz: number): number {
  return Math.min(LEVELS - 1, Math.max(0, (dz - DZ0) / DZ_STEP));
}
