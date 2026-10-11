/** Accessible dual-thumb range slider built from two native range inputs. */
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

export class RangeSlider {
  el: HTMLDivElement;
  private a: HTMLInputElement;
  private b: HTMLInputElement;
  private fill: HTMLDivElement;
  private opts: RangeSliderOpts;

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
    const handler = (final: boolean) => (e: Event) => {
      let lo = +this.a.value, hi = +this.b.value;
      if (lo > hi) {
        if (e.target === this.a) this.a.value = String((lo = hi));
        else this.b.value = String((hi = lo));
      }
      this.paint();
      (final ? opts.onChange ?? opts.onInput : opts.onInput)([lo, hi]);
    };
    for (const inp of [this.a, this.b]) {
      inp.addEventListener('input', handler(false));
      inp.addEventListener('change', handler(true));
    }
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
    this.paint();
  }

  private paint() {
    const { min, max } = this.opts;
    const p = (v: number) => ((v - min) / (max - min)) * 100;
    const lo = p(+this.a.value), hi = p(+this.b.value);
    this.fill.style.left = `${lo}%`;
    this.fill.style.width = `${hi - lo}%`;
    // keep the upper thumb reachable when both thumbs sit at the max end
    this.a.style.zIndex = +this.a.value > max - (max - min) * 0.05 ? '3' : '2';
  }
}
