/**
 * NOAA HRRR (3 km) snow depth for the contiguous US and Alaska, shown on top
 * of the global 0.25° GFS snow field. Fetched from NOAA's public AWS bucket
 * with the same .idx + byte-range approach as GFS.
 */
import { decodeGrib2, type GribField } from './grib2';

const BUCKET = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com';
const HOUR = 3600_000;

export type HrrrDomain = 'conus' | 'alaska';
export const HRRR_DOMAINS: HrrrDomain[] = ['conus', 'alaska'];

/**
 * Polar stereographic and Lambert conformal grids share one form:
 * x = rho sin(n dLon), y = -rho cos(n dLon), rho = k / tan(pi/4 + lat/2)^n,
 * and grid index = (x - x1) / dx, (y - y1) / dy.
 */
export interface ConicGrid {
  n: number;
  k: number;
  lov: number; // degrees
  x1: number;
  y1: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function conicGrid(f: GribField): ConicGrid {
  const p = f.projected;
  if (!p) throw new Error('not a projected grid');
  let n: number, k: number;
  if (p.type === 'polar') {
    n = 1;
    k = p.radius * (1 + Math.sin(rad(p.lad)));
  } else {
    const p1 = rad(p.latin1), p2 = rad(p.latin2);
    const t = (phi: number) => Math.tan(Math.PI / 4 + phi / 2);
    n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
    k = (p.radius * Math.cos(p1) * Math.pow(t(p1), n)) / n;
  }
  const g: ConicGrid = { n, k, lov: p.lov, x1: 0, y1: 0, dx: p.dxM, dy: p.dyM, nx: f.nx, ny: f.ny };
  [g.x1, g.y1] = conicXY(g, f.lon1, f.lat1);
  if (p.scan & 0x80) g.dx = -g.dx;
  if (!(p.scan & 0x40)) g.dy = -g.dy;
  return g;
}

function conicXY(g: ConicGrid, lon: number, lat: number): [number, number] {
  const dl = ((((lon - g.lov + 540) % 360) + 360) % 360) - 180;
  const rho = g.k / Math.pow(Math.tan(Math.PI / 4 + rad(lat) / 2), g.n);
  const th = g.n * rad(dl);
  return [rho * Math.sin(th), -rho * Math.cos(th)];
}

/** Fractional grid index (column, row) of a point. */
export function conicIndex(g: ConicGrid, lon: number, lat: number): [number, number] {
  const [x, y] = conicXY(g, lon, lat);
  return [(x - g.x1) / g.dx, (y - g.y1) / g.dy];
}

function fileUrl(domain: HrrrDomain, run: number, fh: number) {
  const d = new Date(run);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const ff = String(fh).padStart(2, '0');
  return domain === 'conus'
    ? `${BUCKET}/hrrr.${date}/conus/hrrr.t${hh}z.wrfsfcf${ff}.grib2`
    : `${BUCKET}/hrrr.${date}/alaska/hrrr.t${hh}z.wrfsfcf${ff}.ak.grib2`;
}

const idxCache = new Map<string, Promise<string[][] | null>>();

function loadIdx(url: string): Promise<string[][] | null> {
  let p = idxCache.get(url + '.idx');
  if (!p) {
    p = fetch(url + '.idx', { cache: 'no-cache' })
      .then(async (r) => (r.ok ? (await r.text()).trim().split('\n').map((l) => l.split(':')) : null))
      .catch(() => null);
    idxCache.set(url + '.idx', p);
    p.then((v) => v || setTimeout(() => idxCache.delete(url + '.idx'), 60_000));
  }
  return p;
}

/**
 * Runs that may cover a valid time, newest first. CONUS runs every hour and
 * Alaska every 3 hours, out to 18 h; the 00/06/12/18 UTC runs go out to 48 h.
 */
function candidates(domain: HrrrDomain, validTime: number, now: number): [number, number][] {
  const step = domain === 'conus' ? 1 : 3;
  const out: [number, number][] = [];
  let run = Math.floor(Math.min(now, validTime + HOUR) / (step * HOUR)) * step * HOUR;
  for (; run >= validTime - 48 * HOUR && out.length < 8; run -= step * HOUR) {
    const fh = Math.round((validTime - run) / HOUR);
    const max = new Date(run).getUTCHours() % 6 === 0 ? 48 : 18;
    if (fh >= 0 && fh <= max) out.push([run, fh]);
  }
  return out;
}

export interface HrrrSnow {
  grid: ConicGrid;
  /** snow depth in cm, rows in grid order */
  values: Float32Array;
}

/** Snow depth (cm) from the newest HRRR run covering validTime, or null when none does. */
export async function hrrrSnow(domain: HrrrDomain, validTime: number, now = Date.now()): Promise<HrrrSnow | null> {
  const t = Math.round(validTime / HOUR) * HOUR;
  for (const [run, fh] of candidates(domain, t, now)) {
    const url = fileUrl(domain, run, fh);
    const rows = await loadIdx(url);
    if (!rows) continue;
    const fc = fh === 0 ? 'anl' : `${fh} hour fcst`;
    const i = rows.findIndex((r) => r[3] === 'SNOD' && r[4] === 'surface' && r[5] === fc);
    if (i < 0) continue;
    const end = rows[i + 1] ? +rows[i + 1][1] - 1 : '';
    const res = await fetch(url, { headers: { Range: `bytes=${rows[i][1]}-${end}` } });
    if (!res.ok) continue;
    const [f] = decodeGrib2(new Uint8Array(await res.arrayBuffer()));
    const values = new Float32Array(f.values.length);
    for (let j = 0; j < values.length; j++) {
      const v = f.values[j];
      values[j] = Number.isNaN(v) ? 0 : Math.min(v * 100, 2000); // m -> cm; glaciers report tens of metres
    }
    return { grid: conicGrid(f), values };
  }
  return null;
}
