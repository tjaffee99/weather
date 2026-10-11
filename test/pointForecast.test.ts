import { describe, expect, it } from 'vitest';
import { codeFromFields, condition, isDaytime } from '../src/live/pointForecast';

describe('conditions', () => {
  it('maps WMO codes to labels and day/night icons', () => {
    expect(condition(0, true)).toEqual({ label: 'Sunny', icon: '☀️' });
    expect(condition(0, false).label).toBe('Clear');
    expect(condition(3).label).toBe('Overcast');
    expect(condition(63).label).toBe('Rain');
    expect(condition(75).label).toBe('Heavy snow');
    expect(condition(95).label).toBe('Thunderstorms');
  });
  it('derives a code from model fields', () => {
    expect(codeFromFields(5, 0, false)).toBe(0);
    expect(codeFromFields(90, 0, false)).toBe(3);
    expect(codeFromFields(90, 2, false)).toBe(63);
    expect(codeFromFields(90, 1, true)).toBe(73);
  });
  it('knows day from night', () => {
    // Boca Raton: 17:00 UTC is midday, 06:00 UTC is 2 am
    expect(isDaytime(-80.1, 26.37, Date.UTC(2026, 9, 11, 17))).toBe(true);
    expect(isDaytime(-80.1, 26.37, Date.UTC(2026, 9, 11, 6))).toBe(false);
  });
});
