export type ClimVar = 'feels' | 'tmax' | 'tmin' | 'dew' | 'sst' | 'cloud' | 'precip' | 'wind' | 'snow' | 'sun' | 'uv' | 'rh' | 'snowfall' | 'aqi';
export type CritVar = ClimVar | 'daylight';

export interface VarMeta {
  type: 'linear' | 'bins';
  scale?: number;
  offset?: number;
  nodata?: number;
  edges?: number[];
  file: string;
  bytes: number;
  mode: number;
  checksum: number;
}

export interface ClimateMeta {
  version: number;
  source: string;
  grid: { nx: number; ny: number; lon0: number; lat0: number; dx: number; dy: number };
  days: number;
  block: number;
  ncells: number;
  sampleYears: number[];
  vars: Record<ClimVar, VarMeta>;
}

/** A criterion in metric units; bounds may be +-Infinity. */
export interface Criterion {
  v: CritVar;
  lo: number;
  hi: number;
}

export const LEVELS = 9;
export const DZ0 = -2000;
export const DZ_STEP = 500;
export const LAPSE = 0.0065;

export interface MonthStats {
  feels: number;
  tmax: number;
  tmin: number;
  dew: number;
  cloud: number;
  precip: number; // mm per month
  rainDays: number; // days >= 1 mm per month
  sunnyDays: number; // daytime cloud <= 25%
  snowDays: number; // snow on ground >= 1 cm
  wind: number;
  sst: number;
  sun: number; // average hours of sunshine per day
  uv: number; // average daily peak UV index
  rh: number; // average daytime relative humidity, %
  snowfall: number; // cm of snow falling in the month
  aqi: number; // average daily US AQI (PM2.5)
  goodAirDays: number; // days with AQI <= 50
  match: number; // matching days per month
  /** the conditions that rule out the most days this month, worst first */
  why: Obstacle[];
}

/** A condition that rules days out: which side it misses on and on what share of days. */
export interface Obstacle {
  v: CritVar;
  dir: 'low' | 'high';
  frac: number;
}

export interface DetailResult {
  cellLon: number;
  cellLat: number;
  cellElev: number;
  shift: number; // °C applied to the main cell for the point's elevation
  cells: number; // how many nearby cells were blended (the main one is cellLon/cellLat)
  perYear: number;
  daily: Float32Array; // smoothed probability per day of year
  months: Partial<MonthStats>[];
  loaded: ClimVar[];
}
