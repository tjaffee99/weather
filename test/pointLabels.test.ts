import { describe, expect, it } from 'vitest';
import { correctionField } from '../src/live/pointLabels';
import { apparentTemp } from '../src/live/feels';

describe('correctionField', () => {
  // 10° x 10° box, 100 x 100 cells: cell (x, y) centre at lon -100 + (x + 0.5) * 0.1, lat 45 - (y + 0.5) * 0.1
  const extent: [number, number, number, number] = [-100, 45, 10, 10];
  const at = (f: Float32Array, lon: number, lat: number) => f[Math.floor((45 - lat) / 0.1) * 100 + Math.floor((lon + 100) / 0.1)];

  it('matches the residual at a city and fades to zero away from it', () => {
    const f = correctionField([{ lon: -95, lat: 40, r: 3 }], extent, 50, 100, 100);
    expect(at(f, -95, 40)).toBeGreaterThan(2.7);
    expect(at(f, -95, 40)).toBeLessThanOrEqual(3);
    expect(Math.abs(at(f, -91, 43))).toBeLessThan(0.01);
  });

  it('never overshoots the residuals of close cities that disagree', () => {
    const f = correctionField([{ lon: -95, lat: 40, r: 4 }, { lon: -94.9, lat: 40, r: -4 }], extent, 60, 100, 100);
    for (const v of f) expect(Math.abs(v)).toBeLessThanOrEqual(4);
  });
});

describe('apparentTemp', () => {
  it('is below the air temperature in dry, breezy weather and above it when humid', () => {
    expect(apparentTemp(24.5, 6.8, 2.7)).toBeCloseTo(21.9, 1);
    expect(apparentTemp(30, 25, 1)).toBeGreaterThan(33);
  });
});
