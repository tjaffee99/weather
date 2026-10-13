/**
 * Observed (not forecast) layers for the live view:
 * - radar: RainViewer's global radar composite (last 2 hours, 10-minute frames),
 *   redrawn in this app's precipitation colours;
 * - satellite: EUMETSAT's 3-hourly global infrared cloud map, a mosaic of all
 *   geostationary weather satellites, drawn as clouds (clear sky blue, cloud
 *   white) so it matches the forecast cloud layer.
 * Tiles go through custom protocols (radar://, satir://) that recolour them.
 */
import type { Map as MlMap, RasterLayerSpecification } from 'maplibre-gl';
import { CLOUD, PRECIP, SNOWFALL, domain, rasterize, tf, type Palette } from '../map/palettes';
import { RADAR_COLORS } from './radarColors';

export type ObsKind = 'radar' | 'satellite';

export interface Frame {
  time: number; // ms
  tiles: string;
}

const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
let rvHost = 'https://tilecache.rainviewer.com';
const EUM_WMS = 'https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=mumi:worldcloudmap_ir108&styles=&format=image/png&crs=EPSG:3857&width=256&height=256';
const EUM_CAPS = 'https://view.eumetsat.int/geoserver/mumi/worldcloudmap_ir108/ows?service=WMS&version=1.3.0&request=GetCapabilities';
/** radar tiles stop at this zoom; MapLibre stretches them beyond */
const MAX_ZOOM = 7;
const SAT_FRAMES = 8; // 3-hourly images: the last 24 hours

export async function loadFrames(kind: ObsKind): Promise<Frame[]> {
  if (kind === 'radar') {
    const j = await (await fetch(RV_API, { cache: 'no-cache' })).json();
    rvHost = j.host ?? rvHost;
    return (j.radar?.past ?? []).map((f: { time: number; path: string }) => ({
      time: f.time * 1000,
      tiles: `radar://${f.path.split('/').pop()}/{z}/{x}/{y}`,
    }));
  }
  // the newest image time is the layer's default time dimension
  const caps = await (await fetch(EUM_CAPS, { cache: 'no-cache' })).text();
  const latest = Date.parse(/<Dimension name="time" default="([^"]+)"/.exec(caps)?.[1] ?? '');
  if (!Number.isFinite(latest)) throw new Error('satellite times unavailable');
  return Array.from({ length: SAT_FRAMES }, (_, k) => {
    const time = latest - (SAT_FRAMES - 1 - k) * 3 * 3600_000;
    return { time, tiles: `satir://${new Date(time).toISOString().replace('.000', '')}/{bbox-epsg-3857}` };
  });
}

// ---------------- tile recolouring ----------------

function paletteLut(p: Palette): { lut: Uint8Array; at: (v: number) => number } {
  const lut = rasterize(p, 256);
  const [d0, d1] = domain(p);
  return { lut, at: (v) => Math.round(Math.min(1, Math.max(0, (tf(p, v) - d0) / (d1 - d0))) * 255) * 4 };
}

/** RGBA for each radar code (dBZ + 32, +128 for snow), as rain or snowfall rate in our palettes. */
const radarRgba = (() => {
  const rain = paletteLut(PRECIP), snow = paletteLut(SNOWFALL);
  const out = new Uint8Array(256 * 4);
  for (let code = 0; code < 256; code++) {
    const isSnow = code >= 128;
    const z = Math.pow(10, ((code % 128) - 32) / 10);
    // Marshall-Palmer for rain (Z = 200 R^1.6), Z = 2000 R^2 for snow (water equivalent)
    const rate = isSnow ? Math.sqrt(z / 2000) : Math.pow(z / 200, 1 / 1.6);
    const { lut, at } = isSnow ? snow : rain;
    const i = at(rate);
    out.set(lut.subarray(i, i + 4), code * 4);
  }
  return out;
})();

const radarIndex = RADAR_COLORS.map(([rgba, code]) => ({ r: rgba >>> 24, g: (rgba >>> 16) & 255, b: (rgba >>> 8) & 255, a: rgba & 255, code }));
const radarCache = new Map<number, number>();

/** Nearest radar colour (canvas round-trips can shift faint, translucent colours slightly). */
function radarCode(r: number, g: number, b: number, a: number): number {
  const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  let c = radarCache.get(key);
  if (c === undefined) {
    let best = Infinity;
    c = -1;
    for (const e of radarIndex) {
      const d = ((e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2) * (a / 255) ** 2 + 4 * (e.a - a) ** 2;
      if (d < best) {
        best = d;
        c = e.code;
      }
    }
    radarCache.set(key, c);
  }
  return c;
}

const cloudRgba = (() => {
  const { lut, at } = paletteLut(CLOUD);
  const out = new Uint8Array(256 * 4);
  for (let g = 0; g < 256; g++) {
    // infrared brightness: clear sea/land is ~50-80, cold cloud tops brighter
    const t = Math.min(1, Math.max(0, (g - 85) / 90));
    const s = t * t * (3 - 2 * t);
    const i = at(s * 100);
    out.set(lut.subarray(i, i + 4), g * 4);
  }
  return out;
})();

async function recolour(url: string, fn: (px: Uint8ClampedArray) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  fn(img.data);
  ctx.putImageData(img, 0, 0);
  return (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

/** radar://{id}/{z}/{x}/{y} */
export async function radarTile(url: string): Promise<ArrayBuffer> {
  const m = /radar:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(url)!;
  return recolour(`${rvHost}/v2/radar/${m[1]}/256/${m[2]}/${m[3]}/${m[4]}/2/1_1.png`, (px) => {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const c = radarCode(px[i], px[i + 1], px[i + 2], px[i + 3]);
      if (c < 0) {
        px[i + 3] = 0;
        continue;
      }
      px.set(radarRgba.subarray(c * 4, c * 4 + 4), i);
    }
  });
}

/** satir://{ISO time}/{bbox in EPSG:3857} */
export async function satelliteTile(url: string): Promise<ArrayBuffer> {
  const m = /satir:\/\/([^/]+)\/(.+)$/.exec(url)!;
  return recolour(`${EUM_WMS}&time=${m[1]}&bbox=${m[2]}`, (px) => {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      px.set(cloudRgba.subarray(px[i] * 4, px[i] * 4 + 4), i);
    }
  });
}

// ---------------- map layers ----------------

/**
 * One raster layer per frame, added only when that frame is first shown (the
 * imagery services throttle clients that pull every frame at once). Switching
 * frames keeps the previous picture up until the next one has loaded.
 */
export class ObservedLayers {
  kind: ObsKind | null = null;
  frames: Frame[] = [];
  index = 0;
  private added = new Set<number>();
  private visible = -1;
  private token = 0;

  constructor(
    private map: MlMap,
    private before: string,
    private opacity = 0.9,
  ) {}

  private id(i: number) {
    return `obs-${this.kind}-${i}`;
  }

  async activate(kind: ObsKind): Promise<void> {
    if (this.kind === kind && this.frames.length) return;
    this.deactivate();
    const token = ++this.token;
    this.kind = kind;
    const frames = await loadFrames(kind);
    if (token !== this.token) return;
    this.frames = frames;
    this.show(frames.length - 1);
  }

  deactivate() {
    this.token++;
    for (const i of this.added) {
      const id = this.id(i);
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
    this.added.clear();
    this.visible = -1;
    this.frames = [];
    this.kind = null;
  }

  private ensure(i: number) {
    if (this.added.has(i)) return;
    const id = this.id(i);
    this.map.addSource(id, {
      type: 'raster',
      tiles: [this.frames[i].tiles],
      tileSize: 256,
      maxzoom: MAX_ZOOM,
      attribution:
        this.kind === 'radar'
          ? 'Radar: <a href="https://www.rainviewer.com/">RainViewer</a>'
          : 'Satellite: <a href="https://view.eumetsat.int/">EUMETSAT</a>',
    });
    const layer: RasterLayerSpecification = {
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 220 }, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    };
    this.map.addLayer(layer, this.before);
    this.added.add(i);
  }

  /** Show frame i once its tiles are in (resolves when it is on screen). */
  show(i: number): Promise<void> {
    if (!this.frames.length) return Promise.resolve();
    this.index = Math.max(0, Math.min(this.frames.length - 1, i));
    const want = this.index, token = this.token;
    this.ensure(want);
    const swap = () => {
      if (token !== this.token || this.index !== want) return;
      for (const k of this.added) this.map.setPaintProperty(this.id(k), 'raster-opacity', k === want ? this.opacity : 0);
      this.visible = want;
    };
    const id = this.id(want);
    if (this.map.isSourceLoaded(id) || this.visible < 0) {
      swap();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        this.map.off('sourcedata', check);
        clearTimeout(timer);
        swap();
        resolve();
      };
      const check = () => {
        if (this.map.getSource(id) && this.map.isSourceLoaded(id)) done();
      };
      // never hang on a slow tile
      const timer = setTimeout(done, 4000);
      this.map.on('sourcedata', check);
    });
  }
}
