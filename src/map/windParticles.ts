/**
 * Animated wind streaks (GPU particle advection with fading trails), drawn as a
 * MapLibre custom layer on top of the wind-speed field. Mercator only.
 *
 * Particle positions live in a float texture (mercator coordinates). Each frame:
 *  1. update pass: advect particles through the wind texture, respawn some
 *     randomly inside the viewport;
 *  2. trail pass: fade the previous trail image and draw particles as points;
 *  3. composite the trail image over the map.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import type { GridSpec } from './fieldLayer';

type GL = WebGL2RenderingContext;
const RES = 120; // RES*RES particles

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos; gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`;

const UPDATE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outPos;
uniform sampler2D u_state;
uniform sampler2D u_windA;
uniform sampler2D u_windB;
uniform float u_mix;
uniform vec4 u_grid;     // lon0, lat0, dx, dy
uniform vec2 u_gridSize;
uniform vec4 u_view;     // mercator x0, y0, x1, y1 of the viewport
uniform float u_speed;   // mercator units per (m/s) per frame
uniform float u_seed;
uniform float u_drop;
const float PI = 3.141592653589793;
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 wind(vec2 m) {
  float lon = fract(m.x) * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * m.y))));
  vec2 uv = vec2((lon - u_grid.x) / u_grid.z + 0.5, (u_grid.y - lat) / u_grid.w + 0.5) / u_gridSize;
  return mix(texture(u_windA, uv).rg, texture(u_windB, uv).rg, u_mix);
}
void main() {
  vec4 s = texture(u_state, v_uv);
  vec2 p = s.xy;
  vec2 w = wind(p);
  p += vec2(w.x, -w.y) * u_speed;
  float age = s.z + 1.0;
  vec2 seed = (v_uv + u_seed) * 13.7;
  bool outside = p.x < u_view.x || p.x > u_view.z || p.y < u_view.y || p.y > u_view.w;
  float drop = u_drop + length(w) * 0.0004;
  if (outside || rand(seed) < drop || s.w < 0.5) {
    p = u_view.xy + vec2(rand(seed + 1.3), rand(seed + 2.1)) * (u_view.zw - u_view.xy);
    age = 0.0;
  }
  outPos = vec4(p, age, 1.0);
}`;

const DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform sampler2D u_windA;
uniform mat4 u_matrix;
uniform float u_res;
uniform float u_size;
uniform vec4 u_grid;
uniform vec2 u_gridSize;
out float v_speed;
out float v_age;
const float PI = 3.141592653589793;
void main() {
  int id = gl_VertexID;
  vec2 uv = (vec2(float(id % int(u_res)), float(id / int(u_res))) + 0.5) / u_res;
  vec4 s = texture(u_state, uv);
  float lon = fract(s.x) * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * s.y))));
  vec2 guv = vec2((lon - u_grid.x) / u_grid.z + 0.5, (u_grid.y - lat) / u_grid.w + 0.5) / u_gridSize;
  v_speed = length(texture(u_windA, guv).rg);
  v_age = s.z;
  gl_PointSize = u_size;
  gl_Position = u_matrix * vec4(s.xy, 0.0, 1.0);
}`;

const DRAW_FS = `#version 300 es
precision highp float;
in float v_speed;
in float v_age;
out vec4 color;
void main() {
  float a = clamp(0.18 + v_speed / 22.0, 0.18, 0.8) * smoothstep(0.0, 6.0, v_age);
  color = vec4(a, a, a, a);
}`;

const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 color;
uniform sampler2D u_tex;
uniform float u_fade;
void main() { color = texture(u_tex, v_uv) * u_fade; }`;

export class WindParticles implements CustomLayerInterface {
  id: string;
  type = 'custom' as const;
  renderingMode = '2d' as const;
  enabled = false;

  private map?: MlMap;
  private gl?: GL;
  private ok = false;
  private progs: Record<string, { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }> = {};
  private quad?: WebGLBuffer;
  private quadVao?: WebGLVertexArrayObject;
  private emptyVao?: WebGLVertexArrayObject;
  private state: WebGLTexture[] = [];
  private stateFb: WebGLFramebuffer[] = [];
  private trail: WebGLTexture[] = [];
  private trailFb: WebGLFramebuffer[] = [];
  private trailSize = [0, 0];
  private windA?: WebGLTexture;
  private windB?: WebGLTexture;
  private grid?: GridSpec;
  mix = 0;
  private moving = false;
  private needsReset = true;
  private frame = 0;
  private raf = 0;

  constructor(id: string) {
    this.id = id;
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl as GL;
    const g = this.gl;
    // float render targets are needed for particle state
    this.ok = !!g.getExtension('EXT_color_buffer_float');
    if (!this.ok) return;
    const mk = (vs: string, fs: string, names: string[]) => {
      const c = (t: number, s: string) => {
        const sh = g.createShader(t)!;
        g.shaderSource(sh, s);
        g.compileShader(sh);
        if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(sh) || '');
        return sh;
      };
      const p = g.createProgram()!;
      g.attachShader(p, c(g.VERTEX_SHADER, vs));
      g.attachShader(p, c(g.FRAGMENT_SHADER, fs));
      g.bindAttribLocation(p, 0, 'a_pos');
      g.linkProgram(p);
      if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || '');
      const u: Record<string, WebGLUniformLocation | null> = {};
      for (const n of names) u[n] = g.getUniformLocation(p, n);
      return { p, u };
    };
    this.progs.update = mk(QUAD_VS, UPDATE_FS, ['u_state', 'u_windA', 'u_windB', 'u_mix', 'u_grid', 'u_gridSize', 'u_view', 'u_speed', 'u_seed', 'u_drop']);
    this.progs.draw = mk(DRAW_VS, DRAW_FS, ['u_state', 'u_windA', 'u_matrix', 'u_res', 'u_size', 'u_grid', 'u_gridSize']);
    this.progs.fade = mk(QUAD_VS, FADE_FS, ['u_tex', 'u_fade']);
    this.quad = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, this.quad);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), g.STATIC_DRAW);
    this.quadVao = g.createVertexArray()!;
    g.bindVertexArray(this.quadVao);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    this.emptyVao = g.createVertexArray()!;
    g.bindVertexArray(null);
    for (let i = 0; i < 2; i++) {
      const t = g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, t);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, RES, RES, 0, g.RGBA, g.FLOAT, null);
      this.nearest();
      const fb = g.createFramebuffer()!;
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0);
      this.state.push(t);
      this.stateFb.push(fb);
    }
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    const reset = () => {
      this.moving = true;
      this.needsReset = true;
    };
    map.on('movestart', reset);
    map.on('moveend', () => {
      this.moving = false;
      this.needsReset = true;
      this.kick();
    });
    map.on('resize', reset);
  }

  private nearest() {
    const g = this.gl!;
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  }

  /** u/v (m/s) for two time steps. */
  setWind(grid: GridSpec, a: { u: Float32Array; v: Float32Array }, b: { u: Float32Array; v: Float32Array }) {
    if (!this.ok) return;
    const g = this.gl!;
    this.grid = grid;
    const up = (src: { u: Float32Array; v: Float32Array }, tex?: WebGLTexture) => {
      const n = src.u.length;
      const rg = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        rg[i * 2] = src.u[i];
        rg[i * 2 + 1] = src.v[i];
      }
      const t = tex ?? g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, t);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      g.texImage2D(g.TEXTURE_2D, 0, g.RG16F, grid.nx, grid.ny, 0, g.RG, g.FLOAT, rg);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      return t;
    };
    this.windA = up(a, this.windA);
    this.windB = up(b, this.windB);
  }

  setEnabled(on: boolean) {
    this.enabled = on && this.ok;
    this.needsReset = true;
    if (this.enabled) this.kick();
    this.map?.triggerRepaint();
  }

  /** keep animating at ~30 fps while enabled */
  private kick() {
    if (this.raf || !this.enabled) return;
    const loop = () => {
      this.raf = 0;
      if (!this.enabled) return;
      this.map?.triggerRepaint();
      this.raf = window.setTimeout(() => requestAnimationFrame(loop), 30) as unknown as number;
    };
    this.raf = requestAnimationFrame(loop);
  }

  private ensureTrail() {
    const g = this.gl!;
    const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
    if (this.trailSize[0] === w && this.trailSize[1] === h) return;
    for (const t of this.trail) g.deleteTexture(t);
    for (const f of this.trailFb) g.deleteFramebuffer(f);
    this.trail = [];
    this.trailFb = [];
    for (let i = 0; i < 2; i++) {
      const t = g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, t);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
      this.nearest();
      const fb = g.createFramebuffer()!;
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0);
      this.trail.push(t);
      this.trailFb.push(fb);
    }
    this.trailSize = [w, h];
    this.needsReset = true;
  }

  private viewExtent(): [number, number, number, number] {
    const b = this.map!.getBounds();
    const mx = (lon: number) => (lon + 180) / 360;
    const my = (lat: number) => {
      const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    return [mx(b.getWest()), my(b.getNorth()), mx(b.getEast()), my(b.getSouth())];
  }

  prerender(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.enabled || !this.windA || this.moving || this.map!.getProjection()?.type === 'globe') return;
    const g = this.gl!;
    this.ensureTrail();
    const view = this.viewExtent();
    g.disable(g.DEPTH_TEST);
    g.disable(g.STENCIL_TEST);
    g.disable(g.CULL_FACE);
    g.disable(g.SCISSOR_TEST);
    g.colorMask(true, true, true, true);
    if (this.needsReset) {
      for (const fb of this.trailFb) {
        g.bindFramebuffer(g.FRAMEBUFFER, fb);
        g.clearColor(0, 0, 0, 0);
        g.clear(g.COLOR_BUFFER_BIT);
      }
      for (const fb of this.stateFb) {
        g.bindFramebuffer(g.FRAMEBUFFER, fb);
        g.clearColor(0, 0, 0, 0); // w = 0 -> respawn on first update
        g.clear(g.COLOR_BUFFER_BIT);
      }
      this.needsReset = false;
    }
    const grid = this.grid!;
    const zoom = this.map!.getZoom();
    const worldPx = 512 * 2 ** zoom * (window.devicePixelRatio || 1);
    // 1. update
    const up = this.progs.update;
    g.useProgram(up.p);
    g.bindFramebuffer(g.FRAMEBUFFER, this.stateFb[1]);
    g.viewport(0, 0, RES, RES);
    g.disable(g.BLEND);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.state[0]);
    g.uniform1i(up.u.u_state, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, this.windA);
    g.uniform1i(up.u.u_windA, 1);
    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, this.windB!);
    g.uniform1i(up.u.u_windB, 2);
    g.uniform1f(up.u.u_mix, this.mix);
    g.uniform4f(up.u.u_grid, grid.lon0, grid.lat0, grid.dx, grid.dy);
    g.uniform2f(up.u.u_gridSize, grid.nx, grid.ny);
    g.uniform4f(up.u.u_view, ...view);
    g.uniform1f(up.u.u_speed, (0.22 * (window.devicePixelRatio || 1)) / worldPx);
    g.uniform1f(up.u.u_seed, Math.random());
    g.uniform1f(up.u.u_drop, 0.004);
    g.bindVertexArray(this.quadVao!);
    g.drawArrays(g.TRIANGLES, 0, 6);
    [this.state[0], this.state[1]] = [this.state[1], this.state[0]];
    [this.stateFb[0], this.stateFb[1]] = [this.stateFb[1], this.stateFb[0]];
    // 2. trail: fade previous into the other buffer, then draw points
    const [w, h] = this.trailSize;
    g.bindFramebuffer(g.FRAMEBUFFER, this.trailFb[1]);
    g.viewport(0, 0, w, h);
    const fade = this.progs.fade;
    g.useProgram(fade.p);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.trail[0]);
    g.uniform1i(fade.u.u_tex, 0);
    g.uniform1f(fade.u.u_fade, 0.9);
    g.drawArrays(g.TRIANGLES, 0, 6);
    const dr = this.progs.draw;
    g.useProgram(dr.p);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.state[0]);
    g.uniform1i(dr.u.u_state, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, this.windA);
    g.uniform1i(dr.u.u_windA, 1);
    g.uniformMatrix4fv(dr.u.u_matrix, false, args.defaultProjectionData.mainMatrix as Float32Array);
    g.uniform1f(dr.u.u_res, RES);
    g.uniform1f(dr.u.u_size, 1.3 * (window.devicePixelRatio || 1));
    g.uniform4f(dr.u.u_grid, grid.lon0, grid.lat0, grid.dx, grid.dy);
    g.uniform2f(dr.u.u_gridSize, grid.nx, grid.ny);
    g.bindVertexArray(this.emptyVao!);
    g.drawArrays(g.POINTS, 0, RES * RES);
    [this.trail[0], this.trail[1]] = [this.trail[1], this.trail[0]];
    [this.trailFb[0], this.trailFb[1]] = [this.trailFb[1], this.trailFb[0]];
    g.bindVertexArray(null);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, g.drawingBufferWidth, g.drawingBufferHeight);
    this.frame++;
  }

  render() {
    if (!this.enabled || !this.windA || this.moving || this.map!.getProjection()?.type === 'globe' || !this.trail.length) return;
    const g = this.gl!;
    const fade = this.progs.fade;
    g.useProgram(fade.p);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.DEPTH_TEST);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, this.trail[0]);
    g.uniform1i(fade.u.u_tex, 0);
    g.uniform1f(fade.u.u_fade, 0.9);
    g.bindVertexArray(this.quadVao!);
    g.drawArrays(g.TRIANGLES, 0, 6);
    g.bindVertexArray(null);
  }
}
