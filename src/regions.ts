/**
 * Place names the location cards set themselves (instead of the geocoder's
 * country): a pin in the West Bank is named by who administers that spot under
 * the Oslo II Accord, and one in the Gaza Strip by the Strip. East Jerusalem
 * and the 1949 no man's land keep the geocoder's name. The boundaries
 * (public/data/regions.json, pipeline/build_regions.py, from OCHA) load only
 * for pins near them.
 */
type Ring = [number, number][];
interface Regions {
  bbox: [number, number, number, number];
  areas: { id: string; polygons: Ring[][] }[];
}

const LABELS = {
  AB: 'West Bank, State of Palestine', // Areas A and B (with Hebron's H1 and H2)
  C: 'Judea and Samaria Area, Israel', // Area C
  GAZA: 'Gaza Strip, State of Palestine',
};

let data: Promise<Regions | null> | null = null;

function inRing(r: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside any of the polygons (each an outer ring and its holes, even-odd). */
function inPolygons(ps: Ring[][], x: number, y: number): boolean {
  return ps.some((rings) => rings.reduce((n, r) => n + (inRing(r, x, y) ? 1 : 0), 0) % 2 === 1);
}

/** The card's region line for this point, or null to keep the geocoder's. */
export async function regionDetail(lon: number, lat: number): Promise<string | null> {
  if (lon < 34.1 || lon > 35.7 || lat < 31.1 || lat > 32.7) return null;
  data ??= fetch(`${import.meta.env.BASE_URL}data/regions.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const d = await data;
  if (!d) return null;
  const area = (id: string) => d.areas.find((a) => a.id === id)?.polygons ?? [];
  if (inPolygons(area('AB'), lon, lat)) return LABELS.AB;
  if (inPolygons(area('KEEP'), lon, lat)) return null;
  if (inPolygons(area('WB'), lon, lat)) return LABELS.C;
  if (inPolygons(area('GAZA'), lon, lat)) return LABELS.GAZA;
  return null;
}
