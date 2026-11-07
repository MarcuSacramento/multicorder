// Exportação: mixagem offline (mesmo grafo da reprodução) + Worker de vídeo.
import { PROCESSORS_URL } from './audio-engine.js';
import { exportSize } from './layout.js';
import { DRUMS_ID } from './drums.js';
import { MixGraph } from './mix-graph.js';
import { avcCodecs, EXPORT_RES, exportBitrate } from './quality.js';
import { projectDuration, takeSpans } from './project.js';
import { encodeWav } from './wav.js';

/** Renderiza o mix num OfflineAudioContext (48 kHz, float 32). Sem metrônomo. */
export async function renderMix(project, buffers, { sampleRate = 48000, onlyChannelId = null, tail = 0, maxSec = Infinity } = {}) {
  const dur = projectDuration(project);
  if (dur <= 0) throw new Error('Não há nada gravado para exportar.');
  const len = Math.ceil(Math.min(dur + tail, maxSec) * sampleRate);
  // O limitador do master começa "fechado" e abafaria a 1ª batida em 0 s: um trecho de silêncio
  // antes deixa ele assentar; esse trecho é descartado no fim.
  const pre = Math.round(0.25 * sampleRate);
  const octx = new OfflineAudioContext(2, len + pre, sampleRate);
  let gate = true;
  try { await octx.audioWorklet.addModule(PROCESSORS_URL); } catch { gate = false; }
  let p = project;
  if (onlyChannelId) {
    p = structuredClone(project);
    for (const c of p.channels) { c.solo = false; c.mute = c.id !== onlyChannelId; }
    if (p.guide) p.guide.mute = true;
    if (p.drums) { p.drums.solo = false; p.drums.mute = onlyChannelId !== DRUMS_ID; }
  } else if (project.guide && project.guide.includeInExport === false) {
    p = structuredClone(project);
    p.guide.mute = true;
  }
  const g = new MixGraph(octx, octx.destination, { gate });
  g.sync(p, true);
  g.schedule(p, buffers, pre / sampleRate, 0);
  const full = await octx.startRendering();
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  for (let c = 0; c < 2; c++) out.copyToChannel(full.getChannelData(c).subarray(pre), c);
  return out;
}

export async function exportWavMix(project, buffers) {
  const b = await renderMix(project, buffers, { tail: 1.5 });
  return encodeWav([b.getChannelData(0), b.getChannelData(1)], b.sampleRate, 24);
}

/** RF-52: uma faixa por canal, com os efeitos do canal. */
export async function exportStems(project, buffers, onProgress) {
  const out = [];
  const chans = project.channels.filter((c) => c.takeId && buffers.has(c.id));
  if (project.drums && buffers.has(DRUMS_ID)) chans.push({ id: DRUMS_ID, name: 'Bateria' });
  for (let i = 0; i < chans.length; i++) {
    const ch = chans[i];
    onProgress?.(i / chans.length, ch.name);
    const b = await renderMix(project, buffers, { onlyChannelId: ch.id, tail: 1.5 });
    out.push({ name: ch.name, blob: encodeWav([b.getChannelData(0), b.getChannelData(1)], b.sampleRate, 24) });
  }
  onProgress?.(1);
  return out;
}

/**
 * Exporta o vídeo final. Devolve { blob, info }.
 * onProgress({ stage: 'audio'|'prepare'|'video'|'mux', p }); signal: AbortSignal (RF-53).
 */
export async function exportVideo({ project, store, buffers, format = 'mp4', resolution = 1080, fps = 30, quality = 'normal', onProgress, signal }) {
  onProgress?.({ stage: 'audio', p: 0 });
  const audio = await renderMix(project, buffers);
  if (signal?.aborted) throw new DOMException('Exportação cancelada', 'AbortError');
  onProgress?.({ stage: 'audio', p: 1 });

  // Resolução acima do que o codificador deste computador aceita: desce até uma que funcione.
  const notes = [];
  let [width, height] = exportSize(project.aspect, resolution);
  if (format === 'mp4' && typeof VideoEncoder !== 'undefined') {
    for (const r of EXPORT_RES.filter((x) => x <= resolution).reverse()) {
      const [w, hh] = exportSize(project.aspect, r);
      if (await anyAvc(w, hh, fps)) {
        if (r !== resolution) notes.push(`O codificador H.264 deste computador não aceita ${resolution}p; exportado em ${r}p.`);
        [width, height] = [w, hh];
        break;
      }
    }
  }
  const bitrate = exportBitrate(width, height, fps, quality);
  // Um vídeo por tomada usada no canal; `spans` diz em que trechos ele aparece (punch-in troca o vídeo).
  const videos = [];
  for (const [i, ch] of project.channels.entries()) {
    const byTake = new Map();
    for (const sp of takeSpans(project, ch)) {
      if (!byTake.has(sp.take)) byTake.set(sp.take, []);
      byTake.get(sp.take).push([sp.from, sp.to, (sp.take.videoStart ?? 0) + ch.offsetMs / 1000 + sp.shift, sp.freeze ?? null]);
    }
    for (const [take, spans] of byTake) {
      if (!take.hasVideo) continue;
      const blob = await store.readTakeVideo(project.id, take.id);
      if (blob) videos.push({ channelId: ch.id, label: `${i + 1}`, blob, spans, videoStart: (take.videoStart ?? 0) + ch.offsetMs / 1000 });
    }
  }

  const job = { project: structuredClone(project), width, height, fps, bitrate, notes, duration: audio.duration, format, sampleRate: audio.sampleRate, videos };
  try {
    return await runWorker(job, audio, videoLatencyMode, onProgress, signal);
  } catch (err) {
    // Alguns codificadores do sistema (ex.: H.264 do Windows usado pelo Firefox) geram quadros B
    // no modo 'quality', fora de ordem para o empacotador. O modo 'realtime' desliga os quadros B.
    if (err?.code !== 'reorder' || videoLatencyMode === 'realtime') throw err;
    videoLatencyMode = 'realtime';
    onProgress?.({ stage: 'prepare', p: 0, message: 'Refazendo com o codificador em modo compatível…' });
    return runWorker(job, audio, videoLatencyMode, onProgress, signal);
  }
}

async function anyAvc(w, h, fps) {
  for (const codec of avcCodecs(w, h, fps)) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate: 8e6, avc: { format: 'avc' } });
      if (r.supported) return true;
    } catch { /* próximo */ }
  }
  return false;
}

/** Modo do codificador de vídeo; muda para 'realtime' (e fica assim na sessão) se houver quadros B. */
let videoLatencyMode = 'quality';

function runWorker(job, audio, latencyMode, onProgress, signal) {
  const worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  const L = audio.getChannelData(0).slice();
  const R = audio.getChannelData(1).slice();
  return new Promise((resolve, reject) => {
    const finish = () => { worker.terminate(); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { worker.postMessage({ cmd: 'cancel' }); finish(); reject(new DOMException('Exportação cancelada', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'done') { finish(); resolve({ blob: new Blob([m.buffer], { type: m.mime }), info: m.info }); }
      else if (m.type === 'error') { finish(); reject(Object.assign(new Error(m.message), { code: m.code })); }
    };
    worker.onerror = (e) => { finish(); reject(new Error(e.message || 'Falha no Worker de exportação')); };
    worker.postMessage({ cmd: 'start', job: { ...job, latencyMode, audio: [L, R] } }, [L.buffer, R.buffer]);
  });
}
