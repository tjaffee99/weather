/**
 * MapLibre custom layer that paints a global scalar field with smooth
 * (cubic B-spline) interpolation and a colour ramp, Apple Weather style.
 *
 * Two sources are supported:
 *  - 'live': a regular lat/lon model grid (GFS 0.25°), two time steps that can be
 *    cross-faded, optionally downscaled with a lapse rate using a 0.1° DEM.
 *  - 'climate': per-cell results of the climate explorer at several elevation
 *    offsets; each pixel picks the offset matching its DEM elevation.
 * Works with both the mercator and globe projections.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { domain, rasterize, type Palette } from './palettes';
import type { ConicGrid } from '../live/hrrr';
import { EXCESS_SCALE } from '../climate/blend';

export interface GridSpec {
  nx: number;
  ny: number;
  lon0: number; // longitude of column 0 centre
  lat0: number; // latitude of row 0 centre (north)
  dx: number;
  dy: number;
}

export interface ClimateGridSpec extends GridSpec {
  levels: number;
  dz0: number; // elevation offset of level 0 (m)
  dzStep: number;
}

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_merc;
out vec4 fragColor;

uniform int u_mode;            // 0 live, 1 climate
uniform sampler2D u_fieldA;
uniform sampler2D u_fieldB;
uniform sampler2D u_alt;       // e.g. snow mask for precipitation
uniform sampler2D u_orog;
uniform sampler2D u_dem;
uniform sampler2D u_palette;   // 256 x 2
uniform sampler2DArray u_result;
uniform sampler2D u_cellElev;
uniform sampler2DArray u_mfields; // 'match' mode: one live field per condition
uniform int u_mcount;
uniform vec4 u_mrange[10];       // lo, hi, softness, kind (0 plain, 1 temperature, 2 rate->daily, 3 daylight)
uniform float u_mdoy;
uniform sampler2D u_ldem;       // viewport high-res elevation (m)
uniform vec4 u_ldemExt;         // its mercator extent x0,y0,x1,y1 (x1 <= x0: none)
uniform sampler2D u_reg0;       // live: high-resolution regional fields on conic grids
uniform sampler2D u_reg1;
uniform vec4 u_rcone[2];        // n, k (m), central meridian (deg), weight (0: off)
uniform vec4 u_rgrid[2];        // first grid point x, y and spacing dx, dy (m)
uniform sampler2D u_corr;       // live: additive correction on a lon/lat grid (live/pointLabels.ts)
uniform vec4 u_corrExt;         // its extent: west lon, north lat, width, height (deg); width 0 = none

uniform vec4 u_grid;           // lon0, lat0, dx, dy
uniform vec2 u_gridSize;
uniform vec4 u_cgrid;          // climate grid
uniform vec2 u_cgridSize;
uniform vec3 u_levels;         // count, dz0, dzStep
uniform float u_mix;
uniform vec2 u_domain;
uniform int u_log;
uniform float u_lapse;
uniform float u_snowH;         // live snow depth: terrain scale height (m), 0 = off
uniform float u_useAlt;
uniform float u_opacity;
uniform float u_cut;           // climate: values below are dimmed
uniform float u_csqrt;         // climate: 1 = square-root scale (fraction of days), 0 = values as they are (atlas)
uniform sampler2D u_under;     // copy of the map drawn so far (for u_waterMask)
uniform mediump sampler2DArray u_micro; // microclimate offsets (climate/micro.ts): 3 RGBA snorm layers
uniform vec4 u_microExt;       // their extent: west lon, north lat, width, height (deg); width 0 = none
uniform float u_microScale;    // °C per unit of the snorm value
uniform int u_microVar;        // 0 none, 1 daytime highs, 2 night lows, 3 both
uniform float u_microW[5];     // curve weights for the shown period
uniform float u_microSeasonW[20]; // finder per year: weights for each season
uniform int u_groups;          // climate result groups: 1, or 5 = whole year + 4 seasons
uniform vec4 u_waterMask;      // a = 1: draw only where the map underneath is this water colour (rgb)

const float PI = 3.141592653589793;

vec4 cubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}

// Cubic B-spline filtering from 4 bilinear taps (GPU Gems 2, ch. 20)
void bsplineTaps(vec2 uv, vec2 size, out vec4 offset, out vec2 sxy) {
  vec2 tc = uv * size - 0.5;
  vec2 f = fract(tc);
  tc -= f;
  vec4 xc = cubicW(f.x);
  vec4 yc = cubicW(f.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  offset = (c + vec4(xc.yw, yc.yw) / s) / size.xxyy;
  sxy = vec2(s.x / (s.x + s.y), s.z / (s.z + s.w));
}

vec4 bicubic(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec4 o; vec2 s;
  bsplineTaps(uv, size, o, s);
  vec4 s0 = texture(t, o.xz), s1 = texture(t, o.yz), s2 = texture(t, o.xw), s3 = texture(t, o.yw);
  return mix(mix(s3, s2, s.x), mix(s1, s0, s.x), s.y);
}

vec4 bicubicArr(sampler2DArray t, vec2 uv, float layer) {
  vec2 size = vec2(textureSize(t, 0).xy);
  vec4 o; vec2 s;
  bsplineTaps(uv, size, o, s);
  vec4 s0 = texture(t, vec3(o.xz, layer)), s1 = texture(t, vec3(o.yz, layer));
  vec4 s2 = texture(t, vec3(o.xw, layer)), s3 = texture(t, vec3(o.yw, layer));
  return mix(mix(s3, s2, s.x), mix(s1, s0, s.x), s.y);
}

float demElev(float lon, float lat) {
  float q = texture(u_dem, vec2((lon + 180.0) / 360.0, (90.0 - lat) / 180.0)).r;
  float g = q * q * 9000.0;
  if (u_ldemExt.z <= u_ldemExt.x) return g;
  vec2 t = (v_merc - u_ldemExt.xy) / (u_ldemExt.zw - u_ldemExt.xy);
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return g;
  float l = texture(u_ldem, t).r;
  vec2 e = min(t, 1.0 - t);
  return mix(g, l, smoothstep(0.0, 0.06, min(e.x, e.y)));
}

// Blend in a regional field on a polar stereographic / Lambert conformal grid:
// x = rho sin(n dLon), y = -rho cos(n dLon), rho = k / tan(pi/4 + lat/2)^n
float regional(float v, sampler2D t, vec4 cone, vec4 g, float lon, float lat) {
  if (cone.w <= 0.0 || lat < 1.0) return v;
  float dl = mod(lon - cone.z + 540.0, 360.0) - 180.0;
  float rho = cone.y / pow(tan(PI / 4.0 + radians(lat) * 0.5), cone.x);
  float th = cone.x * radians(dl);
  vec2 ij = (vec2(rho * sin(th), -rho * cos(th)) - g.xy) / g.zw;
  vec2 size = vec2(textureSize(t, 0));
  vec2 e = min(ij, size - 1.0 - ij);
  float edge = min(e.x, e.y);
  if (edge <= 0.0) return v;
  float r = bicubic(t, (ij + 0.5) / size).r;
  return mix(v, r, smoothstep(0.0, 16.0, edge) * cone.w);
}

const float LAPSE_C = 0.0065;

// Microclimate offset curves at this point: tmax c0-c4, tmin c0-c4 (°C).
bool microCoefs(float lon, float lat, out float c[10]) {
  if (u_microExt.z <= 0.0 || u_microVar == 0) return false;
  float u = mod(lon - u_microExt.x, 360.0) / u_microExt.z;
  float v = (u_microExt.y - lat) / u_microExt.w;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return false;
  vec4 a = texture(u_micro, vec3(u, v, 0.0)) * u_microScale;
  vec4 b = texture(u_micro, vec3(u, v, 1.0)) * u_microScale;
  vec4 d = texture(u_micro, vec3(u, v, 2.0)) * u_microScale;
  c = float[10](a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, d.x, d.y);
  return true;
}

// The offset for the chosen temperatures, with curve weights w[o..o+4] (o = 0 or a season's 5*s).
float microOff(float c[10], int season) {
  float hi = 0.0, lo = 0.0;
  for (int k = 0; k < 5; k++) {
    float w = season == -2 ? (k == 0 ? 1.0 : 0.0) : season < 0 ? u_microW[k] : u_microSeasonW[season * 5 + k];
    hi += w * c[k];
    lo += w * c[5 + k];
  }
  return u_microVar == 1 ? hi : u_microVar == 2 ? lo : 0.5 * (hi + lo);
}

// Same rules as src/climate/blend.ts: B-spline over the 4x4 nearby cells, each
// evaluated at elevation z; cells that can't reach it fade out. Result group g.
float climBlend(vec2 x, float z, int g, out float cover) {
  vec2 i0 = floor(x);
  vec4 wx4 = cubicW(x.x - i0.x), wy4 = cubicW(x.y - i0.y);
  float wx[4] = float[4](wx4.x, wx4.y, wx4.z, wx4.w);
  float wy[4] = float[4](wy4.x, wy4.y, wy4.z, wy4.w);
  float lmax = u_levels.x - 1.0;
  int base = g * int(u_levels.x);
  float sv = 0.0, sq = 0.0;
  cover = 0.0;
  for (int j = 0; j < 4; j++) {
    int yy = int(i0.y) + j - 1;
    if (yy < 0 || yy >= int(u_cgridSize.y)) continue;
    for (int i = 0; i < 4; i++) {
      int xx = int(mod(i0.x + float(i - 1), u_cgridSize.x));
      vec2 ce = texelFetch(u_cellElev, ivec2(xx, yy), 0).rg;
      if (ce.y < 0.5) continue;
      // cells without a value (e.g. sea temperature inland) leave a gap
      if (texelFetch(u_result, ivec3(xx, yy, base), 0).g < 0.5) continue;
      float w = wx[i] * wy[j];
      cover += w;
      float want = (z - ce.x - u_levels.y) / u_levels.z;
      float lc = clamp(want, 0.0, lmax);
      float q = w * exp(-abs(want - lc) * u_levels.z / ${EXCESS_SCALE.toFixed(1)});
      float l0 = floor(lc);
      float a = texelFetch(u_result, ivec3(xx, yy, base + int(l0)), 0).r;
      float b = texelFetch(u_result, ivec3(xx, yy, base + int(min(l0 + 1.0, lmax))), 0).r;
      sv += q * mix(a, b, lc - l0);
      sq += q;
    }
  }
  return sv / max(sq, 1e-20);
}

vec4 shade(float v, float altMix) {
  float x = u_log == 1 ? log(max(v, 1e-4)) : v;
  float t = clamp((x - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
  vec4 c0 = texture(u_palette, vec2(t * 255.0 / 256.0 + 0.5 / 256.0, 0.25));
  vec4 c1 = texture(u_palette, vec2(t * 255.0 / 256.0 + 0.5 / 256.0, 0.75));
  return mix(c0, c1, altMix);
}

float daylightHours(float lat, float doy) {
  float phi = radians(lat);
  float decl = radians(23.44) * sin(2.0 * PI * (285.0 + doy) / 365.0);
  float c = (sin(radians(-0.833)) - sin(phi) * sin(decl)) / (cos(phi) * cos(decl));
  return c <= -1.0 ? 24.0 : c >= 1.0 ? 0.0 : 24.0 / PI * acos(c);
}

void main() {
  float lon = fract(v_merc.x) * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  vec4 col;
  float alpha = 1.0;
  if (u_mode == 0) {
    vec2 uv = vec2((lon - u_grid.x) / u_grid.z + 0.5, (u_grid.y - lat) / u_grid.w + 0.5) / u_gridSize;
    float a = bicubic(u_fieldA, uv).r;
    float b = bicubic(u_fieldB, uv).r;
    float v = mix(a, b, u_mix);
    if (u_lapse > 0.0) {
      float zg = bicubic(u_orog, uv).r;
      v += u_lapse * (zg - demElev(lon, lat));
    }
    if (u_snowH > 0.0) {
      // deeper on ridges, thinner in valleys than the model cell's mean elevation
      float dz = demElev(lon, lat) - bicubic(u_orog, uv).r;
      v *= clamp(exp(dz / u_snowH), 0.1, 4.0);
    }
    v = regional(v, u_reg0, u_rcone[0], u_rgrid[0], lon, lat);
    v = regional(v, u_reg1, u_rcone[1], u_rgrid[1], lon, lat);
    if (u_corrExt.z > 0.0) {
      vec2 cu = vec2(mod(lon - u_corrExt.x, 360.0) / u_corrExt.z, (u_corrExt.y - lat) / u_corrExt.w);
      if (cu.x <= 1.0 && cu.y >= 0.0 && cu.y <= 1.0) v += texture(u_corr, cu).r;
    }
    float altMix = u_useAlt > 0.0 ? smoothstep(0.25, 0.75, bicubic(u_alt, uv).r) : 0.0;
    col = shade(v, altMix);
  } else if (u_mode == 2) {
    // how well the live/forecast weather here meets every condition (0..1)
    vec2 uv = vec2((lon - u_grid.x) / u_grid.z + 0.5, (u_grid.y - lat) / u_grid.w + 0.5) / u_gridSize;
    float dz = bicubic(u_orog, uv).r - demElev(lon, lat);
    float q = 1.0;
    for (int i = 0; i < 10; i++) {
      if (i >= u_mcount) break;
      vec4 r = u_mrange[i];
      int kind = int(r.w + 0.5);
      float v = kind == 3 ? daylightHours(lat, u_mdoy) : bicubicArr(u_mfields, uv, float(i)).r;
      if (kind == 1) v += 0.0065 * dz;
      if (kind == 2) v = max(v, 0.0) * 24.0;
      // each condition scores 0.5 exactly at its limit; the weakest one decides
      if (r.x > -1e8) q = min(q, smoothstep(r.x - r.z, r.x + r.z, v));
      if (r.y < 1e8) q = min(q, 1.0 - smoothstep(r.y - r.z, r.y + r.z, v));
    }
    col = shade(q, 0.0);
  } else {
    vec2 x = vec2((lon - u_cgrid.x) / u_cgrid.z, (u_cgrid.y - lat) / u_cgrid.w);
    float z = demElev(lon, lat);
    float mc[10];
    bool micro = microCoefs(lon, lat, mc);
    float cover, v;
    if (u_csqrt < 0.5) {
      // atlas: the microclimate offset adds to the temperature
      v = climBlend(x, z, 0, cover);
      if (micro) v += microOff(mc, -1);
    } else {
      // finder: a pixel warmer than its cells matches like a lower one (r / lapse rate)
      float r = micro ? microOff(mc, u_groups > 1 ? -2 : -1) : 0.0;
      float rs[4] = float[4](0.0, 0.0, 0.0, 0.0);
      float spread = 0.0;
      if (micro && u_groups > 1) {
        for (int s = 0; s < 4; s++) {
          rs[s] = microOff(mc, s);
          spread = max(spread, abs(rs[s] - r));
        }
      }
      if (spread > 0.25) {
        // offsets that change with the seasons (foggy summers): count each season at its own offset
        v = 0.0;
        for (int s = 0; s < 4; s++) v += climBlend(x, z - rs[s] / LAPSE_C, 1 + s, cover);
      } else {
        v = climBlend(x, z - r / LAPSE_C, 0, cover);
      }
    }
    if (cover < 0.04) discard;
    // finder: fixed square-root scale of the fraction of matching days, so a
    // colour always means the same number of days and rare matches stay visible
    col = shade(u_csqrt > 0.5 ? sqrt(max(v, 0.0)) : v, 0.0);
    alpha = smoothstep(0.04, 0.35, cover);
    if (u_cut > 0.0) {
      float keep = smoothstep(u_cut - 0.012, u_cut, v);
      col = mix(vec4(0.86, 0.86, 0.84, 0.55), col, keep);
    }
  }
  float a = col.a * alpha * u_opacity;
  if (u_waterMask.a > 0.5) {
    // the water polygons are opaque and drawn first, so their colour marks the sea pixel-exactly
    vec3 under = texelFetch(u_under, ivec2(gl_FragCoord.xy), 0).rgb;
    a *= 1.0 - smoothstep(0.03, 0.08, distance(under, u_waterMask.rgb));
  }
  fragColor = vec4(col.rgb * a, a);
}`;

function vert(prelude: string, define: string) {
  return `#version 300 es
${prelude}
${define}
in vec2 a_pos;
uniform float u_offset;
out vec2 v_merc;
void main() {
  vec2 p = vec2(a_pos.x + u_offset, a_pos.y);
  v_merc = p;
  gl_Position = projectTile(p);
}`;
}

type GL = WebGL2RenderingContext;

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  aPos: number;
}

const UNIFORMS = [
  'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane',
  'u_projection_transition', 'u_projection_fallback_matrix', 'u_offset',
  'u_mode', 'u_fieldA', 'u_fieldB', 'u_alt', 'u_orog', 'u_dem', 'u_palette', 'u_result', 'u_cellElev',
  'u_grid', 'u_gridSize', 'u_cgrid', 'u_cgridSize', 'u_levels', 'u_mix', 'u_domain', 'u_log',
  'u_lapse', 'u_snowH', 'u_useAlt', 'u_opacity', 'u_cut', 'u_csqrt', 'u_under', 'u_waterMask', 'u_ldem', 'u_ldemExt',
  'u_micro', 'u_microExt', 'u_microScale', 'u_microVar', 'u_microW', 'u_microSeasonW', 'u_groups',
  'u_mfields', 'u_mcount', 'u_mrange', 'u_mdoy', 'u_reg0', 'u_reg1', 'u_rcone', 'u_rgrid', 'u_corr', 'u_corrExt',
];

export class FieldLayer implements CustomLayerInterface {
  id: string;
  type = 'custom' as const;
  renderingMode = '2d' as const;

  private map?: MlMap;
  private gl?: GL;
  private programs = new Map<string, Program>();
  private vbo?: WebGLBuffer;
  private ibo?: WebGLBuffer;
  private vao?: WebGLVertexArrayObject;
  private nIdx = 0;

  private tex: Record<string, WebGLTexture | undefined> = {};
  private grid?: GridSpec;
  private cgrid?: ClimateGridSpec;
  /** 0 live field, 1 climate result, 2 live match against conditions */
  mode: 0 | 1 | 2 = 0;
  mix = 0;
  lapse = 0;
  /** live snow depth: terrain scale height in metres (0 = off) */
  snowH = 0;
  /** climate mode: show the square root of the result (finder) or the values themselves (atlas) */
  climateSqrt = true;
  /**
   * Draw only over water of this colour (0-1 RGB), e.g. sea temperature; null = everywhere.
   * The style's water layer must then be fully opaque, so that it is drawn before this layer.
   */
  waterOnly: [number, number, number] | null = null;
  private underSize: [number, number] = [0, 0];
  /** microclimate offsets: which temperatures (0 none), curve weights for the period, per season */
  microVar: 0 | 1 | 2 | 3 = 0;
  microW = new Float32Array([1, 0, 0, 0, 0]);
  microSeasonW = new Float32Array(20);
  private microExt: [number, number, number, number] = [0, 0, 0, 0];
  private microScale = 0;
  private groups = 1;
  useAlt = 0;
  opacity = 1;
  /** climate mode: normalised value below which results are dimmed (0 = off) */
  cut = 0;
  /** animated multiplier on top of `opacity` for cross-fades */
  fade = 1;
  private fadeRaf = 0;
  private fadeDone?: () => void;
  private paletteDomain: [number, number] = [0, 1];
  private paletteLog = false;
  private hasA = false;
  private hasB = false;
  private hasResult = false;
  private hasMatch = false;
  private mcount = 0;
  private mranges = new Float32Array(40);
  private mdoy = 0;
  private ldemExt: [number, number, number, number] = [0, 0, 0, 0];
  private reg: (ConicGrid | null)[] = [null, null];
  private corrExt: [number, number, number, number] = [0, 0, 0, 0];

  constructor(id: string) {
    this.id = id;
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('WebGL2 is required');
    this.gl = gl;
    // Subdivided mercator square so the globe projection can bend it. Extra rows
    // beyond y in [0, 1] (i.e. past ±85°) close the polar caps on the globe.
    const N = 96;
    const ys = [-1, -0.6, -0.35, -0.2, -0.1, -0.04];
    for (let j = 0; j <= N; j++) ys.push(j / N);
    ys.push(1.04, 1.1, 1.2, 1.35, 1.6, 2);
    const M = ys.length - 1;
    const verts = new Float32Array((N + 1) * (M + 1) * 2);
    for (let j = 0; j <= M; j++)
      for (let i = 0; i <= N; i++) {
        verts[(j * (N + 1) + i) * 2] = i / N;
        verts[(j * (N + 1) + i) * 2 + 1] = ys[j];
      }
    const idx = new Uint32Array(N * M * 6);
    let k = 0;
    for (let j = 0; j < M; j++)
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx.set([a, c, b, b, c, d], k);
        k += 6;
      }
    this.nIdx = idx.length;
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    // 1x1 placeholders so every sampler is always bound to a complete texture
    for (const name of ['fieldA', 'fieldB', 'alt', 'orog', 'cellElev', 'corr']) this.tex[name] = this.makeTex2D(1, 1, new Float32Array([0, 0]), 2);
    this.tex.dem = this.makeR8(1, 1, new Uint8Array([0]));
    this.tex.result = this.makeArray(1, 1, 1, new Float32Array([0, 0]));
    this.tex.ldem = this.makeTex2D(1, 1, new Float32Array([0]), 1);
    this.tex.mfields = this.makeArrayR(1, 1, 1, new Float32Array([0]));
    this.tex.micro = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.micro);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8_SNORM, 1, 1, 3, 0, gl.RGBA, gl.BYTE, new Int8Array(12));
    this.setParams(gl.TEXTURE_2D_ARRAY, gl.CLAMP_TO_EDGE);
    this.tex.under = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.under);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    this.setParams(gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
    this.tex.palette = gl.createTexture()!;
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const t of Object.values(this.tex)) if (t) gl.deleteTexture(t);
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }

  // ---------- texture helpers ----------
  private setParams(target: number, wrapS: number) {
    const gl = this.gl!;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private makeTex2D(w: number, h: number, data: Float32Array, channels: 1 | 2, tex?: WebGLTexture) {
    const gl = this.gl!;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.FLOAT, data);
    this.setParams(gl.TEXTURE_2D, gl.REPEAT);
    return t;
  }

  private makeR8(w: number, h: number, data: Uint8Array, tex?: WebGLTexture) {
    const gl = this.gl!;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.setParams(gl.TEXTURE_2D, gl.REPEAT);
    return t;
  }

  private makeArray(w: number, h: number, layers: number, data: Float32Array, tex?: WebGLTexture) {
    const gl = this.gl!;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RG16F, w, h, layers, 0, gl.RG, gl.FLOAT, data);
    this.setParams(gl.TEXTURE_2D_ARRAY, gl.REPEAT);
    return t;
  }

  private makeArrayR(w: number, h: number, layers: number, data: Float32Array, tex?: WebGLTexture) {
    const gl = this.gl!;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, w, h, layers, 0, gl.RED, gl.FLOAT, data);
    this.setParams(gl.TEXTURE_2D_ARRAY, gl.REPEAT);
    return t;
  }

  // ---------- public data API ----------
  setDem(w: number, h: number, q: Uint8Array) {
    this.tex.dem = this.makeR8(w, h, q, this.tex.dem);
    this.repaint();
  }

  /** High-resolution viewport elevation; null disables it. */
  setLocalDem(d: { width: number; height: number; data: Float32Array; extent: [number, number, number, number] } | null) {
    if (!this.gl) return;
    if (d) {
      this.tex.ldem = this.makeTex2D(d.width, d.height, d.data, 1, this.tex.ldem);
      const gl = this.gl;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      this.ldemExt = d.extent;
    } else {
      this.ldemExt = [0, 0, 0, 0];
    }
    this.repaint();
  }

  setPalette(p: Palette, alt?: Palette) {
    const gl = this.gl!;
    const a = rasterize(p, 256);
    const b = rasterize(alt ?? p, 256);
    const data = new Uint8Array(256 * 2 * 4);
    data.set(a, 0);
    data.set(b, 256 * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.palette!);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.setParams(gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
    this.paletteDomain = domain(p);
    this.paletteLog = p.transform === 'log';
    this.repaint();
  }

  /**
   * High-resolution regional field (e.g. HRRR snow over the US) blended over
   * the live field where it has data; null removes it.
   */
  setRegional(slot: 0 | 1, r: { grid: ConicGrid; values: Float32Array } | null) {
    if (r) {
      const gl = this.gl!;
      const key = `reg${slot}`;
      this.tex[key] = this.makeTex2D(r.grid.nx, r.grid.ny, r.values, 1, this.tex[key]);
      this.setParams(gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
    }
    this.reg[slot] = r ? r.grid : null;
    this.repaint();
  }

  /** Live: an additive correction (w x h, rows from the north) over extent [west, north, width, height], or null. */
  setCorrection(c: { w: number; h: number; values: Float32Array; extent: [number, number, number, number] } | null) {
    if (c) {
      const gl = this.gl!;
      this.tex.corr = this.makeTex2D(c.w, c.h, c.values, 1, this.tex.corr);
      this.setParams(gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
    }
    this.corrExt = c ? c.extent : [0, 0, 0, 0];
    this.repaint();
  }

  /** Upload a live model field into slot A or B. */
  setField(slot: 'fieldA' | 'fieldB' | 'alt' | 'orog', grid: GridSpec, values: Float32Array) {
    this.grid = grid;
    this.tex[slot] = this.makeTex2D(grid.nx, grid.ny, values, 1, this.tex[slot]);
    if (slot === 'fieldA') this.hasA = true;
    if (slot === 'fieldB') this.hasB = true;
    this.repaint();
  }

  get ready() {
    return this.mode === 0 ? this.hasA && this.hasB : this.mode === 1 ? this.hasResult : this.hasMatch;
  }

  /** Live fields, one per condition slot (null = computed in the shader, e.g. daylight). */
  setMatchFields(grid: GridSpec, layers: (Float32Array | null)[]) {
    this.grid = grid;
    const n = Math.max(1, layers.length);
    const size = grid.nx * grid.ny;
    const data = new Float32Array(size * n);
    layers.forEach((l, i) => l && data.set(l, i * size));
    this.tex.mfields = this.makeArrayR(grid.nx, grid.ny, n, data, this.tex.mfields);
    this.hasMatch = true;
    this.repaint();
  }

  /** Per slot: [lo, hi, softness, kind]; ±Infinity bounds are open. Cheap: uniforms only. */
  setMatchRanges(ranges: [number, number, number, number][], doy: number) {
    this.mcount = Math.min(10, ranges.length);
    this.mranges.fill(0);
    ranges.slice(0, 10).forEach(([lo, hi, soft, kind], i) => {
      this.mranges.set([Number.isFinite(lo) ? lo : -1e9, Number.isFinite(hi) ? hi : 1e9, soft, kind], i * 4);
    });
    this.mdoy = doy;
    this.repaint();
  }

  setClimateGrid(spec: ClimateGridSpec, cellElevPremult: Float32Array) {
    this.cgrid = spec;
    this.tex.cellElev = this.makeTex2D(spec.nx, spec.ny, cellElevPremult, 2, this.tex.cellElev);
  }

  /** RG pairs (value*valid, valid), layer-major: [group][level][row][col]; groups = 1, or 5 (year + 4 seasons). */
  setClimateResult(data: Float32Array, groups = 1) {
    const c = this.cgrid!;
    this.groups = groups;
    this.tex.result = this.makeArray(c.nx, c.ny, c.levels * groups, data, this.tex.result);
    this.hasResult = true;
    this.repaint();
  }

  /** Microclimate offsets for the viewport (climate/micro.ts), or null. */
  setMicro(m: { width: number; height: number; data: Int8Array; extent: [number, number, number, number] } | null, scale = 0.1) {
    const gl = this.gl;
    if (!gl) return;
    if (m) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.micro!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8_SNORM, m.width, m.height, 3, 0, gl.RGBA, gl.BYTE, m.data);
      this.setParams(gl.TEXTURE_2D_ARRAY, gl.CLAMP_TO_EDGE);
      this.microExt = m.extent;
      this.microScale = 127 * scale;
    } else this.microExt = [0, 0, 0, 0];
    this.repaint();
  }

  repaint() {
    this.map?.triggerRepaint();
  }

  /** Animate the fade multiplier; resolves when finished (or superseded). */
  fadeTo(target: number, ms = 220): Promise<void> {
    cancelAnimationFrame(this.fadeRaf);
    this.fadeDone?.();
    const from = this.fade;
    if (Math.abs(from - target) < 1e-3 || ms <= 0) {
      this.fade = target;
      this.repaint();
      return Promise.resolve();
    }
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.fadeDone = resolve;
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = k * k * (3 - 2 * k);
        this.fade = from + (target - from) * e;
        this.repaint();
        if (k < 1) this.fadeRaf = requestAnimationFrame(step);
        else {
          this.fadeDone = undefined;
          resolve();
        }
      };
      this.fadeRaf = requestAnimationFrame(step);
    });
  }

  // ---------- rendering ----------
  private program(sd: CustomRenderMethodInput['shaderData']): Program {
    let p = this.programs.get(sd.variantName);
    if (p) return p;
    const gl = this.gl!;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert(sd.vertexShaderPrelude, sd.define)));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
    const u: Program['u'] = {};
    for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
    p = { prog, u, aPos: gl.getAttribLocation(prog, 'a_pos') };
    this.programs.set(sd.variantName, p);
    return p;
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.ready || this.opacity * this.fade <= 0.001) return;
    const gl = this.gl!;
    const p = this.program(args.shaderData);
    gl.useProgram(p.prog);
    const pd = args.defaultProjectionData;
    gl.uniformMatrix4fv(p.u.u_projection_matrix, false, pd.mainMatrix as Float32Array);
    gl.uniform4f(p.u.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
    gl.uniform4f(p.u.u_projection_clipping_plane, ...pd.clippingPlane);
    gl.uniform1f(p.u.u_projection_transition, pd.projectionTransition);
    gl.uniformMatrix4fv(p.u.u_projection_fallback_matrix, false, pd.fallbackMatrix as Float32Array);

    const bind = (unit: number, name: string, target: number, uni: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, this.tex[name]!);
      gl.uniform1i(p.u[uni], unit);
    };
    bind(0, 'fieldA', gl.TEXTURE_2D, 'u_fieldA');
    bind(1, 'fieldB', gl.TEXTURE_2D, 'u_fieldB');
    bind(2, 'alt', gl.TEXTURE_2D, 'u_alt');
    bind(3, 'orog', gl.TEXTURE_2D, 'u_orog');
    bind(4, 'dem', gl.TEXTURE_2D, 'u_dem');
    bind(5, 'palette', gl.TEXTURE_2D, 'u_palette');
    bind(6, 'result', gl.TEXTURE_2D_ARRAY, 'u_result');
    bind(7, 'cellElev', gl.TEXTURE_2D, 'u_cellElev');
    bind(8, 'ldem', gl.TEXTURE_2D, 'u_ldem');
    bind(9, 'mfields', gl.TEXTURE_2D_ARRAY, 'u_mfields');
    bind(10, 'reg0', gl.TEXTURE_2D, 'u_reg0');
    bind(11, 'reg1', gl.TEXTURE_2D, 'u_reg1');
    if (this.waterOnly) {
      // copy what the map has drawn so far (background and opaque water)
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.under!);
      if (this.underSize[0] !== w || this.underSize[1] !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
        this.setParams(gl.TEXTURE_2D, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.underSize = [w, h];
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    }
    bind(12, 'under', gl.TEXTURE_2D, 'u_under');
    bind(13, 'micro', gl.TEXTURE_2D_ARRAY, 'u_micro');
    bind(14, 'corr', gl.TEXTURE_2D, 'u_corr');
    gl.uniform4f(p.u.u_corrExt, ...(this.mode === 0 ? this.corrExt : ([0, 0, 0, 0] as [number, number, number, number])));
    gl.uniform4f(p.u.u_microExt, ...this.microExt);
    gl.uniform1f(p.u.u_microScale, this.microScale);
    gl.uniform1i(p.u.u_microVar, this.mode === 1 ? this.microVar : 0);
    gl.uniform1fv(p.u.u_microW, this.microW);
    gl.uniform1fv(p.u.u_microSeasonW, this.microSeasonW);
    gl.uniform1i(p.u.u_groups, this.groups);
    const wm = this.waterOnly;
    gl.uniform4f(p.u.u_waterMask, wm?.[0] ?? 0, wm?.[1] ?? 0, wm?.[2] ?? 0, wm ? 1 : 0);
    const rc = new Float32Array(8), rg = new Float32Array(8);
    this.reg.forEach((g, i) => {
      if (!g || this.mode !== 0) return;
      rc.set([g.n, g.k, g.lov, 1], i * 4);
      rg.set([g.x1, g.y1, g.dx, g.dy], i * 4);
    });
    gl.uniform4fv(p.u.u_rcone, rc);
    gl.uniform4fv(p.u.u_rgrid, rg);
    gl.uniform1i(p.u.u_mcount, this.mcount);
    gl.uniform4fv(p.u.u_mrange, this.mranges);
    gl.uniform1f(p.u.u_mdoy, this.mdoy);
    gl.uniform4f(p.u.u_ldemExt, ...this.ldemExt);

    gl.uniform1i(p.u.u_mode, this.mode);
    const g = this.grid ?? { nx: 1, ny: 1, lon0: 0, lat0: 0, dx: 1, dy: 1 };
    gl.uniform4f(p.u.u_grid, g.lon0, g.lat0, g.dx, g.dy);
    gl.uniform2f(p.u.u_gridSize, g.nx, g.ny);
    const c = this.cgrid ?? { nx: 1, ny: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, levels: 1, dz0: 0, dzStep: 1 };
    gl.uniform4f(p.u.u_cgrid, c.lon0, c.lat0, c.dx, c.dy);
    gl.uniform2f(p.u.u_cgridSize, c.nx, c.ny);
    gl.uniform3f(p.u.u_levels, c.levels, c.dz0, c.dzStep);
    gl.uniform1f(p.u.u_mix, this.mix);
    gl.uniform2f(p.u.u_domain, this.paletteDomain[0], this.paletteDomain[1]);
    gl.uniform1i(p.u.u_log, this.paletteLog ? 1 : 0);
    gl.uniform1f(p.u.u_lapse, this.lapse);
    gl.uniform1f(p.u.u_snowH, this.mode === 0 ? this.snowH : 0);
    gl.uniform1f(p.u.u_useAlt, this.useAlt);
    gl.uniform1f(p.u.u_opacity, this.opacity * this.fade);
    gl.uniform1f(p.u.u_cut, this.mode === 1 ? this.cut : 0);
    gl.uniform1f(p.u.u_csqrt, this.climateSqrt ? 1 : 0);

    if (!this.vao) {
      this.vao = gl.createVertexArray()!;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo!);
      gl.enableVertexAttribArray(p.aPos);
      gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo!);
    }
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const globe = this.map!.getProjection()?.type === 'globe';
    let x0 = 0, x1 = 0;
    if (!globe) {
      const b = this.map!.getBounds();
      x0 = Math.floor((b.getWest() + 180) / 360);
      x1 = Math.floor((b.getEast() + 180) / 360);
    }
    for (let o = x0; o <= x1; o++) {
      gl.uniform1f(p.u.u_offset, o);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }
}
