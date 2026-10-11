/**
 * Minimal GRIB2 decoder for NOAA GFS fields.
 *
 * Supports regular lat/lon grids (grid template 3.0), simple packing (5.0) and
 * complex packing with spatial differencing (5.2 / 5.3), with or without a
 * bitmap (section 6). That covers every GFS pgrb2 field we use.
 */

export interface GribField {
  nx: number;
  ny: number;
  /** latitude/longitude of the first grid point and increments (degrees) */
  lat1: number;
  lon1: number;
  dx: number;
  dy: number;
  /** values in row-major order, rows from lat1 stepping by -dy (north to south for GFS) */
  values: Float32Array;
}

class BitReader {
  private pos = 0; // bit position
  constructor(private buf: Uint8Array, byteOffset: number) {
    this.pos = byteOffset * 8;
  }
  get bitPos() {
    return this.pos;
  }
  align() {
    this.pos = (this.pos + 7) & ~7;
  }
  read(n: number): number {
    if (n === 0) return 0;
    let v = 0;
    let pos = this.pos;
    const buf = this.buf;
    // read up to 32 bits; values in GFS never exceed 32 bits
    while (n > 0) {
      const byte = buf[pos >>> 3];
      const bitInByte = pos & 7;
      const avail = 8 - bitInByte;
      const take = avail < n ? avail : n;
      const shift = avail - take;
      const bits = (byte >>> shift) & ((1 << take) - 1);
      v = v * (1 << take) + bits;
      n -= take;
      pos += take;
    }
    this.pos = pos;
    return v;
  }
}

function u16(b: Uint8Array, o: number) {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number) {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
/** GRIB uses sign-and-magnitude integers */
function s16(b: Uint8Array, o: number) {
  const v = u16(b, o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
}
function s32(b: Uint8Array, o: number) {
  const v = u32(b, o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
}
function f32(b: Uint8Array, o: number) {
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
}

/** Decode every message in the buffer (e.g. UGRD+VGRD fetched in one range). */
export function decodeGrib2(buf: Uint8Array): GribField[] {
  const out: GribField[] = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    if (buf[off] !== 0x47 || buf[off + 1] !== 0x52 || buf[off + 2] !== 0x49 || buf[off + 3] !== 0x42) {
      off++;
      continue;
    }
    // total length: 8-byte big-endian; GFS messages are < 4 GB
    const len = u32(buf, off + 12);
    out.push(decodeMessage(buf.subarray(off, off + len)));
    off += len;
  }
  return out;
}

function decodeMessage(m: Uint8Array): GribField {
  if (m[7] !== 2) throw new Error('not GRIB edition 2');
  let off = 16;
  let nx = 0, ny = 0, lat1 = 0, lon1 = 0, dx = 0, dy = 0, scan = 0;
  let nPoints = 0;
  let drsTemplate = -1;
  let drs: Uint8Array | null = null;
  let bitmap: Uint8Array | null = null;
  let dataSec: Uint8Array | null = null;

  while (off < m.length - 4) {
    if (m[off] === 0x37 && m[off + 1] === 0x37 && m[off + 2] === 0x37 && m[off + 3] === 0x37) break;
    const len = u32(m, off);
    const sec = m[off + 4];
    const s = m.subarray(off, off + len);
    if (sec === 3) {
      const tpl = u16(s, 12);
      if (tpl !== 0) throw new Error(`unsupported grid template 3.${tpl}`);
      nx = u32(s, 30);
      ny = u32(s, 34);
      lat1 = s32(s, 46) / 1e6;
      lon1 = u32(s, 50) / 1e6;
      dx = u32(s, 63) / 1e6;
      dy = u32(s, 67) / 1e6;
      scan = s[71];
    } else if (sec === 5) {
      nPoints = u32(s, 5);
      drsTemplate = u16(s, 9);
      drs = s;
    } else if (sec === 6) {
      const ind = s[5];
      if (ind === 0) bitmap = s.subarray(6);
      else if (ind !== 255) throw new Error('predefined bitmaps not supported');
    } else if (sec === 7) {
      dataSec = s;
    }
    off += len;
  }
  if (!drs || !dataSec) throw new Error('incomplete GRIB message');
  if (scan & 0x20) throw new Error('column-major scanning not supported');

  const R = f32(drs, 11);
  const E = s16(drs, 15);
  const D = s16(drs, 17);
  const nbits = drs[19];
  const bscale = Math.pow(2, E);
  const dscale = Math.pow(10, -D);

  let packed: Float32Array;
  if (drsTemplate === 0) {
    packed = unpackSimple(dataSec, nPoints, nbits, R, bscale, dscale);
  } else if (drsTemplate === 2 || drsTemplate === 3) {
    packed = unpackComplex(drs, dataSec, nPoints, drsTemplate, R, bscale, dscale);
  } else {
    throw new Error(`unsupported data representation template 5.${drsTemplate}`);
  }

  const total = nx * ny;
  let values: Float32Array;
  if (bitmap) {
    values = new Float32Array(total);
    let k = 0;
    for (let i = 0; i < total; i++) {
      const on = (bitmap[i >>> 3] >>> (7 - (i & 7))) & 1;
      values[i] = on ? packed[k++] : NaN;
    }
  } else {
    values = packed;
  }
  // normalise to north->south rows
  if (scan & 0x40) {
    const flipped = new Float32Array(total);
    for (let j = 0; j < ny; j++) flipped.set(values.subarray(j * nx, (j + 1) * nx), (ny - 1 - j) * nx);
    values = flipped;
    lat1 = lat1 + (ny - 1) * dy;
  }
  return { nx, ny, lat1, lon1, dx, dy, values };
}

function unpackSimple(sec7: Uint8Array, n: number, nbits: number, R: number, bscale: number, dscale: number) {
  const out = new Float32Array(n);
  if (nbits === 0) {
    out.fill(R * dscale);
    return out;
  }
  const br = new BitReader(sec7, 5);
  for (let i = 0; i < n; i++) out[i] = (R + br.read(nbits) * bscale) * dscale;
  return out;
}

function unpackComplex(
  s5: Uint8Array,
  sec7: Uint8Array,
  n: number,
  tpl: number,
  R: number,
  bscale: number,
  dscale: number,
) {
  const nbitsRef = s5[19];
  const missingMgmt = s5[22];
  const ng = u32(s5, 31);
  const refWidth = s5[35];
  const bitsWidth = s5[36];
  const refLen = u32(s5, 37);
  const lenInc = s5[41];
  const lastLen = u32(s5, 42);
  const bitsLen = s5[46];
  const order = tpl === 3 ? s5[47] : 0;
  const extraOctets = tpl === 3 ? s5[48] : 0;
  if (missingMgmt !== 0) throw new Error('missing value management not supported');

  const br = new BitReader(sec7, 5);
  let ival1 = 0, ival2 = 0, minsd = 0;
  if (order > 0 && extraOctets > 0) {
    const nb = extraOctets * 8;
    const readSigned = () => {
      const sign = br.read(1);
      const v = br.read(nb - 1);
      return sign ? -v : v;
    };
    ival1 = readSigned();
    if (order === 2) ival2 = readSigned();
    minsd = readSigned();
  }

  const gref = new Int32Array(ng);
  for (let i = 0; i < ng; i++) gref[i] = br.read(nbitsRef);
  br.align();
  const gwidth = new Int32Array(ng);
  for (let i = 0; i < ng; i++) gwidth[i] = br.read(bitsWidth) + refWidth;
  br.align();
  const glen = new Int32Array(ng);
  for (let i = 0; i < ng; i++) glen[i] = br.read(bitsLen) * lenInc + refLen;
  glen[ng - 1] = lastLen;
  br.align();

  const ifld = new Int32Array(n);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const w = gwidth[g];
    const ref = gref[g];
    const len = glen[g];
    if (w === 0) {
      for (let i = 0; i < len; i++) ifld[k++] = ref;
    } else {
      for (let i = 0; i < len; i++) ifld[k++] = br.read(w) + ref;
    }
  }

  if (order === 1) {
    ifld[0] = ival1;
    for (let i = 1; i < n; i++) ifld[i] = ifld[i] + minsd + ifld[i - 1];
  } else if (order === 2) {
    ifld[0] = ival1;
    if (n > 1) ifld[1] = ival2;
    for (let i = 2; i < n; i++) ifld[i] = ifld[i] + minsd + 2 * ifld[i - 1] - ifld[i - 2];
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (R + ifld[i] * bscale) * dscale;
  return out;
}
