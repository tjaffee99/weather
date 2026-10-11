import type { Quantity } from '../units';
import type { CritVar } from './types';

export interface CritDef {
  v: CritVar;
  label: string;
  hint: string;
  q: Quantity;
  kind: 'continuous' | 'bins';
  /** continuous: slider bounds in metric and imperial display units */
  metric?: { min: number; max: number; step: number };
  imperial?: { min: number; max: number; step: number };
  /** bins: metric bin edges (slider stops are 0, ...edges, ∞) */
  edges?: number[];
  /** approximate download size key (var file) */
  file?: string;
}

export const CRITERIA: CritDef[] = [
  {
    v: 'feels', label: 'Feels-like high', hint: 'Daytime apparent temperature (heat, humidity & wind)', q: 'temp', kind: 'continuous',
    metric: { min: -30, max: 45, step: 1 }, imperial: { min: -20, max: 115, step: 1 }, file: 'feels',
  },
  {
    v: 'tmax', label: 'Daytime high', hint: 'Actual air temperature, daily maximum', q: 'temp', kind: 'continuous',
    metric: { min: -30, max: 45, step: 1 }, imperial: { min: -20, max: 115, step: 1 }, file: 'tmax',
  },
  {
    v: 'tmin', label: 'Overnight low', hint: 'Daily minimum temperature', q: 'temp', kind: 'continuous',
    metric: { min: -40, max: 35, step: 1 }, imperial: { min: -40, max: 95, step: 1 }, file: 'tmin',
  },
  {
    v: 'dew', label: 'Humidity (dew point)', hint: '< 10° dry · 16° noticeable · 20°+ muggy', q: 'temp', kind: 'continuous',
    metric: { min: -20, max: 28, step: 1 }, imperial: { min: -5, max: 82, step: 1 }, file: 'dew',
  },
  {
    v: 'cloud', label: 'Cloud cover', hint: 'Daytime average (9am–6pm)', q: 'percent', kind: 'continuous',
    metric: { min: 0, max: 100, step: 10 }, imperial: { min: 0, max: 100, step: 10 }, file: 'cloud',
  },
  {
    v: 'precip', label: 'Precipitation', hint: 'Daily total rain/snow (water equivalent)', q: 'precip', kind: 'bins',
    edges: [0.1, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150], file: 'precip',
  },
  {
    v: 'wind', label: 'Wind', hint: 'Strongest sustained daytime wind', q: 'speed', kind: 'bins',
    edges: [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 120, 150], file: 'wind',
  },
  {
    v: 'snow', label: 'Snow on the ground', hint: 'Snow depth', q: 'snow', kind: 'bins',
    edges: [1, 2.5, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500], file: 'snow',
  },
  {
    v: 'sst', label: 'Sea temperature', hint: 'Nearby ocean surface — coastal areas only', q: 'temp', kind: 'continuous',
    metric: { min: 0, max: 32, step: 1 }, imperial: { min: 32, max: 90, step: 1 }, file: 'sst',
  },
  {
    v: 'daylight', label: 'Daylight', hint: 'Hours from sunrise to sunset', q: 'hours', kind: 'continuous',
    metric: { min: 0, max: 24, step: 1 }, imperial: { min: 0, max: 24, step: 1 },
  },
];

/** Criterion state as metric bounds; ±Infinity = open-ended. */
export type CritState = Partial<Record<CritVar, [number, number]>>;

export interface Preset {
  id: string;
  label: string;
  icon: string;
  state: CritState;
}

const I = Infinity;
export const PRESETS: Preset[] = [
  { id: 'perfect', label: 'Perfect day', icon: '✨', state: { feels: [18, 27], cloud: [-I, 50], precip: [-I, 1] } },
  { id: 'beach', label: 'Beach', icon: '🏖', state: { feels: [26, I], cloud: [-I, 40], precip: [-I, 1], sst: [24, I], wind: [-I, 30] } },
  { id: 'ski', label: 'Skiing', icon: '⛷', state: { tmax: [-15, 5], snow: [30, I], wind: [-I, 40] } },
  { id: 'hike', label: 'Hiking', icon: '🥾', state: { feels: [8, 24], precip: [-I, 1], wind: [-I, 35], cloud: [-I, 70] } },
  { id: 'dry', label: 'Not muggy', icon: '🌵', state: { dew: [-I, 13], feels: [16, 30] } },
  { id: 'sunny', label: 'Sunshine', icon: '☀️', state: { cloud: [-I, 20], precip: [-I, 0.5] } },
  { id: 'rain', label: 'Rain chance', icon: '☔', state: { precip: [1, I] } },
  { id: 'snowy', label: 'Snow cover', icon: '❄️', state: { snow: [5, I] } },
];
