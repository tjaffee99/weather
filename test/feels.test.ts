import { describe, expect, it } from 'vitest';
import { apparentTemp } from '../src/live/feels';

describe('apparentTemp', () => {
  it('is below the air temperature in dry, breezy weather and above it when humid', () => {
    expect(apparentTemp(24.5, 6.8, 2.7)).toBeCloseTo(21.9, 1);
    expect(apparentTemp(30, 25, 1)).toBeGreaterThan(33);
  });
});
