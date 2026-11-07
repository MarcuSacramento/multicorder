// RC-01: detecção de recursos em tempo de execução.

export const MP4_VIDEO = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.420028'];
export const WEBM_VIDEO = [
  { codec: 'vp09.00.40.08', mux: 'V_VP9' },
  { codec: 'vp8', mux: 'V_VP8' },
];
export const MP4_AUDIO = [
  { codec: 'mp4a.40.2', mux: 'aac' },
  { codec: 'opus', mux: 'opus' },
];
export const WEBM_AUDIO = [{ codec: 'opus', mux: 'A_OPUS' }];

const RECORD_MIMES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

export function detectBrowser() {
  const ua = navigator.userAgent;
  const ff = ua.match(/Firefox\/(\d+)/);
  if (ff) return { name: 'Firefox', version: +ff[1], engine: 'gecko' };
  const edg = ua.match(/Edg\/(\d+)/);
  if (edg) return { name: 'Edge', version: +edg[1], engine: 'blink' };
  const ch = ua.match(/Chrome\/(\d+)/);
  if (ch) return { name: 'Chrome', version: +ch[1], engine: 'blink' };
  const sf = ua.match(/Version\/(\d+).*Safari/);
  if (sf) return { name: 'Safari', version: +sf[1], engine: 'webkit' };
  return { name: 'Desconhecido', version: 0, engine: 'other' };
}

async function videoSupported(codec, width, height, extra = {}) {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 5e6, framerate: 30, ...extra });
    return !!r.supported;
  } catch { return false; }
}

async function audioSupported(codec) {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
    return !!r.supported;
  } catch { return false; }
}

export async function detectCapabilities() {
  const browser = detectBrowser();
  const AC = globalThis.AudioContext;
  const caps = {
    browser,
    secureContext: globalThis.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    audioWorklet: !!AC && 'audioWorklet' in AC.prototype,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    recordMime: null,
    opfs: !!navigator.storage?.getDirectory,
    webcodecs: typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined',
    audioEncoder: typeof AudioEncoder !== 'undefined',
    sinkIdAudioContext: !!AC && 'setSinkId' in AC.prototype,
    sinkIdMedia: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    outputLatency: !!AC && 'outputLatency' in AC.prototype,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    mp4Video: null,
    mp4Audio: null,
    webmVideo: null,
    webmAudio: null,
  };
  if (caps.mediaRecorder) caps.recordMime = RECORD_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || null;
  if (caps.webcodecs) {
    for (const c of MP4_VIDEO) if (await videoSupported(c, 1280, 720, { avc: { format: 'avc' } })) { caps.mp4Video = c; break; }
    for (const c of WEBM_VIDEO) if (await videoSupported(c.codec, 1280, 720)) { caps.webmVideo = c.codec; break; }
  }
  if (caps.audioEncoder) {
    for (const c of MP4_AUDIO) if (await audioSupported(c.codec)) { caps.mp4Audio = c.codec; break; }
    for (const c of WEBM_AUDIO) if (await audioSupported(c.codec)) { caps.webmAudio = c.codec; break; }
  }
  // Sem AAC nativo: a exportação usa o AAC do FFmpeg em WebAssembly (aac-wasm.js), baixado na hora.
  if (caps.mp4Audio !== 'mp4a.40.2' && typeof WebAssembly !== 'undefined' && typeof EncodedAudioChunk !== 'undefined') {
    caps.mp4Audio = 'mp4a.40.2';
    caps.aacWasm = true;
  }
  caps.canExportMp4 = !!(caps.mp4Video && caps.mp4Audio && caps.offscreenCanvas);
  caps.canExportWebm = !!(caps.webmVideo && caps.webmAudio && caps.offscreenCanvas);
  caps.missingCore = [
    !caps.secureContext && 'contexto seguro (HTTPS ou localhost)',
    !caps.getUserMedia && 'getUserMedia',
    !caps.audioWorklet && 'AudioWorklet',
    !caps.mediaRecorder && 'MediaRecorder',
    !caps.opfs && 'OPFS (armazenamento local)',
  ].filter(Boolean);
  return caps;
}
