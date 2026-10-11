export type ClimVar = 'feels' | 'tmax' | 'tmin' | 'dew' | 'sst' | 'cloud' | 'precip' | 'wind' | 'snow' | 'sun';
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
  match: number; // matching days per month
}

export interface DetailResult {
  cellLon: number;
  cellLat: number;
  cellElev: number;
  shift: number; // °C applied for the point's elevation
  perYear: number;
  daily: Float32Array; // smoothed probability per day of year
  months: Partial<MonthStats>[];
  loaded: ClimVar[];
}
