// Faixa de bateria: kit sintetizado, padrões com posição fina e blocos ao longo da música.
//
// Cada batida guarda a posição em "ticks": 96 por tempo do compasso (como num arquivo MIDI), então o
// zoom e a grade só mudam como se edita — as batidas não se movem. Os padrões ficam em compassos,
// assim mudar o BPM ajusta tudo sozinho.
//
// Para tocar, o app gera um áudio único da bateria (como a faixa-guia). Assim loop, gravação,
// mixer e exportação usam o mesmo caminho já testado. Cada padrão é renderizado uma vez e copiado
// nas posições dos blocos; editar um padrão só renderiza esse padrão de novo.
import { barSec, beatsPerBar, defaultFx } from './project.js';
import { dbToGain, uid } from './util.js';

export const DRUMS_ID = 'drums';
/** Teclas do computador que tocam os pads (na ordem da lista) no modo "Tocar". */
export const LIVE_KEYS = 'qwertyuiopasdfghjklzxcvbnm';
export const PPQ = 96;

/** Todos os sons (id, nome). Cada kit toca os que tem; os que faltam vêm do kit sintetizado. */
export const KIT = [
  ['kick', 'Bumbo'], ['kick808', 'Bumbo 808 / aberto'], ['snare', 'Caixa'], ['rimshot', 'Caixa (rimshot)'], ['rim', 'Aro'],
  ['clap', 'Palmas'], ['hatC', 'Chimbal fechado'], ['hatP', 'Chimbal pedal'], ['hatO', 'Chimbal aberto'],
  ['tomH', 'Tom agudo'], ['tomM', 'Tom médio'], ['tomL', 'Tom grave'], ['tomF', 'Surdo'],
  ['ride', 'Prato condução'], ['rideBell', 'Cúpula da condução'], ['crash', 'Prato ataque'], ['china', 'China'],
  ['cowbell', 'Cowbell'], ['shaker', 'Shaker'], ['pandeiro', 'Pandeiro'],
];
export const SOUND_NAMES = Object.fromEntries(KIT);

/** Kits para escolher. `pads`: pads de uma bateria nova com esse kit. */
export const KITS = {
  rock: { label: 'Rock (bateria acústica)', sampled: true,
    pads: ['kick', 'snare', 'rimshot', 'rim', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'tomF', 'ride', 'rideBell', 'crash', 'china', 'cowbell'] },
  jazz: { label: 'Jazz (acústica, leve)', sampled: true,
    pads: ['kick', 'snare', 'rimshot', 'rim', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'tomF', 'ride', 'rideBell', 'crash', 'china', 'shaker'] },
  swirly: { label: 'Swirly (acústica, seca)', sampled: true,
    pads: ['kick', 'snare', 'rimshot', 'rim', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'tomF', 'ride', 'crash', 'china', 'cowbell', 'clap'] },
  unruly: { label: 'Unruly (acústica, com esteira)', sampled: true,
    pads: ['kick', 'kick808', 'snare', 'rimshot', 'rim', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'tomF', 'ride', 'rideBell', 'crash', 'shaker'] },
  synth: { label: 'Eletrônico (sintetizado)', sampled: false,
    pads: ['kick', 'kick808', 'snare', 'rim', 'clap', 'hatC', 'hatP', 'hatO', 'tomH', 'tomM', 'tomL', 'ride', 'crash', 'cowbell', 'shaker', 'pandeiro'] },
};

/** Grades de edição: valor de nota (relativo à semibreve); "T" = tercina; "auto" = segue o zoom. */
export const GRIDS = ['auto', '1/4', '1/8', '1/16', '1/32', '1/64', '1/4T', '1/8T', '1/16T', '1/32T', '1/64T'];
const AUTO_STEPS = ['1/4', '1/8', '1/16', '1/32', '1/64'];
/** Largura mínima (px) de uma célula da grade automática: abaixo disso não dá para clicar com precisão. */
export const MIN_CELL_PX = 14;

const denominator = (p) => parseInt(String(p.timeSig).split('/')[1], 10) || 4;

/** Tamanho de uma célula da grade, em ticks (o tempo do compasso vale PPQ). */
export function gridTicks(p, grid) {
  const m = /^1\/(\d+)(T?)$/.exec(grid) || [0, 16, ''];
  let t = (PPQ * denominator(p)) / +m[1];
  if (m[2]) t = (t * 2) / 3;
  return Math.max(1, Math.round(t));
}

/**
 * Grade em uso. Na automática (como no Soundtrap), aproximar o zoom abre subdivisões menores:
 * a menor nota cuja célula ainda tem MIN_CELL_PX de largura (1/4 → 1/8 → 1/16 → 1/32 → 1/64).
 */
export function activeGrid(p) {
  const d = p.drums;
  if (!d || d.grid !== 'auto') return d?.grid || '1/16';
  const ppt = d.zoom / PPQ;
  const t = d.triplet ? 'T' : '';
  let g = AUTO_STEPS[0] + t;
  for (const s of AUTO_STEPS) {
    if (gridTicks(p, s + t) * ppt >= MIN_CELL_PX) g = s + t;
    else break;
  }
  return g;
}

export const ticksPerBar = (p) => beatsPerBar(p.timeSig) * PPQ;
export const secPerTick = (p) => 60 / p.bpm / PPQ;

/** Volume inicial de cada som no pad novo (dB). O bumbo vem 3 dB acima para ter peso na mixagem. */
const PAD_START_DB = { kick: 3 };
/** Pancada inicial por som (vale também para os pads que já existiam, que não tinham o controle). */
const PUNCH_DEFAULT = { kick: 0.6, kick808: 0.6, snare: 0.5, rimshot: 0.5, rim: 0.5 };

export function createPad(sound) {
  return {
    id: uid('d'), sound, name: SOUND_NAMES[sound] || sound, volumeDb: PAD_START_DB[sound] ?? 0, pan: 0, tune: 0, mute: false, solo: false,
    punch: PUNCH_DEFAULT[sound] ?? 0, // Pancada (0–1): bumbo, caixa e aro
  };
}

const letter = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) + 1 : '');

export function createPattern(d, bars = 1) {
  const used = new Set(d.patterns.map((x) => x.name));
  let i = 0;
  while (used.has(letter(i))) i++;
  return { id: uid('pt'), name: letter(i), bars, hits: [] };
}

/**
 * Compressor de barramento da bateria: os toques são picos curtos (média ~20 dB abaixo do pico),
 * então sem isso a bateria soa baixa perto de um instrumento gravado com o mesmo pico.
 * Ataque rápido segura o pico do toque; o ganho de compensação sobe o corpo do som (~+7 dB de média).
 */
// Compressor de fábrica da bateria: suave e sem ganho extra. O compressor do navegador já põe um
// ganho automático; somar mais em cima levava o bumbo acima de 0 dB e ele estourava no master.
// O ataque de 10 ms deixa passar o começo da batida (o "soco" do bumbo).
const DRUM_COMP = { on: true, thresholdDb: -20, ratio: 2.5, attackMs: 10, releaseMs: 120, makeupDb: 0 };
// Ajuste de fábrica anterior (até nov/2026): quem ainda está nele passa para o novo.
const OLD_DRUM_COMP = { thresholdDb: -24, ratio: 4, attackMs: 1, releaseMs: 120, makeupDb: 6 };

/** Bateria nova: 16 pads, padrão A com uma levada básica, tocando nos compassos pedidos. */
export function createDrums(p, bars = 4, kit = 'rock') {
  const pads = KITS[kit].pads.map((s) => createPad(s));
  const d = { kit, volumeDb: 0, pan: 0, mute: false, solo: false, fx: defaultFx(), pads, patterns: [], blocks: [], grid: 'auto', zoom: 64, sel: null, swing: 50, swingGrid: '1/16', triplet: false, levelV: 3, driveDb: 0 };
  d.fx.eq.hpOn = false;
  d.fx.comp = { ...DRUM_COMP };
  const a = createPattern(d, 1);
  const by = (s) => pads.find((x) => x.sound === s).id;
  const bpb = beatsPerBar(p.timeSig);
  const eighth = gridTicks(p, '1/8');
  for (let t = 0; t < bpb * PPQ; t += eighth) a.hits.push({ pad: by('hatC'), t, v: t % PPQ === 0 ? 0.8 : 0.55 });
  for (let b = 0; b < bpb; b++) {
    if (b % 2 === 0) a.hits.push({ pad: by('kick'), t: b * PPQ, v: 0.9 });
    else a.hits.push({ pad: by('snare'), t: b * PPQ, v: 0.85 });
  }
  d.patterns.push(a);
  d.sel = a.id;
  d.blocks.push({ id: uid('b'), pattern: a.id, start: 0, bars });
  return d;
}

/** Preenche campos ausentes (projetos salvos por versões anteriores). */
export function normalizeDrums(d) {
  if (!d) return null;
  const fx = defaultFx();
  const cf = d.fx || {};
  d.fx = {
    ...fx, ...cf,
    gate: { ...fx.gate, ...cf.gate }, eq: { ...fx.eq, ...cf.eq, low: { ...fx.eq.low, ...cf.eq?.low }, mid: { ...fx.eq.mid, ...cf.eq?.mid }, high: { ...fx.eq.high, ...cf.eq?.high } },
    comp: { ...fx.comp, ...cf.comp }, echo: { ...fx.echo, ...cf.echo },
    dist: { ...fx.dist, ...cf.dist }, wah: { ...fx.wah, ...cf.wah }, chorus: { ...fx.chorus, ...cf.chorus }, double: { ...fx.double, ...cf.double }, trem: { ...fx.trem, ...cf.trem }, reverb: { ...fx.reverb, ...cf.reverb }, send: { ...fx.send, ...cf.send },
  };
  d.kit = KITS[d.kit] ? d.kit : 'synth'; // projetos de antes dos kits acústicos continuam como estavam
  d.volumeDb ??= -3;
  if (!d.levelV) {
    // Projetos antigos: só sobe o nível se o volume e o compressor ainda estão no padrão de antes.
    const c = d.fx.comp;
    if (d.volumeDb === -3) d.volumeDb = 0;
    if (!c.on && c.thresholdDb === -18 && c.ratio === 3 && c.makeupDb === 0) d.fx.comp = { ...DRUM_COMP };
    d.levelV = 1;
  }
  if (d.levelV < 2) {
    const c = d.fx.comp;
    if (Object.entries(OLD_DRUM_COMP).every(([k, v]) => c[k] === v)) d.fx.comp = { ...DRUM_COMP, on: c.on };
    d.levelV = 2;
  }
  d.pan ??= 0;
  d.driveDb ??= 0;
  d.pads = (d.pads || []).map((x) => ({ ...createPad(x.sound || 'kick'), midiNote: null, ...x }));
  if (d.levelV < 3) {
    // Caixa e aro ganharam a Pancada: antes o controle não aparecia e o pad guardava 0, que não foi escolha de ninguém.
    for (const x of d.pads) if (!x.punch && x.sound !== 'kick' && x.sound !== 'kick808' && PUNCH_DEFAULT[x.sound]) x.punch = PUNCH_DEFAULT[x.sound];
    d.levelV = 3;
  }
  d.patterns ??= [];
  d.blocks ??= [];
  if (d.triplet === undefined) { d.triplet = false; if (d.grid === '1/16') d.grid = 'auto'; } // projetos antigos passam a seguir o zoom
  d.grid = GRIDS.includes(d.grid) ? d.grid : 'auto';
  d.zoom ??= 64;
  d.swing = Math.max(50, Math.min(75, +d.swing || 50)); // 50% = reto, 66% ≈ tercina
  d.swingGrid = d.swingGrid === '1/8' ? '1/8' : '1/16';
  if (!d.patterns.length) d.patterns.push(createPattern(d, 1));
  if (!d.patterns.some((x) => x.id === d.sel)) d.sel = d.patterns[0].id;
  return d;
}

/** Último compasso (exclusivo) com bateria. */
/**
 * Pads que não tocam na música: nenhuma batida num padrão que está na faixa, dentro do trecho que o
 * bloco toca. `outside` = os que só têm batidas em padrões fora da música (somem junto).
 * Fica sempre pelo menos um pad.
 */
export function unusedPads(p) {
  const d = p.drums;
  if (!d) return { unused: [], outside: [] };
  const tpb = ticksPerBar(p);
  const limit = new Map(); // padrão → até onde ele toca na música (ticks)
  for (const b of d.blocks) {
    const pat = d.patterns.find((x) => x.id === b.pattern);
    if (pat) limit.set(pat.id, Math.max(limit.get(pat.id) || 0, Math.min(pat.bars, b.bars) * tpb));
  }
  const inSong = new Set();
  const anywhere = new Set();
  for (const pat of d.patterns) {
    const lim = limit.get(pat.id) || 0;
    for (const x of pat.hits) {
      anywhere.add(x.pad);
      if (x.t >= 0 && x.t < lim) inSong.add(x.pad);
    }
  }
  let unused = d.pads.filter((x) => !inSong.has(x.id));
  if (unused.length === d.pads.length) unused = unused.slice(1);
  return { unused, outside: unused.filter((x) => anywhere.has(x.id)) };
}

/** Tira os pads e as batidas deles em todos os padrões. */
export function removePads(d, pads) {
  const gone = new Set(pads.map((x) => x.id));
  d.pads = d.pads.filter((x) => !gone.has(x.id));
  for (const pat of d.patterns) pat.hits = pat.hits.filter((x) => !gone.has(x.pad));
}

export const drumsEndBar = (d) => (d?.blocks || []).reduce((m, b) => Math.max(m, b.start + b.bars), 0);

/** Coloca um bloco em [start, start+bars), cortando os blocos que estavam ali. */
export function placeBlock(d, start, bars, patternId) {
  const s = Math.max(0, start);
  const e = s + Math.max(1, bars);
  const out = [];
  for (const b of d.blocks) {
    const be = b.start + b.bars;
    if (be <= s || b.start >= e) { out.push(b); continue; }
    if (b.start < s) out.push({ ...b, id: uid('b'), bars: s - b.start });
    if (be > e) out.push({ ...b, id: uid('b'), start: e, bars: be - e });
  }
  if (patternId) out.push({ id: uid('b'), pattern: patternId, start: s, bars: e - s });
  out.sort((a, b) => a.start - b.start);
  d.blocks = out;
}

/**
 * Swing: atrasa as notas do contratempo. Em cada par de células (2u), a 1ª metade é esticada
 * e a 2ª encolhida, de forma contínua — vale também para batidas fora da grade.
 */
export function swingTick(p, t) {
  const d = p.drums;
  const s = (d?.swing ?? 50) / 100;
  if (Math.abs(s - 0.5) < 1e-6) return t;
  const u = gridTicks(p, d.swingGrid);
  const base = Math.floor(t / (2 * u)) * 2 * u;
  const ph = t - base;
  const split = 2 * u * s;
  return base + (ph <= u ? ph * (split / u) : split + (ph - u) * ((2 * u - split) / u));
}

/** Pads que soam (respeita mudo e solo dos pads). */
function audiblePads(d) {
  const anySolo = d.pads.some((x) => x.solo);
  return new Map(d.pads.filter((x) => !x.mute && (!anySolo || x.solo)).map((x) => [x.id, x]));
}

// ---------------------------------------------------------------- Kit sintetizado

let kitP = null;
let kitRate = 0;

/** Gera os sons sintetizados uma vez (cada um num OfflineAudioContext). */
export function buildKit(sampleRate = 48000) {
  if (!kitP || kitRate !== sampleRate) {
    kitRate = sampleRate;
    kitP = Promise.all(KIT.map(async ([id]) => [id, await synth(id, sampleRate)])).then((l) => new Map(l));
  }
  return kitP;
}

const LEVEL = {
  kick: 0.95, kick808: 0.95, snare: 0.85, rim: 0.6, clap: 0.75, hatC: 0.45, hatP: 0.35, hatO: 0.45,
  tomH: 0.8, tomM: 0.8, tomL: 0.85, ride: 0.4, crash: 0.55, cowbell: 0.5, shaker: 0.4, pandeiro: 0.55,
  rimshot: 0.9, tomF: 0.85, rideBell: 0.45, china: 0.5,
};
const LENGTH = {
  kick: 0.6, kick808: 1.4, snare: 0.4, rim: 0.12, clap: 0.45, hatC: 0.15, hatP: 0.2, hatO: 0.7,
  tomH: 0.6, tomM: 0.75, tomL: 1.0, ride: 2.0, crash: 2.6, cowbell: 0.5, shaker: 0.2, pandeiro: 0.45,
  rimshot: 0.45, tomF: 1.3, rideBell: 2.0, china: 2.4,
};

function noiseBuffer(c, sec) {
  const n = Math.ceil(sec * c.sampleRate);
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345; // ruído fixo: o mesmo som em toda renderização
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s / 2147483648) - 1; }
  return b;
}

async function synth(id, sr) {
  const len = LENGTH[id];
  const c = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
  const out = c.destination;
  const env = (node, peak, decay, at = 0, attack = 0.001) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, at + attack + decay);
    node.connect(g).connect(out);
    return g;
  };
  const osc = (type, f0, f1 = f0, glide = 0.1) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, 0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, glide);
    o.start(0);
    return o;
  };
  const noise = (filterType, freq, q = 0.8) => {
    const s = c.createBufferSource();
    s.buffer = noiseBuffer(c, len);
    const f = c.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    s.connect(f);
    s.start(0);
    return f;
  };
  // Metálico estilo 808: seis quadradas desafinadas entre si
  const metal = (scale = 1, bp = 10000, hp = 7000) => {
    const sum = c.createGain();
    sum.gain.value = 0.3;
    for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) osc('square', f * scale).connect(sum);
    const b = c.createBiquadFilter();
    b.type = 'bandpass'; b.frequency.value = bp; b.Q.value = 0.9;
    const h = c.createBiquadFilter();
    h.type = 'highpass'; h.frequency.value = hp;
    sum.connect(b).connect(h);
    return h;
  };

  switch (id) {
    case 'kick':
      env(osc('sine', 160, 48, 0.12), 1, 0.45);
      env(noise('lowpass', 3000), 0.25, 0.012);
      break;
    case 'kick808':
      env(osc('sine', 75, 42, 0.09), 1, 1.25, 0, 0.002);
      env(osc('triangle', 150, 60, 0.03), 0.25, 0.04);
      break;
    case 'snare':
      env(osc('triangle', 200, 165, 0.05), 0.6, 0.11);
      env(noise('highpass', 1300), 0.8, 0.22);
      break;
    case 'rim':
      env(osc('triangle', 1750), 0.6, 0.03);
      env(osc('square', 460), 0.35, 0.02);
      break;
    case 'clap': {
      const n = noise('bandpass', 1150, 1.3);
      const g = c.createGain();
      g.gain.setValueAtTime(0, 0);
      for (const t of [0, 0.011, 0.022]) { g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.009); }
      g.gain.setValueAtTime(0.9, 0.033);
      g.gain.exponentialRampToValueAtTime(0.0005, 0.033 + 0.2);
      n.connect(g).connect(out);
      break;
    }
    case 'hatC': env(metal(), 1, 0.05); break;
    case 'hatP': env(metal(1, 9000, 6000), 0.8, 0.08); break;
    case 'hatO': env(metal(), 1, 0.5); break;
    case 'rimshot':
      env(osc('triangle', 230, 180, 0.04), 0.7, 0.1);
      env(noise('highpass', 1600), 1, 0.2);
      env(osc('square', 1800), 0.35, 0.025);
      break;
    case 'rideBell':
      env(metal(2.4, 5500, 3000), 0.6, 1.6);
      env(osc('sine', 2480), 0.35, 1.2);
      break;
    case 'china':
      env(noise('bandpass', 4500, 0.7), 0.8, 1.9, 0, 0.002);
      env(metal(1.1, 5000, 2500), 0.6, 1.2);
      break;
    case 'tomH': case 'tomM': case 'tomL': case 'tomF': {
      const f = { tomH: 230, tomM: 165, tomL: 105, tomF: 78 }[id];
      const d = { tomH: 0.4, tomM: 0.5, tomL: 0.75, tomF: 1.0 }[id];
      env(osc('sine', f * 1.4, f, 0.08), 1, d);
      env(noise('bandpass', f * 4, 1), 0.15, 0.05);
      break;
    }
    case 'ride':
      env(metal(1.6, 6000, 3500), 0.7, 1.8);
      env(osc('sine', 3150), 0.08, 1.2);
      break;
    case 'crash':
      env(noise('highpass', 3500), 0.7, 2.3, 0, 0.002);
      env(metal(1.3, 7000, 4000), 0.5, 1.4);
      break;
    case 'cowbell': {
      const sum = c.createGain();
      osc('square', 545).connect(sum);
      osc('square', 815).connect(sum);
      const b = c.createBiquadFilter();
      b.type = 'bandpass'; b.frequency.value = 800; b.Q.value = 2.5;
      const g = c.createGain();
      g.gain.setValueAtTime(1, 0);
      g.gain.exponentialRampToValueAtTime(0.25, 0.04);
      g.gain.exponentialRampToValueAtTime(0.0005, 0.45);
      sum.connect(b).connect(g).connect(out);
      break;
    }
    case 'shaker': env(noise('bandpass', 5800, 1.1), 1, 0.08, 0, 0.014); break;
    case 'pandeiro': {
      const n = noise('highpass', 7000);
      const g = c.createGain();
      g.gain.setValueAtTime(0, 0);
      for (const [t, v] of [[0, 1], [0.018, 0.7], [0.04, 0.45]]) { g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(v * 0.2, t + 0.016); }
      g.gain.exponentialRampToValueAtTime(0.0005, 0.4);
      n.connect(g).connect(out);
      env(osc('sine', 330, 210, 0.05), 0.45, 0.12);
      break;
    }
    default:
      env(osc('sine', 440), 0.5, 0.2);
  }
  const buf = await c.startRendering();
  // Normaliza o pico, para os sons ficarem equilibrados entre si
  const data = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) { const k = LEVEL[id] / peak; for (let i = 0; i < data.length; i++) data[i] *= k; }
  return buf;
}

// ---------------------------------------------------------------- Renderização

// ---------------------------------------------------------------- Kits gravados (samples)

const KITS_URL = new URL('../../kits/', import.meta.url);
const sampledP = new Map(); // `${kit}|${taxa}` → Promise<{ sounds: Map(som → { layers: AudioBuffer[][], tune }), name, credit }>

/** Carrega (uma vez) os samples de um kit acústico, da pasta kits/ do app. */
export function loadSampledKit(kit, sampleRate = 48000) {
  const key = `${kit}|${sampleRate}`;
  if (!sampledP.has(key)) {
    const p = (async () => {
      const base = new URL(`${kit}/`, KITS_URL);
      const meta = await (await fetch(new URL('kit.json', base))).json();
      // Todos os sons num arquivo só (kit.bin): um pedido em vez de ~130 (bem mais rápido de carregar)
      const pack = await (await fetch(new URL(meta.pack || 'kit.bin', base))).arrayBuffer();
      const ctx = new OfflineAudioContext(2, 1, sampleRate); // só para decodificar (já converte a taxa)
      const sounds = new Map();
      await Promise.all(Object.entries(meta.sounds).map(async ([snd, s]) => {
        const layers = await Promise.all(s.layers.map((files) => Promise.all(files.map(([at, len]) => (
          ctx.decodeAudioData(pack.slice(at, at + len))
        )))));
        sounds.set(snd, { layers, tune: s.tune || 0 });
      }));
      return { sounds, name: meta.name, credit: meta.credit };
    })();
    p.catch(() => sampledP.delete(key));
    sampledP.set(key, p);
  }
  return sampledP.get(key);
}

/** Kit em uso: sons sintetizados (sempre, para o que faltar) + gravados, se o kit for acústico. */
export async function getKit(kit, sampleRate) {
  const synthMap = await buildKit(sampleRate);
  const sampled = KITS[kit]?.sampled ? await loadSampledKit(kit, sampleRate) : null;
  return { id: kit, synth: synthMap, sampled };
}

/**
 * Som de um toque: o sample próprio do pad; senão a camada do kit gravado pela força
 * (4 camadas, da mais leve à mais forte) com variação escolhida pelo `seed`; senão o sintetizado.
 * Devolve { buf, gain, rate } (o ganho dos gravados é suave porque a camada já tem a dinâmica).
 */
function voice(pad, v, seed, kit, samples) {
  const vv = Math.max(0, Math.min(1, v));
  const own = pad.sample && samples?.get(pad.sample.fileId);
  const tuneRate = Math.pow(2, (pad.tune || 0) / 12);
  if (own) return { buf: own, gain: vv * vv, rate: tuneRate };
  const s = kit.sampled?.sounds.get(pad.sound);
  if (s?.layers.length) {
    const n = s.layers.length;
    const pos = vv * n;
    const li = Math.max(0, Math.min(n - 1, Math.ceil(pos) - 1));
    const layer = s.layers[li];
    const buf = layer[Math.abs(seed) % layer.length];
    const within = Math.max(0, Math.min(1, pos - li));
    return { buf, gain: 0.72 + 0.28 * within, rate: tuneRate * Math.pow(2, s.tune / 12) };
  }
  const buf = kit.synth.get(pad.sound);
  return buf ? { buf, gain: vv * vv, rate: tuneRate } : null;
}

// ---------- Pancada (bumbo, caixa e aro) ----------

/**
 * Ajuste da Pancada por som. eq: [frequência, Q, ganho em dB com a Pancada no máximo];
 * boost: quanto os primeiros ms da batida sobem; hold/tc: quanto tempo o reforço dura (s);
 * click: centro do estalo da baqueta (Hz) e clickGain o volume dele; trim: volume tirado no fim (dB).
 */
const KICK_PUNCH = { eq: [[62, 1.1, 5], [380, 1.2, -4], [3800, 0.9, 5]], boost: 1.2, hold: 0.003, tc: 0.012, click: 3300, clickGain: 0.5, trim: -2.5 };
const PUNCH_PROFILE = {
  kick: KICK_PUNCH,
  kick808: KICK_PUNCH,
  // Caixa: corpo (~190 Hz), menos "caixa de papelão" (~600 Hz) e o estalo da esteira (~5 kHz).
  snare: { eq: [[190, 1.0, 3], [600, 1.0, -3], [5000, 0.8, 4]], boost: 1.0, hold: 0.002, tc: 0.008, click: 5000, clickGain: 0.35, trim: -2 },
  rimshot: { eq: [[220, 1.0, 2], [700, 1.0, -2], [4500, 0.8, 4]], boost: 0.9, hold: 0.002, tc: 0.007, click: 4500, clickGain: 0.35, trim: -2 },
  // Aro: a madeira da baqueta (~500 Hz) e o estalo (~2,5 kHz); o som é curto, o reforço também.
  rim: { eq: [[500, 1.0, 2], [2500, 1.0, 4]], boost: 0.8, hold: 0.0015, tc: 0.005, click: 4000, clickGain: 0.25, trim: -2 },
};

/** Sons que têm o controle Pancada. */
export const PUNCH_SOUNDS = new Set(Object.keys(PUNCH_PROFILE));
const punchOf = (pad) => (PUNCH_SOUNDS.has(pad.sound) ? Math.max(0, Math.min(1, pad.punch || 0)) : 0);

/**
 * EQ do pad com Pancada (`a` de 0 a 1), conforme o som (PUNCH_PROFILE).
 * Devolve o nó de entrada; a saída vai para `dest`.
 */
function punchChain(c, a, dest, sound) {
  const pf = PUNCH_PROFILE[sound] || KICK_PUNCH;
  let first = null;
  let last = null;
  for (const [f, q, gMax] of pf.eq) {
    const g = gMax * a;
    const b = c.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = g;
    if (last) last.connect(b); else first = b;
    last = b;
  }
  // O EQ e o soco somam volume: tira um pouco no fim para o som não viver empurrando o limitador do master.
  const trim = c.createGain();
  trim.gain.value = Math.pow(10, (pf.trim * a) / 20);
  last.connect(trim).connect(dest);
  return first;
}

const clickBufs = new Map();
/** Estalo da baqueta: 8 ms de ruído (sempre o mesmo) com queda rápida. */
function clickBuffer(c) {
  let b = clickBufs.get(c.sampleRate);
  if (b) return b;
  const n = Math.round(c.sampleRate * 0.008);
  b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: c.sampleRate });
  const d = b.getChannelData(0);
  let s = 987654321;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = ((s / 0x7fffffff) * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.0018));
  }
  clickBufs.set(c.sampleRate, b);
  return b;
}

/**
 * Uma batida com Pancada: os primeiros ~15 ms saem mais fortes (o "soco") e entra o estalo da
 * baqueta. `g` é o ganho da batida (valor normal `base`); o estalo vai para `dest`.
 */
function punchHit(c, t, a, v, g, base, dest, sound) {
  const pf = PUNCH_PROFILE[sound] || KICK_PUNCH;
  g.gain.setValueAtTime(base * (1 + pf.boost * a), t);
  g.gain.setTargetAtTime(base, t + pf.hold, pf.tc);
  const s = c.createBufferSource();
  s.buffer = clickBuffer(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = pf.click;
  bp.Q.value = 0.9;
  const cg = c.createGain();
  cg.gain.value = pf.clickGain * a * Math.max(0.2, v);
  s.connect(bp).connect(cg).connect(dest);
  s.start(t);
}

const TAIL = 2.6; // segundos de cauda (o som mais longo do kit)
const patternCache = new Map(); // chave → AudioBuffer de uma passada do padrão

/** Batidas de uma passada do padrão (só até `limitTicks`), em segundos a partir do início dela. */
export function patternHits(p, pattern, limitTicks = Infinity) {
  const d = p.drums;
  const pads = audiblePads(d);
  const end = Math.min(pattern.bars * ticksPerBar(p), limitTicks);
  const spt = secPerTick(p);
  return pattern.hits
    .filter((x) => x.t >= 0 && x.t < end && pads.has(x.pad))
    .map((x) => ({
      time: swingTick(p, x.t) * spt, pad: pads.get(x.pad), v: x.v,
      // duração (s): o som é cortado ali; sem `len` ele toca inteiro
      dur: x.len > 0 ? (swingTick(p, x.t + x.len) - swingTick(p, x.t)) * spt : null,
    }))
    .sort((a, b) => a.time - b.time);
}

/** Rampa do corte de uma batida com duração (sem estalo). */
const CUT_FADE = 0.008;

const HAT = new Set(['hatC', 'hatP', 'hatO']);

async function renderPattern(p, pattern, limitTicks, kit, sr, samples) {
  const hits = patternHits(p, pattern, limitTicks);
  const key = JSON.stringify([kit.id, p.bpm, sr, hits.map((x) => [x.time, x.v, x.dur, x.pad.sound, x.pad.volumeDb, x.pad.pan, x.pad.tune, punchOf(x.pad),
    x.pad.sample && samples?.has(x.pad.sample.fileId) ? x.pad.sample.fileId : 0])]);
  if (patternCache.has(key)) return patternCache.get(key);
  if (!hits.length) { patternCache.set(key, null); return null; }
  const last = hits[hits.length - 1].time;
  // cauda: o som mais longo usado (samples do usuário podem ser longos; limite de 30 s)
  // variação (round robin) fixa por batida: a mesma batida soa igual a cada renderização
  const vs = hits.map((x, i) => voice(x.pad, x.v, Math.round(x.time * 1000) + i * 7, kit, samples));
  const longest = Math.max(TAIL, ...vs.map((x) => (x ? x.buf.duration / x.rate : 0)));
  const c = new OfflineAudioContext(2, Math.ceil((last + Math.min(longest, 30)) * sr), sr);
  const padNodes = new Map();
  const padNode = (pad) => {
    let n = padNodes.get(pad.id);
    if (!n) {
      const g = c.createGain();
      g.gain.value = dbToGain(pad.volumeDb);
      const pan = c.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, pad.pan || 0));
      pan.connect(c.destination);
      const a = punchOf(pad);
      g.connect(a ? punchChain(c, a, pan, pad.sound) : pan);
      padNodes.set(pad.id, (n = g));
    }
    return n;
  };
  hits.forEach((x, i) => {
    const vo = vs[i];
    if (!vo) return;
    const s = c.createBufferSource();
    s.buffer = vo.buf;
    s.playbackRate.value = vo.rate;
    const g = c.createGain();
    g.gain.value = vo.gain;
    s.connect(g).connect(padNode(x.pad));
    s.start(x.time);
    const a = punchOf(x.pad);
    if (a) punchHit(c, x.time, a, x.v, g, vo.gain, padNode(x.pad), x.pad.sound);
    // Onde o som para: no fim da duração da batida e, no chimbal aberto, no próximo toque de
    // chimbal (abafa como na bateria de verdade). O que vier primeiro.
    let cut = x.dur != null ? x.time + x.dur : Infinity;
    let fade = CUT_FADE;
    if (x.pad.sound === 'hatO' && !x.pad.sample) {
      const next = hits.slice(i + 1).find((y) => HAT.has(y.pad.sound) && !y.pad.sample);
      if (next && next.time < cut) { cut = next.time; fade = 0.012; }
    }
    if (Number.isFinite(cut)) {
      g.gain.setValueAtTime(vo.gain, cut);
      g.gain.linearRampToValueAtTime(0, cut + fade);
      s.stop(cut + fade + 0.004);
    }
  });
  const buf = await c.startRendering();
  if (patternCache.size > 200) patternCache.clear();
  patternCache.set(key, buf);
  return buf;
}

/** Gera o áudio da bateria da música inteira (ou null se não houver batidas). */
export async function renderDrums(p, sampleRate = 48000, samples = null) {
  const d = p.drums;
  if (!d || !d.blocks.length) return null;
  const kit = await getKit(d.kit, sampleRate);
  const bar = barSec(p);
  const tpb = ticksPerBar(p);
  const parts = [];
  for (const b of d.blocks) {
    const pat = d.patterns.find((x) => x.id === b.pattern);
    if (!pat || !pat.bars) continue;
    for (let k = 0; k * pat.bars < b.bars; k++) {
      const limit = Math.min(pat.bars, b.bars - k * pat.bars) * tpb;
      const buf = await renderPattern(p, pat, limit, kit, sampleRate, samples);
      if (buf) parts.push({ at: (b.start + k * pat.bars) * bar, buf });
    }
  }
  if (!parts.length) return null;
  const len = Math.ceil(Math.max(...parts.map((x) => x.at * sampleRate + x.buf.length)));
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  for (const { at, buf } of parts) {
    const o = Math.round(at * sampleRate);
    const a = buf.getChannelData(0);
    const b2 = buf.getChannelData(1);
    for (let i = 0; i < a.length; i++) { L[o + i] += a[i]; R[o + i] += b2[i]; }
  }
  if (d.driveDb > 0) driveSaturate(L, R, sampleRate, d.driveDb);
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  out.copyToChannel(L, 0);
  out.copyToChannel(R, 1);
  return out;
}

/**
 * Ganho da bateria: sobe `driveDb` e satura suavemente (tanh) com teto em −1 dBFS.
 * Medido: +18 dB de ganho dão ~+11 dB de nível médio (um limitador dava só ~+7, porque segurava
 * o corpo de cada toque junto com o pico). Bateria aceita bem a saturação; o pico nunca passa do teto.
 */
export function driveSaturate(L, R, sr, driveDb, ceilDb = -1) {
  const g = Math.pow(10, driveDb / 20);
  const c = Math.pow(10, ceilDb / 20);
  for (let i = 0; i < L.length; i++) {
    L[i] = c * Math.tanh((L[i] * g) / c);
    R[i] = c * Math.tanh((R[i] * g) / c);
  }
}

/** Toca um som do kit na hora (ao clicar num pad), passando pelo canal da bateria. */
let auditionN = 0;
export async function auditionPad(ctx, dest, pad, v = 0.85, samples = null, kitId = 'synth') {
  const kit = await getKit(kitId, ctx.sampleRate);
  const vo = voice(pad, v, auditionN++, kit, samples);
  if (!vo) return;
  const s = ctx.createBufferSource();
  s.buffer = vo.buf;
  s.playbackRate.value = vo.rate;
  const g = ctx.createGain();
  const base = vo.gain * dbToGain(pad.volumeDb);
  g.gain.value = base;
  const pan = ctx.createStereoPanner();
  pan.pan.value = pad.pan || 0;
  pan.connect(dest);
  const a = punchOf(pad);
  const inp = a ? punchChain(ctx, a, pan, pad.sound) : pan;
  s.connect(g).connect(inp);
  const t = ctx.currentTime + 0.005;
  s.start(t);
  if (a) punchHit(ctx, t, a, v, g, base, inp, pad.sound);
  s.onended = () => { try { pan.disconnect(); } catch { /* ok */ } };
}

// ---------------------------------------------------------------- Copiar e colar

/**
 * Conteúdo copiado de um padrão. Guarda o som e o nome de cada pad, para colar também em outro
 * projeto (onde os pads têm outros ids).
 */
export function copyPattern(d, pattern) {
  const pads = new Map(d.pads.map((x) => [x.id, x]));
  return {
    kind: 'multicorder-drums', bars: pattern.bars, name: pattern.name,
    hits: pattern.hits.filter((x) => pads.has(x.pad)).map((x) => {
      const pad = pads.get(x.pad);
      return { padId: pad.id, sound: pad.sound, padName: pad.name, sample: !!pad.sample, t: x.t, v: x.v, ...(x.len > 0 ? { len: x.len } : {}) };
    }),
  };
}

/**
 * Cola no padrão (somando às batidas que já existem). Acha o pad pelo id, depois por nome + som,
 * depois pelo som; se não existir, cria. Devolve quantas batidas entraram.
 */
export function pastePattern(d, pattern, clip) {
  if (clip?.kind !== 'multicorder-drums') return 0;
  if (clip.bars > pattern.bars) pattern.bars = Math.min(8, clip.bars);
  const map = new Map();
  const padFor = (x) => {
    const k = `${x.padId}|${x.sound}|${x.padName}`;
    if (map.has(k)) return map.get(k);
    let pad = d.pads.find((y) => y.id === x.padId)
      || d.pads.find((y) => y.name === x.padName && y.sound === x.sound)
      || (!x.sample && d.pads.find((y) => y.sound === x.sound && !y.sample));
    if (!pad) {
      pad = { ...createPad(x.sound), name: x.padName || SOUND_NAMES[x.sound] };
      d.pads.push(pad);
    }
    map.set(k, pad);
    return pad;
  };
  let n = 0;
  for (const x of clip.hits) {
    const pad = padFor(x);
    if (pattern.hits.some((y) => y.pad === pad.id && y.t === x.t)) continue;
    pattern.hits.push({ pad: pad.id, t: x.t, v: x.v, ...(x.len > 0 ? { len: x.len } : {}) });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- MIDI (.mid)

/** Notas da bateria General MIDI (canal 10) para cada som do kit. */
export const GM_NOTE = {
  kick: 36, kick808: 35, snare: 38, rim: 37, clap: 39, hatC: 42, hatP: 44, hatO: 46,
  tomH: 50, tomM: 47, tomL: 45, ride: 51, crash: 49, cowbell: 56, shaker: 70, pandeiro: 54,
  rimshot: 40, tomF: 43, rideBell: 53, china: 52,
};

/**
 * Nota General MIDI → som do kit (para importar .mid). Inclui as notas "irmãs" do GM
 * (ex.: 41 surdo grave, 55 splash, 57 prato 2) no som mais parecido que o kit tem.
 */
export const GM_TO_SOUND = {
  ...Object.fromEntries(Object.entries(GM_NOTE).map(([s, n]) => [n, s])),
  41: 'tomF', 48: 'tomH', 55: 'crash', 57: 'crash', 59: 'ride', 58: 'cowbell',
  60: 'tomH', 61: 'tomM', 62: 'tomH', 63: 'tomM', 64: 'tomL', 65: 'tomM', 66: 'tomL',
  67: 'cowbell', 68: 'cowbell', 69: 'shaker', 75: 'rim', 76: 'rim', 77: 'rim', 82: 'shaker',
  27: 'kick', 28: 'snare', 31: 'rim', 33: 'rim', 34: 'rideBell',
};

/** Som de um toque do kit pela nota GM, fora de um pad (usado na faixa-guia em MIDI). */
export function gmDrumVoice(note, v, seed, kit) {
  const sound = GM_TO_SOUND[note];
  if (!sound) return null;
  return voice({ sound, tune: 0 }, v, seed, kit, null);
}

/**
 * Arquivo MIDI (formato 0, canal 10, 96 ticks por semínima).
 * `patternId`: só uma passada daquele padrão; sem ele, a música inteira (blocos, com swing).
 */
export function drumsToMidi(p, { patternId = null } = {}) {
  const d = p.drums;
  const den = parseInt(String(p.timeSig).split('/')[1], 10) || 4;
  const bpb = beatsPerBar(p.timeSig);
  // nosso tick vale 1/PPQ do tempo do compasso; no MIDI, 1/PPQ da semínima
  const toQ = (ticks) => Math.round((ticks * 4) / den);
  const pads = audiblePads(d);
  const notes = [];
  const add = (startTicks, pattern, limit) => {
    for (const x of pattern.hits) {
      const pad = pads.get(x.pad);
      if (!pad || x.t < 0 || x.t >= limit) continue;
      notes.push({
        t: toQ(startTicks + swingTick(p, x.t)), note: GM_NOTE[pad.sound] ?? 38, vel: Math.max(1, Math.min(127, Math.round(x.v * 127))),
        len: x.len > 0 ? Math.max(1, toQ(swingTick(p, x.t + x.len) - swingTick(p, x.t))) : null,
      });
    }
  };
  const tpb = ticksPerBar(p);
  if (patternId) {
    const pat = d.patterns.find((x) => x.id === patternId);
    if (pat) add(0, pat, pat.bars * tpb);
  } else {
    for (const b of d.blocks) {
      const pat = d.patterns.find((x) => x.id === b.pattern);
      if (!pat) continue;
      for (let k = 0; k * pat.bars < b.bars; k++) {
        add((b.start + k * pat.bars) * tpb, pat, Math.min(pat.bars, b.bars - k * pat.bars) * tpb);
      }
    }
  }
  // Sem duração escolhida: fusa (em bateria a duração da nota quase nunca importa).
  const len = Math.round(PPQ / 8);
  const ev = [];
  for (const n of notes) {
    ev.push({ t: n.t, order: 1, bytes: [0x99, n.note, n.vel] });
    ev.push({ t: n.t + (n.len ?? len), order: 0, bytes: [0x89, n.note, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.order - b.order);

  const vlq = (v) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const tempo = Math.round(60000000 / (p.bpm * (den / 4))); // µs por semínima
  const track = [
    0, 0xff, 0x03, 7, ...new TextEncoder().encode('Bateria'),
    0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, bpb, Math.log2(den), 24, 8,
  ];
  let last = 0;
  for (const e of ev) { track.push(...vlq(Math.max(0, e.t - last)), ...e.bytes); last = e.t; }
  track.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, PPQ];
  const tl = track.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, (tl >>> 24) & 255, (tl >>> 16) & 255, (tl >>> 8) & 255, tl & 255, ...track]);
}

// ---------------------------------------------------------------- Pads no vídeo

/**
 * Todas as batidas da música por pad, em segundos (com swing), para acender os pads no vídeo.
 * Devolve Map padId → { t: Float64Array (ordenado), v: Float32Array }.
 */
export function drumTimeline(p) {
  const d = p?.drums;
  const out = new Map();
  if (!d) return out;
  const pads = audiblePads(d);
  const spt = secPerTick(p);
  const tpb = ticksPerBar(p);
  const bar = barSec(p);
  const tmp = new Map();
  for (const b of d.blocks) {
    const pat = d.patterns.find((x) => x.id === b.pattern);
    if (!pat) continue;
    for (let k = 0; k * pat.bars < b.bars; k++) {
      const limit = Math.min(pat.bars, b.bars - k * pat.bars) * tpb;
      const t0 = (b.start + k * pat.bars) * bar;
      for (const x of pat.hits) {
        if (!pads.has(x.pad) || x.t < 0 || x.t >= limit) continue;
        let l = tmp.get(x.pad);
        if (!l) tmp.set(x.pad, (l = []));
        l.push([t0 + swingTick(p, x.t) * spt, x.v]);
      }
    }
  }
  for (const [id, l] of tmp) {
    l.sort((a, b) => a[0] - b[0]);
    out.set(id, { t: Float64Array.from(l, (x) => x[0]), v: Float32Array.from(l, (x) => x[1]) });
  }
  return out;
}

/** Brilho (0–1) de um pad no instante t: acende na batida e apaga em ~0,3 s. */
export function padGlow(tl, padId, t) {
  const e = tl?.get(padId);
  if (!e || !e.t.length || t < e.t[0]) return 0;
  let lo = 0;
  let hi = e.t.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (e.t[m] <= t) lo = m; else hi = m - 1; }
  const age = t - e.t[lo];
  return age > 0.6 ? 0 : (0.35 + 0.65 * e.v[lo]) * Math.exp(-age / 0.13);
}

/** Cor de cada família de som (mesma na prévia e no vídeo). */
export const PAD_HUE = {
  kick: 355, kick808: 340, snare: 25, rim: 35, clap: 45, hatC: 52, hatP: 58, hatO: 64,
  tomH: 190, tomM: 205, tomL: 220, ride: 170, crash: 160, cowbell: 280, shaker: 295, pandeiro: 310,
  rimshot: 15, tomF: 235, rideBell: 178, china: 150,
};
