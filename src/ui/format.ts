const DAY = 86400_000;

export function timeLabel(t: number, now = Date.now()): string {
  if (Math.abs(t - now) < 30 * 60_000) return 'Now';
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dd = new Date(t);
  dd.setHours(0, 0, 0, 0);
  const diff = Math.round((dd.getTime() - today.getTime()) / DAY);
  const hour = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `${day} ${hour}`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function doyToDate(doy: number): { month: number; day: number } {
  let m = 11;
  while (m > 0 && doy < MONTH_START[m]) m--;
  return { month: m, day: doy - MONTH_START[m] + 1 };
}

export function doyLabel(doy: number, long = false): string {
  const { month, day } = doyToDate(doy);
  const d = new Date(2001, month, day);
  return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', day: 'numeric' });
}

export function todayDoy(): number {
  const now = new Date();
  const m = now.getMonth();
  return Math.min(364, MONTH_START[m] + now.getDate() - 1);
}

export { MONTH_START };

export function coordLabel(lon: number, lat: number) {
  const ns = lat >= 0 ? 'N' : 'S';
  let l = ((lon + 540) % 360) - 180;
  const ew = l >= 0 ? 'E' : 'W';
  l = Math.abs(l);
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${l.toFixed(2)}°${ew}`;
}
