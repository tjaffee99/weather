/** Colour ramps. Stops are [value, css colour, alpha?]. */
export type Stop = [number, string, number?];

export interface Palette {
  stops: Stop[];
  /** value transform applied before mapping onto the ramp */
  transform?: 'linear' | 'log';
}

/** Apple Weather–style temperature ramp (°C). */
export const TEMPERATURE: Palette = {
  stops: [
    [-50, '#2a0b4d'],
    [-40, '#43177a'],
    [-30, '#5a2fb0'],
    [-22, '#5a4fd6'],
    [-15, '#3f6fe0'],
    [-8, '#3e95ee'],
    [-2, '#4fb8f2'],
    [2, '#5fcde8'],
    [6, '#63d4c0'],
    [10, '#79d993'],
    [14, '#a8e06e'],
    [18, '#e1e45f'],
    [22, '#f8d553'],
    [26, '#f9b247'],
    [30, '#f48a3c'],
    [34, '#ea6034'],
    [38, '#d93a3a'],
    [42, '#b52245'],
    [46, '#8c1447'],
    [52, '#5e0b3b'],
  ],
};

export const PRECIP: Palette = {
  transform: 'log',
  stops: [
    [0.04, '#2fbf9f', 0],
    [0.1, '#2fbf9f', 0.55],
    [0.4, '#33c46f', 0.8],
    [1, '#7fd13b', 0.9],
    [2.5, '#f2d43d', 0.95],
    [5, '#f59a2f', 1],
    [10, '#ea4b32', 1],
    [25, '#c61f6a', 1],
    [60, '#9b30c9', 1],
  ],
};

export const SNOWFALL: Palette = {
  transform: 'log',
  stops: [
    [0.04, '#bfe3ff', 0],
    [0.1, '#bfe3ff', 0.55],
    [0.4, '#d4ecff', 0.8],
    [1, '#9ec9ff', 0.9],
    [2.5, '#7aa2ff', 0.95],
    [5, '#8b7bff', 1],
    [10, '#c27bff', 1],
    [25, '#ff9cf0', 1],
    [60, '#ffffff', 1],
  ],
};

export const CLOUD: Palette = {
  stops: [
    [0, '#ffffff', 0],
    [15, '#ffffff', 0.02],
    [40, '#e9eef5', 0.3],
    [70, '#dde4ee', 0.62],
    [90, '#d4dbe6', 0.82],
    [100, '#cfd6e2', 0.9],
  ],
};

export const WIND: Palette = {
  stops: [
    [0, '#26307a'],
    [5, '#2f4fa8'],
    [12, '#3a7bd5'],
    [20, '#3fb0c9'],
    [28, '#4ccf98'],
    [36, '#a6dc55'],
    [45, '#f2d43d'],
    [55, '#f59a2f'],
    [70, '#ea4b32'],
    [90, '#c61f6a'],
    [120, '#8a2fb5'],
    [160, '#f0d0ff'],
  ],
};

export const SNOW_DEPTH: Palette = {
  transform: 'log',
  stops: [
    [0.5, '#dfe9ff', 0],
    [1, '#dfe9ff', 0.45],
    [5, '#c5d6ff', 0.7],
    [15, '#9fb4ff', 0.85],
    [40, '#8a8cf5', 0.95],
    [100, '#a66be0', 1],
    [250, '#e2a6f0', 1],
    [600, '#ffffff', 1],
  ],
};

export const HUMIDITY: Palette = {
  stops: [
    [0, '#8a5a2b'],
    [20, '#c08a43'],
    [40, '#d9c27a'],
    [60, '#7fc8a9'],
    [80, '#3f8fd0'],
    [100, '#2b4fa8'],
  ],
};

/** Climate explorer: days per year / probability (normalised 0..1). */
export const SCORE: Palette = {
  stops: [
    [0, '#1d1640', 0.55],
    [0.02, '#2a1f63', 0.8],
    [0.12, '#3b3f9a'],
    [0.25, '#2f6fb7'],
    [0.4, '#2aa1b8'],
    [0.55, '#34c28f'],
    [0.7, '#93d95a'],
    [0.85, '#f1dd4b'],
    [1, '#fff3a8'],
  ],
};

function parseColor(c: string): [number, number, number] {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function tf(p: Palette, v: number) {
  return p.transform === 'log' ? Math.log(Math.max(v, 1e-4)) : v;
}

export function domain(p: Palette): [number, number] {
  return [tf(p, p.stops[0][0]), tf(p, p.stops[p.stops.length - 1][0])];
}

/** Rasterise a palette to `n` RGBA texels across its (transformed) domain. */
export function rasterize(p: Palette, n = 256): Uint8Array {
  const [d0, d1] = domain(p);
  const out = new Uint8Array(n * 4);
  const s = p.stops.map(([v, c, a]) => ({ t: (tf(p, v) - d0) / (d1 - d0), rgb: parseColor(c), a: a ?? 1 }));
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let k = 0;
    while (k < s.length - 2 && t > s[k + 1].t) k++;
    const a = s[k], b = s[k + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1)));
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
    out[i * 4 + 3] = Math.round((a.a + (b.a - a.a) * f) * 255);
  }
  return out;
}

/** CSS gradient for legends. */
export function cssGradient(p: Palette, dir = 'to right'): string {
  const [d0, d1] = domain(p);
  const parts = p.stops.map(([v, c, a]) => {
    const [r, g, b] = parseColor(c);
    const al = Math.max(a ?? 1, 0.35);
    return `rgba(${r},${g},${b},${al}) ${(((tf(p, v) - d0) / (d1 - d0)) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(${dir}, ${parts.join(', ')})`;
}

/** CPU colour lookup (used for chart bars / swatches). */
export function colorAt(p: Palette, v: number): string {
  const [d0, d1] = domain(p);
  const t = Math.min(1, Math.max(0, (tf(p, v) - d0) / (d1 - d0)));
  const ras = rasterize(p, 64);
  const i = Math.round(t * 63) * 4;
  return `rgb(${ras[i]},${ras[i + 1]},${ras[i + 2]})`;
}
