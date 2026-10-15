/**
 * Reverse geocoding with OpenStreetMap Nominatim: the municipality that actually
 * contains the clicked point.
 * Unincorporated areas get a second, finer lookup for the community name.
 * Falls back to the bundled city list when Nominatim is unreachable.
 */
import { nearestCity, type City } from './data';
import { regionDetail } from './regions';

export interface Place {
  name: string;
  detail: string; // region, country
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=en';
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

export async function reverseGeocode(lon: number, lat: number, cities: City[]): Promise<Place | null> {
  const [place, region] = await Promise.all([lookup(lon, lat, cities), regionDetail(lon, lat).catch(() => null)]);
  return place && region ? { ...place, detail: region } : place;
}

async function lookup(lon: number, lat: number, cities: City[]): Promise<Place | null> {
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
    let locality = localityOf(a);
    if (!locality) {
      // no town at city level (unincorporated / rural): look closer for the community name
      const k = await nominatim(lat, lon, 14, ac.signal).catch(() => null);
      if (k && !k.error) {
        const kl = localityOf(k.address ?? {}) ?? k.address?.suburb;
        if (kl) {
          locality = kl;
          a = { ...a, ...k.address };
        }
      }
    }
    const name = locality ?? a.county ?? a.state_district ?? a.state ?? j.name ?? a.country;
    const region = [a.county !== name && !a.city && !a.town ? a.county : undefined, a.state !== name ? a.state : undefined]
      .filter(Boolean)
      .join(', ');
    const detail = [region, a.country !== name ? a.country : undefined].filter(Boolean).join(', ');
    const place: Place = { name, detail };
    cache.set(key, place);
    return place;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const c = nearestCity(cities, lon, lat, 15);
    return c ? { name: `Near ${c.name}`, detail: c.country } : null;
  }
}
