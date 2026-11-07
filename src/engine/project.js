// Modelo do projeto (RF-01, RF-05, RF-06). Puro e serializável em JSON.
import { drumsEndBar, normalizeDrums } from './drums.js';
import { LAYOUTS, pickLayout } from './layout.js';
import { clamp, uid } from './util.js';

export const PROJECT_VERSION = 1;
export const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8'];
export const REVERB_TYPES = { small: 'Sala pequena', room: 'Sala', hall: 'Salão', plate: 'Plate' };
export const ECHO_SYNC = {
  off: 'Livre (ms)', '1/2': '1/2', '1/4': '1/4', '1/4t': '1/4 tercina',
  '1/8.': '1/8 pontuada', '1/8': '1/8', '1/16': '1/16',
};
const ECHO_MULT = { '1/2': 2, '1/4': 1, '1/4t': 2 / 3, '1/8.': 0.75, '1/8': 0.5, '1/16': 0.25 };

export const beatsPerBar = (ts) => parseInt(String(ts).split('/')[0], 10) || 4;

/** Velocidade (Hz) de um efeito que pode seguir o BPM (wah, tremolo): `sync` = figura ou 'off'. */
export function lfoHz(o, bpm) {
  if (o.sync && o.sync !== 'off' && ECHO_MULT[o.sync]) return clamp(1 / ((60 / bpm) * ECHO_MULT[o.sync]), 0.05, 20);
  return clamp(o.rateHz || 1, 0.05, 20);
}

export function echoTimeSec(echo, bpm) {
  const v = echo.sync && echo.sync !== 'off' ? (60 / bpm) * ECHO_MULT[echo.sync] : echo.timeMs / 1000;
  return clamp(v, 0.001, 2.4);
}

export function defaultFx() {
  return {
    bypassAll: false,
    gate: { on: false, thresholdDb: -50, releaseMs: 120 },
    eq: {
      on: true, hpOn: true, hpFreq: 80,
      low: { freq: 120, gain: 0 },
      mid: { freq: 1000, gain: 0, q: 1 },
      high: { freq: 8000, gain: 0 },
    },
    comp: { on: false, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 150, makeupDb: 0 },
    // Efeitos de cor (entre o compressor e o eco)
    dist: { on: false, drive: 0.4, tone: 5000, level: 0.8 },
    wah: { on: false, sync: '1/4', rateHz: 2, depth: 0.8, q: 4 },
    chorus: { on: false, rateHz: 0.8, depth: 0.5, mix: 0.45 },
    double: { on: false, width: 0.8, detune: 0.5, mix: 0.6 },
    trem: { on: false, sync: '1/8', rateHz: 5, depth: 0.5 },
    echo: { on: false, sync: '1/4', timeMs: 375, feedback: 0.3, mix: 0.25, filterHz: 4000 },
    reverb: { on: false, type: 'room', preDelayMs: 20, mix: 0.2 },
    send: { reverbDb: -60 },
  };
}

/** Limpeza da gravação e tom de um canal (processados fora da tela; o arquivo gravado não muda). */
export function defaultClean() {
  return {
    denoise: { on: false, amount: 0.5 },
    declick: { on: false, amount: 0.5 },
    deplosive: { on: false, amount: 0.5 },
    strip: { on: false, thresholdDb: -45, holdMs: 300 },
    pitch: { semis: 0, cents: 0 },
  };
}

export function createChannel(i) {
  return {
    id: uid('c'),
    name: `Canal ${i + 1}`,
    takeId: null,
    punches: [], // punch-ins: { takeId, start, end } em segundos da linha do tempo (trecho que substitui a tomada)
    altTakes: [], // tomadas guardadas (as de antes): { takeId, punches, trimStart, trimEnd }, a mais nova primeiro
    volumeDb: 0,
    volAuto: [], // linha de volume na linha do tempo: [{ t (s), db }]
    panAuto: [], // linha de pan: [{ t (s), v (−1 esquerda … +1 direita) }]
    pan: 0,
    mute: false,
    solo: false,
    offsetMs: 0,
    trimStart: 0,
    trimEnd: 0,
    inputGainDb: 0,
    inputMode: 'L', // 'L' | 'R' | 'stereo' (RU-03)
    audioDeviceId: '',
    videoDeviceId: '',
    linkWith: null, // RU-04: grava junto com outro canal (outra entrada física)
    mirror: true,
    show: 'video', // o que o quadro mostra: 'video' (tomada/câmera) ou 'drums' (pads da bateria)
    zoom: 1,
    panX: 0,
    panY: 0,
    fx: defaultFx(),
  };
}

export function createProject({ name, bpm = 100, timeSig = '4/4', channelCount = 4, aspect = '9:16', layoutId } = {}) {
  const n = clamp(channelCount | 0, 2, 6);
  const now = Date.now();
  return normalizeProject({
    version: PROJECT_VERSION,
    id: uid('p'),
    name: (name || 'Novo projeto').trim(),
    bpm: clamp(+bpm || 100, 40, 240),
    timeSig,
    aspect,
    layoutId: layoutId || LAYOUTS[n][0].id,
    channels: Array.from({ length: n }, (_, i) => createChannel(i)),
    takes: {},
    createdAt: now,
    updatedAt: now,
  });
}

/** Preenche campos ausentes (projetos antigos ou importados). */
export function normalizeProject(p) {
  p.version ??= PROJECT_VERSION;
  p.bpm = clamp(+p.bpm || 100, 40, 240);
  p.timeSig ??= '4/4';
  p.aspect ??= '9:16';
  p.takes ??= {};
  p.master = { volumeDb: 0, limiter: true, ...p.master };
  p.sharedReverb = { type: 'hall', returnDb: 0, ...p.sharedReverb };
  p.metronome = { on: true, volume: 0.6, ...p.metronome };
  p.countInBars ??= 1;
  p.loop = { on: false, start: 0, end: 4, ...p.loop }; // em compassos (fim exclusivo)
  p.notes ??= []; // observações na régua: { id, beat, text } (posição em tempos)
  // Compassos removidos, em ordem: { at, len } em segundos. Cada mídia gravada guarda em `cutBase`
  // quantos cortes já existiam quando entrou no projeto e só aplica os seguintes.
  p.cuts = Array.isArray(p.cuts) ? p.cuts.filter((c) => c && c.len > 0 && c.at >= 0) : [];
  p.grid = { gap: 6, bg: '#000000', radius: 0, borderWidth: 0, borderColor: '#ffffff', ...p.grid };
  p.inputDefaults = { audioDeviceId: '', videoDeviceId: '', ...p.inputDefaults };
  p.guide ??= null;
  p.drums = normalizeDrums(p.drums ?? null); // faixa de bateria (drums.js)
  p.channels = (p.channels || []).map((c, i) => {
    const d = createChannel(i);
    const fx = defaultFx();
    const cf = c.fx || {};
    return {
      ...d, ...c,
      punches: Array.isArray(c.punches) ? c.punches.filter((x) => x && x.takeId && x.end > x.start) : [],
      volAuto: c.volAuto,
      panAuto: c.panAuto,
      clean: (() => {
        const d = defaultClean();
        const o = c.clean || {};
        return Object.fromEntries(Object.keys(d).map((k) => [k, { ...d[k], ...o[k] }]));
      })(),
      altTakes: (Array.isArray(c.altTakes) ? c.altTakes : []).filter((x) => x && x.takeId)
        .map((x) => ({ takeId: x.takeId, punches: Array.isArray(x.punches) ? x.punches : [], trimStart: x.trimStart || 0, trimEnd: x.trimEnd || 0 })),
      fx: {
        ...fx, ...cf,
        gate: { ...fx.gate, ...cf.gate },
        eq: { ...fx.eq, ...cf.eq, low: { ...fx.eq.low, ...cf.eq?.low }, mid: { ...fx.eq.mid, ...cf.eq?.mid }, high: { ...fx.eq.high, ...cf.eq?.high } },
        comp: { ...fx.comp, ...cf.comp },
        dist: { ...fx.dist, ...cf.dist },
        wah: { ...fx.wah, ...cf.wah },
        chorus: { ...fx.chorus, ...cf.chorus },
        double: { ...fx.double, ...cf.double },
        trem: { ...fx.trem, ...cf.trem },
        echo: { ...fx.echo, ...cf.echo },
        reverb: { ...fx.reverb, ...cf.reverb },
        send: { ...fx.send, ...cf.send },
      },
    };
  });
  for (const c of p.channels) normalizeLines(c);
  if (p.drums) normalizeLines(p.drums);
  const opts = LAYOUTS[p.channels.length];
  if (opts && !opts.some((o) => o.id === p.layoutId)) p.layoutId = opts[0].id;
  // Posição do canal em destaque nos layouts com destaque/PiP (projetos antigos: o primeiro)
  p.featured = clamp(Number.isInteger(p.featured) ? p.featured : 0, 0, Math.max(0, p.channels.length - 1));
  // Trocas de layout ao longo da música (posição em tempos, como as observações)
  p.layoutChanges = (Array.isArray(p.layoutChanges) ? p.layoutChanges : [])
    .filter((c) => c && Number.isFinite(c.beat) && c.beat > 0 && c.layoutId)
    .map((c) => ({ id: c.id || uid('lc'), beat: c.beat, layoutId: pickLayout(p.channels.length, c.layoutId), featured: clamp(c.featured | 0, 0, p.channels.length - 1) }))
    .sort((a, b) => a.beat - b.beat);
  // Letra/legenda na tela: [{ id, beat, end (tempos), text }] em ordem, sem se sobrepor
  p.lyrics = (Array.isArray(p.lyrics) ? p.lyrics : [])
    .filter((x) => x && Number.isFinite(x.beat) && Number.isFinite(x.end) && x.end > x.beat && String(x.text || '').trim())
    .map((x) => ({ id: x.id || uid('ly'), beat: Math.max(0, x.beat), end: x.end, text: String(x.text).slice(0, 300) }))
    .sort((a, b) => a.beat - b.beat);
  // Seções da música (verso, refrão…): [{ id, start, end (compassos, fim exclusivo), name, color }]
  p.sections = (Array.isArray(p.sections) ? p.sections : [])
    .filter((x) => x && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .map((x) => ({ id: x.id || uid('sc'), start: Math.max(0, Math.round(x.start)), end: Math.round(x.end), name: String(x.name || 'Seção').slice(0, 40), color: x.color || SECTION_COLORS[0] }))
    .sort((a, b) => a.start - b.start);
  p.lyricStyle = { pos: 'bottom', size: 5, color: '#ffffff', box: true, ...(p.lyricStyle || {}) };
  p.watermark = { on: false, kind: 'text', text: '', image: '', pos: 'br', size: 20, opacity: 0.7, color: '#ffffff', ...(p.watermark || {}) };
  return p;
}

/** RF-06: muda a quantidade de canais mantendo os já gravados (remove do fim). */
export function setChannelCount(p, n) {
  n = clamp(n | 0, 2, 6);
  while (p.channels.length < n) p.channels.push(createChannel(p.channels.length));
  if (p.channels.length > n) {
    const removed = p.channels.splice(n);
    for (const c of p.channels) if (removed.some((r) => r.id === c.linkWith)) c.linkWith = null;
  }
  p.layoutId = pickLayout(n, p.layoutId);
  p.featured = Math.min(p.featured || 0, n - 1);
  for (const c of p.layoutChanges || []) {
    c.layoutId = pickLayout(n, c.layoutId);
    c.featured = Math.min(c.featured || 0, n - 1);
  }
}

/** Linha de volume da faixa: pontos { t (s na linha do tempo), db }, de AUTO_MIN_DB (mudo) a AUTO_MAX_DB. */
export const AUTO_MIN_DB = -40;
export const AUTO_MAX_DB = 6;

/** Ganho linear de um valor da linha (o fundo da faixa é mudo). */
export const autoGain = (db) => (db <= AUTO_MIN_DB + 1e-6 ? 1e-4 : Math.pow(10, db / 20));

/**
 * Valor de uma linha (volume: campo `db`; pan: campo `v`, −1 esquerda a +1 direita) no instante t:
 * reta entre os pontos; antes do 1º e depois do último, fica igual. Sem pontos: `def`.
 */
export function autoValueAt(points, t, f = 'db', def = 0) {
  if (!points?.length) return def;
  if (t <= points[0].t) return points[0][f];
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (t <= b.t) {
      const a = points[i - 1];
      return b.t - a.t < 1e-9 ? b[f] : a[f] + ((b[f] - a[f]) * (t - a.t)) / (b.t - a.t);
    }
  }
  return points[points.length - 1][f];
}

/** Valor (dB) da linha de volume no instante t. */
export const autoDbAt = (points, t) => autoValueAt(points, t, 'db', 0);

/** Linhas de volume e de pan: campo do valor e limites. */
export const AUTO_LINES = {
  volAuto: { f: 'db', min: AUTO_MIN_DB, max: AUTO_MAX_DB },
  panAuto: { f: 'v', min: -1, max: 1 },
};

/** Limpa as linhas de um canal ou da bateria (projetos antigos não têm). */
export function normalizeLines(o) {
  for (const [k, L] of Object.entries(AUTO_LINES)) {
    o[k] = Array.isArray(o[k])
      ? o[k].filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x[L.f]))
        .map((x) => ({ t: Math.max(0, x.t), [L.f]: clamp(x[L.f], L.min, L.max) })).sort((a, b) => a.t - b.t)
      : [];
  }
}

/** Donos de linhas: os canais e a bateria. */
const lineOwners = (p) => [...p.channels, ...(p.drums ? [p.drums] : [])];

/** Linhas depois de remover [at, at+len): o de depois anda para trás; no corte, o valor de lá. */
function cutLines(p, cut) {
  for (const o of lineOwners(p)) {
    for (const [k, L] of Object.entries(AUTO_LINES)) {
      const v = o[k];
      if (!v?.length) continue;
      const f = L.f;
      const val = (t) => autoValueAt(v, t, f);
      const before = v.filter((x) => x.t < cut.at);
      const after = v.filter((x) => x.t > cut.at + cut.len).map((x) => ({ t: x.t - cut.len, [f]: x[f] }));
      // O valor de antes do corte vai até ele e o de depois começa nele (rampa de 5 ms entre os dois).
      const edge = before.length ? [{ t: Math.max(before[before.length - 1].t, cut.at - 0.005), [f]: val(cut.at) }] : [];
      o[k] = [...before, ...edge, { t: cut.at, [f]: val(cut.at + cut.len) }, ...after];
    }
  }
}

/** Linhas com o trecho [src, src+len) repetido em [at, at+len): os pontos dele se repetem na cópia. */
function dupLines(p, src, at, len) {
  for (const o of lineOwners(p)) {
    for (const [k, L] of Object.entries(AUTO_LINES)) {
      const v = o[k];
      if (!v?.length) continue;
      const f = L.f;
      const val = (t) => autoValueAt(v, t, f);
      const d = at - src;
      const before = v.filter((x) => x.t < at);
      const inside = v.filter((x) => x.t >= src && x.t < src + len).map((x) => ({ t: x.t + d, [f]: x[f] }));
      const after = v.filter((x) => x.t >= at).map((x) => ({ t: x.t + len, [f]: x[f] }));
      // o valor de antes da cópia vai até ela (sem rampa até o começo da cópia)
      const hold = before.length ? [{ t: Math.max(before[before.length - 1].t, at - 0.001), [f]: val(at - 0.001) }] : [];
      o[k] = [...before, ...hold, { t: at, [f]: val(src) }, ...inside, { t: at + len - 0.001, [f]: val(src + len - 0.001) }, { t: at + len, [f]: val(at) }, ...after]
        .sort((x, y) => x.t - y.t);
    }
  }
}

/** Linhas depois de abrir [at, at+len): o de depois anda para frente; no buraco, o valor do ponto. */
function insertLines(p, at, len) {
  for (const o of lineOwners(p)) {
    for (const [k, L] of Object.entries(AUTO_LINES)) {
      const v = o[k];
      if (!v?.length) continue;
      const f = L.f;
      const mid = autoValueAt(v, at, f);
      const before = v.filter((x) => x.t <= at);
      const after = v.filter((x) => x.t > at).map((x) => ({ t: x.t + len, [f]: x[f] }));
      o[k] = [...before, { t: at, [f]: mid }, { t: at + len, [f]: mid }, ...after];
    }
  }
}

/** Trecho (s, na linha do tempo de agora) que uma tomada cobre no canal; null se não está pronta. */
export function takeExtent(p, ch, takeId) {
  const t = doneTake(p, takeId);
  if (!t) return null;
  const segs = takeSegments(takeLen(t), t.audioStart + ch.offsetMs / 1000, cutsFor(p, t));
  return segs.length ? { from: Math.max(0, segs[0].from), to: segs[segs.length - 1].to } : null;
}

/** Instante (s) onde começa a tomada principal do canal, sem os cortes de início e fim; null sem tomada. */
export function baseExtent(p, ch) {
  const base = doneTake(p, ch.takeId);
  if (!base) return null;
  const segs = takeSegments(takeLen(base), base.audioStart + ch.offsetMs / 1000, cutsFor(p, base));
  return segs.length ? { from: Math.max(0, segs[0].from), to: segs[segs.length - 1].to } : null;
}

/**
 * Até onde o início e o fim do punch-in i podem ir: dentro do que foi gravado na tomada dele e sem
 * encostar nos vizinhos. Os punch-ins precisam estar na escala atual (normalizePunches antes).
 */
export function punchLimits(p, ch, i) {
  const list = ch.punches;
  const x = list[i];
  const t = p.takes[x.takeId];
  const segs = t ? takeSegments(takeLen(t), t.audioStart + ch.offsetMs / 1000, cutsFor(p, t)) : [];
  const lo = (segs.length ? Math.max(0, segs[0].from) : x.start) + PUNCH_XF;
  const hi = (segs.length ? segs[segs.length - 1].to : x.end) - PUNCH_XF;
  return { min: Math.max(lo, list[i - 1]?.end ?? 0), max: Math.min(hi, list[i + 1]?.start ?? Infinity) };
}

/**
 * Região audível de um canal na linha do tempo (segundos).
 * take.audioStart = posição na linha do tempo da 1ª amostra gravada (negativa: inclui a contagem).
 */
/** Canal cujo quadro mostra os pads da bateria: só visual, fica fora da mixagem (sem strip e sem som). */
export const showsDrums = (p, ch) => ch.show === 'drums' && !!p.drums;

export function channelRegion(ch, take) {
  const tlStart = take.audioStart + ch.offsetMs / 1000;
  const len = take.frames / take.sampleRate;
  const tlEnd = tlStart + len - Math.max(0, ch.trimEnd || 0);
  const start = Math.max(0, ch.trimStart || 0, tlStart);
  return { tlStart, tlEnd, start };
}

/**
 * Tempo dentro do vídeo da tomada correspondente a um instante da linha do tempo.
 * `shift`: quanto o trecho andou para trás com os compassos removidos (vem de takeSpans).
 */
export function videoTimeAt(ch, take, tl, shift = 0, freeze = null) {
  if (freeze != null && tl > freeze) tl = freeze - 0.001; // no silêncio de compassos inseridos o quadro fica parado
  return tl - shift - ((take.videoStart ?? 0) + ch.offsetMs / 1000);
}

// ---------- Punch-in ----------

/** Metade da transição entre a tomada e o punch-in (a troca leva 2 × isso, ~20 ms). */
export const PUNCH_XF = 0.01;

const doneTake = (p, id) => { const t = id && p.takes[id]; return t && t.status === 'done' ? t : null; };

/** Punch-ins válidos do canal, em ordem. */
function livePunches(p, ch) {
  return (ch.punches || []).filter((x) => doneTake(p, x.takeId) && x.end > x.start).sort((a, b) => a.start - b.start);
}

// ---------- Cortes (compassos removidos) ----------

/** Cortes que valem para uma mídia (tomada, punch-in ou guia): os feitos depois que ela entrou. */
export const cutsFor = (p, media) => (p.cuts || []).slice(media?.cutBase || 0);

/** Posição `x` depois dos cortes; o que caía dentro de um trecho removido vai para o início dele. */
export function mapPoint(x, cuts) {
  for (const c of cuts) {
    if (c.ins || c.dup) { if (x >= c.at) x += c.len; continue; } // compassos inseridos/duplicados: o de depois anda para frente
    if (x >= c.at + c.len) x -= c.len;
    else if (x > c.at) x = c.at;
  }
  return x;
}

/**
 * Um trecho [a, b) depois dos cortes, inserções e duplicações: pode virar vários (um trecho duplicado
 * aparece de novo na cópia). Devolve [[a, b], …] em ordem, sem os vazios.
 */
export function mapRanges(a, b, cuts) {
  let list = [[a, b]];
  for (const c of cuts) {
    const out = [];
    for (const [x, y] of list) {
      if (c.dup || c.ins) {
        if (x < c.at) out.push([x, Math.min(y, c.at)]);
        if (y > c.at) out.push([Math.max(x, c.at) + c.len, y + c.len]);
        if (c.dup) {
          const s = Math.max(x, c.src);
          const e = Math.min(y, c.src + c.len);
          if (e - s > 1e-6) out.push([s + c.at - c.src, e + c.at - c.src]);
        }
      } else {
        out.push([mapPoint(x, [c]), mapPoint(y, [c])]);
      }
    }
    list = out.filter(([x, y]) => y - x > 1e-6).sort((p, q) => p[0] - q[0]);
  }
  return list;
}

/**
 * Trechos de uma mídia de `len` segundos que começa em `place`, depois dos cortes:
 * [{ from, to, tlStart }] (tlStart = onde a amostra 0 cai na linha do tempo, para tocar o trecho).
 * Cada corte mantém o que vem antes, descarta [at, at+len) e puxa o que vem depois em −len.
 */
export function takeSegments(len, place, cuts) {
  let segs = [{ from: place, to: place + len, tlStart: place }];
  for (const c of cuts) {
    const e = c.at + c.len;
    const out = [];
    if (c.dup) {
      // Trecho duplicado: [src, src+len) se repete em [at, at+len) e o que vem depois de `at` anda para frente
      const d = c.at - c.src;
      for (const g of segs) {
        if (g.from < c.at) out.push({ ...g, to: Math.min(g.to, c.at) });
        if (g.to > c.at) out.push({ from: Math.max(g.from, c.at) + c.len, to: g.to + c.len, tlStart: g.tlStart + c.len });
        const a = Math.max(g.from, c.src);
        const b = Math.min(g.to, c.src + c.len);
        if (b - a > 1e-6) out.push({ from: a + d, to: b + d, tlStart: g.tlStart + d });
      }
      segs = out.filter((g) => g.to - g.from > 1e-6).sort((x, y) => x.from - y.from);
      continue;
    }
    if (c.ins) {
      // Compassos inseridos: o que vem depois do ponto anda para frente e fica um silêncio no meio
      for (const g of segs) {
        if (g.to <= c.at) out.push(g);
        else if (g.from >= c.at) out.push({ from: g.from + c.len, to: g.to + c.len, tlStart: g.tlStart + c.len });
        else {
          out.push({ ...g, to: c.at });
          out.push({ from: e, to: g.to + c.len, tlStart: g.tlStart + c.len });
        }
      }
      segs = out;
      continue;
    }
    for (const g of segs) {
      if (g.to <= c.at) out.push(g);
      else if (g.from >= e) out.push({ from: g.from - c.len, to: g.to - c.len, tlStart: g.tlStart - c.len });
      else {
        if (g.from < c.at) out.push({ ...g, to: c.at });
        if (g.to > e) out.push({ from: c.at, to: g.to - c.len, tlStart: g.tlStart - c.len });
      }
    }
    segs = out;
  }
  return segs;
}

const MIN_PIECE = 0.005;
const takeLen = (t) => t.frames / t.sampleRate;
const clipTo = (list, a, b) => list
  .map((g) => ({ ...g, from: Math.max(g.from, a), to: Math.min(g.to, b) }))
  .filter((g) => g.to - g.from > MIN_PIECE);

/**
 * Emendas: trechos encostados (corte ou punch-in) ganham transição. Cada lado avança PUNCH_XF
 * sobre o vizinho quando há mídia para isso e é marcado com xfIn/xfOut (o mix-graph faz a rampa).
 */
function withSeams(list, lenOf) {
  return list.map((g, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const xfIn = !!prev && Math.abs(prev.to - g.from) < 1e-4;
    const xfOut = !!next && Math.abs(next.from - g.to) < 1e-4;
    return {
      ...g,
      from: xfIn ? Math.max(g.from - PUNCH_XF, g.tlStart, 0) : g.from,
      to: xfOut ? Math.min(g.to + PUNCH_XF, g.tlStart + lenOf(g)) : g.to,
      xfIn,
      xfOut,
    };
  });
}

/** Trechos de um canal sem transição, em ordem e sem sobreposição: tomada principal e punch-ins. */
function rawPieces(p, ch) {
  const base = doneTake(p, ch.takeId);
  if (!base) return [];
  const off = ch.offsetMs / 1000;
  const place = base.audioStart + off;
  const segs = takeSegments(takeLen(base), place, cutsFor(p, base));
  if (!segs.length) return [];
  const lo = Math.max(0, ch.trimStart || 0);
  const hi = segs[segs.length - 1].to - Math.max(0, ch.trimEnd || 0);
  let out = clipTo(segs, lo, hi).map((g) => ({ ...g, bufId: ch.id, take: base, place }));
  for (const x of livePunches(p, ch)) {
    const t = p.takes[x.takeId];
    for (const [ra, we] of mapRanges(x.start, x.end, cutsFor(p, x))) {
    const ws = Math.max(0, ra);
    if (we - ws < MIN_PIECE) continue; // o trecho do punch-in foi removido
    const pplace = t.audioStart + off;
    const ps = clipTo(takeSegments(takeLen(t), pplace, cutsFor(p, t)), ws, we)
      .map((g) => ({ ...g, bufId: `${ch.id}#${t.id}`, take: t, place: pplace }));
    // O trecho do punch-in substitui o que estava embaixo dele.
    out = out.flatMap((g) => {
      if (g.to <= ws || g.from >= we) return [g];
      const r = [];
      if (g.from < ws) r.push({ ...g, to: ws });
      if (g.to > we) r.push({ ...g, from: we });
      return r;
    }).filter((g) => g.to - g.from > MIN_PIECE);
    out.push(...ps);
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Trechos de áudio de um canal: tomada principal, punch-ins e emendas dos compassos removidos.
 * Cada item: { bufId, take, tlStart (posição da 1ª amostra), from, to, xfIn, xfOut }; xfIn/xfOut marcam
 * as bordas que fazem transição com o trecho vizinho (rampa de 2·PUNCH_XF centrada na emenda).
 */
export function channelPieces(p, ch) {
  return withSeams(rawPieces(p, ch), (g) => takeLen(g.take))
    .map(({ bufId, take, tlStart, from, to, xfIn, xfOut }) => ({ bufId, take, tlStart, from, to, xfIn, xfOut }));
}

/**
 * Qual tomada o quadro mostra em cada trecho: [{ take, from, to, shift }] cobrindo a linha do tempo
 * inteira (o vídeo troca seco nas emendas). `shift` = quanto o trecho andou com os cortes (videoTimeAt).
 */
export function takeSpans(p, ch) {
  const out = rawPieces(p, ch).map((g) => ({ take: g.take, from: g.from, to: g.to, shift: g.tlStart - g.place }));
  if (!out.length) return [];
  for (let i = 0; i < out.length - 1; i++) {
    // Buraco entre dois trechos (compassos inseridos): o quadro fica parado no último quadro de antes.
    if (out[i + 1].from - out[i].to > 0.02) out[i].freeze = out[i].to;
    out[i].to = out[i + 1].from;
  }
  out[0].from = -Infinity;
  out[out.length - 1].to = Infinity;
  return out;
}

/** Trechos da faixa-guia depois dos cortes (mesmo formato de channelPieces, sem bufId). */
export function guidePieces(p) {
  const g = p.guide;
  if (!g?.duration) return [];
  const segs = takeSegments(g.duration, g.offsetMs / 1000, cutsFor(p, g)).filter((x) => x.to - x.from > MIN_PIECE);
  return withSeams(segs, () => g.duration).map((x) => ({ ...x, from: Math.max(0, x.from) }));
}

/** Leva os punch-ins do canal para a escala de agora (antes de comparar com um punch-in novo). */
export function normalizePunches(p, ch) {
  // Um punch-in num trecho duplicado vira dois (o original e o da cópia).
  ch.punches = (ch.punches || []).flatMap((x) => mapRanges(x.start, x.end, cutsFor(p, x))
    .map(([s, e]) => ({ ...x, start: Math.max(0, s), end: e, cutBase: p.cuts.length })))
    .filter((x) => x.end - x.start >= 0.05).sort((a, b) => a.start - b.start);
}

/**
 * Remove os compassos [a, b) (contados de 0, fim exclusivo) da música inteira; o que vem depois anda
 * para trás. A bateria, as observações, o loop e o corte de início mudam aqui; o áudio e o vídeo
 * gravados (e a guia) ficam como estão e passam pelo corte guardado em p.cuts.
 * Devolve { bars, splitBlocks }: splitBlocks = blocos da bateria cortados no meio do padrão (a parte
 * de depois recomeça o padrão).
 */
export function removeBars(p, a, b) {
  a = Math.max(0, Math.floor(a));
  b = Math.max(a + 1, Math.floor(b));
  const n = b - a;
  const bar = barSec(p);
  const cut = { at: a * bar, len: n * bar };
  const splitBlocks = p.drums ? removeDrumBars(p.drums, a, b) : 0;
  const bpb = beatsPerBar(p.timeSig);
  p.notes = p.notes
    .filter((x) => x.beat < a * bpb || x.beat >= b * bpb)
    .map((x) => (x.beat >= b * bpb ? { ...x, beat: x.beat - n * bpb } : x));
  // Trocas de layout: as de depois andam para trás; as de dentro do trecho vão para o ponto do corte
  // (só a última delas fica, para o layout de depois do corte continuar o mesmo).
  const lc = [];
  for (const x of p.layoutChanges || []) {
    const beat = x.beat < a * bpb ? x.beat : x.beat >= b * bpb ? x.beat - n * bpb : a * bpb;
    const prev = lc[lc.length - 1];
    if (prev && Math.abs(prev.beat - beat) < 1e-6) lc.pop();
    if (beat > 0) lc.push({ ...x, beat });
    else { p.layoutId = x.layoutId; p.featured = x.featured; }
  }
  p.layoutChanges = lc;
  // Letra: o que estava dentro do trecho sai; o que atravessa o corte encolhe
  const A0 = a * bpb;
  const B0 = b * bpb;
  const nb = n * bpb;
  const mapB = (x) => (x <= A0 ? x : x >= B0 ? x - nb : A0);
  p.lyrics = (p.lyrics || []).map((x) => ({ ...x, beat: mapB(x.beat), end: mapB(x.end) })).filter((x) => x.end - x.beat > 0.01);
  const mb = (x) => (x < a ? x : x >= b ? x - n : a);
  p.sections = (p.sections || []).map((x) => ({ ...x, start: mb(x.start), end: mb(x.end) })).filter((x) => x.end > x.start);
  p.loop.start = mb(p.loop.start);
  p.loop.end = Math.max(p.loop.start + 1, mb(p.loop.end));
  for (const ch of p.channels) if (ch.trimStart > 0) ch.trimStart = mapPoint(ch.trimStart, [cut]);
  cutLines(p, cut); // linhas de volume e pan
  p.cuts.push(cut);
  return { bars: n, splitBlocks };
}

/**
 * Insere `n` compassos vazios antes do compasso `a` (contado de 0) na música inteira: o que vem depois
 * anda para frente. Como na remoção, o áudio e o vídeo gravados passam pela entrada guardada em p.cuts.
 * Devolve { bars, splitBlocks } (blocos da bateria divididos no meio do padrão).
 */
export function insertBars(p, a, n) {
  a = Math.max(0, Math.floor(a));
  n = Math.max(1, Math.floor(n));
  const bar = barSec(p);
  const at = a * bar;
  const len = n * bar;
  let splitBlocks = 0;
  if (p.drums) {
    const out = [];
    for (const k of p.drums.blocks) {
      const e = k.start + k.bars;
      if (e <= a) out.push(k);
      else if (k.start >= a) out.push({ ...k, start: k.start + n });
      else {
        // bloco que atravessa o ponto: a parte de depois vai para frente
        const pb = p.drums.patterns.find((x) => x.id === k.pattern)?.bars || 1;
        if ((a - k.start) % pb) splitBlocks++;
        out.push({ ...k, bars: a - k.start });
        out.push({ ...k, id: uid('b'), start: a + n, bars: e - a });
      }
    }
    p.drums.blocks = out.sort((x, y) => x.start - y.start);
  }
  const bpb = beatsPerBar(p.timeSig);
  const nb = n * bpb;
  p.notes = p.notes.map((x) => (x.beat >= a * bpb ? { ...x, beat: x.beat + nb } : x));
  p.layoutChanges = (p.layoutChanges || []).map((x) => (x.beat >= a * bpb ? { ...x, beat: x.beat + nb } : x));
  // Letra: a que começa depois do ponto anda; a que atravessa o ponto fica e acaba nele
  p.lyrics = (p.lyrics || []).map((x) => (x.beat >= a * bpb ? { ...x, beat: x.beat + nb, end: x.end + nb }
    : x.end > a * bpb ? { ...x, end: a * bpb } : x));
  if (p.loop.start >= a) p.loop.start += n;
  if (p.loop.end > a) p.loop.end += n;
  p.sections = (p.sections || []).map((x) => (x.start >= a ? { ...x, start: x.start + n, end: x.end + n } : x.end > a ? { ...x, end: x.end + n } : x));
  for (const ch of p.channels) if (ch.trimStart > 0 && ch.trimStart >= at) ch.trimStart += len;
  insertLines(p, at, len);
  p.cuts.push({ at, len, ins: true });
  return { bars: n, splitBlocks };
}

/** Cores das seções (a próxima seção nova pega a cor seguinte). */
export const SECTION_COLORS = ['#4f9d8f', '#9d6b4f', '#6b6fd1', '#b0507a', '#7d9d3f', '#c08a2e', '#4f86b5', '#8a5fb0'];

/**
 * Duplica os compassos [s, e) (contados de 0, fim exclusivo): a cópia entra logo depois, em [e, 2e−s), e o
 * que vinha depois anda para frente. Vai tudo: bateria, observações, letra, trocas de layout, seções,
 * linhas de volume/pan e o que foi gravado (som e vídeo, pela entrada guardada em p.cuts).
 * Devolve { bars, splitBlocks }.
 */
export function duplicateBars(p, s, e) {
  s = Math.max(0, Math.floor(s));
  e = Math.max(s + 1, Math.floor(e));
  const n = e - s;
  const bar = barSec(p);
  const bpb = beatsPerBar(p.timeSig);
  const S = s * bpb;
  const E = e * bpb;
  const nb = n * bpb;
  let splitBlocks = 0;
  if (p.drums) {
    const out = [];
    const copies = [];
    for (const k of p.drums.blocks) {
      const ke = k.start + k.bars;
      // o original: antes de e fica; o que passa de e anda para frente
      if (ke <= e) out.push(k);
      else if (k.start >= e) out.push({ ...k, start: k.start + n });
      else { out.push({ ...k, bars: e - k.start }); out.push({ ...k, id: uid('b'), start: e + n, bars: ke - e }); }
      // a cópia: a parte dentro de [s, e)
      const a = Math.max(k.start, s);
      const b = Math.min(ke, e);
      if (b > a) {
        const pb = p.drums.patterns.find((x) => x.id === k.pattern)?.bars || 1;
        if ((a - k.start) % pb) splitBlocks++;
        copies.push({ ...k, id: uid('b'), start: a + n, bars: b - a });
      }
    }
    p.drums.blocks = [...out, ...copies].sort((x, y) => x.start - y.start);
  }
  const dupBeats = (list) => {
    const after = list.map((x) => (x.beat >= E ? { ...x, beat: x.beat + nb, ...(x.end != null ? { end: x.end + nb } : {}) } : x));
    const copies = list.filter((x) => x.beat >= S && x.beat < E)
      .map((x) => ({ ...x, id: uid('d'), beat: x.beat + nb, ...(x.end != null ? { end: Math.min(x.end, E) + nb } : {}) }));
    return [...after, ...copies].sort((a, b) => a.beat - b.beat);
  };
  p.notes = dupBeats(p.notes);
  p.layoutChanges = dupBeats(p.layoutChanges || []);
  // letra: a frase que atravessa o fim do trecho acaba nele (a cópia começa logo ali)
  p.lyrics = dupBeats((p.lyrics || []).map((x) => (x.beat < E && x.end > E ? { ...x, end: E } : x)));
  p.sections = [
    ...(p.sections || []).map((x) => (x.start >= e ? { ...x, start: x.start + n, end: x.end + n } : x.end > e ? { ...x, end: x.end + n } : x)),
    ...(p.sections || []).filter((x) => x.start >= s && x.end <= e).map((x) => ({ ...x, id: uid('sc'), start: x.start + n, end: x.end + n })),
  ].sort((a, b) => a.start - b.start);
  if (p.loop.start >= e) p.loop.start += n;
  if (p.loop.end > e) p.loop.end += n;
  const at = e * bar;
  const len = n * bar;
  const src = s * bar;
  for (const ch of p.channels) if (ch.trimStart > 0 && ch.trimStart >= at) ch.trimStart += len;
  dupLines(p, src, at, len);
  p.cuts.push({ at, len, src, dup: true });
  return { bars: n, splitBlocks };
}

/** Blocos da bateria: os de depois andam −n compassos; o bloco cortado no meio vira dois (ou um só). */
function removeDrumBars(d, a, b) {
  const n = b - a;
  const out = [];
  let split = 0;
  for (const k of d.blocks) {
    const e = k.start + k.bars;
    if (e <= a) { out.push(k); continue; }
    if (k.start >= b) { out.push({ ...k, start: k.start - n }); continue; }
    const pat = d.patterns.find((x) => x.id === k.pattern);
    const pb = pat?.bars || 1;
    const head = k.start < a ? { ...k, bars: a - k.start } : null;
    const tail = e > b ? { ...k, id: uid('b'), start: a, bars: e - b } : null;
    if (head && tail && n % pb === 0) { out.push({ ...k, bars: k.bars - n }); continue; } // o padrão segue sem quebra
    if (head) out.push(head);
    if (tail) {
      if ((b - k.start) % pb) split++;
      out.push(tail);
    }
  }
  d.blocks = out.sort((x, y) => x.start - y.start);
  return split;
}

/** Tomada que o quadro do canal mostra no instante `tl`. */
export function takeAt(p, ch, tl) {
  const s = takeSpans(p, ch).find((x) => tl >= x.from && tl < x.to);
  return s ? s.take : null;
}

/** Põe um punch-in no canal; os que ele cobre saem ou são cortados (o mais novo vale). */
export function addPunch(ch, punch) {
  const keep = [];
  for (const x of ch.punches || []) {
    if (x.end <= punch.start || x.start >= punch.end) { keep.push(x); continue; }
    if (x.start < punch.start) keep.push({ ...x, end: punch.start });
    if (x.end > punch.end) keep.push({ ...x, start: punch.end });
  }
  keep.push(punch);
  ch.punches = keep.filter((x) => x.end - x.start >= 0.05).sort((a, b) => a.start - b.start);
}

export function projectDuration(p) {
  let d = 0;
  for (const ch of p.channels) {
    for (const pc of channelPieces(p, ch)) d = Math.max(d, pc.to);
  }
  for (const g of guidePieces(p)) d = Math.max(d, g.to);
  if (p.drums) d = Math.max(d, drumsEndBar(p.drums) * barSec(p));
  return Math.max(0, d);
}

/** Duração de um compasso, em segundos. */
export const barSec = (p) => beatsPerBar(p.timeSig) * 60 / p.bpm;

/** Região de loop em segundos, ou null se desligado/inválido. */
export function loopRange(p) {
  const l = p.loop;
  if (!l?.on || !(l.end > l.start)) return null;
  const b = barSec(p);
  return { start: l.start * b, end: l.end * b };
}

export function referencedTakes(p) {
  const s = new Set(p.channels.map((c) => c.takeId).filter(Boolean));
  for (const c of p.channels) for (const x of c.punches || []) s.add(x.takeId);
  // tomadas guardadas e os punch-ins delas continuam no disco
  for (const c of p.channels) {
    for (const a of c.altTakes || []) {
      s.add(a.takeId);
      for (const x of a.punches || []) s.add(x.takeId);
    }
  }
  if (p.pendingTake) s.add(p.pendingTake.takeId);
  return s;
}
