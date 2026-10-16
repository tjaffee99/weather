import type { Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { City } from '../data';

/** Screen cells (px) that each show at least their biggest place, and at most this many with small towns. */
const CELL = 160;
const TOWNS_PER_CELL = 2;

/**
 * Which cities can show a value label right now: allowed at this zoom (the
 * same rule as the city-labels layer's filter) and on screen or just off it.
 * Labels are recomputed when the map stops moving, so only these are worth
 * computing.
 */
export function labelFilter(map: MlMap): (c: City) => boolean {
  const z = map.getZoom();
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const px = (e - w) * 0.3, py = (n - s) * 0.3;
  const west = w - px, east = e + px;
  const all = east - west >= 360 || map.getProjection()?.type === 'globe';
  return (c) => {
    if (c.minzoom > z + 2.4 || c.lat < s - py || c.lat > n + py) return false;
    if (all) return true;
    const x = ((((c.lon - west) % 360) + 360) % 360) + west;
    return x <= east;
  };
}

/**
 * The places to label: the cities the zoom rule allows; small towns (towns.ts)
 * where they keep each screen cell of about 160 px to at most TOWNS_PER_CELL
 * places, biggest first; and, in a cell that would show none, its biggest
 * place. So zooming in keeps bringing in smaller places without crowding, and
 * anywhere with a town on screen shows one.
 */
export function labelPlan(map: MlMap, cities: City[]): { show: (c: City) => boolean; fill: Set<City> } {
  const visible = labelFilter(map);
  const fill = new Set<City>();
  const towns = new Set<City>();
  const z = map.getZoom();
  if (z >= 3) {
    const { clientWidth: W, clientHeight: H } = map.getContainer();
    const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
    const best: (City | undefined)[] = new Array(cols * rows);
    const count = new Uint8Array(cols * rows);
    const candidates: [City, number][] = [];
    const b = map.getBounds();
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    for (const c of cities) {
      if (c.lat < s || c.lat > n) continue;
      const x = ((((c.lon - w) % 360) + 360) % 360) + w;
      if (x > e) continue;
      const p = map.project([c.lon, c.lat]);
      if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) continue;
      const k = Math.floor(p.y / CELL) * cols + Math.floor(p.x / CELL);
      if (c.minzoom <= z + 2.4) {
        if (c.town) candidates.push([c, k]);
        else count[k]++;
      } else if (!best[k] || c.rank < best[k]!.rank) best[k] = c;
    }
    candidates.sort((a, b) => a[0].rank - b[0].rank);
    for (const [c, k] of candidates) {
      if (count[k] < TOWNS_PER_CELL) {
        towns.add(c);
        count[k]++;
      } else if (!best[k] || c.rank < best[k]!.rank) best[k] = c;
    }
    best.forEach((c, k) => c && !count[k] && fill.add(c));
  }
  return { show: (c) => fill.has(c) || (c.town ? towns.has(c) : visible(c)), fill };
}

/**
 * The city-labels source data: every city of the base list (so names show as
 * soon as the zoom allows them, before labels are recomputed) and the loaded
 * small towns that show; `label` gives the value of each shown place.
 */
export function cityFeatures(map: MlMap, cities: City[], label: (c: City) => string): FeatureCollection {
  const { show, fill } = labelPlan(map, cities);
  const features: Feature[] = [];
  cities.forEach((c, i) => {
    const on = show(c);
    if (!on && c.town) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { i, name: c.name, label: on ? label(c) : '', rank: c.rank, minzoom: c.minzoom, fill: fill.has(c) },
    });
  });
  return { type: 'FeatureCollection', features };
}
