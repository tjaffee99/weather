/** Unit preferences and formatting. All internal values are metric. */
export type UnitSystem = 'metric' | 'imperial';

const KEY = 'wa.units';

function initial(): UnitSystem {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'metric' || v === 'imperial') return v;
  } catch {
    /* storage unavailable */
  }
  const loc = navigator.language || '';
  return /^en-(US|LR)|^my\b/.test(loc) ? 'imperial' : 'metric';
}

let system: UnitSystem = initial();
const listeners = new Set<() => void>();

export const units = {
  get system() {
    return system;
  },
  set(s: UnitSystem) {
    system = s;
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* ignore */
    }
    listeners.forEach((f) => f());
  },
  onChange(f: () => void) {
    listeners.add(f);
  },
  get imperial() {
    return system === 'imperial';
  },
};

export type Quantity = 'temp' | 'speed' | 'precip' | 'snow' | 'percent' | 'hours' | 'rate' | 'none';

/** metric -> display unit */
export function toDisplay(q: Quantity, v: number): number {
  if (!units.imperial) return v;
  switch (q) {
    case 'temp':
      return v * 1.8 + 32;
    case 'speed':
      return v / 1.609344;
    case 'precip':
    case 'rate':
      return v / 25.4;
    case 'snow':
      return v / 2.54;
    default:
      return v;
  }
}

export function fromDisplay(q: Quantity, v: number): number {
  if (!units.imperial) return v;
  switch (q) {
    case 'temp':
      return (v - 32) / 1.8;
    case 'speed':
      return v * 1.609344;
    case 'precip':
    case 'rate':
      return v * 25.4;
    case 'snow':
      return v * 2.54;
    default:
      return v;
  }
}

export function unitLabel(q: Quantity): string {
  const imp = units.imperial;
  switch (q) {
    case 'temp':
      return imp ? '°F' : '°C';
    case 'speed':
      return imp ? 'mph' : 'km/h';
    case 'precip':
      return imp ? 'in' : 'mm';
    case 'rate':
      return imp ? 'in/h' : 'mm/h';
    case 'snow':
      return imp ? 'in' : 'cm';
    case 'percent':
      return '%';
    case 'hours':
      return 'h';
    default:
      return '';
  }
}

export function fmt(q: Quantity, v: number, withUnit = true): string {
  if (!Number.isFinite(v)) return '—';
  const d = toDisplay(q, v);
  let s: string;
  switch (q) {
    case 'temp':
      return `${Math.round(d)}°`;
    case 'precip':
    case 'rate':
      s = units.imperial ? (d < 0.1 ? d.toFixed(2) : d.toFixed(1)) : d < 10 ? (Math.round(d * 10) / 10).toString() : Math.round(d).toString();
      break;
    case 'snow':
      s = d < 10 ? (Math.round(d * 10) / 10).toString() : Math.round(d).toString();
      break;
    case 'hours':
      s = (Math.round(d * 10) / 10).toString();
      break;
    default:
      s = Math.round(d).toString();
  }
  return withUnit ? `${s}${q === 'percent' ? '' : ' '}${unitLabel(q)}` : s;
}
