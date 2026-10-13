/**
 * Air quality from NOAA's global aerosol model (GEFS-Aerosols, 0.25°, runs
 * every 6 hours out to 5 days in 3-hour steps), on NOAA's public AWS bucket.
 * Surface PM2.5 is converted to the US Air Quality Index.
 *
 * The model's emissions are out of date in places (about twice too high in
 * China, too low in South Asia), so its PM2.5 is scaled by monthly factors
 * that match it to satellite and ground-monitor estimates (ACAG V6.GL.03,
 * 2021-2024; written by pipeline/acag_bias.py as data/aq_bias.bin).
 */
import { decodeGrib2 } from './grib2';
import { fetchBinary } from '../data';

const BUCKET = 'https://noaa-gefs-pds.s3.amazonaws.com';
const HOUR = 3600_000;

/** US EPA PM2.5 breakpoints (2024): [C_lo, C_hi, AQI_lo, AQI_hi] in ug/m3. */
const BREAKS: [number, number, number, number][] = [
  [0, 9, 0, 50],
  [9, 35.4, 50, 100],
  [35.4, 55.4, 100, 150],
  [55.4, 125.4, 150, 200],
  [125.4, 225.4, 200, 300],
  [225.4, 325.4, 300, 500],
];

export function aqiFromPm25(c: number): number {
  for (const [c0, c1, a0, a1] of BREAKS) if (c <= c1) return a0 + ((Math.max(c, c0) - c0) * (a1 - a0)) / (c1 - c0);
  return 500;
}

/** PM2.5 (ug/m3) for a US AQI value: the inverse of aqiFromPm25. */
export function pm25FromAqi(a: number): number {
  for (const [c0, c1, a0, a1] of BREAKS) if (a <= a1) return c0 + ((Math.max(a, a0) - a0) * (c1 - c0)) / (a1 - a0);
  return 325.4;
}

function fileUrl(run: number, fh: number) {
  const d = new Date(run);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${BUCKET}/gefs.${date}/${hh}/chem/pgrb2ap25/gefs.chem.t${hh}z.a2d_0p25.f${String(fh).padStart(3, '0')}.grib2`;
}

// aq_bias.bin: uint8 [12 months][144 rows, 84N..60S][360 cols, 180W..], factor = 2^((code - 128) / 32)
const BIAS_ROWS = 144, BIAS_COLS = 360, BIAS_TOP = 84;
let biasP: Promise<Float32Array | null> | null = null;
function loadBias(dataBase: string): Promise<Float32Array | null> {
  biasP ??= fetchBinary(`${dataBase}aq_bias.bin`)
    .then((buf) => {
      const out = new Float32Array(buf.length);
      for (let i = 0; i < buf.length; i++) out[i] = Math.pow(2, (buf[i] - 128) / 32);
      return out;
    })
    .catch(() => null);
  return biasP;
}

/** Correction factor at (lat, lon) for a time: bilinear in space, linear between mid-months. */
export function biasAt(bias: Float32Array, lat: number, lon: number, t: number): number {
  const d = new Date(t);
  const doy = (t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400_000;
  const mpos = (doy / 365) * 12 - 0.5; // 0 = mid-January
  const m0 = Math.floor(mpos), fm = mpos - m0;
  const y = BIAS_TOP - 0.5 - lat; // row position of cell centres
  if (y < -0.5 || y > BIAS_ROWS - 0.5) return 1;
  const x = lon + 180 - 0.5;
  const i0 = Math.max(0, Math.min(BIAS_ROWS - 1, Math.floor(y))), i1 = Math.max(0, Math.min(BIAS_ROWS - 1, i0 + 1));
  const fy = Math.max(0, Math.min(1, y - Math.floor(y)));
  const j0 = ((Math.floor(x) % BIAS_COLS) + BIAS_COLS) % BIAS_COLS, j1 = (j0 + 1) % BIAS_COLS, fx = x - Math.floor(x);
  const at = (m: number) => {
    const o = (((m % 12) + 12) % 12) * BIAS_ROWS * BIAS_COLS;
    const g = (i: number, j: number) => bias[o + i * BIAS_COLS + j];
    return (g(i0, j0) * (1 - fx) + g(i0, j1) * fx) * (1 - fy) + (g(i1, j0) * (1 - fx) + g(i1, j1) * fx) * fy;
  };
  return at(m0) * (1 - fm) + at(m0 + 1) * fm;
}

const idxCache = new Map<string, Promise<string[][] | null>>();
function loadIdx(url: string) {
  let p = idxCache.get(url);
  if (!p) {
    p = fetch(url + '.idx', { cache: 'no-cache' })
      .then(async (r) => (r.ok ? (await r.text()).trim().split('\n').map((l) => l.split(':')) : null))
      .catch(() => null);
    idxCache.set(url, p);
    p.then((v) => v || setTimeout(() => idxCache.delete(url), 60_000));
  }
  return p;
}

/**
 * AQI (from surface PM2.5) on the GFS 0.25° grid for a valid time: the newest
 * aerosol run covering it, at the nearest 3-hour step.
 */
export async function aqiField(validTime: number, dataBase: string, now = Date.now()): Promise<Float32Array> {
  const bias = await loadBias(dataBase);
  let run = Math.floor(now / (6 * HOUR)) * 6 * HOUR;
  for (let k = 0; k < 6; k++, run -= 6 * HOUR) {
    const fh = Math.max(0, Math.min(120, Math.round((validTime - run) / (3 * HOUR)) * 3));
    const url = fileUrl(run, fh);
    const rows = await loadIdx(url);
    if (!rows) continue;
    const i = rows.findIndex((r) => r[3] === 'PMTF' && r[4] === 'surface' && r.join(':').toLowerCase().includes('total aerosol'));
    if (i < 0) continue;
    const end = rows[i + 1] ? +rows[i + 1][1] - 1 : '';
    const res = await fetch(url, { headers: { Range: `bytes=${rows[i][1]}-${end}` } });
    if (!res.ok) continue;
    const [f] = decodeGrib2(new Uint8Array(await res.arrayBuffer()));
    const out = new Float32Array(f.values.length);
    // 0.25° grid, north to south, 0..360 east
    const nx = f.nx, ny = f.ny;
    for (let r = 0; r < ny; r++) {
      const lat = 90 - (r * 180) / (ny - 1);
      for (let c = 0; c < nx; c++) {
        const k = bias ? biasAt(bias, lat, (c * 360) / nx, validTime) : 1;
        out[r * nx + c] = aqiFromPm25(Math.max(0, f.values[r * nx + c] || 0) * k);
      }
    }
    return out;
  }
  throw new Error('no recent air quality forecast');
}
