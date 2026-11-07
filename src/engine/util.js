// Utilitários puros, sem dependência de navegador.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** dB → ganho linear. Faders: -60 dB ou menos é tratado como −∞ (silêncio). */
export const faderGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 1e-9 ? -Infinity : 20 * Math.log10(g));

export const uid = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtTime(s) {
  if (!Number.isFinite(s)) s = 0;
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${sign}${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function fmtDb(db) {
  if (!Number.isFinite(db) || db <= -60) return '−∞';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** PRNG determinístico (as impulse responses saem idênticas na prévia e na exportação). */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
