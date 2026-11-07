// Arquivos MIDI (.mid): leitura, faixa-guia sintetizada e importação para a bateria.
//
// A faixa-guia em MIDI vira áudio (um sintetizador simples por família de instrumento do
// General MIDI; o canal 10 usa o kit da bateria). Ela é guardada como WAV, então loop, mixer e
// exportação seguem o mesmo caminho da guia em áudio.
import {
  createPad, createPattern, getKit, gmDrumVoice, GM_NOTE, GM_TO_SOUND, PPQ, placeBlock, SOUND_NAMES, ticksPerBar,
} from './drums.js';

const DRUM_CH = 9; // canal 10

// ---------------------------------------------------------------- Leitura

/**
 * Lê um arquivo MIDI (formato 0, 1 ou 2). Devolve
 * { division, smpte, notes: [{ tick, end, ch, note, vel, sec, endSec }], ccs, bends, programs,
 *   tempos: [{ tick, uspq }], timeSigs: [{ tick, num, den }], tickToSec(tick), duration, name }.
 * As notas já vêm com o fim (note off) casado.
 */
export function parseMidi(buffer) {
  const b = new Uint8Array(buffer);
  let o = 0;
  const u32 = () => { const v = (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; o += 4; return v; };
  const u16 = () => { const v = b[o] << 8 | b[o + 1]; o += 2; return v; };
  const str4 = () => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  // RIFF MIDI (.rmi): o MIDI fica dentro do bloco "data"
  if (str4() === 'RIFF') {
    const i = findBytes(b, [0x4d, 0x54, 0x68, 0x64]);
    if (i < 0) throw new Error('arquivo RMI sem dados MIDI');
    o = i;
  }
  if (str4() !== 'MThd') throw new Error('não é um arquivo MIDI (.mid)');
  o += 4;
  const hlen = u32();
  const hstart = o;
  u16(); // formato
  const ntracks = u16();
  const div = u16();
  o = hstart + hlen;
  const smpte = (div & 0x8000) !== 0;
  // SMPTE: ticks por segundo fixos (raro); senão ticks por semínima
  const tps = smpte ? (256 - (div >> 8)) * (div & 0xff) : 0;
  const division = smpte ? 0 : div || 96;

  const raw = []; // { tick, kind, ... } de todas as trilhas
  let name = '';
  for (let tr = 0; tr < ntracks && o + 8 <= b.length; tr++) {
    const id = str4();
    o += 4;
    const len = u32();
    const end = Math.min(b.length, o + len);
    if (id !== 'MTrk') { o = end; tr--; continue; }
    let tick = 0;
    let status = 0;
    while (o < end) {
      let delta = 0;
      for (let k = 0; k < 4; k++) { const c = b[o++]; delta = (delta << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
      tick += delta;
      let st = b[o];
      if (st & 0x80) o++;
      else st = status; // running status
      if (st === 0xff) {
        const type = b[o++];
        const ml = vlq();
        const data = b.subarray(o, o + ml);
        o += ml;
        if (type === 0x51 && ml >= 3) raw.push({ tick, kind: 'tempo', uspq: (data[0] << 16) | (data[1] << 8) | data[2] });
        else if (type === 0x58 && ml >= 2) raw.push({ tick, kind: 'ts', num: data[0], den: 2 ** data[1] });
        else if (type === 0x03 && !name && tr === 0) name = new TextDecoder().decode(data).trim();
        else if (type === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { o += vlq(); continue; }
      if (!(st & 0x80)) break; // arquivo corrompido: para esta trilha
      status = st;
      const type = st & 0xf0;
      const ch = st & 0x0f;
      const d1 = b[o++];
      const d2 = type === 0xc0 || type === 0xd0 ? 0 : b[o++];
      if (type === 0x90 && d2 > 0) raw.push({ tick, kind: 'on', ch, note: d1, vel: d2, tr });
      else if (type === 0x80 || type === 0x90) raw.push({ tick, kind: 'off', ch, note: d1, tr });
      else if (type === 0xb0) raw.push({ tick, kind: 'cc', ch, cc: d1, val: d2 });
      else if (type === 0xc0) raw.push({ tick, kind: 'pc', ch, program: d1 });
      else if (type === 0xe0) raw.push({ tick, kind: 'bend', ch, val: ((d2 << 7) | d1) - 8192 });
    }
    o = end;
  }

  function vlq() {
    let v = 0;
    for (let k = 0; k < 4; k++) { const c = b[o++]; v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
    return v;
  }

  // ordem estável: no mesmo tick, note off antes de note on (notas repetidas)
  const rank = { tempo: 0, ts: 0, pc: 1, cc: 2, bend: 2, off: 3, on: 4 };
  raw.sort((a, c) => a.tick - c.tick || rank[a.kind] - rank[c.kind]);

  const tempos = raw.filter((x) => x.kind === 'tempo').map(({ tick, uspq }) => ({ tick, uspq }));
  const timeSigs = raw.filter((x) => x.kind === 'ts').map(({ tick, num, den }) => ({ tick, num, den }));

  // tick → segundos com o mapa de tempo
  const segs = [];
  let sec = 0;
  let lastTick = 0;
  let uspq = 500000;
  for (const t of tempos) {
    sec += ((t.tick - lastTick) * uspq) / 1e6 / division;
    segs.push({ tick: t.tick, sec, uspq: t.uspq });
    lastTick = t.tick;
    uspq = t.uspq;
  }
  const tickToSec = smpte
    ? (tick) => tick / tps
    : (tick) => {
      let s = 0, lt = 0, u = 500000;
      let lo = 0, hi = segs.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].tick <= tick) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx >= 0) { s = segs[idx].sec; lt = segs[idx].tick; u = segs[idx].uspq; }
      return s + ((tick - lt) * u) / 1e6 / division;
    };

  const notes = [];
  const open = new Map(); // `${tr}|${ch}|${note}` → pilha de notas abertas
  const ccs = [];
  const bends = [];
  const programs = [];
  let lastEvTick = 0;
  for (const e of raw) {
    lastEvTick = Math.max(lastEvTick, e.tick);
    if (e.kind === 'on') {
      const n = { tick: e.tick, end: null, ch: e.ch, note: e.note, vel: e.vel };
      notes.push(n);
      const k = `${e.tr}|${e.ch}|${e.note}`;
      if (!open.has(k)) open.set(k, []);
      open.get(k).push(n);
    } else if (e.kind === 'off') {
      const st = open.get(`${e.tr}|${e.ch}|${e.note}`);
      const n = st?.shift(); // a mais antiga primeiro
      if (n) n.end = e.tick;
    } else if (e.kind === 'cc') ccs.push(e);
    else if (e.kind === 'bend') bends.push(e);
    else if (e.kind === 'pc') programs.push(e);
  }
  const defLen = (division || 96) / 2;
  for (const n of notes) {
    if (n.end == null || n.end < n.tick) n.end = Math.max(n.tick + defLen, lastEvTick);
    n.sec = tickToSec(n.tick);
    n.endSec = tickToSec(n.end);
  }
  for (const e of [...ccs, ...bends, ...programs]) e.sec = tickToSec(e.tick);
  const duration = notes.reduce((m, n) => Math.max(m, n.endSec), 0);
  return { division, smpte, tps, notes, ccs, bends, programs, tempos, timeSigs, tickToSec, duration, name };
}

function findBytes(b, pat) {
  outer: for (let i = 0; i + pat.length <= b.length; i++) {
    for (let k = 0; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

/** Tempo (BPM) e compasso do começo do arquivo, se ele disser. */
export function midiMeta(m) {
  const t0 = m.tempos.find((x) => x.tick === 0) || m.tempos[0];
  const ts0 = m.timeSigs.find((x) => x.tick === 0) || m.timeSigs[0];
  const bpm = t0 ? Math.round((60000000 / t0.uspq) * 100) / 100 : null;
  const tempoChanges = new Set(m.tempos.map((x) => x.uspq)).size > 1;
  return { bpm, timeSig: ts0 ? `${ts0.num}/${ts0.den}` : null, tempoChanges };
}

// ---------------------------------------------------------------- Faixa-guia: sintetizador

// Timbres por família do General MIDI (programa / 8).
// w: onda; w2/det: segunda onda e desafinação (cents); a/d/s/r: envelope (s = nível de sustentação,
// 0 = som que morre sozinho, como piano e violão); cut: corte do filtro (× frequência da nota);
// fenv: quanto o filtro abre no ataque; oct2: 2ª onda uma oitava acima.
const FAMILY = [
  { w: 'triangle', w2: 'sine', oct2: true, a: 0.003, d: 1.6, s: 0, r: 0.25, cut: 9, fenv: 2, g: 1 }, // piano
  { w: 'sine', w2: 'sine', det: 1200 * Math.log2(3.5), a: 0.001, d: 0.9, s: 0, r: 0.3, cut: 20, fenv: 0, g: 0.8 }, // percussão cromática
  { w: 'square', w2: 'sine', oct2: true, a: 0.01, d: 0.1, s: 0.9, r: 0.08, cut: 5, fenv: 0, g: 0.5 }, // órgão
  { w: 'sawtooth', a: 0.002, d: 1.4, s: 0, r: 0.15, cut: 4, fenv: 4, g: 0.7 }, // violão/guitarra
  { w: 'sawtooth', w2: 'sine', a: 0.004, d: 0.9, s: 0.5, r: 0.08, cut: 3, fenv: 3, g: 1 }, // baixo
  { w: 'sawtooth', w2: 'sawtooth', det: 9, a: 0.09, d: 0.3, s: 0.85, r: 0.35, cut: 5, fenv: 0, g: 0.45 }, // cordas
  { w: 'sawtooth', w2: 'sawtooth', det: 12, a: 0.12, d: 0.3, s: 0.85, r: 0.45, cut: 4, fenv: 0, g: 0.45 }, // conjunto / coro
  { w: 'sawtooth', a: 0.03, d: 0.2, s: 0.8, r: 0.12, cut: 3, fenv: 3, g: 0.55 }, // metais
  { w: 'square', a: 0.03, d: 0.2, s: 0.8, r: 0.1, cut: 3, fenv: 1, g: 0.45 }, // palhetas
  { w: 'triangle', w2: 'sine', oct2: true, a: 0.04, d: 0.2, s: 0.85, r: 0.15, cut: 8, fenv: 0, g: 0.7 }, // flautas
  { w: 'square', w2: 'sawtooth', det: 7, a: 0.005, d: 0.2, s: 0.8, r: 0.1, cut: 6, fenv: 2, g: 0.4 }, // synth lead
  { w: 'sawtooth', w2: 'triangle', det: 7, a: 0.3, d: 0.5, s: 0.8, r: 0.6, cut: 3, fenv: 0, g: 0.45 }, // synth pad
  { w: 'sawtooth', a: 0.05, d: 0.6, s: 0.5, r: 0.4, cut: 4, fenv: 1, g: 0.45 }, // efeitos
  { w: 'triangle', w2: 'sawtooth', a: 0.002, d: 1.0, s: 0, r: 0.2, cut: 6, fenv: 3, g: 0.7 }, // étnicos (sitar, banjo…)
  { w: 'sine', w2: 'triangle', a: 0.001, d: 0.5, s: 0, r: 0.15, cut: 10, fenv: 0, g: 0.9 }, // percussivos
  { w: 'triangle', a: 0.02, d: 0.4, s: 0.3, r: 0.3, cut: 4, fenv: 0, g: 0.4 }, // efeitos sonoros
];

const MAX_SEC = 20 * 60;

/** Valor de um controle (CC) no canal, no instante `sec` (último valor até ali). */
function ccAt(list, sec, dflt) {
  let v = dflt;
  for (const e of list) { if (e.sec > sec) break; v = e.val; }
  return v;
}

/**
 * Sintetiza o MIDI inteiro num AudioBuffer estéreo (normalizado em −1 dBFS).
 * `kitId`: kit usado no canal 10.
 */
export async function renderMidi(m, sampleRate = 48000, { kitId = 'synth' } = {}) {
  if (!m.notes.length) throw new Error('o arquivo não tem notas');
  const len = Math.min(MAX_SEC, m.duration + 3);
  const c = new OfflineAudioContext(2, Math.ceil(len * sampleRate), sampleRate);
  const master = c.createGain();
  master.gain.value = 0.25;
  master.connect(c.destination);

  const byCh = (list) => {
    const out = Array.from({ length: 16 }, () => []);
    for (const e of list) out[e.ch].push(e);
    return out;
  };
  const ccCh = byCh(m.ccs);
  const bendCh = byCh(m.bends);
  const pcCh = byCh(m.programs.map((x) => ({ ...x, val: x.program })));

  // Barramento por canal: volume (CC7) × expressão (CC11) → pan (CC10)
  const bus = [];
  for (let ch = 0; ch < 16; ch++) {
    const g = c.createGain();
    const pan = c.createStereoPanner();
    g.connect(pan).connect(master);
    let vol = 100, expr = 127;
    g.gain.setValueAtTime((vol / 127) * (expr / 127), 0);
    for (const e of ccCh[ch]) {
      if (e.cc === 7) vol = e.val;
      else if (e.cc === 11) expr = e.val;
      else if (e.cc === 10) { pan.pan.setValueAtTime(Math.max(-1, Math.min(1, (e.val - 64) / 63)), e.sec); continue; }
      else continue;
      const k = (vol / 127) * (expr / 127);
      g.gain.setTargetAtTime(k * k, e.sec, 0.01);
    }
    bus.push(g);
  }

  // Pedal de sustentação (CC64): uma nota solta com o pedal abaixado continua até o pedal subir
  const pedal = ccCh.map((l) => {
    const iv = [];
    let down = null;
    for (const e of l) {
      if (e.cc !== 64) continue;
      if (e.val >= 64 && down == null) down = e.sec;
      else if (e.val < 64 && down != null) { iv.push([down, e.sec]); down = null; }
    }
    if (down != null) iv.push([down, Infinity]);
    return iv;
  });
  const releaseAt = (ch, sec) => {
    for (const [a, b2] of pedal[ch]) if (sec >= a && sec < b2) return Math.min(b2, sec + 8);
    return sec;
  };

  let kit = null;
  if (m.notes.some((n) => n.ch === DRUM_CH)) {
    try { kit = await getKit(kitId, sampleRate); } catch { kit = await getKit('synth', sampleRate); } // sem a pasta kits/: sintetizado
  }
  let seed = 0;

  for (const n of m.notes) {
    if (n.sec >= len) continue;
    const v = n.vel / 127;
    if (n.ch === DRUM_CH) {
      const vo = gmDrumVoice(n.note, v, seed++, kit);
      if (!vo) continue;
      const s = c.createBufferSource();
      s.buffer = vo.buf;
      s.playbackRate.value = vo.rate;
      const g = c.createGain();
      g.gain.value = vo.gain * 1.3;
      s.connect(g).connect(bus[n.ch]);
      s.start(n.sec);
      continue;
    }
    const program = ccAt(pcCh[n.ch], n.sec, 0);
    const fam = FAMILY[program >> 3] || FAMILY[0];
    const f = 440 * 2 ** ((n.note - 69) / 12);
    const off = Math.max(n.sec + 0.02, releaseAt(n.ch, n.endSec));
    // som que morre sozinho (piano, violão…) não precisa durar mais que o decaimento
    const decayLen = fam.s ? Infinity : fam.d * (1.4 - Math.min(0.9, (n.note - 40) / 80));
    const stopAt = Math.min(off, n.sec + decayLen) + fam.r + 0.05;

    const env = c.createGain();
    const peak = v * v * fam.g;
    env.gain.setValueAtTime(0, n.sec);
    env.gain.linearRampToValueAtTime(peak, n.sec + fam.a);
    const sus = fam.s ? peak * fam.s : 0.0001;
    env.gain.setTargetAtTime(sus, n.sec + fam.a, fam.s ? fam.d / 3 : decayLen / 5);
    if (off < stopAt - fam.r - 0.04) {
      env.gain.cancelScheduledValues(off);
      env.gain.setTargetAtTime(0, off, fam.r / 4);
    }

    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    const cut = Math.min(18000, f * fam.cut + 300);
    filt.Q.value = 0.7;
    if (fam.fenv) {
      filt.frequency.setValueAtTime(Math.min(18000, cut * (1 + fam.fenv * v)), n.sec);
      filt.frequency.setTargetAtTime(cut, n.sec + fam.a, 0.12);
    } else filt.frequency.value = cut;
    filt.connect(env).connect(bus[n.ch]);

    const oscs = []; // [oscilador, desafinação própria]
    const mk = (type, freq, detune, gain) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = c.createGain();
      g.gain.value = gain;
      o.connect(g).connect(filt);
      o.start(n.sec);
      o.stop(stopAt);
      oscs.push([o, detune]);
    };
    mk(fam.w, f, fam.det && fam.w2 === fam.w ? -fam.det / 2 : 0, fam.w2 ? 0.65 : 1);
    if (fam.w2) mk(fam.w2, fam.oct2 ? f * 2 : f, fam.det ? (fam.w2 === fam.w ? fam.det / 2 : fam.det) : 0, fam.oct2 ? 0.2 : 0.45);

    // Pitch bend (faixa de ±2 semitons) durante a nota
    const bl = bendCh[n.ch];
    if (bl.length) {
      const bend = (val, at) => { for (const [o, det] of oscs) o.detune.setValueAtTime(det + (val / 8192) * 200, at); };
      bend(ccAt(bl, n.sec, 0), n.sec);
      for (const e of bl) {
        if (e.sec <= n.sec) continue;
        if (e.sec >= stopAt) break;
        bend(e.val, e.sec);
      }
    }
  }

  const buf = await c.startRendering();
  // corta o silêncio do fim e normaliza o pico
  let peak = 0;
  let last = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a > 1e-4 && i > last) last = i;
    }
  }
  if (peak > 0) {
    const k = 0.89 / peak;
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
  }
  const n = Math.min(buf.length, last + Math.round(0.2 * sampleRate));
  const out = new AudioBuffer({ length: Math.max(1, n), numberOfChannels: 2, sampleRate });
  out.copyToChannel(buf.getChannelData(0).subarray(0, n), 0);
  out.copyToChannel(buf.getChannelData(1).subarray(0, n), 1);
  return out;
}

// ---------------------------------------------------------------- Bateria: importação

/**
 * Notas de bateria do arquivo: as do canal 10; se não houver nenhuma, todas
 * (alguns programas salvam a bateria em outro canal).
 */
function drumNotes(m) {
  const ch10 = m.notes.filter((n) => n.ch === DRUM_CH);
  return ch10.length ? ch10 : m.notes;
}

/** Pad para uma nota: nota MIDI escolhida no pad → nota GM do som → cria um pad. */
function padForNote(d, note, created) {
  let pad = d.pads.find((x) => x.midiNote === note)
    || d.pads.find((x) => x.midiNote == null && !x.sample && GM_NOTE[x.sound] === note);
  if (pad) return pad;
  const sound = GM_TO_SOUND[note];
  if (!sound) return null;
  pad = d.pads.find((x) => x.midiNote == null && !x.sample && x.sound === sound);
  if (pad) return pad;
  pad = { ...createPad(sound), name: SOUND_NAMES[sound] };
  d.pads.push(pad);
  created.push(pad.name);
  return pad;
}

/** Converte a posição do arquivo para os ticks da bateria (96 por tempo do compasso do projeto). */
function tickConverter(p, m) {
  const den = parseInt(String(p.timeSig).split('/')[1], 10) || 4;
  if (m.smpte) return (n) => Math.round((n.sec * p.bpm) / 60 * PPQ);
  // semínima do arquivo → tempo do compasso do projeto
  return (n) => Math.round((n.tick / m.division) * PPQ * (den / 4));
}

/**
 * Importa as batidas do arquivo para a bateria.
 * mode 'song': a música inteira a partir do compasso `startBar` — cada compasso vira um padrão
 *   (compassos iguais usam o mesmo padrão; repetições seguidas viram um bloco só).
 * mode 'pattern': soma as batidas no padrão `patternId` (até 8 compassos).
 * Devolve { hits, patterns, bars, skipped: [notas sem som], created: [pads novos] }.
 */
export function importDrumsMidi(p, m, { mode = 'song', patternId = null, startBar = 0 } = {}) {
  const d = p.drums;
  const conv = tickConverter(p, m);
  const created = [];
  const skipped = new Set();
  const hits = [];
  for (const n of drumNotes(m)) {
    const t = conv(n);
    if (t < 0) continue;
    const pad = padForNote(d, n.note, created);
    if (!pad) { skipped.add(n.note); continue; }
    hits.push({ pad: pad.id, t, v: Math.max(0.05, Math.min(1, n.vel / 127)) });
  }
  const res = { hits: 0, patterns: 0, bars: 0, skipped: [...skipped].sort((a, b) => a - b), created, removed: [] };
  if (!hits.length) return res;
  const tpb = ticksPerBar(p);

  if (mode === 'pattern') {
    const pat = d.patterns.find((x) => x.id === patternId) || d.patterns[0];
    const lastBar = Math.floor(Math.max(...hits.map((x) => x.t)) / tpb) + 1;
    const want = [1, 2, 4, 8].find((x) => x >= lastBar) || 8;
    if (want > pat.bars) pat.bars = want;
    const limit = pat.bars * tpb;
    for (const x of hits) {
      if (x.t >= limit) continue;
      if (pat.hits.some((y) => y.pad === x.pad && y.t === x.t)) continue;
      pat.hits.push(x);
      res.hits++;
    }
    res.bars = pat.bars;
    res.removed = removeUnusedPads(d);
    return res;
  }

  // Música inteira: um padrão por compasso diferente
  const nBars = Math.floor(Math.max(...hits.map((x) => x.t)) / tpb) + 1;
  const perBar = Array.from({ length: nBars }, () => []);
  for (const x of hits) perBar[Math.floor(x.t / tpb)].push({ ...x, t: x.t % tpb });
  const keyOf = (l) => l.map((x) => `${x.pad}:${x.t}:${Math.round(x.v * 127)}`).sort().join(',');
  const byKey = new Map();
  const seq = perBar.map((l) => {
    if (!l.length) return null;
    const k = keyOf(l);
    let pat = byKey.get(k);
    if (!pat) {
      pat = createPattern(d, 1);
      pat.hits = l;
      d.patterns.push(pat);
      byKey.set(k, pat);
      res.patterns++;
    }
    res.hits += l.length;
    return pat.id;
  });
  placeBlock(d, startBar, nBars, null); // limpa o trecho
  for (let i = 0; i < nBars;) {
    let j = i + 1;
    while (j < nBars && seq[j] === seq[i]) j++;
    if (seq[i]) placeBlock(d, startBar + i, j - i, seq[i]);
    i = j;
  }
  const first = seq.find(Boolean);
  if (first) d.sel = first;
  res.bars = nBars;
  res.removed = removeUnusedPads(d);
  return res;
}

/** Tira os pads sem nenhuma batida em nenhum padrão (fica pelo menos um). Devolve os removidos. */
export function removeUnusedPads(d) {
  const used = new Set(d.patterns.flatMap((x) => x.hits.map((y) => y.pad)));
  const removed = d.pads.filter((x) => !used.has(x.id));
  if (removed.length === d.pads.length) removed.shift();
  if (!removed.length) return [];
  const gone = new Set(removed);
  d.pads = d.pads.filter((x) => !gone.has(x));
  return removed;
}
