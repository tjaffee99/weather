/** Shared static data: DEM and cities. */
export interface Dem {
  w: number;
  h: number;
  q: Uint8Array;
}

/** Fetch a (possibly gzip-compressed) binary asset. */
export async function fetchBinary(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +(res.headers.get('content-length') || 0);
  let buf: Uint8Array;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    buf = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.length;
    }
  } else {
    buf = new Uint8Array(await res.arrayBuffer());
  }
  // servers may or may not have already removed the gzip layer
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return buf;
}

export async function loadDem(base: string): Promise<Dem> {
  const b = await fetchBinary(`${base}data/dem.bin`);
  const magic = String.fromCharCode(...b.subarray(0, 4));
  if (magic !== 'DEM1') throw new Error('bad DEM file');
  const dv = new DataView(b.buffer, b.byteOffset);
  const w = dv.getUint16(4, true), h = dv.getUint16(6, true);
  return { w, h, q: b.subarray(8, 8 + w * h) };
}

/** Bilinear DEM elevation (m) at lon/lat. */
export function demAt(d: Dem, lon: number, lat: number): number {
  const x = ((((lon + 180) / 360) * d.w - 0.5) % d.w + d.w) % d.w;
  const y = Math.min(d.h - 1, Math.max(0, ((90 - lat) / 180) * d.h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % d.w, y1 = Math.min(d.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const g = (xx: number, yy: number) => d.q[yy * d.w + xx] / 255;
  const q = g(x0, y0) * (1 - fx) * (1 - fy) + g(x1, y0) * fx * (1 - fy) + g(x0, y1) * (1 - fx) * fy + g(x1, y1) * fx * fy;
  return q * q * 9000;
}

export interface City {
  name: string;
  country: string;
  lat: number;
  lon: number;
  pop: number;
  minzoom: number;
  capital: boolean;
  rank: number;
  /** metres above sea level (GeoNames SRTM), if known */
  elev: number | null;
  /** microclimate offset curves (climate/micro.ts), stored integers */
  mc?: number[] | null;
}

export async function loadCities(base: string): Promise<City[]> {
  const j = await (await fetch(`${base}data/cities.json`)).json();
  return (j.rows as [string, string, number, number, number, number, number, number | null, number[] | null | undefined][]).map((r, i) => ({
    name: r[0],
    country: r[1],
    lat: r[2],
    lon: r[3],
    pop: r[4],
    minzoom: r[5],
    capital: r[6] === 1,
    rank: i,
    elev: r[7] ?? null,
    mc: r[8] ?? null,
  }));
}

/** Closest city by straight-line distance (no preference for big cities). */
export function nearestCity(cities: City[], lon: number, lat: number, maxKm = 40): City | null {
  let best: City | null = null;
  let bd = maxKm;
  const cl = Math.cos((lat * Math.PI) / 180);
  for (const c of cities) {
    let dl = Math.abs(c.lon - lon);
    if (dl > 180) dl = 360 - dl;
    const d = Math.hypot((c.lat - lat) * 111, dl * 111 * cl);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
