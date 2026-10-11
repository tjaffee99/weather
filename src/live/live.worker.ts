/// <reference lib="webworker" />
import { fetchField, NO_SEA, type Cycle, type LiveVar } from './gfs';
import { hrrrSnow, type ConicGrid, type HrrrDomain } from './hrrr';

export interface LiveRequest {
  id: number;
  cycle: Cycle;
  fh: number;
  v: LiveVar;
  /** instead of a GFS field: HRRR snow depth for this domain at valid time t */
  hrrr?: { domain: HrrrDomain; t: number };
}
export interface LiveResponse {
  id: number;
  error?: string;
  /** scalar values (north->south rows, 0..360 lon), already converted to display units base (°C, mm/h, %, km/h, cm, m) */
  values?: Float32Array;
  /** for wind: u and v components in m/s */
  u?: Float32Array;
  vv?: Float32Array;
  nx?: number;
  ny?: number;
  /** HRRR responses: the projected grid (values are absent when no run covers the time) */
  grid?: ConicGrid;
}

self.onmessage = async (e: MessageEvent<LiveRequest>) => {
  const { id, cycle, fh, v, hrrr } = e.data;
  try {
    if (hrrr) {
      const r = await hrrrSnow(hrrr.domain, hrrr.t);
      const msg: LiveResponse = r ? { id, values: r.values, grid: r.grid, nx: r.grid.nx, ny: r.grid.ny } : { id };
      (self as unknown as Worker).postMessage(msg, r ? [r.values.buffer] : []);
      return;
    }
    if (v === 'sun') {
      const out = await sunshineHours(cycle, fh);
      (self as unknown as Worker).postMessage({ id, values: out, nx: 1440, ny: 721 } satisfies LiveResponse, [out.buffer]);
      return;
    }
    const fields = await fetchField(cycle, fh, v);
    const f = fields[0];
    const n = f.values.length;
    const out = new Float32Array(n);
    const src = f.values;
    let u: Float32Array | undefined, vv: Float32Array | undefined;
    switch (v) {
      case 'temp':
      case 'feels':
      case 'dew':
        for (let i = 0; i < n; i++) out[i] = src[i] - 273.15;
        break;
      case 'sst':
        out.set(seaSurface(fields[0].values, fields[1].values, fields[2].values, f.nx, f.ny));
        break;
      case 'precip':
        for (let i = 0; i < n; i++) out[i] = src[i] * 3600; // kg m-2 s-1 -> mm/h
        break;
      case 'snow':
        for (let i = 0; i < n; i++) out[i] = Number.isNaN(src[i]) ? 0 : src[i] * 100; // m -> cm
        break;
      case 'wind': {
        u = fields[0].values;
        vv = fields[1].values;
        for (let i = 0; i < n; i++) out[i] = Math.hypot(u[i], vv[i]) * 3.6; // km/h
        break;
      }
      default:
        out.set(src);
    }
    const msg: LiveResponse = { id, values: out, u, vv, nx: f.nx, ny: f.ny };
    const transfer: Transferable[] = [out.buffer];
    if (u && vv) transfer.push(u.buffer, vv.buffer);
    (self as unknown as Worker).postMessage(msg, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message || err) });
  }
};


/**
 * Sea surface temperature (°C) on open water, spread a few cells inland so
 * coastal places carry their nearby sea temperature; elsewhere NO_SEA.
 */
function seaSurface(skin: Float32Array, land: Float32Array, ice: Float32Array, nx: number, ny: number): Float32Array {
  const n = nx * ny;
  let cur = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const water = land[i] < 0.5 && !(ice[i] > 0.15);
    cur[i] = water ? skin[i] - 273.15 : NaN;
  }
  // dilate onto the coast: ~3 cells (0.75°, roughly 80 km)
  for (let pass = 0; pass < 3; pass++) {
    const next = cur.slice();
    for (let y = 1; y < ny - 1; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (!Number.isNaN(cur[i])) continue;
        let s = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const v = cur[(y + dy) * nx + ((x + dx + nx) % nx)];
            if (!Number.isNaN(v)) {
              s += v;
              k++;
            }
          }
        if (k) next[i] = s / k;
      }
    cur = next;
  }
  for (let i = 0; i < n; i++) if (Number.isNaN(cur[i])) cur[i] = NO_SEA;
  return cur;
}

/**
 * Hours of sunshine over the 24 h around forecast hour fh. GFS SUNSD resets
 * every 6 hours, so the value at each 6-hourly step is that bucket's total.
 * GFS counts any clear daylight as sunshine, even with the sun on the horizon;
 * WMO sunshine needs a 120 W/m2 direct beam, which a clear sky gives only
 * above about 3 degrees of solar elevation, so each bucket is capped by the
 * time the sun spends above that.
 */
async function sunshineHours(cycle: Cycle, fh: number): Promise<Float32Array> {
  const start = Math.min(96, Math.max(0, Math.round((fh - 12) / 6) * 6));
  const ends = [start + 6, start + 12, start + 18, start + 24];
  const parts = await Promise.all(ends.map((e) => fetchField(cycle, e, 'sunsd')));
  const n = parts[0][0].values.length;
  const out = new Float32Array(n);
  const possible = new Float32Array(n);
  parts.forEach(([f], k) => {
    sunUpHours(cycle.time + (ends[k] - 6) * 3600_000, 6, possible);
    for (let i = 0; i < n; i++) out[i] += Math.min(f.values[i] / 3600, possible[i]);
  });
  return out;
}

/** Hours with the sun at least 3 degrees up, per GFS grid point, over [t0, t0 + hours). */
function sunUpHours(t0: number, hours: number, out: Float32Array) {
  const NX = 1440, NY = 721, STEP = 0.25; // hours
  out.fill(0);
  const minSin = Math.sin((3 * Math.PI) / 180);
  const sinLat = new Float64Array(NY), cosLat = new Float64Array(NY), cosH = new Float64Array(NX);
  for (let r = 0; r < NY; r++) {
    const phi = ((90 - r * 0.25) * Math.PI) / 180;
    sinLat[r] = Math.sin(phi);
    cosLat[r] = Math.cos(phi);
  }
  for (let s = 0; s < hours / STEP; s++) {
    const t = new Date(t0 + (s + 0.5) * STEP * 3600_000);
    const utcH = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600;
    const doy = (Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400_000 + 1;
    // NOAA solar position approximations
    const g = ((2 * Math.PI) / 365) * (doy - 1 + (utcH - 12) / 24);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl =
      0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const sd = Math.sin(decl), cd = Math.cos(decl);
    for (let c = 0; c < NX; c++) cosH[c] = Math.cos((((utcH * 60 + eqt + 4 * c * 0.25) / 4 - 180) * Math.PI) / 180);
    for (let r = 0; r < NY; r++) {
      const a = sinLat[r] * sd, b = cosLat[r] * cd;
      // skip rows where the sun is below the threshold all day, or above it all day
      if (a + b < minSin) continue;
      const row = r * NX;
      if (a - b >= minSin) {
        for (let c = 0; c < NX; c++) out[row + c] += STEP;
        continue;
      }
      for (let c = 0; c < NX; c++) if (a + b * cosH[c] >= minSin) out[row + c] += STEP;
    }
  }
}
