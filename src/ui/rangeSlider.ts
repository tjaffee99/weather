/**
 * Dual-thumb range slider. Two native range inputs provide the visuals and
 * keyboard access; pointer input is handled here so the thumbs can always be
 * pulled apart: the thumb nearest the pointer moves, and when both sit on the
 * same spot the drag direction decides (left = lower bound, right = upper).
 */
import { h } from './dom';

export interface RangeSliderOpts {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onInput: (v: [number, number]) => void;
  onChange?: (v: [number, number]) => void;
  label?: string;
}

type Thumb = 'a' | 'b';
const THUMB = 18; // px, must match the CSS thumb size

export class RangeSlider {
  el: HTMLDivElement;
  private a: HTMLInputElement;
  private b: HTMLInputElement;
  private fill: HTMLDivElement;
  private opts: RangeSliderOpts;
  private drag: { which: Thumb | null; startX: number; moved: boolean } | null = null;

  constructor(opts: RangeSliderOpts) {
    this.opts = opts;
    const mk = (v: number, which: string) =>
      h('input', {
        type: 'range',
        min: opts.min,
        max: opts.max,
        step: opts.step,
        value: v,
        'aria-label': `${opts.label ?? ''} ${which}`,
      });
    this.a = mk(opts.value[0], 'minimum');
    this.b = mk(opts.value[1], 'maximum');
    this.fill = h('div', { class: 'rs-fill' });
    this.el = h('div', { class: 'rs' }, h('div', { class: 'rs-track' }), this.fill, this.a, this.b);

    // keyboard (and assistive tech) changes come through the native inputs
    const handler = (final: boolean) => (e: Event) => {
      let lo = +this.a.value, hi = +this.b.value;
      if (lo > hi) {
        if (e.target === this.a) this.a.value = String((lo = hi));
        else this.b.value = String((hi = lo));
      }
      this.raise(e.target === this.a ? 'a' : 'b');
      this.paint();
      (final ? opts.onChange ?? opts.onInput : opts.onInput)([lo, hi]);
    };
    for (const inp of [this.a, this.b]) {
      inp.addEventListener('input', handler(false));
      inp.addEventListener('change', handler(true));
    }

    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    this.paint();
  }

  get value(): [number, number] {
    return [+this.a.value, +this.b.value];
  }

  set value(v: [number, number]) {
    this.a.value = String(v[0]);
    this.b.value = String(v[1]);
    this.paint();
  }

  setRange(min: number, max: number, step: number) {
    for (const i of [this.a, this.b]) {
      i.min = String(min);
      i.max = String(max);
      i.step = String(step);
    }
    this.opts.min = min;
    this.opts.max = max;
    this.opts.step = step;
    this.paint();
  }

  /** Slider value under a client x coordinate (thumb centres travel inset by half a thumb). */
  private valueAt(x: number): number {
    const r = this.el.getBoundingClientRect();
    const { min, max, step } = this.opts;
    const t = Math.min(1, Math.max(0, (x - r.left - THUMB / 2) / Math.max(1, r.width - THUMB)));
    const v = min + t * (max - min);
    return Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const v = this.valueAt(e.clientX);
    const va = +this.a.value, vb = +this.b.value;
    let which: Thumb | null;
    if (va === vb) which = v < va ? 'a' : v > vb ? 'b' : null; // stacked: decide on the first move
    else {
      const da = Math.abs(v - va), db = Math.abs(v - vb);
      which = da < db ? 'a' : db < da ? 'b' : v < va ? 'a' : 'b';
    }
    this.drag = { which, startX: e.clientX, moved: false };
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('dragging');
    e.preventDefault();
    if (which) {
      (which === 'a' ? this.a : this.b).focus({ preventScroll: true });
      this.moveTo(which, v);
    }
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.which) {
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) < 3) return;
      d.which = dx < 0 ? 'a' : 'b';
      (d.which === 'a' ? this.a : this.b).focus({ preventScroll: true });
    }
    this.moveTo(d.which, this.valueAt(e.clientX));
  }

  private onUp(e: PointerEvent) {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    this.el.classList.remove('dragging');
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (moved) (this.opts.onChange ?? this.opts.onInput)(this.value);
  }

  private moveTo(which: Thumb, v: number) {
    const va = +this.a.value, vb = +this.b.value;
    const inp = which === 'a' ? this.a : this.b;
    const next = which === 'a' ? Math.min(v, vb) : Math.max(v, va);
    this.raise(which);
    if (+inp.value === next) return;
    inp.value = String(next);
    if (this.drag) this.drag.moved = true;
    this.paint();
    this.opts.onInput(this.value);
  }

  /** The thumb last touched is drawn on top. */
  private raise(which: Thumb) {
    this.a.style.zIndex = which === 'a' ? '3' : '2';
    this.b.style.zIndex = which === 'b' ? '3' : '2';
  }

  private paint() {
    const { min, max } = this.opts;
    const t = (v: number) => (v - min) / (max - min || 1);
    const lo = t(+this.a.value), hi = t(+this.b.value);
    // match the native thumb travel (inset by half a thumb on each side)
    const x = (f: number) => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${f})`;
    this.fill.style.left = x(lo);
    this.fill.style.width = `calc((100% - ${THUMB}px) * ${hi - lo})`;
  }
}
