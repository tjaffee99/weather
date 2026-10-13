/**
 * Air quality from NOAA's global aerosol model (GEFS-Aerosols, 0.25°, runs
 * every 6 hours out to 5 days in 3-hour steps), on NOAA's public AWS bucket.
 * Surface PM2.5 is converted to the US Air Quality Index.
 */
import { decodeGrib2 } from './grib2';

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

function fileUrl(run: number, fh: number) {
  const d = new Date(run);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${BUCKET}/gefs.${date}/${hh}/chem/pgrb2ap25/gefs.chem.t${hh}z.a2d_0p25.f${String(fh).padStart(3, '0')}.grib2`;
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
export async function aqiField(validTime: number, now = Date.now()): Promise<Float32Array> {
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
    for (let j = 0; j < out.length; j++) out[j] = aqiFromPm25(Math.max(0, f.values[j] || 0));
    return out;
  }
  throw new Error('no recent air quality forecast');
}
