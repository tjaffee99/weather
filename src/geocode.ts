/**
 * Reverse geocoding with OpenStreetMap Nominatim: the municipality that actually
 * contains the clicked point (with its boundary, so the map can outline it).
 * Unincorporated areas get a second, finer lookup for the community name.
 * Falls back to the bundled city list when Nominatim is unreachable.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Geometry } from 'geojson';
import { nearestCity, type City } from './data';

export interface Place {
  name: string;
  detail: string; // region, country
  boundary?: Geometry;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0005&accept-language=en';
let ctrl: AbortController | null = null;
let lastRequest = 0;
const cache = new Map<string, Place | null>();

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))));
  });

// Nominatim's usage policy allows at most one request per second
async function nominatim(lat: number, lon: number, zoom: number, signal: AbortSignal) {
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequest = Date.now();
  const res = await fetch(`${NOMINATIM}&lat=${lat}&lon=${lon}&zoom=${zoom}`, { signal });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const localityOf = (a: Record<string, string>) => a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality;
const areaGeom = (g?: Geometry) => (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : undefined);

export async function reverseGeocode(lon: number, lat: number, _zoom: number, cities: City[]): Promise<Place | null> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key)!;
  ctrl?.abort();
  const ac = new AbortController();
  ctrl = ac;
  try {
    const j = await nominatim(lat, lon, 10, ac.signal);
    if (j.error) {
      cache.set(key, null); // open ocean etc.
      return null;
    }
    let a = j.address ?? {};
    let boundary = areaGeom(j.geojson);
    let locality = localityOf(a);
    if (!locality) {
      // no town at city level (unincorporated / rural): look closer for the community name
      const k = await nominatim(lat, lon, 14, ac.signal).catch(() => null);
      if (k && !k.error) {
        const kl = localityOf(k.address ?? {}) ?? k.address?.suburb;
        if (kl) {
          locality = kl;
          a = { ...a, ...k.address };
          boundary = k.addresstype && localityOf({ [k.addresstype]: kl }) ? areaGeom(k.geojson) : undefined;
        }
      }
    }
    const name = locality ?? a.county ?? a.state_district ?? a.state ?? j.name ?? a.country;
    const region = [a.county !== name && !a.city && !a.town ? a.county : undefined, a.state !== name ? a.state : undefined]
      .filter(Boolean)
      .join(', ');
    const detail = [region, a.country !== name ? a.country : undefined].filter(Boolean).join(', ');
    const place: Place = { name, detail, boundary };
    cache.set(key, place);
    return place;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const c = nearestCity(cities, lon, lat, 15);
    return c ? { name: `Near ${c.name}`, detail: c.country } : null;
  }
}

export function boundaryLayers(map: MlMap) {
  map.addSource('place-boundary', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'place-fill',
    type: 'fill',
    source: 'place-boundary',
    paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.07 },
  });
  map.addLayer({
    id: 'place-casing',
    type: 'line',
    source: 'place-boundary',
    paint: { 'line-color': 'rgba(255,255,255,0.9)', 'line-width': 4.5 },
  });
  map.addLayer({
    id: 'place-line',
    type: 'line',
    source: 'place-boundary',
    paint: { 'line-color': '#0a6ee0', 'line-width': 2 },
  });
}

export function showBoundary(map: MlMap, geom?: Geometry) {
  const src = map.getSource('place-boundary') as GeoJSONSource | undefined;
  src?.setData({ type: 'FeatureCollection', features: geom ? [{ type: 'Feature', geometry: geom, properties: {} }] : [] });
}
