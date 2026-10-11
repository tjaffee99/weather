import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGrib2 } from '../src/live/grib2';
import { conicGrid, conicIndex } from '../src/live/hrrr';

const ref = JSON.parse(readFileSync(new URL('./fixtures/grib_ref.json', import.meta.url), 'utf8'));

function check(name: string, path: URL) {
  const buf = new Uint8Array(readFileSync(path));
  const [f] = decodeGrib2(buf);
  const r = ref[name];
  expect(f.nx * f.ny).toBe(r.n);
  expect(f.nx).toBe(1440);
  expect(f.lat1).toBe(90);
  let nan = 0, sum = 0;
  for (const v of f.values) {
    if (Number.isNaN(v)) nan++;
    else sum += v;
  }
  expect(nan).toBe(r.nanCount);
  expect(sum / (r.n - nan)).toBeCloseTo(r.mean, 3);
  for (const [i, v] of Object.entries(r.samples as Record<string, number | null>)) {
    if (v === null) expect(Number.isNaN(f.values[+i])).toBe(true);
    else expect(f.values[+i]).toBeCloseTo(v, 3);
  }
}

describe('GRIB2 decoder (checked against ecCodes)', () => {
  it('decodes complex packing with 2nd order spatial differencing', () => {
    check('csnow', new URL('./fixtures/csnow.grb', import.meta.url));
  });
  it('applies the section 6 bitmap', () => {
    check('snod', new URL('./fixtures/snod.grb', import.meta.url));
  });
  const tmp = process.env.GRIB_TMP_FIXTURE;
  it.skipIf(!tmp || !existsSync(tmp))('decodes a full 2 m temperature field', () => {
    check('tmp', new URL(`file://${tmp}`));
  });
});

describe('HRRR Lambert conformal grid (checked against ecCodes)', () => {
  const r = ref.hrrr_snod;
  const [f] = decodeGrib2(new Uint8Array(readFileSync(new URL('./fixtures/hrrr_snod.grb', import.meta.url))));

  it('decodes values in file order', () => {
    expect([f.nx, f.ny]).toEqual([r.nx, r.ny]);
    expect(f.projected?.type).toBe('lambert');
    let sum = 0;
    for (const v of f.values) sum += v;
    expect(sum / f.values.length).toBeCloseTo(r.mean, 5);
    for (const p of r.points) expect(f.values[p.i]).toBeCloseTo(p.value, 3);
  });

  it('maps latitude/longitude to grid indices', () => {
    const g = conicGrid(f);
    for (const p of r.points) {
      const [i, j] = conicIndex(g, p.lon, p.lat);
      expect(i).toBeCloseTo(p.i % r.nx, 3);
      expect(j).toBeCloseTo(Math.floor(p.i / r.nx), 3);
    }
  });
});
