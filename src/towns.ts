/**
 * Small towns (1,000+ people, GeoNames) for the map labels, loaded by 5° tile
 * for the area on screen once zoomed in (pipeline/build_towns.py). Loaded towns
 * are appended to the shared city list, so labels, taps and cards treat them
 * like any other city; they rank after every city of the base list.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { City } from './data';

const MIN_ZOOM = 6; // the biggest towns show from zoom 6.6

type Row = [string, string, number, number, number, number, number, number | null, number[] | null];

export class Towns {
  private index?: Promise<Set<string> | null>;
  private tileDeg = 5;
  private loading = new Map<string, Promise<void>>();
  private base: number;
  /** towns were added to the city list */
  onLoad: () => void = () => {};

  constructor(
    private baseUrl: string,
    private cities: City[],
  ) {
    this.base = cities.length;
  }

  private tiles(): Promise<Set<string> | null> {
    this.index ??= fetch(`${this.baseUrl}data/towns/index.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tile: number; tiles: [number, number, number][] } | null) => {
        if (!j) return null;
        this.tileDeg = j.tile;
        return new Set(j.tiles.map(([ty, tx]) => `${ty}_${tx}`));
      })
      .catch(() => null);
    return this.index;
  }

  /** Load the tiles around the view (when zoomed in far enough). */
  async update(map: MlMap) {
    if (map.getZoom() < MIN_ZOOM) return;
    const have = await this.tiles();
    if (!have) return;
    const b = map.getBounds(), d = this.tileDeg;
    const px = (b.getEast() - b.getWest()) * 0.3, py = (b.getNorth() - b.getSouth()) * 0.3;
    const ty0 = Math.floor((90 - Math.min(90, b.getNorth() + py)) / d), ty1 = Math.floor((90 - Math.max(-90, b.getSouth() - py)) / d);
    const tx0 = Math.floor((b.getWest() - px + 180) / d), tx1 = Math.floor((b.getEast() + px + 180) / d);
    if ((ty1 - ty0 + 1) * (tx1 - tx0 + 1) > 16) return;
    const cols = 360 / d;
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${ty}_${(((tx % cols) + cols) % cols)}`;
        if (have.has(key) && !this.loading.has(key)) {
          const p = this.load(key);
          this.loading.set(key, p);
          jobs.push(p);
        }
      }
    if (jobs.length) await Promise.all(jobs).then(() => this.onLoad());
  }

  private async load(key: string) {
    const r = await fetch(`${this.baseUrl}data/towns/${key}.json`).catch(() => null);
    if (!r?.ok) return void this.loading.delete(key);
    const j = (await r.json()) as { rows: Row[] };
    for (const [name, country, lat, lon, pop, minzoom, rank, elev, mc] of j.rows)
      this.cities.push({ name, country, lat, lon, pop, minzoom, capital: false, rank: this.base + rank, elev, mc, town: true });
  }
}
