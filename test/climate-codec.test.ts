import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checksum, decodeVar, parseCells } from '../src/climate/codec';

const dir = new URL('../public/data/climate/', import.meta.url);
const has = existsSync(new URL('meta.json', dir));

describe.skipIf(!has)('climate sample files', () => {
  const meta = has ? JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) : null;
  const read = (f: string) => new Uint8Array(gunzipSync(readFileSync(new URL(f, dir))));

  it('cells file matches meta', () => {
    const cells = parseCells(read('cells.bin'));
    expect(cells.ncells).toBe(meta.ncells);
    expect(cells.nx).toBe(meta.grid.nx);
    expect(cells.mask.reduce((s, x) => s + x, 0)).toBe(meta.ncells);
  });

  for (const v of Object.keys(meta?.vars ?? {})) {
    it(`decodes ${v} bit-exactly`, () => {
      const cells = parseCells(read('cells.bin'));
      const codes = decodeVar(read(meta.vars[v].file), cells, meta.days, meta.block);
      expect(checksum(codes)).toBe(meta.vars[v].checksum);
    });
  }
});
