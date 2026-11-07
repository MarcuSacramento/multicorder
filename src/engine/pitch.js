// Afinador (RF-35): detecção de frequência por YIN e conversão para nota + cents. Puro, sem navegador.

export const NOTE_NAMES = ['Dó', 'Dó♯', 'Ré', 'Ré♯', 'Mi', 'Fá', 'Fá♯', 'Sol', 'Sol♯', 'Lá', 'Lá♯', 'Si'];
export const NOTE_LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/**
 * Frequência fundamental de um trecho de áudio (YIN, de Cheveigné & Kawahara).
 * Devolve { freq, clarity } (clarity 0..1, quanto mais perto de 1 mais "afinável") ou null
 * em silêncio / som sem altura definida. Faixa: `minHz`–`maxHz` (padrão 38–1400 Hz: do mi grave do baixo ao agudo da voz).
 */
export function detectPitch(buf, sampleRate, { minHz = 38, maxHz = 1400, threshold = 0.15, minRms = 0.003 } = {}) {
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(buf.length / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const W = buf.length - maxLag;
  if (W < 64 || maxLag <= minLag) return null;

  let e = 0;
  for (let i = 0; i < W; i++) e += buf[i] * buf[i];
  if (Math.sqrt(e / W) < minRms) return null;

  // Diferença quadrática média normalizada (d'), calculada só até maxLag.
  const d = new Float32Array(maxLag + 1);
  d[0] = 1;
  let sum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = buf[i] - buf[i + tau];
      s += x * x;
    }
    sum += s;
    d[tau] = sum > 0 ? (s * tau) / sum : 1;
  }

  // 1º mínimo abaixo do limiar (evita oitava abaixo); sem nenhum, o menor valor global.
  let tau = -1;
  for (let t = minLag; t < maxLag; t++) {
    if (d[t] < threshold) {
      while (t + 1 < maxLag && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = minLag;
    for (let t = minLag; t < maxLag; t++) if (d[t] < d[best]) best = t;
    if (d[best] > 0.35) return null; // ruído, percussão ou várias notas juntas
    tau = best;
  }

  // Interpolação parabólica entre os vizinhos para precisão abaixo de uma amostra.
  let t = tau;
  if (tau > 1 && tau < maxLag) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a - 2 * b + c;
    if (den > 0) t = tau + (a - c) / (2 * den);
  }
  return { freq: sampleRate / t, clarity: Math.max(0, Math.min(1, 1 - d[tau])) };
}

/** Nota mais próxima de `freq`, com o desvio em cents (−50..+50). `a4` = referência do Lá (Hz). */
export function noteFromFreq(freq, a4 = 440) {
  const midi = 69 + 12 * Math.log2(freq / a4);
  const n = Math.round(midi);
  const cents = (midi - n) * 100;
  const pc = ((n % 12) + 12) % 12;
  return {
    midi: n,
    name: NOTE_NAMES[pc],
    letter: NOTE_LETTERS[pc],
    octave: Math.floor(n / 12) - 1,
    cents,
    target: a4 * Math.pow(2, (n - 69) / 12),
  };
}

/**
 * Suaviza a leitura: mediana das últimas leituras próximas (descarta saltos isolados, como
 * a oitava errada num ataque). Guarde o objeto `state` entre chamadas.
 */
export function smoothPitch(state, reading, keep = 5) {
  const now = reading ? reading.freq : null;
  state.hist ??= [];
  if (now == null) {
    state.miss = (state.miss || 0) + 1;
    if (state.miss > 6) state.hist = [];
    return state.hist.length ? median(state.hist) : null;
  }
  state.miss = 0;
  const last = state.hist.length ? median(state.hist) : null;
  // Mudou de nota (mais de ~1 semitom): recomeça o histórico para responder na hora.
  if (last && Math.abs(12 * Math.log2(now / last)) > 0.8) state.hist = [];
  state.hist.push(now);
  if (state.hist.length > keep) state.hist.shift();
  return median(state.hist);
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
