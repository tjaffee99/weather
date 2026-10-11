/// <reference lib="webworker" />
import { fetchField, NO_SEA, type Cycle, type LiveVar } from './gfs';

export interface LiveRequest {
  id: number;
  cycle: Cycle;
  fh: number;
  v: LiveVar;
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
}

self.onmessage = async (e: MessageEvent<LiveRequest>) => {
  const { id, cycle, fh, v } = e.data;
  try {
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
