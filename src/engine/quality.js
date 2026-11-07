// Opções de qualidade de vídeo: resolução e quadros da câmera, taxa de bits da gravação e da exportação.
// As escolhas dependem do computador/câmera, então ficam salvas no navegador (não no projeto).

export const QUALITY = {
  normal: { label: 'Normal', k: 1 },
  alta: { label: 'Alta', k: 2 },
  maxima: { label: 'Máxima', k: 3.5 },
};

export const REC_RES = {
  720: { label: '720p (HD)', w: 1280, h: 720 },
  1080: { label: '1080p (Full HD)', w: 1920, h: 1080 },
  1440: { label: '1440p (2K)', w: 2560, h: 1440 },
  2160: { label: '2160p (4K)', w: 3840, h: 2160 },
};

export const EXPORT_RES = [720, 1080, 1440, 2160];

const KEY = 'mc.videoPrefs';
const DEFAULTS = { recRes: 1080, recFps: 30, recQuality: 'alta', expRes: 1080, expFps: 30, expQuality: 'alta' };

export function loadVideoPrefs() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ok */ }
  const p = { ...DEFAULTS, ...v };
  if (!REC_RES[p.recRes]) p.recRes = DEFAULTS.recRes;
  if (!EXPORT_RES.includes(+p.expRes)) p.expRes = DEFAULTS.expRes;
  for (const k of ['recQuality', 'expQuality']) if (!QUALITY[p[k]]) p[k] = DEFAULTS[k];
  p.recFps = +p.recFps === 60 ? 60 : 30;
  p.expFps = +p.expFps === 60 ? 60 : 30;
  return p;
}

export function saveVideoPrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ok */ }
}

/**
 * Taxa de bits proporcional a pixels × quadros. Referência: 1080p a 30 fps em "Normal" = 8 Mbps
 * (o que o app usava antes). Quadros a mais custam menos que proporcional (fps^0,7).
 */
function bitrateFor(w, h, fps, quality, base, cap) {
  const px = (w * h) / (1920 * 1080);
  const f = Math.pow(fps / 30, 0.7);
  return Math.round(Math.min(cap, base * px * f * (QUALITY[quality]?.k ?? 1)));
}

/** Gravação da câmera (WebM VP8/VP9 do MediaRecorder). */
export const recordBitrate = (w, h, fps, q) => bitrateFor(w, h, fps, q, 8e6, 60e6);

/** Vídeo exportado (H.264 / VP9). */
export const exportBitrate = (w, h, fps, q) => bitrateFor(w, h, fps, q, 8e6, 80e6);

/** MB por minuto para uma taxa de bits. */
export const mbPerMin = (bps) => (bps * 60) / 8 / 1e6;

/**
 * Códigos H.264 (avc1) do nível mínimo que cabe no tamanho, nos quadros e na taxa de bits pedidos, e acima.
 * O nível 4.0 (que o app usava fixo) só vai até 1080p30 e 25 Mbps (High); 1440p e 4K precisam de 5.x.
 * Um arquivo que passa do limite do nível declarado é recusado por decodificadores de celular.
 */
export function avcCodecs(w, h, fps, bitrate = 0) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  // [nível, quadro máx. (macroblocos), macroblocos/s, taxa máx. em kbit/s no Main/Baseline]
  const LEVELS = [
    ['28', 8192, 245760, 20000], ['2a', 8704, 522240, 50000], ['32', 22080, 589824, 135000],
    ['33', 36864, 983040, 240000], ['34', 36864, 2073600, 240000], ['3c', 139264, 4177920, 240000],
  ];
  const out = [];
  for (const prof of ['6400', '4d00', '42e0', '4200']) {
    const k = prof === '6400' ? 1.25 : 1; // o High pode 25% a mais
    for (const [l, maxFs, maxRate, maxBr] of LEVELS) {
      if (mbs <= maxFs && rate <= maxRate && bitrate <= maxBr * 1000 * k) out.push(`avc1.${prof}${l}`);
    }
  }
  return out;
}
