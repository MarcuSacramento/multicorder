// Impulse responses geradas no app (RF-31). Determinísticas: prévia e exportação soam iguais.
import { mulberry32 } from './util.js';

const PRESETS = {
  small: { dur: 0.5, decay: 4.0, damp: 0.45, seed: 11 },
  room: { dur: 1.1, decay: 3.2, damp: 0.35, seed: 23 },
  hall: { dur: 2.8, decay: 2.4, damp: 0.25, seed: 37 },
  plate: { dur: 1.8, decay: 2.8, damp: 0.05, seed: 53 },
};

const cache = new WeakMap(); // BaseAudioContext → Map(type → AudioBuffer)

export function getImpulse(ctx, type) {
  let m = cache.get(ctx);
  if (!m) { m = new Map(); cache.set(ctx, m); }
  if (!m.has(type)) m.set(type, makeImpulse(ctx, type));
  return m.get(type);
}

function makeImpulse(ctx, type) {
  const p = PRESETS[type] || PRESETS.room;
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(p.dur * sr));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = mulberry32(p.seed * 7 + ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, p.decay);
      const a = p.damp + (0.92 - p.damp) * t; // fica mais escuro com o tempo
      lp = a * lp + (1 - a) * (rnd() * 2 - 1);
      d[i] = lp * env;
    }
    // Reflexões iniciais
    for (let r = 0; r < 8; r++) {
      const pos = Math.floor((0.004 + rnd() * 0.07) * sr);
      if (pos < len) d[pos] += (rnd() * 2 - 1) * 0.6 * (1 - r / 8);
    }
  }
  return buf;
}
