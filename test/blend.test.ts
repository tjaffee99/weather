import { describe, expect, it } from 'vitest';
import { blendTaps, bspline, EXCESS_SCALE } from '../src/climate/blend';

const g = { nx: 360, ny: 144, lon0: -179.5, lat0: 83.5, dx: 1, dy: 1 };

describe('climate cell blending', () => {
  it('B-spline weights sum to 1', () => {
    for (const f of [0, 0.16, 0.5, 0.9]) expect(bspline(f).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('covers fully where every cell exists, and evaluates each cell at the point elevation', () => {
    const { taps, cover } = blendTaps(g, () => 500, -71.34, -17.64, 34);
    expect(cover).toBeCloseTo(1, 12);
    for (const t of taps) expect(t.dz).toBe(34 - 500);
  });

  it('fades out cells that cannot reach the point elevation', () => {
    // a coastal point at 34 m: its own cell averages 883 m, the one inland 3500 m
    const own = 108 + 101 * 360; // col for -71.5, row for -17.5
    const { taps } = blendTaps(g, (p) => (p === own ? 883 : 3500), -71.34, -17.64, 34);
    const t0 = taps.find((t) => t.p === own)!;
    const inland = taps.find((t) => t.p === own + 1)!;
    expect(t0.dz).toBe(34 - 883);
    expect(inland.dz).toBe(-2000); // clamped to the lowest level
    const w = (t: { q: number }) => t.q;
    expect(w(inland) / w(t0)).toBeLessThan(Math.exp(-(3466 - 2000) / EXCESS_SCALE));
  });

  it('wraps across the antimeridian', () => {
    const { taps } = blendTaps(g, () => 0, 179.9, 60, 0);
    const cols = new Set(taps.map((t) => t.p % g.nx));
    expect(cols.has(0)).toBe(true);
    expect(cols.has(359)).toBe(true);
  });
});
