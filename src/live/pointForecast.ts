/**
 * Point forecast for the location card, from the free Open-Meteo API (best
 * available high-resolution model for the location, elevation-corrected, with
 * WMO weather codes for conditions). The map itself stays on NOAA GFS.
 */

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
}

export interface PointForecast {
  source: 'Open-Meteo' | 'NOAA GFS';
  timezone?: string;
  hours: Hour[];
  daily: { t: number; max: number; min: number; sun?: number; uv?: number }[];
}

export async function openMeteo(lat: number, lon: number, signal?: AbortSignal): Promise<PointForecast> {
  const hourly = [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'precipitation_probability',
    'precipitation', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'is_day',
  ];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=${hourly.join(',')}&daily=temperature_2m_max,temperature_2m_min,sunshine_duration,uv_index_max` +
    `&past_days=1&forecast_days=5&timezone=auto&timeformat=unixtime`;
  const res = await fetch(url, { signal });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.reason || `HTTP ${res.status}`);
  const h = j.hourly;
  const hours: Hour[] = (h.time as number[]).map((t, i) => ({
    t: t * 1000,
    temp: h.temperature_2m[i],
    feels: h.apparent_temperature?.[i],
    code: h.weather_code?.[i] ?? 0,
    isDay: h.is_day?.[i] === 1,
    pop: h.precipitation_probability?.[i] ?? undefined,
    precip: h.precipitation?.[i],
    cloud: h.cloud_cover?.[i],
    humidity: h.relative_humidity_2m?.[i],
    wind: h.wind_speed_10m?.[i],
    gust: h.wind_gusts_10m?.[i],
  })).filter((x) => Number.isFinite(x.temp));
  const d = j.daily;
  const daily =
    (d?.time as number[] | undefined)?.map((t, i) => ({
      t: t * 1000,
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      sun: d.sunshine_duration?.[i] != null ? d.sunshine_duration[i] / 3600 : undefined,
      uv: d.uv_index_max?.[i] ?? undefined,
    })) ?? [];
  return { source: 'Open-Meteo', timezone: j.timezone, hours, daily };
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
