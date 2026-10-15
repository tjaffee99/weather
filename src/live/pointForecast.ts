/**
 * Point forecast for the location card, from the free Open-Meteo API (best
 * available high-resolution model for the location, elevation-corrected, with
 * WMO weather codes for conditions). The map itself stays on NOAA GFS; the
 * card's temperatures start from the map's (anchorForecast).
 */
import { apparentTemp } from './feels';

export interface Hour {
  t: number; // UTC ms
  temp: number;
  feels?: number;
  code: number; // WMO weather code
  isDay: boolean;
  pop?: number; // precipitation probability %
  precip?: number; // mm in the hour
  cloud?: number;
  humidity?: number;
  wind?: number; // km/h
  gust?: number;
  windDir?: number; // degrees, direction the wind comes from
  uv?: number;
  dew?: number; // °C
  snowfall?: number; // cm in the hour
  snowDepth?: number; // cm on the ground
}

export interface PointForecast {
  source: 'Open-Meteo' | 'NOAA GFS';
  timezone?: string;
  hours: Hour[];
  /** t: local midnight. max/min (and the feels-like fmax/fmin) from the hours where they cover the day */
  daily: { t: number; max: number; min: number; fmax?: number; fmin?: number; sun?: number; uv?: number; precip?: number; pop?: number; snowfall?: number }[];
  /** current air quality, when available */
  air?: { aqi: number; pm25: number };
}

export async function openMeteo(lat: number, lon: number, signal?: AbortSignal): Promise<PointForecast> {
  const hourly = [
    'temperature_2m', 'relative_humidity_2m', 'weather_code', 'precipitation_probability',
    'precipitation', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'is_day',
    'wind_direction_10m', 'uv_index', 'dew_point_2m', 'snowfall', 'snow_depth',
  ];
  const daily = ['temperature_2m_max', 'temperature_2m_min', 'sunshine_duration', 'uv_index_max', 'precipitation_sum', 'precipitation_probability_max', 'snowfall_sum'];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=${hourly.join(',')}&daily=${daily.join(',')}` +
    `&past_days=1&forecast_days=5&timezone=auto&timeformat=unixtime`;
  const res = await fetch(url, { signal });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.reason || `HTTP ${res.status}`);
  const h = j.hourly;
  const hours: Hour[] = (h.time as number[]).map((t, i) => ({
    t: t * 1000,
    temp: h.temperature_2m[i],
    // the app's own feels-like (Open-Meteo's apparent_temperature also adds sunshine)
    feels: h.dew_point_2m?.[i] != null && h.wind_speed_10m?.[i] != null ? apparentTemp(h.temperature_2m[i], h.dew_point_2m[i], h.wind_speed_10m[i] / 3.6) : undefined,
    code: h.weather_code?.[i] ?? 0,
    isDay: h.is_day?.[i] === 1,
    pop: h.precipitation_probability?.[i] ?? undefined,
    precip: h.precipitation?.[i],
    cloud: h.cloud_cover?.[i],
    humidity: h.relative_humidity_2m?.[i],
    wind: h.wind_speed_10m?.[i],
    gust: h.wind_gusts_10m?.[i],
    windDir: h.wind_direction_10m?.[i] ?? undefined,
    uv: h.uv_index?.[i] ?? undefined,
    dew: h.dew_point_2m?.[i] ?? undefined,
    snowfall: h.snowfall?.[i] ?? undefined, // cm
    snowDepth: h.snow_depth?.[i] != null ? h.snow_depth[i] * 100 : undefined, // m -> cm
  })).filter((x) => Number.isFinite(x.temp));
  const d = j.daily;
  const days =
    (d?.time as number[] | undefined)?.map((t, i) => ({
      t: t * 1000,
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      ...dayRange(hours, t * 1000),
      sun: d.sunshine_duration?.[i] != null ? d.sunshine_duration[i] / 3600 : undefined,
      uv: d.uv_index_max?.[i] ?? undefined,
      precip: d.precipitation_sum?.[i] ?? undefined,
      pop: d.precipitation_probability_max?.[i] ?? undefined,
      snowfall: d.snowfall_sum?.[i] ?? undefined,
    })) ?? [];
  return { source: 'Open-Meteo', timezone: j.timezone, hours, daily: days };
}

/**
 * High and low (actual and feels-like) of the local day starting at t, from the
 * same hours as the card's chart and sentence, when they cover the day.
 */
function dayRange(hours: Hour[], t: number): { max?: number; min?: number; fmax?: number; fmin?: number } {
  const hs = hours.filter((x) => x.t >= t && x.t < t + 86400_000);
  if (hs.length < 20) return {};
  const ts = hs.map((x) => x.temp), fs = hs.filter((x) => x.feels != null).map((x) => x.feels!);
  return { max: Math.max(...ts), min: Math.min(...ts), ...(fs.length >= 20 ? { fmax: Math.max(...fs), fmin: Math.min(...fs) } : {}) };
}

const HOUR = 3600_000;
/** e-folding time of the map anchor (anchorForecast) */
const ANCHOR_FADE = 6 * HOUR;

/**
 * The forecast with its temperatures starting from the map's at time `at`:
 * the difference between the map and the forecast there is added to every
 * hour, fading out (e-folding 6 hours) so the forecast takes over. The card
 * then shows the map's number for the place and moment on the map, and moves
 * smoothly from place to place like the map does, instead of jumping between
 * the point forecast's grid cells.
 */
export function anchorForecast(fc: PointForecast, at: number, now: { temp: number; feels: number }): PointForecast {
  const hs = fc.hours;
  const i = hs.findIndex((x) => x.t > at);
  if (i <= 0) return fc;
  const a = hs[i - 1], b = hs[i], w = (at - a.t) / (b.t - a.t);
  const dT = now.temp - (a.temp + (b.temp - a.temp) * w);
  const dF = a.feels != null && b.feels != null ? now.feels - (a.feels + (b.feels - a.feels) * w) : dT;
  const hours = hs.map((x) => {
    const k = Math.exp(-Math.abs(x.t - at) / ANCHOR_FADE);
    return { ...x, temp: x.temp + dT * k, feels: x.feels != null ? x.feels + dF * k : x.feels };
  });
  return { ...fc, hours, daily: fc.daily.map((d) => ({ ...d, ...dayRange(hours, d.t) })) };
}

export interface Condition {
  label: string;
  icon: string;
}

/** WMO weather interpretation codes -> label + icon. */
export function condition(code: number, isDay = true): Condition {
  const sun = isDay;
  if (code === 0) return { label: sun ? 'Sunny' : 'Clear', icon: sun ? '☀️' : '🌙' };
  if (code === 1) return { label: sun ? 'Mostly sunny' : 'Mostly clear', icon: sun ? '🌤️' : '🌙' };
  if (code === 2) return { label: 'Partly cloudy', icon: sun ? '⛅' : '☁️' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫️' };
  if (code >= 51 && code <= 55) return { label: 'Drizzle', icon: sun ? '🌦️' : '🌧️' };
  if (code === 56 || code === 57 || code === 66 || code === 67) return { label: 'Freezing rain', icon: '🌧️' };
  if (code === 61) return { label: 'Light rain', icon: sun ? '🌦️' : '🌧️' };
  if (code === 63) return { label: 'Rain', icon: '🌧️' };
  if (code === 65) return { label: 'Heavy rain', icon: '🌧️' };
  if (code === 71) return { label: 'Light snow', icon: '🌨️' };
  if (code === 73 || code === 77) return { label: 'Snow', icon: '🌨️' };
  if (code === 75) return { label: 'Heavy snow', icon: '❄️' };
  if (code === 80) return { label: 'Showers', icon: sun ? '🌦️' : '🌧️' };
  if (code === 81 || code === 82) return { label: code === 82 ? 'Heavy showers' : 'Showers', icon: '🌧️' };
  if (code === 85 || code === 86) return { label: 'Snow showers', icon: '🌨️' };
  if (code === 95) return { label: 'Thunderstorms', icon: '⛈️' };
  if (code === 96 || code === 99) return { label: 'Thunderstorms & hail', icon: '⛈️' };
  return { label: '—', icon: '·' };
}

/** Approximate WMO code from model fields (GFS fallback). */
export function codeFromFields(cloud: number, precip: number, snow: boolean): number {
  if (precip >= 0.1) {
    if (snow) return precip > 2 ? 75 : precip > 0.5 ? 73 : 71;
    return precip > 4 ? 65 : precip > 1 ? 63 : 61;
  }
  return cloud < 15 ? 0 : cloud < 40 ? 1 : cloud < 75 ? 2 : 3;
}

/** Is the sun up at this place and time? (solar elevation > -0.83°) */
export function isDaytime(lon: number, lat: number, t: number): boolean {
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (t - start) / 86400000;
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy - 81)) * (Math.PI / 180);
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + lon / 15;
  const ha = ((hours - 12) * 15 * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  return Math.asin(sinEl) > (-0.83 * Math.PI) / 180;
}

/**
 * Sunrise and sunset (ms) on the local solar day containing time t, when the
 * sun's upper limb crosses the horizon with standard refraction (-0.833°);
 * 'day' or 'night' when it doesn't rise or set. NOAA's low-precision solar
 * formulas: within a few minutes.
 */
export function sunTimes(lon: number, lat: number, t: number): { rise: number; set: number } | 'day' | 'night' {
  const local = new Date(t + (lon / 15) * HOUR);
  const noon0 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12) - (lon / 15) * HOUR;
  const doy = (noon0 - Date.UTC(local.getUTCFullYear(), 0, 1)) / 86400_000;
  const g = (2 * Math.PI / 365) * doy;
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = (lat * Math.PI) / 180;
  const cosH = (Math.sin((-0.833 * Math.PI) / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
  if (cosH > 1) return 'night';
  if (cosH < -1) return 'day';
  const noon = noon0 - eqt * 60_000;
  const half = ((Math.acos(cosH) * 180) / Math.PI / 15) * HOUR;
  return { rise: noon - half, set: noon + half };
}

