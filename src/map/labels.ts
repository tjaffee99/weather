import type { Map as MlMap } from 'maplibre-gl';
import type { City } from '../data';

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
