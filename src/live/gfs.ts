/**
 * Locate and fetch NOAA GFS 0.25 deg fields straight from the public AWS bucket.
 *
 * The bucket allows CORS GET with Range headers, so we read each `.idx`
 * inventory and request just the bytes of the GRIB messages we need (~0.5-1 MB
 * per global field) instead of whole 500 MB files.
 */
import { decodeGrib2, type GribField } from './grib2';

const BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const HOUR = 3600_000;

/** Sea temperature value used where there is no sea nearby (below any threshold). */
export const NO_SEA = -60;

export type LiveVar = 'temp' | 'feels' | 'precip' | 'cloud' | 'wind' | 'snow' | 'humidity' | 'orog' | 'csnow' | 'dew' | 'sst';

/** GRIB parameter + level as written in the .idx inventory */
const RECORDS: Record<LiveVar, string[]> = {
  temp: ['TMP:2 m above ground'],
  feels: ['APTMP:2 m above ground'],
  precip: ['PRATE:surface'],
  csnow: ['CSNOW:surface'],
  cloud: ['TCDC:entire atmosphere'],
  wind: ['UGRD:10 m above ground', 'VGRD:10 m above ground'],
  snow: ['SNOD:surface'],
  humidity: ['RH:2 m above ground'],
  orog: ['HGT:surface'],
  dew: ['DPT:2 m above ground'],
  // skin temperature over water = sea surface temperature; land & ice masks to pick water
  sst: ['TMP:surface', 'LAND:surface', 'ICEC:surface'],
};

export interface Cycle {
  date: string; // YYYYMMDD
  hour: number; // 0, 6, 12, 18
  time: number; // ms epoch
}

const idxCache = new Map<string, Promise<string[][] | null>>();

function fileUrl(c: Cycle, fh: number) {
  const hh = String(c.hour).padStart(2, '0');
  return `${BUCKET}/gfs.${c.date}/${hh}/atmos/gfs.t${hh}z.pgrb2.0p25.f${String(fh).padStart(3, '0')}`;
}

function cycleAt(t: number): Cycle {
  const d = new Date(t);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return { date, hour: d.getUTCHours(), time: t };
}

async function loadIdx(c: Cycle, fh: number): Promise<string[][] | null> {
  const url = fileUrl(c, fh) + '.idx';
  let p = idxCache.get(url);
  if (!p) {
    p = fetch(url, { cache: 'no-cache' })
      .then(async (r) => (r.ok ? (await r.text()).trim().split('\n').map((l) => l.split(':')) : null))
      .catch(() => null);
    idxCache.set(url, p);
    // don't cache failures forever: a file may appear a few minutes later
    p.then((v) => v || setTimeout(() => idxCache.delete(url), 60_000));
  }
  return p;
}

/**
 * Newest cycle whose forecast already covers [now, now + horizonH].
 * GFS files appear on S3 ~3.5-5 h after the nominal cycle time.
 */
export async function findLatestCycle(now = Date.now(), horizonH = 48): Promise<Cycle> {
  const base = Math.floor(now / (6 * HOUR)) * 6 * HOUR;
  for (let k = 0; k < 8; k++) {
    const c = cycleAt(base - k * 6 * HOUR);
    const fhNow = Math.max(0, Math.floor((now - c.time) / HOUR));
    const last = Math.min(fhNow + horizonH, 120);
    const [a, b] = await Promise.all([loadIdx(c, fhNow), loadIdx(c, last)]);
    if (a && b) return c;
  }
  throw new Error('No recent GFS cycle found');
}

/** Forecast hour (relative to cycle) for a valid time. */
export function forecastHour(c: Cycle, validTime: number) {
  return Math.round((validTime - c.time) / HOUR);
}

/** Fetch & decode the GRIB messages of one variable at one forecast hour. */
export async function fetchField(c: Cycle, fh: number, v: LiveVar, signal?: AbortSignal): Promise<GribField[]> {
  const rows = await loadIdx(c, fh);
  if (!rows) throw new Error(`GFS f${fh} not available`);
  const fc = fh === 0 ? 'anl' : `${fh} hour fcst`;
  const wanted = RECORDS[v];
  // locate the messages; consecutive ones are merged into one range request
  const hits: number[] = [];
  for (const w of wanted) {
    const i = rows.findIndex((r) => `${r[3]}:${r[4]}` === w && r[5] === fc);
    if (i < 0) throw new Error(`${w} missing from GFS f${fh}`);
    hits.push(i);
  }
  // adjacent messages share one range request; distant ones get their own
  const runs: number[][] = [];
  for (const h of [...hits].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && h - last[last.length - 1] <= 2) last.push(h);
    else runs.push([h]);
  }
  const byIndex = new Map<number, GribField>();
  await Promise.all(
    runs.map(async (run) => {
      const start = +rows[run[0]][1];
      const endRow = rows[run[run.length - 1] + 1];
      const end = endRow ? +endRow[1] - 1 : '';
      const res = await fetch(fileUrl(c, fh), { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (!res.ok) throw new Error(`GFS download failed (${res.status})`);
      const fields = decodeGrib2(new Uint8Array(await res.arrayBuffer()));
      for (const h of run) byIndex.set(h, fields[h - run[0]]);
    }),
  );
  // in the order the records were requested
  return hits.map((h) => byIndex.get(h)!);
}
