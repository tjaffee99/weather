import { describe, expect, it } from 'vitest';
import { DAYS, DAYS_IN_MONTH, decodeAtlas, evalAt, evalField, periodDays, periodWeights } from '../src/climate/atlasData';

const NC = 9;

describe('atlas curves', () => {
  it('months add up to the year', () => {
    const year = periodWeights({ kind: 'year', m: 0, d: 0 }, NC);
    const sum = new Float64Array(NC);
    for (let m = 0; m < 12; m++) {
      const w = periodWeights({ kind: 'month', m, d: 0 }, NC);
      for (let c = 0; c < NC; c++) sum[c] += w[c] * periodDays({ kind: 'month', m, d: 0 });
    }
    for (let c = 0; c < NC; c++) expect(sum[c]).toBeCloseTo(year[c] * DAYS, 6);
  });

  it('evaluates a day on the curve', () => {
    // mean 10, first harmonic cosine amplitude 5: coldest in mid-year (t = 0.5)
    const coef = new Float32Array(NC);
    coef[0] = 10;
    coef[1] = 5;
    const f = { kind: 'mean' as const, levels: 1, n: 1, nc: NC, coef };
    const at = (d: number) => evalAt(f, periodWeights({ kind: 'day', m: 0, d }, NC), 0, 0);
    expect(at(182)).toBeCloseTo(5, 1);
    expect(at(0)).toBeCloseTo(15, 1);
    expect(evalField(f, periodWeights({ kind: 'year', m: 0, d: 0 }, NC))[0]).toBeCloseTo(10, 6);
    // clipping applies to the per-day value
    expect(evalAt(f, periodWeights({ kind: 'day', m: 0, d: 0 }, NC), 0, 0, 0, 12)).toBe(12);
  });

  it('decodes int16 coefficients with no-data', () => {
    const raw = new Int16Array(NC * 2);
    raw[0] = 100; // cell 0, mean
    raw[1] = -32768; // cell 1: no data
    const f = decodeAtlas(new Uint8Array(raw.buffer), { file: '', kind: 'sum', scale: 0.5, levels: 1, bytes: 0 }, 4, 2);
    expect(f.coef[0]).toBe(50);
    expect(Number.isNaN(f.coef[1])).toBe(true);
    expect(DAYS_IN_MONTH.reduce((a, b) => a + b)).toBe(DAYS);
  });
});
