/**
 * Decoder for the climate sample files written by pipeline/encode_climate.py.
 * Must mirror the encoder's raster prediction exactly.
 */

export interface CellsInfo {
  ny: number;
  nx: number;
  ncells: number;
  mask: Uint8Array; // ny*nx, 1 = stored cell
  elev: Int16Array; // per cell (m)
  land: Uint8Array; // per cell land fraction * 255
}

export function parseCells(b: Uint8Array): CellsInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'CEL1') throw new Error('bad cells file');
  const ny = dv.getUint16(4, true), nx = dv.getUint16(6, true), ncells = dv.getUint32(8, true);
  let o = 12;
  const mask = b.slice(o, o + nx * ny);
  o += nx * ny;
  const elev = new Int16Array(ncells);
  for (let i = 0; i < ncells; i++) elev[i] = dv.getInt16(o + i * 2, true);
  o += ncells * 2;
  const land = b.slice(o, o + ncells);
  return { ny, nx, ncells, mask, elev, land };
}

function med(left: number, up: number, ul: number): number {
  const mx = left > up ? left : up;
  const mn = left > up ? up : left;
  if (ul >= mx) return mn;
  if (ul <= mn) return mx;
  return left + up - ul;
}

/**
 * Decode one variable file (gzip already removed) into cell-major codes:
 * out[cell * days + day].
 */
export function decodeVar(buf: Uint8Array, cells: CellsInfo, days: number, block: number): Uint8Array {
  const mode = buf[0];
  const res = buf.subarray(1);
  const { nx, ny, ncells, mask } = cells;
  if (res.length !== ncells * days) throw new Error(`corrupt climate file (${res.length} != ${ncells * days})`);
  const out = new Uint8Array(ncells * days);
  const N = nx * ny;
  let prev = new Int32Array(N);
  let cur = new Int32Array(N);
  const d = new Int32Array(N); // day-to-day change raster (temporal mode)
  let p = 0;
  for (let t = 0; t < days; t++) {
    const temporal = mode === 2 && t % block !== 0;
    const src = temporal ? d : cur; // raster the predictor reads from
    let last = 0;
    let ci = 0;
    for (let i = 0; i < ny; i++) {
      const row = i * nx;
      for (let j = 0; j < nx; j++) {
        const pos = row + j;
        if (mask[pos]) {
          let v: number;
          if (mode === 0) {
            v = res[p++];
          } else {
            let pred: number;
            if (i === 0 && j === 0) pred = 0;
            else if (i === 0) pred = src[pos - 1];
            else if (j === 0) pred = src[pos - nx];
            else pred = med(src[pos - 1], src[pos - nx], src[pos - nx - 1]);
            if (temporal) v = (prev[pos] + pred + res[p++]) & 255;
            else v = (pred + res[p++]) & 255;
          }
          cur[pos] = v;
          if (temporal) d[pos] = v - prev[pos];
          last = v;
          out[ci * days + t] = v;
          ci++;
        } else {
          cur[pos] = last;
          if (temporal) d[pos] = last - prev[pos];
        }
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return out;
}

/** Same checksum as the encoder (cell-major order). */
export function checksum(codes: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < codes.length; i++) s += codes[i] * ((i % 65521) + 1);
  return s;
}
