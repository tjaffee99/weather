/// <reference lib="webworker" />
/**
 * Climate explorer engine. Holds the decoded daily samples (cell-major) and
 * answers threshold queries:
 *  - days mode: how many days per year match all criteria
 *  - date mode: probability that a day near a given date matches
 * Each answer is computed for LEVELS elevation offsets so the renderer can pick
 * the right one per pixel from a fine DEM (temperature lapse-rate downscaling).
 */
import { fetchBinary } from '../data';
import { decodeVar, parseCells, checksum, type CellsInfo } from './codec';
import { DZ0, DZ_STEP, LAPSE, LEVELS, type ClimVar, type ClimateMeta, type Criterion, type DetailResult, type MonthStats } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let meta: ClimateMeta;
let cells: CellsInfo;
let base = '';
let cellRow: Uint16Array;
let cellCol: Uint16Array;
let cellIndex: Int32Array; // raster -> cell
let daylight: Float32Array; // [row * days + d]
const data: Partial<Record<ClimVar, Uint8Array>> = {};
const loading: Partial<Record<ClimVar, Promise<void>>> = {};
const TEMP_VARS: ClimVar[] = ['feels', 'tmax', 'tmin'];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

function post(msg: unknown, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

async function init(b: string) {
  base = b;
  meta = await (await fetch(`${base}data/climate/meta.json`)).json();
  cells = parseCells(await fetchBinary(`${base}data/climate/cells.bin`));
  const { nx, ny, ncells, mask } = cells;
  cellRow = new Uint16Array(ncells);
  cellCol = new Uint16Array(ncells);
  cellIndex = new Int32Array(nx * ny).fill(-1);
  let c = 0;
  for (let i = 0; i < ny; i++)
    for (let j = 0; j < nx; j++)
      if (mask[i * nx + j]) {
        cellRow[c] = i;
        cellCol[c] = j;
        cellIndex[i * nx + j] = c++;
      }
  // daylight hours per latitude row and day (sunrise to sunset incl. refraction)
  const days = meta.days;
  daylight = new Float32Array(ny * days);
  for (let i = 0; i < ny; i++) {
    const phi = ((meta.grid.lat0 - i * meta.grid.dy) * Math.PI) / 180;
    for (let d = 0; d < days; d++) {
      const decl = ((23.44 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + d + 1)) / 365);
      const cosw = (Math.sin((-0.833 * Math.PI) / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
      daylight[i * days + d] = cosw <= -1 ? 24 : cosw >= 1 ? 0 : (24 / Math.PI) * Math.acos(cosw);
    }
  }
  // cell elevation texture: RG = (elev * valid, valid)
  const elevTex = new Float32Array(nx * ny * 2);
  for (let k = 0; k < ncells; k++) {
    const p = cellRow[k] * nx + cellCol[k];
    elevTex[p * 2] = cells.elev[k];
    elevTex[p * 2 + 1] = 1;
  }
  post({ type: 'ready', meta, elevTex }, [elevTex.buffer]);
}

function need(vars: ClimVar[]): Promise<void> {
  return Promise.all(
    vars.map((v) => {
      if (data[v]) return Promise.resolve();
      if (!loading[v]) {
        const vm = meta.vars[v];
        loading[v] = fetchBinary(`${base}data/climate/${vm.file}`, (l, t) => post({ type: 'progress', v, loaded: l, total: t || vm.bytes })).then(
          (buf) => {
            const codes = decodeVar(buf, cells, meta.days, meta.block);
            if (checksum(codes) !== vm.checksum) throw new Error(`checksum mismatch for ${v}`);
            data[v] = codes;
          },
        );
        loading[v]!.catch(() => delete loading[v]);
      }
      return loading[v]!;
    }),
  ).then(() => undefined);
}

/** Convert a metric criterion into an inclusive code range for the stored variable. */
function codeRange(c: Criterion): [number, number] {
  const vm = meta.vars[c.v as ClimVar];
  if (vm.type === 'bins') {
    const e = vm.edges!;
    // bin k spans [edge[k-1], edge[k]); bin 0 starts at 0, last bin is open-ended
    let lo = 0, hi = e.length;
    for (let k = 0; k <= e.length; k++) {
      const binLo = k === 0 ? 0 : e[k - 1];
      if (binLo < c.lo - 1e-9) lo = k + 1;
    }
    for (let k = e.length; k >= 0; k--) {
      const binHi = k === e.length ? Infinity : e[k];
      if (binHi > c.hi + 1e-9) hi = k - 1;
    }
    // "≤ 0" means "none at all", i.e. the first bin
    if (c.hi < e[0]) hi = 0;
    return [lo, hi];
  }
  const s = vm.scale!, o = vm.offset!;
  const lo = (c.lo - o) / s - 1e-6, hi = (c.hi - o) / s + 1e-6;
  // nodata (0) never matches
  return [vm.nodata !== undefined ? Math.max(lo, 0.5) : lo, hi];
}

interface Prepared {
  plain: { arr: Uint8Array; lo: number; hi: number }[];
  temps: { arr: Uint8Array; lo: number; hi: number }[]; // in °C, shifted by elevation
  daylight?: [number, number];
}

function prepare(crit: Criterion[]): Prepared {
  const p: Prepared = { plain: [], temps: [] };
  for (const c of crit) {
    if (c.v === 'daylight') {
      p.daylight = [c.lo, c.hi];
      continue;
    }
    const arr = data[c.v]!;
    if (TEMP_VARS.includes(c.v)) {
      const o = meta.vars[c.v].offset!;
      // compare raw codes against bounds expressed in code units
      p.temps.push({ arr, lo: c.lo - o, hi: c.hi - o });
    } else {
      const [lo, hi] = codeRange(c);
      p.plain.push({ arr, lo, hi });
    }
  }
  return p;
}

const SHIFTS = Array.from({ length: LEVELS }, (_, k) => -LAPSE * (DZ0 + k * DZ_STEP));

/**
 * For every cell, accumulate weights of matching days into acc[level*ncells + cell].
 * `weights` has one entry per day (0 to skip).
 */
function accumulate(p: Prepared, weights: Float32Array, acc: Float32Array) {
  const { ncells } = cells;
  const days = meta.days;
  const plain = p.plain, temps = p.temps;
  const nP = plain.length, nT = temps.length;
  const dl = p.daylight;
  const active: number[] = [];
  for (let d = 0; d < days; d++) if (weights[d] > 0) active.push(d);
  for (let c = 0; c < ncells; c++) {
    const base = c * days;
    const dlBase = cellRow[c] * days;
    for (let ai = 0; ai < active.length; ai++) {
      const d = active[ai];
      const i = base + d;
      let ok = true;
      for (let k = 0; k < nP; k++) {
        const v = plain[k].arr[i];
        if (v < plain[k].lo || v > plain[k].hi) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (dl) {
        const h = daylight[dlBase + d];
        if (h < dl[0] || h > dl[1]) continue;
      }
      const w = weights[d];
      if (nT === 0) {
        for (let l = 0; l < LEVELS; l++) acc[l * ncells + c] += w;
        continue;
      }
      let a = -1e9, b = 1e9;
      for (let k = 0; k < nT; k++) {
        const t = temps[k].arr[i];
        const lo = temps[k].lo - t, hi = temps[k].hi - t;
        if (lo > a) a = lo;
        if (hi < b) b = hi;
      }
      if (a > b) continue;
      for (let l = 0; l < LEVELS; l++) {
        const s = SHIFTS[l];
        if (s >= a && s <= b) acc[l * ncells + c] += w;
      }
    }
  }
}

function windowWeights(doy: number, half: number): Float32Array {
  const days = meta.days;
  const w = new Float32Array(days);
  for (let k = -half; k <= half; k++) w[(doy + k + days) % days] = 1 - Math.abs(k) / (half + 1);
  return w;
}

const NICE = [5, 10, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 365];

function query(crit: Criterion[], mode: 'days' | 'date', doy: number, half: number) {
  const p = prepare(crit);
  const { ncells, nx, ny } = cells;
  const acc = new Float32Array(LEVELS * ncells);
  let weights: Float32Array;
  let norm: number;
  if (mode === 'days') {
    weights = new Float32Array(meta.days).fill(1);
    norm = 365 / meta.days;
  } else {
    weights = windowWeights(doy, half);
    norm = 1 / weights.reduce((s, x) => s + x, 0);
  }
  accumulate(p, weights, acc);
  for (let i = 0; i < acc.length; i++) acc[i] *= norm;
  // colour scale: days mode adapts to the distribution so strict filters stay readable
  let scaleMax = 1;
  if (mode === 'days') {
    const mid = acc.subarray(4 * ncells, 5 * ncells);
    const sorted = Float32Array.from(mid).sort();
    const p995 = sorted[Math.floor(sorted.length * 0.995)] || 0;
    scaleMax = NICE.find((n) => n >= p995 * 1.02) ?? 365;
  }
  const out = new Float32Array(LEVELS * nx * ny * 2);
  for (let l = 0; l < LEVELS; l++)
    for (let c = 0; c < ncells; c++) {
      const o = ((l * ny + cellRow[c]) * nx + cellCol[c]) * 2;
      out[o] = Math.min(1, acc[l * ncells + c] / scaleMax);
      out[o + 1] = 1;
    }
  // summary at sea-level-equivalent level for the UI
  const lvl0 = acc.subarray(4 * ncells, 5 * ncells);
  let any = 0;
  for (let c = 0; c < ncells; c++) if (lvl0[c] > (mode === 'days' ? 0.5 : 0.005)) any++;
  return { out, scaleMax, coverage: any / ncells, levelValues: acc };
}

function nearestCell(lon: number, lat: number): number {
  const g = meta.grid;
  const j0 = Math.round((((lon - g.lon0) / g.dx) % g.nx + g.nx) % g.nx);
  const i0 = Math.round((g.lat0 - lat) / g.dy);
  let best = -1, bd = Infinity;
  for (let di = -2; di <= 2; di++)
    for (let dj = -2; dj <= 2; dj++) {
      const i = i0 + di;
      if (i < 0 || i >= g.ny) continue;
      const j = (((j0 + dj) % g.nx) + g.nx) % g.nx;
      const c = cellIndex[i * g.nx + j];
      if (c < 0) continue;
      const dd = di * di + dj * dj;
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
  return best;
}

function decodeValue(v: ClimVar, code: number): number {
  const vm = meta.vars[v];
  if (vm.type === 'linear') return code * vm.scale! + vm.offset!;
  const e = vm.edges!;
  if (code === 0) return e[0] / 3;
  if (code >= e.length) return e[e.length - 1] * 1.3;
  return (e[code - 1] + e[code]) / 2;
}

function detail(lon: number, lat: number, demElev: number, crit: Criterion[]): DetailResult | null {
  const c = nearestCell(lon, lat);
  if (c < 0) return null;
  const days = meta.days;
  const g = meta.grid;
  const cellElev = cells.elev[c];
  const shift = -LAPSE * (demElev - cellElev);
  const p = prepare(crit);
  const match = new Float32Array(days);
  for (let d = 0; d < days; d++) {
    const i = c * days + d;
    let ok = true;
    for (const q of p.plain) if (q.arr[i] < q.lo || q.arr[i] > q.hi) ok = false;
    if (ok && p.daylight) {
      const h = daylight[cellRow[c] * days + d];
      if (h < p.daylight[0] || h > p.daylight[1]) ok = false;
    }
    if (ok) for (const q of p.temps) if (q.arr[i] + shift < q.lo || q.arr[i] + shift > q.hi) ok = false;
    match[d] = ok ? 1 : 0;
  }
  const daily = new Float32Array(days);
  const half = 10;
  for (let d = 0; d < days; d++) {
    let s = 0, ws = 0;
    for (let k = -half; k <= half; k++) {
      const w = 1 - Math.abs(k) / (half + 1);
      s += w * match[(d + k + days) % days];
      ws += w;
    }
    daily[d] = s / ws;
  }
  const loaded = (Object.keys(data) as ClimVar[]).filter((v) => data[v]);
  const months: Partial<MonthStats>[] = [];
  for (let m = 0; m < 12; m++) {
    const a = MONTH_START[m], b = MONTH_START[m + 1];
    const n = b - a;
    const st: Partial<MonthStats> = {};
    let mt = 0;
    for (let d = a; d < b; d++) mt += match[d];
    st.match = mt;
    const mean = (v: ClimVar, sh = 0) => {
      const arr = data[v];
      if (!arr) return undefined;
      let s = 0, k = 0;
      for (let d = a; d < b; d++) {
        const code = arr[c * days + d];
        if (meta.vars[v].nodata !== undefined && code === meta.vars[v].nodata) continue;
        s += decodeValue(v, code) + sh;
        k++;
      }
      return k ? s / k : undefined;
    };
    const count = (v: ClimVar, f: (x: number) => boolean) => {
      const arr = data[v];
      if (!arr) return undefined;
      let k = 0;
      for (let d = a; d < b; d++) if (f(decodeValue(v, arr[c * days + d]))) k++;
      return k;
    };
    st.feels = mean('feels', shift);
    st.tmax = mean('tmax', shift);
    st.tmin = mean('tmin', shift);
    st.dew = mean('dew');
    st.cloud = mean('cloud');
    st.wind = mean('wind');
    st.sst = mean('sst');
    st.sun = mean('sun');
    const pm = mean('precip');
    st.precip = pm === undefined ? undefined : pm * n;
    st.rainDays = count('precip', (x) => x >= 1);
    st.sunnyDays = count('cloud', (x) => x <= 25);
    st.snowDays = count('snow', (x) => x >= 1);
    months.push(st);
  }
  const perYear = match.reduce((s, x) => s + x, 0) * (365 / days);
  return {
    cellLon: g.lon0 + cellCol[c] * g.dx,
    cellLat: g.lat0 - cellRow[c] * g.dy,
    cellElev,
    shift,
    perYear,
    daily,
    months,
    loaded,
  };
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m.base);
    else if (m.type === 'need') {
      await need(m.vars);
      post({ type: 'loaded', id: m.id });
    } else if (m.type === 'query') {
      await need(m.crit.filter((c: Criterion) => c.v !== 'daylight').map((c: Criterion) => c.v));
      const t0 = performance.now();
      const r = query(m.crit, m.mode, m.doy, m.half);
      post({ type: 'result', id: m.id, data: r.out, scaleMax: r.scaleMax, coverage: r.coverage, ms: performance.now() - t0 }, [r.out.buffer]);
    } else if (m.type === 'detail') {
      await need(m.vars);
      post({ type: 'detail', id: m.id, result: detail(m.lon, m.lat, m.dem, m.crit) });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, error: String((err as Error)?.message || err) });
  }
};
