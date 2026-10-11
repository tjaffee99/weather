import type { Quantity } from '../units';
import type { CritVar } from './types';

export type CritGroup = 'Temperature' | 'Sky & air' | 'Rain & wind' | 'Snow & sea';
export const GROUPS: CritGroup[] = ['Temperature', 'Sky & air', 'Rain & wind', 'Snow & sea'];

export interface CritDef {
  v: CritVar;
  group: CritGroup;
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
  /** range used when the condition is added (metric; ±Infinity = open) */
  def: [number, number];
}

export const CRITERIA: CritDef[] = [
  {
    v: 'feels', group: 'Temperature', label: 'Feels-like high', hint: 'How warm the afternoon feels (heat, humidity, wind)', q: 'temp', kind: 'continuous',
    metric: { min: -30, max: 45, step: 1 }, imperial: { min: -20, max: 115, step: 1 }, file: 'feels',
    def: [18, 27], // comfortable outdoors for most people (64–81 °F)
  },
  {
    v: 'tmax', group: 'Temperature', label: 'Daytime high', hint: 'Afternoon air temperature', q: 'temp', kind: 'continuous',
    metric: { min: -30, max: 45, step: 1 }, imperial: { min: -20, max: 115, step: 1 }, file: 'tmax',
    def: [20, 29], // pleasant afternoon (68–84 °F)
  },
  {
    v: 'tmin', group: 'Temperature', label: 'Overnight low', hint: 'Coldest part of the night', q: 'temp', kind: 'continuous',
    metric: { min: -40, max: 35, step: 1 }, imperial: { min: -40, max: 95, step: 1 }, file: 'tmin',
    def: [10, 20], // no jacket needed, cool enough to sleep (50–68 °F)
  },
  {
    v: 'dew', group: 'Sky & air', label: 'Humidity', hint: 'Dew point: under 10° dry, 16° sticky, 20°+ muggy', q: 'temp', kind: 'continuous',
    metric: { min: -20, max: 28, step: 1 }, imperial: { min: -5, max: 82, step: 1 }, file: 'dew',
    def: [-Infinity, 16], // above ~16 °C (61 °F) dew point air starts to feel sticky
  },
  {
    v: 'cloud', group: 'Sky & air', label: 'Cloud cover', hint: 'Average from 9 am to 6 pm', q: 'percent', kind: 'continuous',
    metric: { min: 0, max: 100, step: 10 }, imperial: { min: 0, max: 100, step: 10 }, file: 'cloud',
    def: [-Infinity, 40], // mostly sunny
  },
  {
    v: 'precip', group: 'Rain & wind', label: 'Precipitation', hint: 'Rain or melted snow per day', q: 'precip', kind: 'bins',
    edges: [0.1, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150], file: 'precip',
    def: [-Infinity, 1], // a dry day (the standard 1 mm wet-day threshold)
  },
  {
    v: 'wind', group: 'Rain & wind', label: 'Wind', hint: 'Strongest steady daytime wind', q: 'speed', kind: 'bins',
    edges: [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 120, 150], file: 'wind',
    def: [-Infinity, 25], // below a 'fresh breeze' (Beaufort 5 starts at 29 km/h)
  },
  {
    v: 'snow', group: 'Snow & sea', label: 'Snow on the ground', hint: 'Snow depth', q: 'snow', kind: 'bins',
    edges: [1, 2.5, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500], file: 'snow',
    def: [20, Infinity], // a proper white landscape (8 in)
  },
  {
    v: 'sst', group: 'Snow & sea', label: 'Sea temperature', hint: 'Nearby ocean; coastal places only', q: 'temp', kind: 'continuous',
    metric: { min: 0, max: 32, step: 1 }, imperial: { min: 32, max: 90, step: 1 }, file: 'sst',
    def: [24, Infinity], // comfortable swimming (75 °F)
  },
  {
    v: 'daylight', group: 'Sky & air', label: 'Daylight', hint: 'Sunrise to sunset', q: 'hours', kind: 'continuous',
    metric: { min: 0, max: 24, step: 1 }, imperial: { min: 0, max: 24, step: 1 },
    def: [10, Infinity],
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
  { id: 'perfect', label: 'Perfect day', icon: '✨', state: { feels: [18, 27], cloud: [-I, 40], precip: [-I, 1] } },
  { id: 'beach', label: 'Beach', icon: '🏖', state: { feels: [26, 36], cloud: [-I, 40], precip: [-I, 1], wind: [-I, 30], sst: [24, I] } },
  { id: 'ski', label: 'Skiing', icon: '⛷', state: { tmax: [-12, 4], snow: [30, I], wind: [-I, 40] } },
  { id: 'hike', label: 'Hiking', icon: '🥾', state: { feels: [10, 24], precip: [-I, 1], wind: [-I, 30] } },
  { id: 'dry', label: 'Not muggy', icon: '🌵', state: { dew: [-I, 13], feels: [16, 30] } },
  { id: 'sunny', label: 'Sunny', icon: '☀️', state: { cloud: [-I, 20], precip: [-I, 1] } },
  { id: 'rain', label: 'Rainy', icon: '☔', state: { precip: [1, I] } },
  { id: 'snowy', label: 'Snowy', icon: '❄️', state: { snow: [5, I] } },
];
