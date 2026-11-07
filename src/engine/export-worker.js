// Worker de exportação (RF-50, RF-51, RF-53, RF-54):
// decodifica os vídeos das tomadas (VideoDecoder), compõe a grade num OffscreenCanvas,
// codifica com VideoEncoder/AudioEncoder e empacota em MP4 ou WebM. Tudo offline, sem tempo real.
import { createAacEncoder } from './aac-wasm.js';
import { fixAvcDescription } from './avcc.js';
import { MP4_AUDIO, WEBM_AUDIO, WEBM_VIDEO } from './capabilities.js';
import { avcCodecs } from './quality.js';
import { drawGrid } from './compositor.js';
import { drumTimeline } from './drums.js';
import { hasReorder, interleave, planDecodeTimes } from './mux-order.js';
import { guardPeaks } from './peak-guard.js';
import { demuxWebM } from './webm-demux.js';

const MUXERS = {
  mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm',
  webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.0.3/+esm',
};

// Teto do pico verdadeiro do áudio. O AAC cria picos de até ~1 dB acima do que entra; com −1,5 dBTP
// o arquivo decodificado fica abaixo de 0 dBFS e sobra margem para a recodificação das plataformas.
const AUDIO_CEILING_DB = -1.5;

let cancelled = false;

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'cancel') cancelled = true;
  if (m.cmd === 'start') {
    cancelled = false;
    run(m.job).catch((err) => self.postMessage({ type: 'error', message: err?.message || String(err), code: err?.code }));
  }
};

const progress = (stage, p, extra = {}) => self.postMessage({ type: 'progress', stage, p, ...extra });

async function drain(enc, max) {
  while (enc.encodeQueueSize > max) await new Promise((r) => setTimeout(r, 1));
}

async function pickVideo(format, width, height, fps, bitrate) {
  const cands = format === 'mp4'
    ? avcCodecs(width, height, fps, bitrate).map((codec) => ({ codec, mux: 'avc', extra: { avc: { format: 'avc' } } }))
    : WEBM_VIDEO.map((c) => ({ ...c, extra: {} }));
  for (const c of cands) {
    const cfg = { codec: c.codec, width, height, bitrate, framerate: fps, ...c.extra };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, mux: c.mux };
    } catch { /* tenta o próximo */ }
  }
  return null;
}

async function pickAudio(format, sampleRate) {
  for (const c of format === 'mp4' ? MP4_AUDIO : WEBM_AUDIO) {
    const cfg = { codec: c.codec, sampleRate, numberOfChannels: 2, bitrate: 192000 };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, mux: c.mux };
    } catch { /* tenta o próximo */ }
  }
  return null;
}

/** Entrega, para cada instante, o último quadro decodificado com timestamp ≤ t. */
class FrameCursor {
  constructor(demuxed) {
    this.chunks = demuxed.frames;
    this.next = 0;
    this.queue = [];
    this.current = null;
    this.ended = false;
    this.waiters = [];
    this.decoder = new VideoDecoder({
      output: (f) => { this.queue.push(f); this.waiters.splice(0).forEach((w) => w()); },
      error: () => { this.ended = true; this.waiters.splice(0).forEach((w) => w()); },
    });
    const cfg = { codec: demuxed.codec, codedWidth: demuxed.width, codedHeight: demuxed.height };
    if (demuxed.description && /^avc/.test(demuxed.codec)) cfg.description = demuxed.description;
    this.decoder.configure(cfg);
  }

  waitOutput(ms) {
    return new Promise((r) => { this.waiters.push(r); setTimeout(r, ms); });
  }

  async frameAt(tus) {
    for (;;) {
      while (this.queue.length && this.queue[0].timestamp <= tus) {
        this.current?.close();
        this.current = this.queue.shift();
      }
      if (this.queue.length || this.ended) return this.current;
      if (this.decoder.state === 'closed') { this.ended = true; continue; }
      if (this.next < this.chunks.length) {
        if (this.decoder.decodeQueueSize < 6) {
          const c = this.chunks[this.next++];
          try {
            this.decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.timestamp, data: c.data }));
          } catch { this.ended = true; }
        } else {
          await this.waitOutput(30);
        }
      } else {
        try { await this.decoder.flush(); } catch { /* arquivo cortado */ }
        this.ended = true;
      }
    }
  }

  close() {
    this.current?.close();
    this.queue.forEach((f) => f.close());
    this.queue = [];
    try { this.decoder.close(); } catch { /* ok */ }
  }
}

/** Troca o avcC que o codificador entregou por um montado do SPS/PPS do vídeo (ver avcc.js). */
function fixVideoConfig(videoOut) {
  const first = videoOut.find((x) => x.m?.decoderConfig);
  if (!first) return;
  const key = videoOut.find((x) => x.c.type === 'key');
  let data = null;
  if (key) { data = new Uint8Array(key.c.byteLength); key.c.copyTo(data); }
  const desc = fixAvcDescription(first.m.decoderConfig.description, data);
  if (desc) first.m = { ...first.m, decoderConfig: { ...first.m.decoderConfig, description: desc } };
}

async function run(job) {
  const { project, width, height, fps, duration, sampleRate, audio, videos } = job;
  const bitrate = job.bitrate || (width * height >= 1900 * 1000 ? 8e6 : 5e6);
  let format = job.format;
  const notes = [...(job.notes || [])];

  let v = await pickVideo(format, width, height, fps, bitrate);
  let a = await pickAudio(format, sampleRate);
  if ((!v || !a) && format === 'mp4') {
    notes.push(`MP4 indisponível neste navegador/sistema (${!v ? 'H.264' : 'áudio'} sem codificador). Exportado em WebM.`);
    format = 'webm';
    v = await pickVideo(format, width, height, fps, bitrate);
    a = await pickAudio(format, sampleRate);
  }
  if (!v || !a) throw new Error('Nenhum codificador de vídeo/áudio disponível para exportar.');
  // Sem AAC no navegador (Firefox no Windows): usa o AAC do FFmpeg em WebAssembly.
  let aacWasm = null;
  const audioOut = [];
  if (format === 'mp4' && a.mux !== 'aac') {
    progress('prepare', 0, { message: 'Carregando o codificador AAC…' });
    try {
      aacWasm = await createAacEncoder({
        sampleRate, numberOfChannels: 2, bitrate: 192000,
        output: (c, m) => audioOut.push({ c, m }),
      });
      a = { cfg: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 192000 }, mux: 'aac' };
    } catch (err) {
      console.warn('AAC (WebAssembly) indisponível:', err);
      notes.push('Não foi possível carregar o codificador AAC (sem internet?): o áudio do MP4 saiu em Opus. Navegadores e o VLC tocam, mas o player do Windows, o WhatsApp e o iPhone podem abrir o vídeo sem som.');
    }
  }

  progress('prepare', 0, { message: 'Carregando o empacotador…' });
  const lib = await import(MUXERS[format]);
  const target = new lib.ArrayBufferTarget();
  const muxer = new lib.Muxer({
    target,
    // frameRate: a trilha de vídeo usa 1/fps como unidade de tempo, então os quadros ficam com
    // duração exatamente constante (as plataformas recusam ou reprocessam vídeo com fps variável).
    video: { codec: v.mux, width, height, ...(format === 'mp4' ? { frameRate: fps } : {}) },
    audio: { codec: a.mux, numberOfChannels: 2, sampleRate },
    firstTimestampBehavior: 'offset',
    ...(format === 'mp4' ? { fastStart: 'in-memory' } : {}),
  });

  let encErr = null;
  // Os pacotes ficam guardados e só vão para o empacotador no fim, já com DTS calculado
  // (o MP4 em memória guarda tudo de qualquer jeito, então não há custo extra relevante).
  const videoOut = [];
  const venc = new VideoEncoder({ output: (c, m) => videoOut.push({ c, m }), error: (e) => { encErr = e; } });
  venc.configure({ ...v.cfg, latencyMode: job.latencyMode || 'quality' });
  const aenc = aacWasm ? null : new AudioEncoder({ output: (c, m) => audioOut.push({ c, m }), error: (e) => { encErr = e; } });
  aenc?.configure(a.cfg);


  // Vídeos das tomadas
  const cursors = [];
  for (const vid of videos) {
    try {
      const d = demuxWebM(await vid.blob.arrayBuffer());
      if (!d || !d.codec) { notes.push(`Canal ${vid.label}: formato de vídeo não suportado na exportação.`); continue; }
      const sup = await VideoDecoder.isConfigSupported({ codec: d.codec, codedWidth: d.width, codedHeight: d.height });
      if (!sup.supported) { notes.push(`Canal ${vid.label}: sem decodificador para ${d.rawCodec}.`); continue; }
      cursors.push({ ...vid, cursor: new FrameCursor(d) });
    } catch (err) {
      notes.push(`Canal ${vid.label}: vídeo ilegível (${err.message}).`);
    }
  }

  const drumTL = drumTimeline(project);
  // Marca d'água de imagem: guardada no projeto como data URL
  let wmImage = null;
  const wm = project.watermark;
  if (wm?.on && wm.kind === 'image' && wm.image) {
    try { wmImage = await createImageBitmap(await (await fetch(wm.image)).blob()); } catch { notes.push("Não deu para ler a imagem da marca d'água; o vídeo saiu sem ela."); }
  }
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  const N = Math.max(1, Math.ceil(duration * fps));
  const frameUs = 1e6 / fps;
  for (let n = 0; n < N; n++) {
    if (cancelled) { cursors.forEach((c) => c.cursor.close()); return; }
    const t = n / fps;
    const sources = {};
    for (const c of cursors) {
      // Trechos desta tomada: [início, fim, videoStart]; fora deles o quadro mostra outra tomada.
      // Com compassos removidos cada trecho tem o próprio videoStart (o vídeo pula para frente).
      const sp = c.spans ? c.spans.find(([a, b]) => t >= a && t < b) : null;
      if (c.spans && !sp) continue;
      // sp[3]: a partir dali o quadro fica parado (silêncio de compassos inseridos)
      const tt = sp && sp[3] != null && t > sp[3] ? sp[3] - 0.001 : t;
      const tv = tt - (sp && sp[2] != null ? sp[2] : c.videoStart);
      const f = await c.cursor.frameAt(Math.max(0, tv) * 1e6);
      if (f) sources[c.channelId] = { image: f, width: f.displayWidth, height: f.displayHeight };
    }
    drawGrid(g, width, height, project, sources, { time: t, drumTL, wmImage });
    const vf = new VideoFrame(canvas, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs) });
    venc.encode(vf, { keyFrame: n % (fps * 2) === 0 });
    vf.close();
    await drain(venc, 6);
    if (encErr) throw encErr;
    if (n % 10 === 0) progress('video', n / N);
  }
  progress('video', 1);
  await venc.flush();
  cursors.forEach((c) => c.cursor.close());
  if (encErr) throw encErr;
  if (format === 'mp4') fixVideoConfig(videoOut);
  if (videoOut.length < N) notes.push(`O codificador descartou ${N - videoOut.length} de ${N} quadros.`);

  // O 1º quadro entrou com timestamp 0. O codificador do Firefox devolve tudo deslocado
  // (ex.: 33333, 100000, 66666…); tira esse deslocamento para o vídeo não atrasar em relação ao áudio.
  const shift = videoOut.reduce((m, x) => Math.min(m, x.c.timestamp), videoOut.length ? Infinity : 0);
  for (const x of videoOut) x.pts = x.c.timestamp - shift;
  const pts = videoOut.map((x) => x.pts);
  let vItems;
  let delayUs = 0;
  if (hasReorder(pts)) {
    // Quadros B (comum no H.264 do sistema usado pelo Firefox): calcula o DTS de cada quadro.
    if (format !== 'mp4') {
      throw Object.assign(new Error('O codificador de vídeo gerou quadros fora de ordem (quadros B), que o WebM não aceita. Tente exportar em MP4.'), { code: 'reorder' });
    }
    const plan = planDecodeTimes(pts, frameUs);
    delayUs = plan.delayUs;
    vItems = videoOut.map((x, k) => ({ kind: 'v', ...x, dts: plan.dts[k] }));
  } else {
    vItems = videoOut.map((x) => ({ kind: 'v', ...x, dts: x.pts }));
  }

  // Áudio (já mixado no OfflineAudioContext). O MP4 começa toda trilha em zero, e com quadros B
  // o 1º quadro só aparece em `delayUs`; o áudio ganha o mesmo silêncio na frente para ficar alinhado.
  progress('mux', 0, { message: 'Codificando o áudio…' });
  // (O "priming" de ~21 ms do AAC não é descontado: VLC/FFmpeg já o pulam; nos players que não pulam,
  // o áudio fica no máximo 21 ms atrasado, o que não se percebe. Adiantado ele nunca fica.)
  const [L, R] = audio;
  // Pico verdadeiro abaixo do teto e sem NaN (ver peak-guard.js).
  progress('mux', 0, { message: 'Conferindo os picos do áudio…' });
  const guard = guardPeaks([L, R], sampleRate, { ceilingDb: AUDIO_CEILING_DB });
  if (guard.invalid) notes.push(`O mix tinha ${guard.invalid} amostra${guard.invalid > 1 ? "s" : ""} inválida${guard.invalid > 1 ? "s" : ""} (NaN), trocada${guard.invalid > 1 ? "s" : ""} por silêncio.`);
  if (guard.peakInDb > 0 && guard.reductionDb < -1) {
    const db = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1).replace('.', ',')} dB`;
    notes.push(`O áudio passava do máximo (pico ${db(guard.peakInDb)}): foi segurado em ${db(AUDIO_CEILING_DB)}, com até ${db(-guard.reductionDb).slice(1)} de redução nos picos. ${project.master?.limiter ? 'Para controlar isso no mix, baixe o volume do master.' : 'Para controlar isso no mix, ligue o limitador do master ou baixe o volume.'}`);
  }
  const pad = Math.round((delayUs * sampleRate) / 1e6);
  const total = pad + L.length;
  const block = 4800;
  for (let i = 0; i < total; i += block) {
    if (cancelled) return;
    const n = Math.min(block, total - i);
    const data = new Float32Array(n * 2); // zeros = silêncio no trecho inicial
    const s0 = Math.max(0, i - pad);
    const s1 = Math.max(0, i + n - pad);
    const at = Math.max(0, pad - i);
    if (s1 > s0) {
      data.set(L.subarray(s0, s1), at);
      data.set(R.subarray(s0, s1), n + at);
    }
    if (aacWasm) {
      aacWasm.encode([data.subarray(0, n), data.subarray(n)]);
      if (i % (block * 20) === 0) { progress('mux', i / total, { message: 'Codificando o áudio (AAC)…' }); await new Promise((r) => setTimeout(r, 0)); }
      continue;
    }
    const ad = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((i * 1e6) / sampleRate), data,
    });
    aenc.encode(ad);
    ad.close();
    await drain(aenc, 32);
    if (encErr) throw encErr;
  }
  if (aacWasm) aacWasm.flush();
  else await aenc.flush();
  if (encErr) throw encErr;
  if (pad) notes.push(`Vídeo com quadros B: áudio e vídeo começam juntos após ${(delayUs / 1000).toFixed(0)} ms.`);
  const aItems = audioOut.map((x) => ({ kind: 'a', ...x, dts: x.c.timestamp }));
  for (const it of interleave(vItems, aItems)) {
    if (it.kind === 'a') muxer.addAudioChunk(it.c, it.m);
    else if (format === 'mp4') muxer.addVideoChunk(it.c, it.m, it.pts, it.pts - it.dts);
    else muxer.addVideoChunk(it.c, it.m, it.pts);
  }
  progress('mux', 1);
  muxer.finalize();
  const buffer = target.buffer;
  self.postMessage({
    type: 'done',
    buffer,
    mime: format === 'mp4' ? 'video/mp4' : 'video/webm',
    info: { format, video: v.cfg.codec, audio: a.cfg.codec, width, height, fps, bitrate, notes },
  }, [buffer]);
}
