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
import { DZ0, DZ_STEP, LAPSE, LEVELS, MONTH_NARROW, MONTH_START, MONTH_WIDE, monthWeights, type ClimVar, type ClimateMeta, type Criterion, type DetailResult, type MonthStats, type Obstacle, type CritVar } from './types';
import { blendTaps, levelOf } from './blend';

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
let monthOf: Uint8Array; // calendar month of each sample day

/**
 * Precipitation and snow at each elevation level: the cell's value times a
 * per-month factor (pipeline/encode_climate.py level_factors), so a valley
 * floor and the mountains above it in the same 1° cell get their own rain and
 * snow. Per variable, cell-major: fc[(cell * 12 + month) * LEVELS + level] is
 * the factor code, flat[cell * 12 + month] = 1 when all levels share it.
 */
interface LevelVar {
  fc: Uint8Array;
  flat: Uint8Array;
}
const levelData: Partial<Record<ClimVar, LevelVar>> = {};
let levelsLoading: Promise<void> | null = null;
const FACTOR = new Float32Array(256);

function isLevelVar(v: CritVar): v is ClimVar {
  return !!meta.levels?.vars.includes(v as ClimVar);
}

function needLevels(): Promise<void> {
  if (!meta.levels) return Promise.resolve();
  levelsLoading ??= fetchBinary(`${base}data/climate/${meta.levels.file}`).then((buf) => {
    const L = meta.levels!;
    const n = cells.ncells;
    for (let k = 0; k < 256; k++) FACTOR[k] = k === 0 ? 0 : Math.pow(2, (k - 128) / L.steps);
    L.vars.forEach((v, vi) => {
      const fc = new Uint8Array(n * 12 * LEVELS), flat = new Uint8Array(n * 12);
      for (let m = 0; m < 12; m++)
        for (let l = 0; l < LEVELS; l++) {
          const src = ((vi * 12 + m) * LEVELS + l) * n;
          for (let c = 0; c < n; c++) fc[(c * 12 + m) * LEVELS + l] = buf[src + c];
        }
      for (let c = 0; c < n; c++)
        for (let m = 0; m < 12; m++) {
          const o = (c * 12 + m) * LEVELS;
          let same = 1;
          for (let l = 1; l < LEVELS; l++) if (fc[o + l] !== fc[o]) same = 0;
          flat[c * 12 + m] = same;
        }
      levelData[v] = { fc, flat };
    });
  });
  levelsLoading.catch(() => (levelsLoading = null));
  return levelsLoading;
}

/** Factor for a variable at a cell, sample day and fractional level (1 without level data). */
function levelFactor(v: ClimVar, c: number, d: number, lvl: number): number {
  const ld = levelData[v];
  if (!ld) return 1;
  const o = (c * 12 + monthOf[d]) * LEVELS;
  const l0 = Math.floor(lvl), l1 = Math.min(LEVELS - 1, l0 + 1), f = lvl - l0;
  return (1 - f) * FACTOR[ld.fc[o + l0]] + f * FACTOR[ld.fc[o + l1]];
}

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
  monthOf = new Uint8Array(days);
  for (let d = 0, m = 0; d < days; d++) {
    while (d >= MONTH_START[m + 1]) m++;
    monthOf[d] = m;
  }
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
  const lv = vars.some((v) => isLevelVar(v)) ? needLevels() : Promise.resolve();
  return Promise.all([
    lv,
    ...vars.map((v) => {
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
  ]).then(() => undefined);
}

/**
 * Matching is done per stored code through lookup tables. A linear code c
 * stands for every value within half a step of c (the encoder rounds), so it
 * counts with the fraction of that band inside [lo, hi]: narrow ranges, like
 * a single °F inside a 1 °C step, get their fair share of days instead of
 * all or nothing. Binned variables (precipitation, wind, snow) match whole
 * bins; their slider stops are the bin edges.
 */
function plainLut(c: Criterion): Float32Array {
  const vm = meta.vars[c.v as ClimVar];
  const lut = new Float32Array(256);
  if (vm.type === 'bins') {
    const e = vm.edges!;
    for (let k = 0; k <= e.length; k++) {
      // bin k spans [edge[k-1], edge[k]); bin 0 starts at 0, the last bin is open-ended
      const binLo = k === 0 ? 0 : e[k - 1];
      const binHi = k === e.length ? Infinity : e[k];
      // whole bins inside the range; "≤ 0" means "none at all", i.e. the first bin
      if ((binLo >= c.lo - 1e-9 && binHi <= c.hi + 1e-9) || (k === 0 && c.hi < e[0])) lut[k] = 1;
    }
    return lut;
  }
  for (let k = 0; k < 256; k++) lut[k] = bandFraction(k * vm.scale! + vm.offset!, vm.scale!, c.lo, c.hi);
  if (vm.nodata !== undefined) lut[vm.nodata] = 0;
  return lut;
}

/**
 * Matching for a binned rain/snow variable scaled by a level factor:
 * lut[factorCode * 256 + code] = 1 when the bin's middle value times the factor
 * lies within the range. With a factor of 1 this is the same as whole bins.
 */
function levelLut(c: Criterion): Float32Array {
  const vm = meta.vars[c.v as ClimVar];
  const e = vm.edges!;
  const hi = c.hi < e[0] ? e[0] * (1 - 1e-6) : c.hi; // "none" = below the first edge
  const lut = new Float32Array(256 * 256);
  for (let fc = 0; fc < 256; fc++)
    for (let k = 0; k <= e.length; k++) {
      const x = decodeValue(c.v as ClimVar, k) * FACTOR[fc];
      if (x >= c.lo - 1e-9 && x <= hi + 1e-9) lut[fc * 256 + k] = 1;
    }
  return lut;
}

/** Fraction of the band [v - step/2, v + step/2] that lies within [lo, hi]. */
function bandFraction(v: number, step: number, lo: number, hi: number): number {
  const a = Math.max(lo, v - step / 2), b = Math.min(hi, v + step / 2);
  return b > a ? (b - a) / step : 0;
}

/** One condition on its own, for explaining what rules days out (location card). */
interface Cond {
  v: CritVar;
  lo: number;
  hi: number;
  /** how well day i meets this condition (0..1); temperatures between levels l0, l1 */
  weight(i: number, row: number, d: number, l0: number, l1: number, f: number): number;
  /** the day's value in the condition's units (temperatures shifted, rain and snow scaled to the point's level) */
  value(i: number, row: number, d: number, shift: number, lvl: number): number;
}

interface Prepared {
  conds: Cond[];
  plain: { arr: Uint8Array; lut: Float32Array }[];
  /** temperatures, shifted to each elevation level: lut[level * 256 + code] */
  temps: { arr: Uint8Array; lut: Float32Array; lmin: Int8Array; lmax: Int8Array }[];
  /** rain and snow with per-level factors: lut[factorCode * 256 + code] */
  levs: { arr: Uint8Array; lut: Float32Array; ld: LevelVar }[];
  daylight?: [number, number];
}

function prepare(crit: Criterion[]): Prepared {
  const p: Prepared = { conds: [], plain: [], temps: [], levs: [] };
  for (const c of crit) {
    if (c.v === 'daylight') {
      p.daylight = [c.lo, c.hi];
      p.conds.push({
        v: c.v, lo: c.lo, hi: c.hi,
        weight: (_i, row, d) => {
          const h = daylight[row * meta.days + d];
          return h < c.lo || h > c.hi ? 0 : 1;
        },
        value: (_i, row, d) => daylight[row * meta.days + d],
      });
      continue;
    }
    const arr = data[c.v]!;
    const decode = (code: number) => decodeValue(c.v as ClimVar, code);
    if (TEMP_VARS.includes(c.v)) {
      const vm = meta.vars[c.v];
      const lut = new Float32Array(LEVELS * 256);
      for (let l = 0; l < LEVELS; l++)
        for (let k = 0; k < 256; k++) lut[l * 256 + k] = bandFraction(k * vm.scale! + vm.offset! + SHIFTS[l], vm.scale!, c.lo, c.hi);
      // per code, the span of levels that can match (empty when lmin > lmax)
      const lmin = new Int8Array(256).fill(LEVELS), lmax = new Int8Array(256).fill(-1);
      for (let k = 0; k < 256; k++)
        for (let l = 0; l < LEVELS; l++)
          if (lut[l * 256 + k] > 0) {
            lmin[k] = Math.min(lmin[k], l);
            lmax[k] = Math.max(lmax[k], l);
          }
      p.temps.push({ arr, lut, lmin, lmax });
      p.conds.push({
        v: c.v, lo: c.lo, hi: c.hi,
        weight: (i, _row, _d, l0, l1, f) => (1 - f) * lut[l0 * 256 + arr[i]] + f * lut[l1 * 256 + arr[i]],
        value: (i, _row, _d, shift) => arr[i] * vm.scale! + vm.offset! + shift,
      });
    } else if (isLevelVar(c.v) && levelData[c.v]) {
      const ld = levelData[c.v]!;
      const lut = levelLut(c);
      const v = c.v;
      p.levs.push({ arr, lut, ld });
      p.conds.push({
        v, lo: c.lo, hi: c.hi,
        weight: (i, _row, d, l0, l1, f) => {
          const o = ((i / meta.days) | 0) * 12 * LEVELS + monthOf[d] * LEVELS;
          return (1 - f) * lut[ld.fc[o + l0] * 256 + arr[i]] + f * lut[ld.fc[o + l1] * 256 + arr[i]];
        },
        value: (i, _row, d, _shift, lvl) => decode(arr[i]) * levelFactor(v, (i / meta.days) | 0, d, lvl),
      });
    } else {
      const lut = plainLut(c);
      p.plain.push({ arr, lut });
      p.conds.push({ v: c.v, lo: c.lo, hi: c.hi, weight: (i) => lut[arr[i]], value: (i) => decode(arr[i]) });
    }
  }
  return p;
}

const SHIFTS = Array.from({ length: LEVELS }, (_, k) => -LAPSE * (DZ0 + k * DZ_STEP));

/** Weight of day i for the non-temperature conditions (0 = no match). */
function plainWeight(p: Prepared, i: number, row: number, d: number): number {
  let w = 1;
  for (const q of p.plain) {
    w *= q.lut[q.arr[i]];
    if (w === 0) return 0;
  }
  if (p.daylight) {
    const h = daylight[row * meta.days + d];
    if (h < p.daylight[0] || h > p.daylight[1]) return 0;
  }
  return w;
}

/** Weight of day i for the temperature (and per-level rain/snow) conditions at elevation level l. */
function tempWeight(p: Prepared, i: number, l: number, d = 0): number {
  let w = 1;
  for (const q of p.temps) w *= q.lut[l * 256 + q.arr[i]];
  if (p.levs.length) {
    const o = ((i / meta.days) | 0) * 12 * LEVELS + monthOf[d] * LEVELS + l;
    for (const q of p.levs) w *= q.lut[q.ld.fc[o] * 256 + q.arr[i]];
  }
  return w;
}

/**
 * For every cell, accumulate weights of matching days into acc[level*ncells + cell].
 * `weights` has one entry per day (0 to skip).
 */
function accumulate(p: Prepared, weights: Float32Array, acc: Float32Array) {
  const { ncells } = cells;
  const days = meta.days;
  // hot loop: everything inlined into locals
  const pArr = p.plain.map((q) => q.arr), pLut = p.plain.map((q) => q.lut);
  const tArr = p.temps.map((q) => q.arr), tLut = p.temps.map((q) => q.lut);
  const tMin = p.temps.map((q) => q.lmin), tMax = p.temps.map((q) => q.lmax);
  const nP = pArr.length, nT = tArr.length;
  const lArr = p.levs.map((q) => q.arr), lLut = p.levs.map((q) => q.lut);
  const lFc = p.levs.map((q) => q.ld.fc), lFlat = p.levs.map((q) => q.ld.flat);
  const nL = lArr.length;
  const lw = new Float32Array(LEVELS);
  const dl = p.daylight;
  const codes = new Int32Array(nT);
  const active: number[] = [];
  for (let d = 0; d < days; d++) if (weights[d] > 0) active.push(d);
  for (let c = 0; c < ncells; c++) {
    const base = c * days;
    const dlBase = cellRow[c] * days;
    for (let ai = 0; ai < active.length; ai++) {
      const d = active[ai];
      const i = base + d;
      let w = weights[d];
      for (let k = 0; k < nP && w > 0; k++) w *= pLut[k][pArr[k][i]];
      if (w === 0) continue;
      if (dl) {
        const h = daylight[dlBase + d];
        if (h < dl[0] || h > dl[1]) continue;
      }
      // levels where the temperatures can match
      let l0 = 0, l1 = LEVELS - 1;
      for (let k = 0; k < nT; k++) {
        const code = (codes[k] = tArr[k][i]);
        if (tMin[k][code] > l0) l0 = tMin[k][code];
        if (tMax[k][code] < l1) l1 = tMax[k][code];
      }
      if (l0 > l1) continue;
      // rain and snow per level: one factor for flat cells, else a weight per level
      let perLevel = false;
      if (nL) {
        const om = c * 12 + monthOf[d], o = om * LEVELS;
        for (let k = 0; k < nL && w > 0; k++) {
          if (lFlat[k][om]) w *= lLut[k][lFc[k][o] * 256 + lArr[k][i]];
          else perLevel = true;
        }
        if (w === 0) continue;
        if (perLevel) {
          let any = 0;
          for (let l = l0; l <= l1; l++) {
            let t = 1;
            for (let k = 0; k < nL; k++) if (!lFlat[k][om]) t *= lLut[k][lFc[k][o + l] * 256 + lArr[k][i]];
            lw[l] = t;
            any += t;
          }
          if (any === 0) continue;
        }
      }
      if (nT === 0) {
        for (let l = 0; l < LEVELS; l++) acc[l * ncells + c] += perLevel ? w * lw[l] : w;
        continue;
      }
      for (let l = l0; l <= l1; l++) {
        const o = l * 256;
        let t = perLevel ? w * lw[l] : w;
        for (let k = 0; k < nT; k++) t *= tLut[k][o + codes[k]];
        acc[l * ncells + c] += t;
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
  // stored as a fraction of days (0..1) in both modes; the colour scale is fixed
  const scaleMax = mode === 'days' ? 365 : 1;
  const out = new Float32Array(LEVELS * nx * ny * 2);
  for (let l = 0; l < LEVELS; l++)
    for (let c = 0; c < ncells; c++) {
      const o = ((l * ny + cellRow[c]) * nx + cellCol[c]) * 2;
      out[o] = acc[l * ncells + c] / scaleMax;
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

let kernels: { narrow: Float64Array[]; wide: Float64Array[] } | undefined;
function monthKernels(days: number) {
  if (!kernels || kernels.narrow[0].length !== days)
    kernels = {
      narrow: Array.from({ length: 12 }, (_, m) => monthWeights(m, MONTH_NARROW, days)),
      wide: Array.from({ length: 12 }, (_, m) => monthWeights(m, MONTH_WIDE, days)),
    };
  return kernels;
}

function decodeValue(v: ClimVar, code: number): number {
  const vm = meta.vars[v];
  if (vm.type === 'linear') return code * vm.scale! + vm.offset!;
  const e = vm.edges!;
  if (code === 0) return e[0] / 3;
  if (code >= e.length) return e[e.length - 1] * 1.3;
  return (e[code - 1] + e[code]) / 2;
}

/**
 * Location card numbers. Blends the nearby cells with the same weights as
 * the map (blend.ts), each cell's temperatures shifted to the point's
 * elevation, so the card agrees with the map colour and city label.
 */
function detail(lon: number, lat: number, demElev: number, crit: Criterion[]): DetailResult | null {
  const g = meta.grid;
  const elevAt = (p: number) => (cellIndex[p] < 0 ? undefined : cells.elev[cellIndex[p]]);
  let taps = blendTaps(g, elevAt, lon, lat, demElev).taps;
  if (!taps.length) {
    // off the edge of the data (small islands): nearest cell within 2°
    const c = nearestCell(lon, lat);
    if (c < 0) return null;
    taps = [{ p: cellRow[c] * g.nx + cellCol[c], q: 1, dz: levelShift(demElev - cells.elev[c]) }];
  }
  const qmax = Math.max(...taps.map((t) => t.q));
  taps = taps.filter((t) => t.q > qmax * 1e-3);
  const qsum = taps.reduce((s, t) => s + t.q, 0);
  const main = taps.reduce((a, b) => (b.q > a.q ? b : a));
  const days = meta.days;
  const p = prepare(crit);
  const match = new Float32Array(days);
  const loaded = (Object.keys(data) as ClimVar[]).filter((v) => data[v]);
  // what rules days out: per month, condition and direction, the share of days failing it
  const fails = Array.from({ length: 12 }, () => new Float64Array(p.conds.length * 2));
  const sums: Record<string, number>[] = Array.from({ length: 12 }, () => ({}));
  const wsum: Record<string, number>[] = Array.from({ length: 12 }, () => ({}));
  const add = (m: number, k: string, v: number | undefined, w: number) => {
    if (v === undefined || !Number.isFinite(v)) return;
    sums[m][k] = (sums[m][k] ?? 0) + v * w;
    wsum[m][k] = (wsum[m][k] ?? 0) + w;
  };

  for (const t of taps) {
    const c = cellIndex[t.p];
    const w = t.q / qsum;
    const shift = -LAPSE * t.dz;
    // matches are interpolated between the two nearest elevation levels, like the map
    const lvl = levelOf(t.dz);
    const l0 = Math.floor(lvl), l1 = Math.min(LEVELS - 1, l0 + 1), f = lvl - l0;
    const m1 = new Float32Array(days);
    for (let d = 0, m = 0; d < days; d++) {
      const i = c * days + d;
      while (d >= MONTH_START[m + 1]) m++;
      p.conds.forEach((q, k) => {
        const miss = 1 - q.weight(i, cellRow[c], d, l0, l1, f);
        if (miss <= 0) return;
        // which side it misses on: the nearer bound
        const v = q.value(i, cellRow[c], d, shift, lvl);
        const low = !Number.isFinite(q.hi) || (Number.isFinite(q.lo) && v - q.lo < q.hi - v);
        fails[m][k * 2 + (low ? 0 : 1)] += (w * miss) / (MONTH_START[m + 1] - MONTH_START[m]);
      });
      const pw = plainWeight(p, i, cellRow[c], d);
      if (pw === 0) continue;
      m1[d] = pw * ((1 - f) * tempWeight(p, i, l0, d) + f * tempWeight(p, i, l1, d));
      match[d] += w * m1[d];
    }
    // monthly normals over smoothed month windows (see monthWeights), as in the atlas
    const K = monthKernels(days);
    for (let m = 0; m < 12; m++) {
      const n = MONTH_START[m + 1] - MONTH_START[m];
      const narrow = K.narrow[m], wide = K.wide[m];
      // rain and snow are scaled to the point's elevation level (1 for other variables)
      const fac = (v: ClimVar, d: number) => (isLevelVar(v) ? levelFactor(v, c, d, lvl) : 1);
      const mean = (v: ClimVar, k: Float64Array, sh = 0) => {
        const arr = data[v];
        if (!arr) return undefined;
        const nodata = meta.vars[v].nodata;
        let s = 0, ws = 0;
        for (let d = 0; d < days; d++) {
          const kd = k[d];
          if (!kd) continue;
          const code = arr[c * days + d];
          if (nodata !== undefined && code === nodata) continue;
          s += kd * (decodeValue(v, code) * fac(v, d) + sh);
          ws += kd;
        }
        return ws ? s / ws : undefined;
      };
      /** expected days in the month for which f holds */
      const count = (v: ClimVar, f: (x: number) => boolean) => {
        const arr = data[v];
        if (!arr) return undefined;
        let s = 0;
        for (let d = 0; d < days; d++) if (wide[d] && f(decodeValue(v, arr[c * days + d]) * fac(v, d))) s += wide[d];
        return s * n;
      };
      let mt = 0;
      for (let d = 0; d < days; d++) mt += narrow[d] * m1[d];
      add(m, 'match', mt * n, w);
      add(m, 'feels', mean('feels', narrow, shift), w);
      add(m, 'tmax', mean('tmax', narrow, shift), w);
      add(m, 'tmin', mean('tmin', narrow, shift), w);
      add(m, 'dew', mean('dew', narrow), w);
      add(m, 'sst', mean('sst', narrow), w);
      add(m, 'sun', mean('sun', narrow), w);
      add(m, 'uv', mean('uv', narrow), w);
      add(m, 'cloud', mean('cloud', wide), w);
      add(m, 'wind', mean('wind', wide), w);
      add(m, 'rh', mean('rh', wide), w);
      add(m, 'aqi', mean('aqi', wide), w);
      add(m, 'goodAirDays', count('aqi', (x) => x <= 50), w);
      add(m, 'badAirDays', count('aqi', (x) => x > 100), w);
      const sf = mean('snowfall', wide);
      add(m, 'snowfall', sf === undefined ? undefined : sf * n, w);
      const pm = mean('precip', wide);
      add(m, 'precip', pm === undefined ? undefined : pm * n, w);
      add(m, 'rainDays', count('precip', (x) => x >= 1), w);
      add(m, 'sunnyDays', count('cloud', (x) => x <= 25), w);
      add(m, 'snowDays', count('snow', (x) => x >= 1), w);
    }
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
  const months = sums.map((sm, m) => {
    const st: Record<string, number> = {};
    for (const k of Object.keys(sm)) st[k] = sm[k] / wsum[m][k];
    const why: Obstacle[] = [];
    p.conds.forEach((q, k) => {
      for (const dir of [0, 1]) {
        const frac = fails[m][k * 2 + dir];
        if (frac >= 0.05) why.push({ v: q.v, dir: dir ? 'high' : 'low', frac });
      }
    });
    why.sort((a, b) => b.frac - a.frac);
    return { ...st, why: why.slice(0, 3) } as Partial<MonthStats>;
  });
  const perYear = match.reduce((s, x) => s + x, 0) * (365 / days);
  const mc = cellIndex[main.p];
  return {
    cellLon: g.lon0 + cellCol[mc] * g.dx,
    cellLat: g.lat0 - cellRow[mc] * g.dy,
    cellElev: cells.elev[mc],
    shift: -LAPSE * main.dz,
    cells: taps.length,
    perYear,
    daily,
    months,
    loaded,
  };
}

/** An elevation shift clamped to the range the map's levels cover. */
function levelShift(dz: number) {
  return Math.min(DZ0 + (LEVELS - 1) * DZ_STEP, Math.max(DZ0, dz));
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
