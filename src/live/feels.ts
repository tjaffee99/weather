/**
 * The feels-like temperature used everywhere in the app (live map, labels,
 * location cards and the climate finder's ERA5 normals): Steadman's apparent
 * temperature in the shade, AT = T + 0.33 e - 0.70 ws - 4, with T in °C, e the
 * water vapour pressure in hPa (from the dew point) and ws the 10 m wind in m/s.
 */
export function apparentTemp(tC: number, dewC: number, windMs: number): number {
  const d = Math.min(dewC, tC);
  const e = 6.105 * Math.exp((17.27 * d) / (237.7 + d));
  return tC + 0.33 * e - 0.7 * windMs - 4;
}
