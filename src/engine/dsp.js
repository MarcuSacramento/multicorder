// Ponte para o dsp-worker.js: processa os lados de um áudio fora da tela e devolve uma Promise.

let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data);
  };
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'Falha no processamento do som'));
    waiting.clear();
    worker = null;
  };
  return worker;
}

/** Há algo para processar? */
export function cleanActive(c) {
  if (!c) return false;
  return !!(c.denoise?.on || c.declick?.on || c.deplosive?.on || c.strip?.on || c.pitch?.semis || c.pitch?.cents);
}

/** Chave das opções que mudam o som (para saber quando processar de novo). */
export const cleanKey = (c) => (cleanActive(c) ? JSON.stringify(c) : '');

/** Processa os lados (Float32Array; são transferidos). Devolve { chans, info }. */
export function processAudio(chans, sr, clean) {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, chans, sr, clean }, chans.map((x) => x.buffer));
  });
}
