// RNF-02: calibração da latência de ida e volta por loopback (clique na saída → entrada).
import { median, sleep } from './util.js';

/**
 * Toca N cliques, grava a entrada e mede o atraso até o início de cada clique.
 * Devolve a mediana e a dispersão (repetibilidade).
 */
export async function calibrateLatency(engine, { clicks = 8, spacing = 0.4 } = {}) {
  await engine.resume();
  if (!engine.inputOpen) throw new Error('Abra a entrada de áudio antes de calibrar.');
  const sr = engine.sampleRate;
  const parts = [];
  let first = null;
  engine.startCapture((m) => {
    if (m.type !== 'data') return;
    if (first === null) first = m.frame;
    parts.push(m.data);
  });
  const t0 = engine.now + 0.6;
  const times = Array.from({ length: clicks }, (_, i) => t0 + i * spacing);
  engine.playClicks(times);
  await sleep((t0 - engine.now + clicks * spacing + 0.6) * 1000);
  await engine.stopCapture();
  if (first === null) throw new Error('Nenhum áudio foi capturado.');

  const total = parts.reduce((s, p) => s + p.length / 2, 0);
  const mono = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) mono[o++] = Math.max(Math.abs(p[i]), Math.abs(p[i + 1]));
  }

  const results = [];
  for (const tc of times) {
    const c = Math.round(tc * sr) - first;
    const pre0 = Math.max(0, c - Math.floor(0.08 * sr));
    const end = Math.min(total, c + Math.floor(0.3 * sr));
    if (c <= 0 || end <= c) continue;
    let noise = 0;
    for (let i = pre0; i < c; i++) noise = Math.max(noise, mono[i]);
    let peak = 0;
    for (let i = c; i < end; i++) peak = Math.max(peak, mono[i]);
    if (peak < 0.02 || peak < noise * 3) continue;
    const thr = Math.max(noise * 2, peak * 0.3);
    for (let i = c; i < end; i++) {
      if (mono[i] >= thr) { results.push(((i - c) / sr) * 1000); break; }
    }
  }
  if (results.length < Math.ceil(clicks / 2)) {
    throw new Error('Os cliques não foram detectados. Aproxime o fone do microfone (ou ligue a saída na entrada com um cabo) e aumente o volume.');
  }
  const med = median(results);
  const inliers = results.filter((r) => Math.abs(r - med) < 10);
  return {
    latencyMs: median(inliers),
    spreadMs: Math.max(...inliers) - Math.min(...inliers),
    detected: results.length,
    total: clicks,
  };
}
