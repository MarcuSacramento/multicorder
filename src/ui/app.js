// Controlador da interface. A UI só conversa com o motor (src/engine); só o motor chama as APIs de mídia.
import { AudioEngine } from '../engine/audio-engine.js';
import { detectCapabilities } from '../engine/capabilities.js';
import { isBluetooth, listDevices, openAudioInput, openVideoInput, stopStream } from '../engine/devices.js';
import {
  activeGrid, auditionPad, copyPattern, createDrums, createPattern, LIVE_KEYS, drumTimeline, drumsToMidi, DRUMS_ID, GM_NOTE, gridTicks, pastePattern, placeBlock,
  removePads, renderDrums, secPerTick, ticksPerBar, unusedPads,
} from '../engine/drums.js';
import { importDrumsMidi, midiMeta, parseMidi, renderMidi } from '../engine/midi.js';
import { GUIDE_ID } from '../engine/mix-graph.js';
import {
  addPunch, barSec, beatsPerBar, cutsFor, duplicateBars, mapRanges, insertBars, takeExtent, loopRange, normalizeProject, normalizePunches, projectDuration, PUNCH_XF, removeBars,
  showsDrums, TIME_SIGNATURES,
} from '../engine/project.js';
import { renderMix } from '../engine/exporter.js';
import { encodeWav } from '../engine/wav.js';
import { loadVideoPrefs, REC_RES, recordBitrate } from '../engine/quality.js';
import { TakeRecorder } from '../engine/recorder.js';
import { cleanActive, cleanKey, processAudio } from '../engine/dsp.js';
import { ProjectStore } from '../engine/storage.js';
import { fmtBytes, gainToDb, uid } from '../engine/util.js';
import { busy, collapsible, download, h, safeName, toast } from './dom.js';
import { renderExportPanel } from './views/export.js';
import { renderDrumsPanel, updateDrumsPanel } from './views/drums.js';
import { renderHome } from './views/home.js';
import { renderInspector, takeClips, updateInputMeters, usedInputs } from './views/inspector.js';
import { renderMixer, updateMeters } from './views/mixer.js';
import { Stage } from './views/stage.js';
import { Tracks } from './views/tracks.js';
import { buildWorkspace, placeTracks, renderStatus, renderTopbar, updateTransport } from './views/workspace.js';
import { barBeat } from './views/timeline.js';

const MB = 1024 * 1024;
const root = document.getElementById('app');

const S = {
  project: null,
  selectedId: null,
  transport: 'stopped', // 'stopped' | 'playing' | 'recording'
  armed: false,
  arming: false,
  armedChannelId: null,
  audioStream: null,
  videoStream: null,
  inputInfo: null,
  monitor: false,
  devices: { audioIn: [], videoIn: [], audioOut: [] },
  bufKeys: new Map(),
  cleanInfo: new Map(), // canal → o que a limpeza fez (estalos, puffs, segundos silenciados)
  guideKey: null,
  drumKey: null, // última versão da bateria pedida
  drumBufKey: null, // versão que está no buffer tocando
  drumsOpen: false,
  drumFollow: true, // o editor da bateria acompanha a música tocando
  mixerMin: (() => { try { return localStorage.getItem('mc.mixerMin') === '1'; } catch { return false; } })(), // mixer compacto
  drumsMin: (() => { try { return localStorage.getItem('mc.drumsMin') === '1'; } catch { return false; } })(), // painel da bateria minimizado
  drumSamples: new Map(), // fileId → AudioBuffer dos samples próprios dos pads
  drumTL: null, // batidas por pad (acende os pads no vídeo)
  padFlash: new Map(), // padId → { at: performance.now(), v } — toques ao vivo
  livePlay: false, // teclado do computador toca os pads
  liveRec: false, // toques ao vivo entram na grade enquanto a música toca
  liveSnap: 'grid', // 'grid' | 'free'
  midi: null, // { access, names: [] }
  midiLearn: null, // pad esperando uma nota do controlador
  recorder: null,
  recording: null,
  stopping: false,
  rateFallback: false,
  raf: 0,
  ui: null,
};

export const app = {
  S,
  engine: new AudioEngine(),
  store: new ProjectStore(),
  caps: null,
  stage: null,
  get project() { return S.project; },
  selected() { return S.project?.channels.find((c) => c.id === S.selectedId) || null; },
};

// ---------------------------------------------------------------- Início

async function boot() {
  root.replaceChildren(h('div', { class: 'splash' }, 'Carregando Multicorder…'));
  app.caps = await detectCapabilities();
  if (app.caps.missingCore.length) {
    return fatal(`Este navegador não tem: ${app.caps.missingCore.join(', ')}. Use o Firefox 130+ ou o Chrome 126+ no computador, abrindo por http://localhost.`);
  }
  try {
    await app.store.init();
    await app.engine.init({ sampleRate: 48000 });
  } catch (e) {
    return fatal(e.message);
  }
  app.stage = new Stage(app);
  app.tracks = new Tracks(app);
  document.addEventListener('pointerdown', () => app.engine.resume(), true);
  document.addEventListener('keydown', onKey);
  navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange);
  window.addEventListener('beforeunload', (e) => {
    if (S.transport === 'recording') { e.preventDefault(); e.returnValue = ''; }
  });
  app.store.persist().catch(() => {});
  try { S.devices = await listDevices(); } catch { /* sem permissão ainda */ }
  await restoreSink();
  await app.goHome();
}

/** RC-03: no Chrome, volta para a saída escolhida antes. No Firefox não há setSinkId no Web Audio. */
async function restoreSink() {
  if (!app.engine.canSetSink()) return;
  let id = '';
  try { id = localStorage.getItem('mc.sink') || ''; } catch { /* ok */ }
  if (!id) return;
  try {
    await app.engine.setSink(id);
    S.sinkId = id;
    S.sinkLabel = S.devices.audioOut.find((d) => d.id === id)?.label || 'escolhida';
  } catch { /* dispositivo sumiu */ }
}

function fatal(msg) {
  root.replaceChildren(h('div', { class: 'fatal card' }, h('h1', null, 'Multicorder - VideoMusic Maker'), h('p', null, msg)));
}

app.goHome = async () => {
  await closeProject();
  await renderHome(app, root);
};

// ---------------------------------------------------------------- Projeto

app.openProject = async (id) => {
  await closeProject();
  let p;
  try {
    p = normalizeProject(await app.store.load(id));
  } catch (e) {
    toast(`Não foi possível abrir o projeto: ${e.message}`, 'error');
    return;
  }
  const recovered = await recoverPending(p);
  S.project = p;
  S.selectedId = p.channels[0].id;
  S.bufKeys = new Map();
  S.guideKey = null;
  S.drumKey = S.drumBufKey = null;
  S.drumSamples = new Map();
  S.drumTL = null;
  S.livePlay = S.liveRec = false;
  S.midiLearn = null;
  app.engine.stopPos = 0;
  app.engine.sync(p, true);
  S.ui = buildWorkspace(app, root);
  app.stage.mount(S.ui.stageWrap);
  app.renderPanels();
  startLoop();
  const b = busy(`Abrindo "${p.name}"…`);
  try {
    await app.loadAllMedia((done, total) => b.set(total ? done / total : 1, `Mídias carregadas: ${done} de ${total}`));
    b.set(null, 'Carregando bateria…');
    await loadDrumSamples();
    await app.flushDrums();
  } finally { b.close(); }
  toast(`Projeto "${p.name}" carregado.`, 'info', 3000);
  resetHistory();
  if (recovered) toast(recovered, 'warn', 12000);
  checkStorage(false);
};

async function closeProject() {
  if (!S.project) return;
  if (S.transport === 'recording') await stopRecording();
  app.engine.stop();
  S.transport = 'stopped';
  app.disarm(true);
  await saveNow();
  app.stage.clear();
  for (const id of [...app.engine.buffers.keys()]) app.engine.setBuffer(id, null);
  cancelAnimationFrame(S.raf);
  S.raf = 0;
  S.project = null;
  S.ui = null;
  resetHistory();
}

/** CA-06: recupera a tomada que estava sendo gravada quando a aba fechou. */
async function recoverPending(p) {
  const pt = p.pendingTake;
  if (!pt) return null;
  const take = p.takes[pt.takeId];
  const frames = await app.store.takeAudioFrames(p.id, pt.takeId);
  let msg;
  if (take && take.audioStart != null && frames > 0) {
    take.frames = frames;
    take.status = 'done';
    take.recovered = true;
    take.videoStart ??= 0;
    const vid = await app.store.readTakeVideo(p.id, pt.takeId);
    take.hasVideo = !!vid;
    for (const id of pt.channelIds) {
      const ch = p.channels.find((c) => c.id === id);
      if (ch) ch.takeId = pt.takeId;
    }
    msg = `Tomada interrompida recuperada (${(frames / take.sampleRate).toFixed(1)} s).`;
  } else {
    delete p.takes[pt.takeId];
    await app.store.deleteTake(p.id, pt.takeId);
    msg = 'Uma tomada interrompida não tinha dados suficientes e foi descartada.';
  }
  delete p.pendingTake;
  await app.store.save(p);
  await app.store.gc(p);
  await app.store.save(p);
  return msg;
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.project) return;
  try { await app.store.save(S.project); } catch (e) { toast(`Erro ao salvar: ${e.message}`, 'error'); }
}
app.saveNow = saveNow;

/** Qualquer mudança no modelo passa por aqui. `structural` redesenha os painéis. */
app.touch = (structural = false) => {
  if (!S.project) return;
  app.engine.sync(S.project);
  restartIfLoopChanged();
  refreshDrums();
  saveSoon();
  updateMonitor();
  commitSoon();
  if (structural) app.renderPanels();
};

// ---------------------------------------------------------------- Desfazer / refazer

// Guarda "fotos" do projeto (JSON) depois de cada edição; mudanças seguidas em menos de 350 ms
// (arrastar um fader, por exemplo) viram um passo só. Ficam de fora as tomadas gravadas, a escolha
// de dispositivos e o arquivo da faixa-guia: são mídia, e os arquivos apagados não voltam.
const HIST_MAX = 100;
const hist = { stack: [], idx: -1, timer: 0 };

function snapshot(p) {
  const q = { ...p };
  delete q.takes;
  delete q.pendingTake;
  delete q.updatedAt;
  delete q.inputDefaults;
  // Dos punch-ins entra só onde cada um começa e termina (arrastar as bordas na faixa dá para desfazer);
  // gravar ou apagar um punch-in não volta.
  q.channels = p.channels.map(({ takeId, punches, altTakes, audioDeviceId, videoDeviceId, ...c }) => (
    punches?.length ? { ...c, pb: punches.map((x) => [x.takeId, x.start, x.end, x.cutBase || 0]) } : c));
  if (p.guide) {
    const { volumeDb, mute, offsetMs, includeInExport } = p.guide;
    q.guide = { volumeDb, mute, offsetMs, includeInExport };
  }
  if (p.drums) {
    const { sel, ...d } = p.drums; // o padrão aberto no editor não é uma edição
    q.drums = d;
  }
  return JSON.stringify(q);
}

function resetHistory() {
  clearTimeout(hist.timer);
  hist.timer = 0;
  hist.stack = S.project ? [snapshot(S.project)] : [];
  hist.idx = hist.stack.length - 1;
  updateUndoButtons();
}

/** Arrastos longos (bordas na faixa): segura o histórico e grava um passo só ao soltar. */
app.holdHistory = (on) => {
  hist.hold = on;
  if (!on && hist.idx >= 0) commitNow();
};

function commitSoon() {
  if (hist.idx < 0 || S.restoring || hist.hold) return;
  clearTimeout(hist.timer);
  hist.timer = setTimeout(commitNow, 350);
  updateUndoButtons();
}

function commitNow() {
  clearTimeout(hist.timer);
  hist.timer = 0;
  const p = S.project;
  if (!p || hist.idx < 0) return;
  const s = snapshot(p);
  if (s === hist.stack[hist.idx]) { updateUndoButtons(); return; }
  hist.stack.splice(hist.idx + 1);
  hist.stack.push(s);
  if (hist.stack.length > HIST_MAX) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  updateUndoButtons();
}

/** Volta o projeto para uma foto, mantendo tomadas, dispositivos e o arquivo da guia atuais. */
function restore(json) {
  const p = S.project;
  const q = JSON.parse(json);
  // Um corte de compassos não volta depois que algo foi gravado em cima dele: a gravação nova está
  // na escala de tempo de depois do corte e ficaria fora do lugar.
  const nCuts = (q.cuts || []).length;
  const media = [...Object.values(p.takes), p.guide, ...p.channels.flatMap((c) => c.punches || [])].filter(Boolean);
  if (media.some((m) => (m.cutBase || 0) > nCuts)) return false;
  const cur = new Map(p.channels.map((c) => [c.id, c]));
  for (const c of q.channels) {
    const o = cur.get(c.id);
    c.takeId = o && o.takeId && p.takes[o.takeId] ? o.takeId : null;
    // Bordas dos punch-ins da foto, para os que ainda existem (casando pela tomada, na ordem)
    const pb = c.pb || [];
    delete c.pb;
    const used = new Set();
    const live = o?.punches || [];
    const count = (list, id) => list.filter((y) => (y.takeId ?? y[0]) === id).length;
    c.punches = live.map((x) => {
      if (count(live, x.takeId) !== count(pb, x.takeId)) return x; // um punch-in novo dividiu este: fica como está
      const k = pb.findIndex((y, j) => !used.has(j) && y[0] === x.takeId);
      if (k < 0) return x;
      used.add(k);
      return { ...x, start: pb[k][1], end: pb[k][2], cutBase: pb[k][3] };
    });
    c.altTakes = o?.altTakes || [];
    c.audioDeviceId = o?.audioDeviceId || '';
    c.videoDeviceId = o?.videoDeviceId || '';
  }
  q.takes = p.takes;
  q.pendingTake = p.pendingTake;
  q.inputDefaults = p.inputDefaults;
  q.updatedAt = p.updatedAt;
  q.guide = p.guide && q.guide ? { ...p.guide, ...q.guide } : p.guide;
  if (q.drums) {
    const sel = p.drums?.sel;
    q.drums.sel = q.drums.patterns.some((x) => x.id === sel) ? sel : q.drums.patterns[0]?.id;
  }
  for (const k of Object.keys(p)) if (!(k in q)) delete p[k];
  Object.assign(p, q);
  normalizeProject(p);
  if (!p.channels.some((c) => c.id === S.selectedId)) S.selectedId = p.channels[0].id;
  S.restoring = true;
  try { app.touch(true); } finally { S.restoring = false; }
  app.loadAllMedia(); // limpeza/tom do canal podem ter mudado (só processa o que mudou)
  if (S.transport === 'playing') playFrom(Math.max(0, app.engine.position)); // sincronia/corte reagendados
  app.loadAllMedia();
  loadDrumSamples();
  updateUndoButtons();
}

app.canUndo = () => hist.idx > 0 || !!hist.timer;
app.canRedo = () => hist.idx >= 0 && hist.idx < hist.stack.length - 1 && !hist.timer;

app.undo = () => {
  if (!S.project || S.transport === 'recording') return;
  commitNow(); // a edição que ainda estava agrupando vira um passo, e é ela que sai
  if (hist.idx <= 0) { toast('Nada para desfazer.', 'info', 1500); return; }
  if (restore(hist.stack[hist.idx - 1]) === false) {
    toast('Não dá para desfazer a remoção de compassos depois de gravar em cima dela (a gravação nova ficaria fora do lugar).', 'warn', 8000);
    return;
  }
  hist.idx--;
  hist.stack[hist.idx] = snapshot(S.project);
  updateUndoButtons();
  toast('Desfeito', 'info', 1200);
};

app.redo = () => {
  if (!S.project || S.transport === 'recording') return;
  commitNow();
  if (hist.idx >= hist.stack.length - 1) { toast('Nada para refazer.', 'info', 1500); return; }
  if (restore(hist.stack[hist.idx + 1]) === false) {
    toast('Não dá para refazer este passo: há uma gravação feita depois em outra escala de tempo.', 'warn', 8000);
    return;
  }
  hist.idx++;
  // A foto pode diferir do que ficou (ex.: a guia foi trocada depois): passa a valer o estado real.
  hist.stack[hist.idx] = snapshot(S.project);
  updateUndoButtons();
  toast('Refeito', 'info', 1200);
};

/** Arquivos de samples que ainda podem voltar com o desfazer não são apagados. */
const historyMentions = (id) => hist.stack.some((s) => s.includes(id));

function updateUndoButtons() {
  const bar = S.ui?.topbar;
  if (!bar) return;
  const u = bar.querySelector('[data-undo]');
  const r = bar.querySelector('[data-redo]');
  if (u) u.disabled = !(hist.idx > 0 || hist.timer);
  if (r) r.disabled = !(hist.idx >= 0 && hist.idx < hist.stack.length - 1);
}
app.updateUndoButtons = updateUndoButtons;

/**
 * Sincronia/corte de um canal. Tocando, reagenda só o áudio desse canal no mesmo ponto
 * (sem isso a mudança só valia no próximo play, enquanto o vídeo já mudava na hora).
 */
app.setChannelTiming = (ch, patch) => {
  Object.assign(ch, patch);
  app.touch();
  if (S.transport === 'playing') app.engine.refreshSource(ch.id);
};

/**
 * Nível "cheio" de um áudio: RMS em janelas de 400 ms, pegando a janela do percentil 90
 * (ignora silêncios e não se deixa levar por um único pico). Em dB.
 */
function loudLevelDb(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const w = Math.round(buf.sampleRate * 0.4);
  const lv = [];
  for (let o = 0; o + w <= L.length; o += w) {
    let s = 0;
    for (let i = o; i < o + w; i++) s += (L[i] * L[i] + R[i] * R[i]) / 2;
    const db = 10 * Math.log10(s / w + 1e-12);
    if (db > -60) lv.push(db);
  }
  if (!lv.length) return null;
  lv.sort((a, b) => a - b);
  return lv[Math.floor(lv.length * 0.9)];
}

/**
 * Iguala o volume da bateria ao do canal gravado mais alto (cada um medido com os próprios efeitos e fader,
 * sem o limitador do master). Ordem: fader da bateria (até +6 dB) → Ganho da bateria (até +18 dB) →
 * só então abaixa os canais gravados pelo que ainda faltar.
 */
app.matchDrumsLevel = async () => {
  const p = S.project;
  const d = p?.drums;
  const buffers = app.engine.buffers;
  if (!d || !buffers.get(DRUMS_ID) || S.transport !== 'stopped' || S.matching) return;
  const chans = p.channels.filter((c) => c.takeId && p.takes[c.takeId]?.status === 'done' && !c.mute && !showsDrums(p, c) && buffers.get(c.id));
  if (!chans.length) { toast('Grave pelo menos um canal para igualar a bateria a ele.', 'warn'); return; }
  S.matching = true;
  toast('Medindo o volume dos canais e da bateria…', 'info', 4000);
  try {
    const FADER_MAX = 6, DRIVE_MAX = 18;
    const q = structuredClone(p);
    q.master.limiter = false;
    q.master.volumeDb = 0;
    // Mede só o strip em questão (os outros canais saem do clone) e no máximo 30 s: fica rápido em música longa.
    const level = async (id, bufs = buffers) => {
      const one = { ...q, channels: q.channels.filter((c) => c.id === id), guide: null };
      if (id !== DRUMS_ID) one.drums = null;
      return loudLevelDb(await renderMix(one, bufs, { onlyChannelId: id, maxSec: 30 }));
    };
    let target = null;
    for (const c of chans) { const v = await level(c.id); if (v != null && (target == null || v > target)) target = v; }
    let drumsDb = await level(DRUMS_ID);
    if (drumsDb == null || target == null) { toast('Não deu para medir: a bateria ou os canais estão em silêncio.', 'warn'); return; }
    if (Math.abs(target - drumsDb) < 0.5) { toast('A bateria já está no mesmo nível do canal gravado mais alto.', 'info', 6000); return; }

    // 1) fader
    const want = d.volumeDb + (target - drumsDb);
    q.drums.volumeDb = Math.max(-30, Math.min(FADER_MAX, Math.round(want * 2) / 2));
    let rest = want - q.drums.volumeDb;
    // 2) Ganho. A saturação não é linear: mede, estima a inclinação (dB de nível por dB de ganho) e corrige.
    let drive = d.driveDb || 0;
    if (rest > 0.25) {
      const sr = app.engine.sampleRate;
      const at = async (dv) => {
        q.drums.driveDb = dv;
        const buf = await renderDrums(q, sr, S.drumSamples);
        return level(DRUMS_ID, new Map(buffers).set(DRUMS_ID, buf));
      };
      let d0 = drive, l0 = await level(DRUMS_ID);
      let slope = 0.6; // chute inicial, medido nos kits
      for (let k = 0; k < 4 && drive < DRIVE_MAX; k++) {
        rest = target - l0;
        if (rest < 0.4) break;
        drive = Math.min(DRIVE_MAX, Math.round((d0 + rest / slope) * 2) / 2);
        if (drive <= d0) break;
        const l1 = await at(drive);
        if (l1 > l0 + 0.05) slope = Math.max(0.15, Math.min(1, (l1 - l0) / (drive - d0)));
        d0 = drive; l0 = l1;
      }
      drumsDb = l0;
      rest = Math.max(0, target - drumsDb);
      if (target - drumsDb < -0.75) {
        // o Ganho passou do ponto: desconta a sobra no fader (depois da saturação ele é linear)
        q.drums.volumeDb = Math.max(-30, Math.round((q.drums.volumeDb + (target - drumsDb)) * 2) / 2);
      }
    } else rest = 0;
    d.volumeDb = q.drums.volumeDb;
    d.driveDb = drive;
    // 3) ainda faltando com o Ganho no máximo: abaixa os canais gravados (sobra pequena antes disso é só arredondamento)
    const cut = drive >= DRIVE_MAX ? Math.round(rest * 2) / 2 : 0;
    if (cut >= 0.5) for (const c of p.channels) if (c.takeId) c.volumeDb = Math.max(-60, c.volumeDb - cut);
    toast(`Bateria: fader ${d.volumeDb.toFixed(1)} dB, ganho +${d.driveDb.toFixed(1)} dB`
      + (cut >= 0.5 ? `; canais gravados ${cut.toFixed(1)} dB mais baixos (suba o master se o total ficar baixo).` : '.'), 'info', 10000);
    app.touch(true);
  } catch (e) {
    toast(`Erro ao medir: ${e.message}`, 'error');
  } finally {
    S.matching = false;
  }
};

app.layoutCenter = () => placeTracks(app);
// Blocos de baixo abrindo/fechando e a janela mudando de tamanho: o centro recalcula a altura.
for (const ev of ['mc-layout', 'resize']) window.addEventListener(ev, () => { if (S.ui) { placeTracks(app); app.stage?.resize(); } });
app.collapsible = collapsible;

/** "Exportar" na barra de cima: abre a coluna da direita (se recolhida) e leva até os botões, no fim dela. */
app.showExportPanel = () => {
  if (!S.ui) return;
  if (S.ui.mobile) { app.mobileTab('exportar'); return; } // celular: a aba Exportar
  S.ui.right._set(false);
  renderExportPanel(app, S.ui.exportbar);
  // os botões ficam no fim da coluna: rola até eles
  const btn = S.ui.exportbar.querySelector('[data-export-video]');
  btn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  btn?.focus({ preventScroll: true });
};

app.renderPanels = () => {
  if (!S.ui) return;
  renderTopbar(app, S.ui.topbar);
  renderInspector(app, S.ui.inspector);
  renderExportPanel(app, S.ui.exportbar);
  renderMixer(app, S.ui.mixer);
  renderDrumsPanel(app, S.ui.drums);
  renderStatus(app, S.ui.status);
  updateTransport(app, S.ui.transport, app.engine.position);
  app.stage.resize();
};

app.select = (id) => {
  if (S.selectedId === id) return;
  S.selectedId = id;
  if (S.armed && S.transport === 'stopped') {
    const ch = app.selected();
    const a = ch.audioDeviceId || S.project.inputDefaults.audioDeviceId;
    const v = ch.videoDeviceId || S.project.inputDefaults.videoDeviceId;
    const sameA = !a || a === S.inputInfo?.settings?.deviceId;
    const sameV = !v || v === (S.inputInfo?.videoSettings?.deviceId || 'none');
    if (sameA && sameV) S.armedChannelId = id;
    else app.arm();
  }
  renderInspector(app, S.ui.inspector);
  renderMixer(app, S.ui.mixer);
  updateMonitor();
};

app.swapChannels = (i, j) => {
  const a = S.project.channels;
  if (S.transport !== 'stopped' || !a[i] || !a[j]) return;
  [a[i], a[j]] = [a[j], a[i]];
  app.touch(true);
};

// ---------------------------------------------------------------- Mídia das tomadas

app.loadAllMedia = async (onProgress) => {
  const p = S.project;
  if (!p) return;
  const jobs = [];
  for (const ch of p.channels) {
    jobs.push(loadChannelAudio(ch));
    for (const id of [ch.takeId, ...(ch.punches || []).map((x) => x.takeId)]) {
      const t = id && p.takes[id];
      if (t?.hasVideo && t.status === 'done') jobs.push(app.stage.loadTakeVideo(p.id, t));
    }
  }
  jobs.push(loadGuide());
  let done = 0;
  onProgress?.(0, jobs.length);
  const tracked = onProgress ? jobs.map((j) => j.finally(() => onProgress(++done, jobs.length))) : jobs;
  try { await Promise.all(tracked); } catch (e) { toast(`Erro ao carregar mídia: ${e.message}`, 'error'); }
  app.stage.dropUnused(p);
  if (S.ui) { renderMixer(app, S.ui.mixer); updateTransport(app, S.ui.transport, app.engine.position); }
};

/**
 * Monta os AudioBuffers do canal (tomada principal + punch-ins) a partir do estéreo bruto,
 * conforme a entrada física escolhida (RU-03). Punch-in fica no buffer "<canal>#<tomada>".
 */
async function loadChannelAudio(ch) {
  const p = S.project;
  const base = ch.takeId && p.takes[ch.takeId];
  const wanted = new Map();
  if (base?.status === 'done') {
    wanted.set(ch.id, base);
    for (const x of ch.punches || []) {
      const t = p.takes[x.takeId];
      if (t?.status === 'done') wanted.set(`${ch.id}#${t.id}`, t);
    }
  }
  for (const id of [...S.bufKeys.keys()]) {
    if (id.startsWith(`${ch.id}#`) && !wanted.has(id)) { S.bufKeys.delete(id); app.engine.setBuffer(id, null); }
  }
  if (!wanted.has(ch.id)) { S.bufKeys.set(ch.id, null); app.engine.setBuffer(ch.id, null); return; }
  const busy = cleanActive(ch.clean) && [...wanted].some(([id, t]) => S.bufKeys.get(id) !== `${t.id}|${ch.inputMode}|${cleanKey(ch.clean)}`);
  const slow = busy ? setTimeout(() => toast(`Processando o som de "${ch.name}" (limpeza/tom)…`, 'info', 3000), 700) : 0;
  try {
    await Promise.all([...wanted].map(([id, t]) => loadTakeBuffer(id, t, ch.inputMode, ch.clean, ch)));
  } finally { clearTimeout(slow); }
}

async function loadTakeBuffer(bufId, t, inputMode, clean = null, ch = null) {
  const p = S.project;
  const ck = cleanKey(clean);
  const key = `${t.id}|${inputMode}|${ck}`;
  if (S.bufKeys.get(bufId) === key) return;
  S.bufKeys.set(bufId, key);
  const raw = await app.store.readTakeAudio(p.id, t.id);
  if (S.bufKeys.get(bufId) !== key || S.project !== p) return;
  const frames = raw.length >> 1;
  if (!frames) { app.engine.setBuffer(bufId, null); return; }
  const stereo = inputMode === 'stereo';
  let chans;
  if (stereo) {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let i = 0; i < frames; i++) { L[i] = raw[2 * i]; R[i] = raw[2 * i + 1]; }
    chans = [L, R];
  } else {
    const off = inputMode === 'R' ? 1 : 0;
    const d = new Float32Array(frames);
    for (let i = 0; i < frames; i++) d[i] = raw[2 * i + off];
    chans = [d];
  }
  if (ck) {
    // Limpeza e tom: processa fora da tela; o arquivo gravado continua igual
    try {
      const r = await processAudio(chans, t.sampleRate, clean);
      if (S.bufKeys.get(bufId) !== key || S.project !== p) return;
      chans = r.chans;
      if (ch && !bufId.includes('#')) S.cleanInfo.set(ch.id, r.info);
    } catch (e) {
      toast(`Não deu para processar o som${ch ? ` de "${ch.name}"` : ''}: ${e.message}. Tocando sem a limpeza.`, 'warn', 8000);
    }
  } else if (ch && !bufId.includes('#')) S.cleanInfo.delete(ch.id);
  const buf = new AudioBuffer({ length: frames, numberOfChannels: chans.length, sampleRate: t.sampleRate });
  chans.forEach((d, i) => buf.copyToChannel(d, i));
  app.engine.setBuffer(bufId, buf);
  if (ck && S.transport === 'playing' && ch) app.engine.refreshSource(ch.id);
  if (t.frames !== frames) { t.frames = frames; saveSoon(); }
}
app.reloadChannelAudio = async (ch) => { await loadChannelAudio(ch); };

/** Mudou a limpeza ou o tom do canal: processa de novo (agrupa mudanças seguidas de um slider). */
const cleanTimers = new Map();
app.setClean = (ch) => {
  app.touch();
  clearTimeout(cleanTimers.get(ch.id));
  cleanTimers.set(ch.id, setTimeout(async () => {
    cleanTimers.delete(ch.id);
    await loadChannelAudio(ch);
    if (S.ui) renderInspector(app, S.ui.inspector);
  }, 450));
};

async function loadGuide() {
  const g = S.project.guide;
  const key = g ? g.fileId : null;
  if (S.guideKey === key) return;
  S.guideKey = key;
  if (!g) { app.engine.setBuffer(GUIDE_ID, null); return; }
  const f = await app.store.readFile(S.project.id, `guide-${g.fileId}.bin`);
  const buf = await app.engine.ctx.decodeAudioData(await f.arrayBuffer());
  app.engine.setBuffer(GUIDE_ID, buf);
}

const isMidiFile = (file) => /\.(mid|midi|kar|rmi)$/i.test(file.name) || /midi/i.test(file.type);

/**
 * Oferece usar o andamento e o compasso de um arquivo MIDI no projeto (a grade, o metrônomo e a
 * bateria passam a bater com o arquivo). Devolve true se o projeto mudou.
 */
function adoptMidiTempo(m) {
  const p = S.project;
  const meta = midiMeta(m);
  const bpm = meta.bpm && meta.bpm >= 40 && meta.bpm <= 240 ? Math.round(meta.bpm * 100) / 100 : null;
  const ts = meta.timeSig && TIME_SIGNATURES.includes(meta.timeSig) ? meta.timeSig : null;
  const diffBpm = bpm && Math.abs(bpm - p.bpm) >= 0.01;
  const diffTs = ts && ts !== p.timeSig;
  if (!diffBpm && !diffTs) return false;
  const what = [diffBpm && `${bpm} BPM`, diffTs && `compasso ${ts}`].filter(Boolean).join(' e ');
  if (!confirm(`O arquivo MIDI está em ${what}; o projeto está em ${p.bpm} BPM, ${p.timeSig}.\n\nMudar o projeto para o andamento do arquivo?`)) return false;
  if (diffBpm) p.bpm = bpm;
  if (diffTs) p.timeSig = ts;
  return true;
}

/** RF-13: faixa-guia (não ocupa quadro na grade). Aceita áudio ou MIDI (.mid, sintetizado aqui). */
app.importGuide = async (file, { source = null, url = null, name = null } = {}) => {
  const p = S.project;
  const midi = !source && isMidiFile(file);
  try {
    let ab;
    let buf;
    if (midi) {
      const m = parseMidi(await file.arrayBuffer());
      if (!m.notes.length) throw new Error('o arquivo não tem notas');
      adoptMidiTempo(m);
      if (midiMeta(m).tempoChanges) toast('O MIDI muda de andamento no meio: a guia segue o arquivo, mas a grade do projeto usa um BPM só.', 'warn', 9000);
      toast('Gerando o áudio do MIDI…', 'info', 3000);
      buf = await renderMidi(m, app.engine.sampleRate, { kitId: p.drums?.kit || 'rock' });
      ab = await encodeWav([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate, 16).arrayBuffer();
    } else {
      ab = await file.arrayBuffer();
      buf = await app.engine.ctx.decodeAudioData(ab.slice(0));
    }
    if (S.project !== p) return;
    const fileId = uid('g');
    await app.store.writeFile(p.id, `guide-${fileId}.bin`, ab);
    if (p.guide) await app.store.deleteFile(p.id, `guide-${p.guide.fileId}.bin`);
    const keep = p.guide ? { volumeDb: p.guide.volumeDb, mute: p.guide.mute, offsetMs: p.guide.offsetMs, includeInExport: p.guide.includeInExport } : {};
    p.guide = {
      volumeDb: -6, mute: false, offsetMs: 0, includeInExport: true, ...keep,
      fileId, cutBase: p.cuts.length, name: name || file.name, duration: buf.duration, source: source || (midi ? 'midi' : 'audio'), url,
    };
    S.guideKey = fileId;
    app.engine.setBuffer(GUIDE_ID, buf);
    app.touch(true);
    if (midi) toast(`Faixa-guia criada a partir do MIDI (${file.name}).`, 'info', 4000);
    return true;
  } catch (e) {
    console.error(e);
    toast(`Não foi possível ler ${midi ? 'o MIDI' : 'o áudio'}: ${e.message}`, 'error');
    return false;
  }
};

app.removeGuide = async () => {
  const p = S.project;
  if (!p.guide) return;
  await app.store.deleteFile(p.id, `guide-${p.guide.fileId}.bin`);
  p.guide = null;
  S.guideKey = null;
  app.engine.setBuffer(GUIDE_ID, null);
  app.touch(true);
};

app.deleteTake = async (ch) => {
  if (!ch.takeId || S.transport !== 'stopped') return;
  const next = (ch.altTakes || []).find((x) => S.project.takes[x.takeId]?.status === 'done');
  if (!confirm(`Apagar a tomada de "${ch.name}"${ch.punches?.length ? ' e os punch-ins dela' : ''}?${next ? `
O canal passa a usar a tomada guardada de ${takeWhen(S.project.takes[next.takeId])}.` : ''} Isso não pode ser desfeito.`)) return;
  ch.takeId = null;
  ch.punches = [];
  if (next) {
    // a guardada mais nova vira a tomada do canal
    ch.altTakes = ch.altTakes.filter((x) => x !== next);
    ch.takeId = next.takeId;
    ch.punches = next.punches || [];
    ch.trimStart = next.trimStart || 0;
    ch.trimEnd = next.trimEnd || 0;
  }
  await saveNow();
  await app.store.gc(S.project);
  await saveNow();
  await loadChannelAudio(ch);
  if (next) await app.loadAllMedia(); // o vídeo da tomada que voltou
  app.stage.dropUnused(S.project);
  app.touch(true);
};

// ---------------------------------------------------------------- Entrada (câmera + áudio)

app.arm = async () => {
  const p = S.project;
  const ch = app.selected();
  if (!p || !ch || S.arming) return;
  // Sem esperar: com a saída de áudio travada, resume() demora; a câmera não depende dela.
  // Se o relógio estiver parado, o play/gravar seguinte reinicia o áudio (ensureAudio).
  app.engine.resume();
  app.disarm(true);
  S.arming = true;
  renderInspector(app, S.ui.inspector);
  try {
    const a = await openAudioInput(ch.audioDeviceId || p.inputDefaults.audioDeviceId);
    S.audioStream = a.stream;
    let v = null;
    const vid = ch.videoDeviceId || p.inputDefaults.videoDeviceId;
    if (vid !== 'none') {
      const vp = loadVideoPrefs();
      try { v = await openVideoInput(vid, { ...REC_RES[vp.recRes], fps: vp.recFps }); } catch (e) { toast(`Câmera indisponível (${e.message}). Gravando só áudio.`, 'warn'); }
    }
    S.videoStream = v?.stream || null;
    try {
      app.engine.openInput(a.stream);
    } catch (e) {
      if (e.name !== 'NotSupportedError') throw e;
      // Firefox: entrada numa taxa diferente da do AudioContext. Recria o contexto na taxa do sistema.
      await app.engine.init({});
      app.engine.sync(p, true);
      await restoreSink();
      app.engine.openInput(a.stream);
      S.rateFallback = true;
      toast(`O sistema está em ${app.engine.sampleRate} Hz e o dispositivo não aceita 48 kHz neste navegador. O app passou a usar ${app.engine.sampleRate} Hz. Para 48 kHz, ajuste a taxa da interface no sistema (RU-05).`, 'warn', 14000);
    }
    S.armed = true;
    S.armedChannelId = ch.id;
    S.inputInfo = { label: a.label, settings: a.settings, videoSettings: v?.settings || null, videoLabel: v?.label || null };
    if (a.settings.deviceId) { ch.audioDeviceId = a.settings.deviceId; p.inputDefaults.audioDeviceId = a.settings.deviceId; }
    if (v?.settings.deviceId) { ch.videoDeviceId = v.settings.deviceId; p.inputDefaults.videoDeviceId = v.settings.deviceId; }
    const cc = a.settings.channelCount;
    if (cc === 1 && ch.inputMode !== 'L') {
      ch.inputMode = 'L';
      toast('A entrada entregou só 1 canal; usando a Entrada 1 (RC-04).', 'warn');
    }
    if (a.settings.sampleRate && a.settings.sampleRate !== app.engine.sampleRate) {
      toast(`Atenção: a entrada está em ${a.settings.sampleRate} Hz e o app em ${app.engine.sampleRate} Hz. O navegador vai converter; para melhor qualidade use a mesma taxa no sistema.`, 'warn', 10000);
    }
    if (isBluetooth(a.label)) toast('Dispositivo Bluetooth detectado: a latência é alta e varia. Use fone com fio ou a interface USB.', 'warn', 10000);
    a.track.addEventListener('ended', onInputEnded);
    v?.track.addEventListener('ended', onInputEnded);
    app.stage.setLive(S.videoStream);
    try { S.devices = await listDevices(); } catch { /* ok */ }
    saveSoon();
  } catch (e) {
    toast(`Não foi possível abrir a entrada: ${e.message}`, 'error', 10000);
    app.disarm(true);
  } finally {
    S.arming = false;
    if (S.ui) { renderInspector(app, S.ui.inspector); renderStatus(app, S.ui.status); }
    updateMonitor();
  }
};

app.disarm = (silent = false) => {
  stopStream(S.audioStream);
  stopStream(S.videoStream);
  S.audioStream = S.videoStream = null;
  app.engine.closeInput();
  S.armed = false;
  S.armedChannelId = null;
  S.inputInfo = null;
  app.stage?.setLive(null);
  if (!silent && S.ui) renderInspector(app, S.ui.inspector);
};

function onInputEnded() {
  if (S.transport === 'recording') { stopRecording('device'); return; }
  if (S.armed) {
    app.disarm();
    toast('A entrada de áudio ou a câmera foi desconectada.', 'warn');
  }
}

async function onDeviceChange() {
  try { S.devices = await listDevices(); } catch { return; }
  const id = S.inputInfo?.settings?.deviceId;
  if (S.armed && id && !S.devices.audioIn.some((d) => d.id === id)) onInputEnded();
  else if (S.ui && S.transport === 'stopped') renderInspector(app, S.ui.inspector);
}

function updateMonitor() {
  const ch = app.selected();
  if (!ch) return;
  app.engine.setMonitor({ on: S.monitor && S.armed, mode: ch.inputMode, gainDb: ch.inputGainDb });
}
app.setMonitor = (on) => { S.monitor = on; updateMonitor(); };

// ---------- Nível da entrada e afinador ----------

const LEVEL_TEST_MS = 8000;

/** Mede o pico da entrada do canal por 8 s; o painel mostra a sugestão no fim. */
app.startLevelTest = (ch) => {
  if (!S.armed || S.transport === 'recording') return;
  app.engine.resume();
  S.levelTest = { channelId: ch.id, until: performance.now() + LEVEL_TEST_MS, peak: 0, clipped: false, done: false };
  renderInspector(app, S.ui.inspector);
};

function tickLevelTest() {
  const t = S.levelTest;
  if (!t || t.done) return;
  const ch = S.project.channels.find((c) => c.id === t.channelId);
  const lv = app.engine.inputLevels();
  if (!ch || !lv || !S.armed) { S.levelTest = null; renderInspector(app, S.ui.inspector); return; }
  for (const k of usedInputs(ch)) {
    t.peak = Math.max(t.peak, lv[k]);
    if (lv[k] >= 0.99) t.clipped = true;
  }
  if (performance.now() >= t.until) {
    t.done = true;
    t.peakDb = gainToDb(t.peak);
    renderInspector(app, S.ui.inspector);
  }
}

const A4_KEY = 'mc.tunerA4';
app.tunerA4 = () => {
  try { const v = +localStorage.getItem(A4_KEY); if (v >= 415 && v <= 466) return v; } catch { /* ok */ }
  return 440;
};
app.setTunerA4 = (v) => {
  try { localStorage.setItem(A4_KEY, String(Math.round(Math.min(466, Math.max(415, v))))); } catch { /* ok */ }
};
app.setTuner = (on) => {
  S.tunerOn = on;
  S.tunerState = {};
  renderInspector(app, S.ui.inspector);
};

// ---------------------------------------------------------------- Latência

app.latency = () => {
  try {
    const v = JSON.parse(localStorage.getItem('mc.latency') || 'null');
    if (v && Number.isFinite(v.ms)) return { ...v, calibrated: true };
  } catch { /* ok */ }
  const l = app.engine.latency();
  const inMs = (S.inputInfo?.settings?.latency ?? 0.01) * 1000;
  return { ms: Math.round(l.baseMs + l.outputMs + inMs), calibrated: false };
};

app.setLatency = (ms, extra = {}) => {
  try { localStorage.setItem('mc.latency', JSON.stringify({ ms, at: Date.now(), ...extra })); } catch { /* ok */ }
  if (S.ui) { renderStatus(app, S.ui.status); updateTransport(app, S.ui.transport, app.engine.position); }
};

app.clearLatency = () => {
  try { localStorage.removeItem('mc.latency'); } catch { /* ok */ }
  if (S.ui) renderStatus(app, S.ui.status);
};

// ---------------------------------------------------------------- Transporte

/** A saída de áudio do sistema parou de pedir som: o relógio do navegador não anda e nada toca. */
function audioStalled() {
  if (S.audioWarnedAt && Date.now() - S.audioWarnedAt < 10000) return;
  S.audioWarnedAt = Date.now();
  toast('A saída de áudio do computador não está respondendo, e reiniciar o áudio do app não resolveu. '
    + 'Feche outros programas que usam a interface (DAW, driver ASIO, chamadas), confira a saída padrão do Windows '
    + '(ou desligue e ligue o cabo USB da interface) e recarregue a página.', 'error', 20000);
}

/**
 * Recria o AudioContext: fecha e reabre a saída de áudio do navegador (destrava quando o Windows/Chrome
 * para de entregar som). Reabre a entrada se ela estava ligada. Devolve true se o relógio voltou a andar.
 */
async function recoverAudio() {
  if (S.recovering) return S.recovering;
  S.recovering = (async () => {
    const wasArmed = S.armed;
    app.disarm(true); // solta microfone e câmera antes de recriar o contexto
    try {
      await app.engine.init(S.rateFallback ? {} : { sampleRate: 48000 });
      if (S.project) app.engine.sync(S.project, true);
      await restoreSink();
      await app.engine.resume();
      const ok = await app.engine.clockAlive(400);
      if (ok && wasArmed) await app.arm();
      if (ok) toast('O áudio tinha travado e foi reiniciado.', 'warn', 6000);
      return ok;
    } catch (e) {
      console.warn('Falha ao reiniciar o áudio', e);
      return false;
    } finally {
      if (S.ui) { renderInspector(app, S.ui.inspector); renderStatus(app, S.ui.status); }
    }
  })();
  try { return await S.recovering; } finally { S.recovering = null; }
}

/** Garante que o áudio está andando; se travou, tenta reiniciar uma vez antes de avisar. */
async function ensureAudio() {
  await app.engine.resume();
  if (await app.engine.clockAlive(150)) return true;
  if (await recoverAudio()) return true;
  audioStalled();
  return false;
}

app.togglePlay = async () => {
  if (!S.project) return;
  if (S.transport === 'recording') return stopRecording();
  if (S.transport === 'playing') {
    app.engine.stop();
    S.transport = 'stopped';
    updateTransport(app, S.ui.transport, app.engine.position);
    return;
  }
  if (!(await ensureAudio())) return;
  const dur = projectDuration(S.project);
  let from = app.engine.stopPos;
  if (dur > 0 && from >= dur - 0.05 && !loopRange(S.project)) from = 0;
  playFrom(from);
  S.transport = 'playing';
  updateTransport(app, S.ui.transport, app.engine.position);
};

app.seek = (pos) => {
  if (S.transport === 'recording') return;
  if (S.transport === 'playing') playFrom(pos);
  else app.engine.seek(pos);
};

const loopKey = (p) => `${p.loop.on}|${p.loop.start}|${p.loop.end}|${p.bpm}|${p.timeSig}`;

/** Toca respeitando o loop do projeto (a gravação nunca usa loop). */
function playFrom(pos) {
  S.loopKey = loopKey(S.project);
  app.engine.play(pos, { loop: loopRange(S.project) });
}

/** Mudou o loop, o BPM ou o compasso durante a reprodução: recomeça do mesmo ponto. */
function restartIfLoopChanged() {
  if (S.transport !== 'playing' || S.loopKey === loopKey(S.project)) return;
  playFrom(Math.max(0, app.engine.position));
}

// ---------- Observações na régua ----------

const noteLabel = (p, beat) => {
  const bpb = beatsPerBar(p.timeSig);
  return `${Math.floor(beat / bpb) + 1}.${(beat % bpb) + 1}`;
};

/** Cria uma observação na posição atual (arredondada para o tempo mais próximo). */
app.addNote = () => {
  const p = S.project;
  if (!p) return;
  const beat = Math.max(0, Math.round(Math.max(0, app.engine.position) * p.bpm / 60));
  const text = prompt(`Observação no compasso ${noteLabel(p, beat)}:`, '');
  if (!text?.trim()) return;
  p.notes.push({ id: uid('n'), beat, text: text.trim() });
  p.notes.sort((a, b) => a.beat - b.beat);
  app.touch();
};

/** Edita o texto; deixar vazio apaga. */
app.editNote = (id) => {
  const p = S.project;
  const n = p?.notes.find((x) => x.id === id);
  if (!n) return;
  const text = prompt(`Observação no compasso ${noteLabel(p, n.beat)} (deixe vazio para apagar):`, n.text);
  if (text == null) return;
  if (text.trim()) n.text = text.trim();
  else p.notes.splice(p.notes.indexOf(n), 1);
  app.touch();
};

app.toggleLoop = () => {
  if (!S.project || S.transport === 'recording') return;
  S.project.loop.on = !S.project.loop.on;
  app.touch();
};

/** Região do loop em compassos (início inclusivo, fim exclusivo). */
app.setLoop = (start, end, on = true) => {
  const l = S.project.loop;
  l.start = Math.max(0, Math.round(Math.min(start, end)));
  l.end = Math.max(l.start + 1, Math.round(Math.max(start, end)));
  l.on = on;
  app.touch();
  if (S.ui && S.transport === 'stopped') renderInspector(app, S.ui.inspector); // o botão do punch-in mostra o trecho
};

/**
 * Remove os compassos [a, b) da música inteira (contados de 0, fim exclusivo): bateria, observações,
 * loop, canais gravados, punch-ins e faixa-guia. O que vem depois anda para trás. Dá para desfazer.
 */
app.removeBars = (a, b) => {
  const p = S.project;
  if (!p || S.transport !== 'stopped') return;
  const label = b - a > 1 ? `compassos ${a + 1}–${b}` : `compasso ${a + 1}`;
  if (!confirm(`Remover ${label} da música inteira?\n\nSai desse trecho tudo: bateria, observações, canais gravados (som e vídeo), punch-ins e faixa-guia. O que vem depois anda para trás e fecha o buraco.\n\nDá para desfazer com Ctrl+Z (enquanto você não gravar nada em cima).`)) return;
  const r = removeBars(p, a, b);
  app.engine.seek(Math.min(app.engine.stopPos, a * barSec(p)));
  app.touch(true);
  app.loadAllMedia();
  toast(`${r.bars === 1 ? 'Compasso removido' : `${r.bars} compassos removidos`}.`
    + (r.splitBlocks ? ` ${r.splitBlocks === 1 ? 'Um bloco' : `${r.splitBlocks} blocos`} da bateria foi cortado no meio do padrão: a parte de depois recomeça o padrão do início.` : '')
    + ' Ctrl+Z desfaz.', r.splitBlocks ? 'warn' : 'info', r.splitBlocks ? 9000 : 4000);
};

/**
 * Insere compassos vazios antes do compasso `a` (contado de 0) na música inteira: bateria, observações,
 * trocas de layout, linhas de volume/pan e o que foi gravado andam para frente. Dá para desfazer.
 */
app.insertBars = (a = null) => {
  const p = S.project;
  if (!p || S.transport !== 'stopped') return;
  const bar = barSec(p);
  const here = a ?? Math.round(Math.max(0, app.engine.stopPos) / bar);
  const ans = prompt(`Inserir quantos compassos vazios antes do compasso ${here + 1}?

O que vem dali em diante (bateria, observações, canais gravados, punch-ins, guia, trocas de layout e linhas de volume) anda para frente e fica um silêncio no meio.

Para escolher outro ponto, cancele e ponha o cursor no compasso desejado.`, '1');
  if (ans == null) return;
  const n = Math.floor(Number(String(ans).replace(',', '.')));
  if (!(n >= 1 && n <= 64)) { toast('Use um número de 1 a 64.', 'warn'); return; }
  const r = insertBars(p, here, n);
  app.engine.seek(here * bar);
  app.touch(true);
  app.loadAllMedia();
  toast(`${n === 1 ? 'Compasso inserido' : `${n} compassos inseridos`} antes do compasso ${here + 1}.`
    + (r.splitBlocks ? ` ${r.splitBlocks === 1 ? 'Um bloco' : `${r.splitBlocks} blocos`} da bateria foi dividido no meio do padrão: a parte de depois recomeça o padrão do início.` : '')
    + ' Ctrl+Z desfaz.', r.splitBlocks ? 'warn' : 'info', r.splitBlocks ? 9000 : 5000);
};

/** Duplica os compassos [a, b) logo depois deles (seção copiada): tudo vai junto, inclusive o gravado. */
app.duplicateBars = (a, b, name = null) => {
  const p = S.project;
  if (!p || S.transport !== 'stopped') return;
  const what = name ? `"${name}" (compassos ${a + 1}–${b})` : `os compassos ${a + 1}–${b}`;
  if (!confirm(`Duplicar ${what}?\n\nA cópia entra logo depois, nos compassos ${b + 1}–${2 * b - a}, com tudo o que tem no trecho: canais gravados (som e vídeo), punch-ins, bateria, guia, letra, observações, trocas de layout e linhas de volume/pan. O que vem depois anda para frente.\n\nCtrl+Z desfaz.`)) return;
  const r = duplicateBars(p, a, b);
  app.engine.seek(b * barSec(p));
  app.touch(true);
  app.loadAllMedia();
  toast(`${name ? `"${name}" duplicada` : 'Trecho duplicado'}: a cópia está nos compassos ${b + 1}–${2 * b - a}.`
    + (r.splitBlocks ? ` ${r.splitBlocks === 1 ? 'Um bloco' : `${r.splitBlocks} blocos`} da bateria começa no meio do padrão na cópia: ela recomeça o padrão do início.` : '')
    + ' Ctrl+Z desfaz.', r.splitBlocks ? 'warn' : 'info', r.splitBlocks ? 9000 : 5000);
};

app.rewind = () => app.seek(0);

// ---------------------------------------------------------------- Bateria

const drumsKey = (p) => (p.drums
  ? JSON.stringify([p.drums.kit, p.bpm, p.timeSig, p.drums.swing, p.drums.swingGrid, p.drums.driveDb || 0, [...S.drumSamples.keys()],
    p.drums.pads, p.drums.patterns.map((x) => [x.id, x.bars, x.hits]), p.drums.blocks])
  : null);
let drumTimer = 0;

/** Pede um novo áudio da bateria quando os padrões mudam (agrupa edições seguidas). */
function refreshDrums() {
  const p = S.project;
  if (!p) return;
  const key = drumsKey(p);
  if (key === S.drumKey) return;
  S.drumKey = key;
  clearTimeout(drumTimer);
  drumTimer = setTimeout(() => { drumTimer = 0; renderDrumsNow(p, key); }, 120);
}

async function renderDrumsNow(p, key) {
  let buf = null;
  try {
    buf = key ? await renderDrums(p, app.engine.sampleRate, S.drumSamples) : null;
  } catch (e) {
    console.error(e);
    toast(`Erro ao gerar a bateria: ${e.message}`, 'error');
  }
  if (S.project !== p || S.drumKey !== key) return; // já mudou de novo
  app.engine.setBuffer(DRUMS_ID, buf);
  S.drumBufKey = key;
  S.drumTL = drumTimeline(p);
  // Tocando (ou gravando): troca só o som da bateria, sem parar a música.
  if (S.transport !== 'stopped') app.engine.refreshSource(DRUMS_ID);
}

/** Garante que o áudio da bateria corresponde ao projeto (antes de exportar). */
app.flushDrums = async () => {
  const p = S.project;
  if (!p) return;
  const key = drumsKey(p);
  if (key === S.drumBufKey) return;
  clearTimeout(drumTimer);
  drumTimer = 0;
  S.drumKey = key;
  await renderDrumsNow(p, key);
};

app.toggleDrums = () => {
  if (!S.project) return;
  S.drumsOpen = !S.drumsOpen;
  renderDrumsPanel(app, S.ui.drums);
  updateTransport(app, S.ui.transport, app.engine.position);
};

/** Mixer compacto (só mudo e solo) ou completo. A escolha fica guardada no navegador. */
app.setMixerMin = (on) => {
  if (!S.project) return;
  S.mixerMin = on;
  try { localStorage.setItem('mc.mixerMin', on ? '1' : '0'); } catch { /* ok */ }
  renderMixer(app, S.ui.mixer);
  app.stage.resize();
};

/** Minimiza o painel da bateria (só a faixa com os blocos) ou volta ao editor completo. */
app.setDrumsMin = (on) => {
  if (!S.project) return;
  S.drumsMin = on;
  try { localStorage.setItem('mc.drumsMin', on ? '1' : '0'); } catch { /* ok */ }
  if (!S.drumsOpen) S.drumsOpen = true;
  renderDrumsPanel(app, S.ui.drums);
  updateTransport(app, S.ui.transport, app.engine.position);
  app.stage.resize();
};

app.addDrums = () => {
  const p = S.project;
  const dur = projectDuration(p);
  const bars = dur > 0 ? Math.max(1, Math.ceil(dur / barSec(p) - 1e-6)) : 8;
  p.drums = createDrums(p, bars);
  S.drumsOpen = true;
  S.drumsMin = false;
  app.touch(true);
};

app.removeDrums = () => {
  const p = S.project;
  if (!p.drums || !confirm('Remover a bateria do projeto (todos os padrões e pads)?')) return;
  p.drums = null;
  app.touch(true);
  cleanDrumFiles();
};

/** Botão "Tirar pads sem uso": remove os pads que não tocam na música (Ctrl+Z desfaz). */
app.removeUnusedPads = async () => {
  const p = S.project;
  if (!p?.drums) return;
  const { unused, outside } = unusedPads(p);
  if (!unused.length) { toast('Todos os pads tocam na música: nada para tirar.', 'info', 4000); return; }
  const names = (list) => (list.length > 10 ? `${list.slice(0, 10).map((x) => x.name).join(', ')} e mais ${list.length - 10}` : list.map((x) => x.name).join(', '));
  const warn = outside.length
    ? `\n\nAtenção: ${names(outside)} ${outside.length > 1 ? 'têm' : 'tem'} batidas só em padrões que não estão na música; essas batidas também saem.`
    : '';
  if (!confirm(`Tirar ${unused.length} pad${unused.length > 1 ? 's' : ''} que não toca${unused.length > 1 ? 'm' : ''} na música?\n\n${names(unused)}${warn}\n\nCtrl+Z desfaz.`)) return;
  if (S.midiLearn && unused.includes(S.midiLearn)) S.midiLearn = null;
  removePads(p.drums, unused);
  app.touch(true);
  toast(`${unused.length} pad${unused.length > 1 ? 's' : ''} sem uso removido${unused.length > 1 ? 's' : ''}. Ctrl+Z desfaz.`, 'info', 5000);
  await cleanDrumFiles(); // sons próprios que ainda podem voltar com o Ctrl+Z ficam guardados
};

app.auditionPad = (pad, v) => {
  const e = app.engine;
  e.resume();
  const strip = e.graph.strips.get(DRUMS_ID);
  auditionPad(e.ctx, strip ? strip.input : e.ctx.destination, pad, v, S.drumSamples, S.project?.drums?.kit);
};

// ---------- Tocar ao vivo (teclado e MIDI) ----------

app.setLivePlay = (on) => {
  S.livePlay = on;
  if (!on) S.liveRec = false;
  if (S.ui) { renderDrumsPanel(app, S.ui.drums); renderStatus(app, S.ui.status); }
};

app.setLiveRec = (on) => {
  S.liveRec = on;
  if (on && !S.livePlay && !S.midi) S.livePlay = true;
  if (S.ui) renderDrumsPanel(app, S.ui.drums);
};

/** Um toque num pad: soa na hora, acende e (gravando toques) entra na grade. */
app.hitPad = (pad, v = 0.8, lateSec = 0) => {
  app.auditionPad(pad, v);
  S.padFlash.set(pad.id, { at: performance.now(), v });
  flashPadRow(pad.id);
  if (S.liveRec && S.transport !== 'stopped') {
    // Desconta o atraso da saída de áudio (ouvimos a música atrasada) e o atraso do evento.
    const l = app.engine.latency();
    const pos = app.engine.position - (l.baseMs + l.outputMs) / 1000 - lateSec;
    if (pos >= 0) recordLiveHit(pad, pos, v);
  }
};

function flashPadRow(id) {
  const row = S.ui?.drums.querySelector(`.dr-pad[data-pad="${id}"]`);
  if (!row) return;
  row.classList.add('hit');
  setTimeout(() => row.classList.remove('hit'), 110);
}

/** Grava o toque no padrão que está tocando naquele compasso (cria um bloco se não houver). */
function recordLiveHit(pad, pos, v) {
  const p = S.project;
  const d = p.drums;
  const bar = barSec(p);
  const b = Math.floor(pos / bar);
  let blk = d.blocks.find((x) => b >= x.start && b < x.start + x.bars);
  if (!blk) {
    const sel = d.patterns.find((x) => x.id === d.sel) || d.patterns[0];
    placeBlock(d, b, sel.bars, sel.id);
    blk = d.blocks.find((x) => x.start === b);
  }
  const pat = d.patterns.find((x) => x.id === blk.pattern);
  if (!pat) return;
  const len = pat.bars * ticksPerBar(p);
  let t = ((pos - blk.start * bar) / secPerTick(p)) % len;
  if (S.liveSnap === 'grid') {
    const c = gridTicks(p, activeGrid(p));
    t = (Math.round(t / c) * c) % len;
  } else t = Math.round(t) % len;
  const same = pat.hits.find((x) => x.pad === pad.id && Math.abs(x.t - t) < (S.liveSnap === 'grid' ? 1 : 4));
  if (same) same.v = Math.max(same.v, v);
  else pat.hits.push({ pad: pad.id, t, v });
  app.touch();
  if (d.sel === pat.id) S.ui?.drums._ed?.draw();
  else { d.sel = pat.id; renderDrumsPanel(app, S.ui.drums); }
}

/** Liga um controlador MIDI USB (Web MIDI). Notas → pads pela nota escolhida ou pelo padrão General MIDI. */
app.connectMidi = async () => {
  if (!navigator.requestMIDIAccess) {
    toast('Este navegador não oferece Web MIDI. No Firefox, ele pede para instalar uma permissão do site; no Chrome/Edge funciona direto.', 'warn', 10000);
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    const attach = () => {
      const names = [];
      for (const input of access.inputs.values()) {
        input.onmidimessage = onMidi;
        names.push(input.name || 'Controlador MIDI');
      }
      S.midi = { access, names };
      if (S.ui) renderDrumsPanel(app, S.ui.drums);
    };
    access.onstatechange = attach;
    attach();
    toast(S.midi.names.length ? `MIDI: ${S.midi.names.join(', ')}` : 'MIDI ligado, mas nenhum controlador encontrado. Conecte um pelo USB.', 'info', 5000);
  } catch (e) {
    toast(`MIDI não liberado: ${e.message}`, 'error');
  }
};

function onMidi(e) {
  const [st, note, vel] = e.data;
  if ((st & 0xf0) !== 0x90 || !vel) return; // só "nota ligada"
  const d = S.project?.drums;
  if (!d) return;
  if (S.midiLearn) {
    const pad = S.midiLearn;
    S.midiLearn = null;
    for (const x of d.pads) if (x !== pad && x.midiNote === note) x.midiNote = null;
    pad.midiNote = note;
    app.touch();
    toast(`${pad.name} agora toca com a nota ${note}.`, 'info', 3000);
    renderDrumsPanel(app, S.ui.drums);
    return;
  }
  const pad = d.pads.find((x) => x.midiNote === note) || d.pads.find((x) => x.midiNote == null && GM_NOTE[x.sound] === note);
  if (!pad) return;
  const late = Math.max(0, (performance.now() - e.timeStamp) / 1000);
  app.hitPad(pad, vel / 127, late < 1 ? late : 0);
}

app.learnMidi = (pad) => {
  S.midiLearn = pad;
  toast(S.midi ? `Toque a tecla/pad do controlador para ${pad.name}.` : 'Ligue o MIDI primeiro (botão "MIDI USB" no painel).', 'info', 5000);
};

// ---------- Samples próprios nos pads ----------

const sampleFile = (fileId) => `drum-${fileId}.bin`;

/** Carrega (uma vez) os arquivos de áudio usados pelos pads. */
async function loadDrumSamples() {
  const p = S.project;
  for (const pad of p?.drums?.pads || []) {
    const id = pad.sample?.fileId;
    if (!id || S.drumSamples.has(id)) continue;
    try {
      const f = await app.store.readFile(p.id, sampleFile(id));
      const buf = await app.engine.ctx.decodeAudioData(await f.arrayBuffer());
      if (S.project === p) S.drumSamples.set(id, buf);
    } catch (e) {
      toast(`Pad "${pad.name}": não foi possível ler o som próprio (${e.message}). Usando o som do kit.`, 'warn', 9000);
    }
  }
}

/** Apaga arquivos de samples que nenhum pad usa mais. */
async function cleanDrumFiles() {
  const p = S.project;
  if (!p) return;
  const used = new Set((p.drums?.pads || []).map((x) => x.sample?.fileId).filter(Boolean));
  try {
    for (const f of await app.store.walk(p.id)) {
      const m = /^drum-(.+)\.bin$/.exec(f.path);
      if (m && !used.has(m[1]) && !historyMentions(m[1])) { await app.store.deleteFile(p.id, f.path); S.drumSamples.delete(m[1]); }
    }
  } catch { /* pasta ainda não existe */ }
}

/** Usa um arquivo de áudio do usuário como som do pad (fica salvo dentro do projeto). */
app.setPadSample = async (pad, file) => {
  const p = S.project;
  try {
    const ab = await file.arrayBuffer();
    const buf = await app.engine.ctx.decodeAudioData(ab.slice(0));
    if (buf.duration > 30) throw new Error('o som tem mais de 30 s');
    const fileId = uid('s');
    await app.store.writeFile(p.id, sampleFile(fileId), ab);
    S.drumSamples.set(fileId, buf);
    pad.sample = { fileId, name: file.name };
    pad.name = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || pad.name;
    app.touch(true);
    app.auditionPad(pad);
    await cleanDrumFiles();
  } catch (e) {
    toast(`Não foi possível usar o arquivo: ${e.message}`, 'error');
  }
};

app.clearPadSample = async (pad) => {
  pad.sample = null;
  app.touch(true);
  await cleanDrumFiles();
};
app.cleanDrumFiles = cleanDrumFiles;

// ---------- Copiar / colar padrão (vale entre projetos) ----------

const CLIP = 'mc.drumClip';
let clipMem = null;
app.copyDrumPattern = (pattern) => {
  const clip = copyPattern(S.project.drums, pattern);
  clipMem = clip;
  try { localStorage.setItem(CLIP, JSON.stringify(clip)); } catch { /* ok */ }
  toast(`Padrão ${pattern.name} copiado (${clip.hits.length} batidas).`, 'info', 2500);
};
app.drumClipboard = () => {
  try { return JSON.parse(localStorage.getItem(CLIP) || 'null') || clipMem; } catch { return clipMem; }
};
app.pasteDrumPattern = (pattern) => {
  const clip = app.drumClipboard();
  if (!clip) { toast('Nada copiado ainda: use "Copiar" num padrão.', 'info', 3000); return; }
  const n = pastePattern(S.project.drums, pattern, clip);
  toast(n ? `${n} batidas coladas em ${pattern.name}.` : 'Essas batidas já estavam no padrão.', 'info', 2500);
  app.touch(true);
};

// ---------- MIDI ----------

/**
 * Importa um .mid para a bateria. mode 'song': a música inteira (padrões + blocos desde o
 * compasso 1); 'pattern': soma as batidas no padrão aberto. Cria a bateria se não houver.
 */
app.importDrumsMidi = async (file, mode = 'song') => {
  const p = S.project;
  let m;
  try {
    m = parseMidi(await file.arrayBuffer());
    if (!m.notes.length) throw new Error('o arquivo não tem notas');
  } catch (e) {
    toast(`Não foi possível ler o MIDI: ${e.message}`, 'error');
    return;
  }
  if (S.project !== p) return;
  if (mode === 'song' && p.drums?.blocks.length
    && !confirm('Os blocos da bateria na música vão ser trocados pelos do arquivo, a partir do compasso 1.\nOs padrões que você já tem continuam na lista.\n\nImportar?')) return;
  adoptMidiTempo(m);
  if (!p.drums) {
    p.drums = createDrums(p, 1);
    p.drums.patterns = [];
    p.drums.blocks = [];
    mode = 'song';
    S.drumsMin = false; // bateria nova: mostra o editor
  }
  const d = p.drums;
  const r = importDrumsMidi(p, m, { mode, patternId: d.sel, startBar: 0 });
  if (!d.patterns.length) { const a = createPattern(d, 1); d.patterns.push(a); d.sel = a.id; }
  S.drumsOpen = true;
  app.touch(true);
  if (!r.hits) {
    toast('Nenhuma batida de bateria reconhecida no arquivo (as notas precisam seguir o padrão General MIDI, de preferência no canal 10).', 'warn', 9000);
    return;
  }
  const parts = [mode === 'song'
    ? `${r.hits} batidas em ${r.bars} compasso${r.bars > 1 ? 's' : ''} (${r.patterns} padrão${r.patterns > 1 ? 'ões' : ''} novo${r.patterns > 1 ? 's' : ''}).`
    : `${r.hits} batidas no padrão.`];
  if (r.created.length) parts.push(`Pads novos: ${r.created.join(', ')}.`);
  if (r.removed.length) {
    parts.push(r.removed.length > 4
      ? `${r.removed.length} pads sem batidas removidos (use "+ Pad…" para pôr de volta).`
      : `Pads sem batidas removidos: ${r.removed.map((x) => x.name).join(', ')}.`);
  }
  if (r.removed.some((x) => x.sample)) cleanDrumFiles();
  if (r.skipped.length) parts.push(`Notas sem som correspondente ignoradas: ${r.skipped.join(', ')}.`);
  toast(parts.join(' '), r.skipped.length ? 'warn' : 'info', 9000);
};

app.exportDrumsMidi = (patternId = null) => {
  const p = S.project;
  const bytes = drumsToMidi(p, { patternId });
  const pat = patternId && p.drums.patterns.find((x) => x.id === patternId);
  download(new Blob([bytes], { type: 'audio/midi' }), `${safeName(p.name)}-bateria${pat ? `-${safeName(pat.name)}` : ''}.mid`);
};

app.toggleRecord = async () => {
  if (S.transport === 'recording') return stopRecording();
  if (S.transport === 'playing') { app.engine.stop(); S.transport = 'stopped'; }
  return startRecording();
};

async function checkStorage(interactive) {
  try {
    const e = await app.store.estimate();
    S.storage = e;
    if (S.ui) renderStatus(app, S.ui.status);
    if (e.quota && e.free < 500 * MB) {
      const msg = `Pouco espaço de armazenamento livre para o navegador: ${fmtBytes(e.free)} (RNF-09).`;
      if (interactive) return confirm(`${msg}\nUma tomada de vídeo 1080p usa ~60 MB por minuto. Gravar mesmo assim?`);
      toast(msg, 'warn', 10000);
    }
  } catch { /* estimativa indisponível */ }
  return true;
}

/**
 * Grava uma tomada no canal selecionado. Com `punch` = { start, end } (segundos), é um punch-in:
 * toca um pré-roll antes do trecho, grava, para sozinho depois do fim e só o trecho substitui a tomada.
 */
async function startRecording({ punch = null, from = 0 } = {}) {
  const p = S.project;
  const ch = app.selected();
  if (!p || !ch || S.transport !== 'stopped') return;
  if (!app.caps.recordMime) toast('Este navegador não grava vídeo WebM; será gravado só o áudio.', 'warn');
  const linked = ch.linkWith ? p.channels.find((c) => c.id === ch.linkWith) : null;
  const over = [ch, linked].filter((c) => c?.takeId);
  const hasPunches = over.some((c) => c.punches?.length);
  if (!punch && over.length && !confirm(`Gravar outra tomada em ${over.map((c) => `"${c.name}"`).join(' e ')}?\nA tomada atual${hasPunches ? ' (com os punch-ins dela)' : ''} fica guardada na lista "Outras tomadas" do canal: dá para voltar a ela ou usar só um trecho dela depois. Os outros canais não mudam.\n\nPara regravar só um trecho, use o Punch-in (Shift+R).`)) return;
  if (!(await checkStorage(true))) return;
  if (!S.armed || S.armedChannelId !== ch.id) {
    if (!S.armed) await app.arm();
    if (!S.armed) return;
    S.armedChannelId = ch.id;
  }
  if (!app.engine.workletOk) { toast('AudioWorklet indisponível: não dá para gravar.', 'error'); return; }
  if (!(await ensureAudio())) return;
  if (!S.armed) return; // a entrada não voltou depois de reiniciar o áudio
  S.armedChannelId = ch.id;

  const engine = app.engine;
  const sr = engine.sampleRate;
  const lat = app.latency();
  const spb = 60 / p.bpm;
  const startCtx = engine.now + 0.3;
  // Gravação normal: a contagem regressiva antecede o 0. Punch-in ou "gravar daqui": toca desde
  // `playFrom` (pré-roll de compassos antes do ponto).
  const lead = punch ? punch.start : from;
  const preRoll = !!punch || from > 0;
  const playFrom = preRoll ? lead - Math.max(1, p.countInBars) * barSec(p) : 0;
  // instante do contexto em que a linha do tempo está em 0
  const T0 = preRoll ? startCtx - playFrom : startCtx + p.countInBars * beatsPerBar(p.timeSig) * spb;
  const takeId = uid('t');
  const take = {
    id: takeId, status: 'recording', sampleRate: sr, channels: 2, audioStart: null, videoStart: null,
    frames: 0, latencyMs: lat.ms, latencyCalibrated: lat.calibrated, createdAt: Date.now(), hasVideo: false, punch: !!punch, cutBase: p.cuts.length,
    videoMime: (app.caps.recordMime || 'video/webm').split(';')[0],
  };
  const channelIds = [ch.id, linked?.id].filter(Boolean);
  p.takes[takeId] = take;
  p.pendingTake = { takeId, channelIds };
  await app.store.save(p);

  const rec = new TakeRecorder({
    engine, store: app.store, projectId: p.id, takeId,
    videoStream: S.videoStream, mimeType: app.caps.recordMime,
    videoBitrate: (() => {
      const vs = S.inputInfo?.videoSettings || {};
      return recordBitrate(vs.width || 1280, vs.height || 720, vs.frameRate || 30, loadVideoPrefs().recQuality);
    })(),
    onMeta: (m) => {
      // Posição na linha do tempo da 1ª amostra = quadro / taxa − T0 − latência de ida e volta.
      if (m.firstFrame != null) take.audioStart = m.firstFrame / sr - T0 - lat.ms / 1000;
      if (m.videoStartCtx != null) { take.videoStart = m.videoStartCtx - T0; take.hasVideo = true; }
      saveSoon();
    },
    onDeviceLost: () => stopRecording('device'),
    onError: (e) => toast(`Erro ao salvar a gravação: ${e.message}`, 'error'),
  });
  S.recorder = rec;
  S.recording = { takeId, T0, channelIds, punch, from: punch?.open ? punch.start : from };
  S.transport = 'recording';
  try {
    await rec.start();
  } catch (e) {
    toast(`Não foi possível iniciar a gravação: ${e.message}`, 'error');
    S.transport = 'stopped';
    S.recorder = S.recording = null;
    delete p.takes[takeId];
    delete p.pendingTake;
    await saveNow();
    return;
  }
  if (punch) {
    // O canal toca a tomada antiga até o início do trecho (para entrar no clima) e cala ali.
    engine.play(playFrom, {
      at: startCtx, countInFrom: startCtx, countInUntil: T0 + punch.start,
      cutAt: new Map(channelIds.map((id) => [id, punch.start])),
    });
  } else if (from > 0) {
    // Canal vazio gravando de um ponto: os outros tocam desde o pré-roll, com clique até o ponto.
    engine.play(playFrom, { at: startCtx, exclude: channelIds, countInFrom: startCtx, countInUntil: T0 + from });
  } else {
    engine.play(0, { at: T0, exclude: channelIds, countInFrom: startCtx });
  }
  updateTransport(app, S.ui.transport, engine.position);
  renderMixer(app, S.ui.mixer);
  renderInspector(app, S.ui.inspector);
}

async function stopRecording(reason) {
  if (S.transport !== 'recording' || S.stopping) return;
  S.stopping = true;
  const p = S.project;
  const { takeId, channelIds, punch, from } = S.recording;
  const take = p.takes[takeId];
  app.engine.stop();
  let res = { frames: 0, hasVideo: false };
  try { res = await S.recorder.stop(); } catch (e) { toast(`Erro ao finalizar: ${e.message}`, 'error'); }
  S.recorder = null;
  S.recording = null;
  S.transport = 'stopped';
  S.stopping = false;
  take.frames = res.frames;
  take.hasVideo = take.hasVideo && res.hasVideo;
  if (res.clips) take.clips = res.clips;
  delete p.pendingTake;
  if (!res.frames || take.audioStart == null) {
    delete p.takes[takeId];
    await app.store.deleteTake(p.id, takeId);
    toast('Nada foi gravado.', 'warn');
  } else {
    take.status = 'done';
    take.videoStart ??= 0;
    if (res.silent) {
      toast('A tomada foi gravada sem som: a entrada de áudio entregou silêncio total (dispositivo travado ou ocupado). '
        + 'Clique em "Desligar câmera e entrada", ligue de novo, confira o medidor de nível e grave outra vez.', 'error', 20000);
    }
    if (punch) applyPunch(p, take, channelIds, punch);
    else {
      for (const id of channelIds) {
        const c = p.channels.find((x) => x.id === id);
        if (!c) continue;
        // A tomada de antes fica guardada (com punch-ins e cortes), a mais nova primeiro.
        if (c.takeId && p.takes[c.takeId]?.status === 'done') {
          c.altTakes = [{ takeId: c.takeId, punches: c.punches || [], trimStart: c.trimStart || 0, trimEnd: c.trimEnd || 0 }, ...(c.altTakes || [])];
        }
        // Gravado de um ponto: o pré-roll (antes do ponto) fica de fora pelo corte de início.
        c.takeId = takeId;
        c.punches = [];
        c.trimStart = from || 0;
        c.trimEnd = 0;
      }
    }
    const clipped = channelIds.map((id) => p.channels.find((x) => x.id === id)).filter((c) => c && takeClips(take, c));
    if (clipped.length && !res.silent) {
      toast(`A gravação saturou (clipping) em ${clipped.map((c) => `"${c.name}" (${takeClips(take, c)}×)`).join(' e ')}. `
        + 'Ouça o resultado; se tiver distorção, abaixe o ganho da interface e grave de novo.', 'warn', 12000);
    }
  }
  await saveNow();
  await app.store.gc(p);
  await saveNow();
  app.engine.seek(from > 0 ? from : punch ? Math.max(0, punch.start - barSec(p)) : 0); // de um ponto: volta a ele, para regravar
  if (reason === 'device') {
    toast('A interface de áudio ou a câmera foi desconectada. A gravação parou e o que já foi gravado está salvo.', 'error', 15000);
    app.disarm(true);
  }
  await app.loadAllMedia();
  app.renderPanels();
}

// ---------- Gravar a partir de um ponto ----------

/** Posição para mostrar: "compasso.tempo" e o tempo em segundos (ex.: "3.2 (0:05.4)"). */
app.posLabel = (sec) => {
  const p = S.project;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, '0');
  return `${barBeat(p, sec)} (${m}:${s})`;
};

/**
 * Grava o canal selecionado a partir do cursor (Alt+R), em qualquer ponto, não só no compasso.
 * Toca compassos de preparação antes do ponto. Se o canal já tem tomada, ela segue até o ponto e daí
 * em diante vale a nova, até parar (um punch-in sem fim marcado). Canal vazio: tomada nova que começa ali.
 */
app.recordFrom = async () => {
  const p = S.project;
  const ch = app.selected();
  if (!p || !ch) return;
  if (S.transport === 'recording') return stopRecording();
  if (S.transport === 'playing') { app.engine.stop(); S.transport = 'stopped'; }
  const at = Math.max(0, app.engine.stopPos);
  if (at < 0.02) { toast('O cursor está no início: gravação normal. Para gravar de outro ponto, clique na linha do tempo onde quer começar.', 'info', 6000); return startRecording(); }
  const has = !!ch.takeId && p.takes[ch.takeId]?.status === 'done';
  const pre = Math.max(1, p.countInBars);
  toast(`Gravando a partir de ${app.posLabel(at)}, com ${pre} compasso${pre > 1 ? 's' : ''} de preparação antes. `
    + (has ? 'A tomada atual toca até ali; dali até onde você parar vale a gravação nova.' : 'O canal começa ali.'), 'info', 6000);
  await startRecording(has ? { punch: { start: at, end: Infinity, open: true } } : { from: at });
};

// ---------- Várias tomadas por canal ----------

/** Troca a tomada do canal por uma guardada (a atual vai para a lista). */
app.useAltTake = async (ch, i) => {
  const p = S.project;
  const alt = ch.altTakes?.[i];
  if (!alt || S.transport !== 'stopped') return;
  const cur = ch.takeId && p.takes[ch.takeId]?.status === 'done'
    ? { takeId: ch.takeId, punches: ch.punches || [], trimStart: ch.trimStart || 0, trimEnd: ch.trimEnd || 0 } : null;
  ch.altTakes.splice(i, 1);
  if (cur) ch.altTakes.unshift(cur);
  ch.takeId = alt.takeId;
  ch.punches = alt.punches || [];
  ch.trimStart = alt.trimStart || 0;
  ch.trimEnd = alt.trimEnd || 0;
  await saveNow();
  await loadChannelAudio(ch);
  await app.loadAllMedia();
  app.touch(true);
  toast(`"${ch.name}" agora usa a tomada de ${takeWhen(p.takes[alt.takeId])}. A de antes ficou na lista.`, 'info', 5000);
};

/** Usa uma tomada guardada só no trecho do loop (vira um punch-in com ela). */
app.useAltTakeInLoop = async (ch, i) => {
  const p = S.project;
  const alt = ch.altTakes?.[i];
  if (!alt || S.transport !== 'stopped') return;
  if (!ch.takeId) { toast('O canal está sem tomada principal: use "Usar esta" para escolher uma.', 'warn'); return; }
  const r = app.punchRange();
  if (!r) { toast('Escolha o trecho arrastando sobre os números dos compassos na régua.', 'warn', 6000); return; }
  const ext = takeExtent(p, ch, alt.takeId);
  const start = Math.max(r.start, (ext?.from ?? r.start) + PUNCH_XF);
  const end = Math.min(r.end, (ext?.to ?? r.end) - PUNCH_XF);
  if (!ext || end - start < 0.1) { toast('Essa tomada não tem gravação nesse trecho.', 'warn'); return; }
  normalizePunches(p, ch);
  addPunch(ch, { takeId: alt.takeId, start, end, cutBase: p.cuts.length });
  await saveNow();
  await loadChannelAudio(ch);
  await app.loadAllMedia();
  app.touch(true);
  toast(`Compassos ${app.punchLabel({ start, end })} de "${ch.name}" agora vêm da tomada de ${takeWhen(p.takes[alt.takeId])} (aparece em laranja nas faixas).`, 'info', 6000);
};

app.deleteAltTake = async (ch, i) => {
  const p = S.project;
  const alt = ch.altTakes?.[i];
  if (!alt || S.transport !== 'stopped') return;
  const used = (ch.punches || []).some((x) => x.takeId === alt.takeId);
  if (!confirm(`Apagar a tomada de ${takeWhen(p.takes[alt.takeId])} de "${ch.name}"?${used ? '\nUm trecho dela está em uso (punch-in): esse trecho continua.' : ''} Isso não pode ser desfeito.`)) return;
  ch.altTakes.splice(i, 1);
  await saveNow();
  await app.store.gc(p);
  await saveNow();
  app.touch(true);
};

/** "hoje 14:32" / "12/11 09:05" e a duração, para reconhecer a tomada na lista. */
function takeWhen(t) {
  if (!t) return '?';
  const d = new Date(t.createdAt || 0);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${today ? 'hoje' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
app.takeWhen = takeWhen;

// ---------- Punch-in ----------

/** Compasso (1, 2…) de uma posição em segundos, para mostrar: inteiro ou com uma casa. */
const barLabel = (p, sec, end = false) => {
  // Fim em início de compasso: "até o compasso N" (o anterior, inteiro). Fim no meio: a posição (N,x).
  const raw = sec / barSec(p);
  const whole = Math.abs(raw - Math.round(raw)) < 0.05;
  const b = end && whole ? raw : raw + 1;
  return Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1).replace('.', ',');
};
app.punchLabel = (x) => {
  // Um punch-in gravado guarda a posição de quando foi feito: passa pelos compassos removidos/inseridos depois.
  const p = S.project;
  const r = x.takeId ? mapRanges(x.start, x.end, cutsFor(p, x)) : [[x.start, x.end]];
  const a = r.length ? r[0][0] : x.start;
  const e = r.length ? r[r.length - 1][1] : x.end;
  return `${barLabel(p, Math.max(0, a))}–${barLabel(p, e, true)}`;
};

/** Trecho do punch-in: o trecho do loop da régua (em segundos). */
app.punchRange = () => {
  const p = S.project;
  const l = p.loop;
  if (!(l.end > l.start)) return null;
  const b = barSec(p);
  return { start: l.start * b, end: l.end * b };
};

/** Regrava só o trecho do loop no canal selecionado (Shift+R). */
app.startPunch = async () => {
  const p = S.project;
  const ch = app.selected();
  if (!p || !ch || S.transport !== 'stopped') return;
  if (!ch.takeId || p.takes[ch.takeId]?.status !== 'done') {
    toast('O punch-in regrava um trecho de uma tomada que já existe. Grave o canal primeiro (R).', 'warn', 6000);
    return;
  }
  const r = app.punchRange();
  if (!r) { toast('Escolha o trecho arrastando sobre os números dos compassos na régua.', 'warn', 6000); return; }
  const pre = Math.max(1, p.countInBars);
  toast(`Punch-in nos compassos ${app.punchLabel(r)}: ${pre} compasso${pre > 1 ? 's' : ''} de preparação antes, e para sozinho no fim.`, 'info', 5000);
  await startRecording({ punch: r });
};

/** Depois de gravar: o trecho gravado entra como punch-in nos canais (cortado ao que de fato foi gravado). */
function applyPunch(p, take, channelIds, punch) {
  const len = take.frames / take.sampleRate;
  let used = false;
  let short = false;
  for (const id of channelIds) {
    const c = p.channels.find((x) => x.id === id);
    if (!c) continue;
    const ts = take.audioStart + c.offsetMs / 1000;
    const start = Math.max(punch.start, ts + PUNCH_XF);
    const end = Math.min(punch.end, ts + len - PUNCH_XF);
    if (end - start < 0.1) continue;
    if (Number.isFinite(punch.end) && end < punch.end - 0.05) short = true;
    normalizePunches(p, c); // os antigos na mesma escala do novo, para comparar trechos
    addPunch(c, { takeId: take.id, start, end, cutBase: p.cuts.length });
    used = true;
  }
  if (!used) toast(punch.open ? 'A gravação parou antes do ponto escolhido: nada mudou.' : 'A gravação parou antes do trecho do punch-in: nada mudou.', 'warn', 6000);
  else if (short) toast('A gravação parou antes do fim do trecho: o punch-in vale só até onde gravou.', 'info', 6000);
}

/** Remove um punch-in (i) ou todos (i = null): volta a tocar a tomada principal no trecho. */
app.removePunch = async (ch, i = null) => {
  if (S.transport !== 'stopped' || !ch.punches?.length) return;
  const what = i == null ? `todos os ${ch.punches.length} punch-ins` : `o punch-in dos compassos ${app.punchLabel(ch.punches[i])}`;
  if (!confirm(`Remover ${what} de "${ch.name}"? A tomada principal volta a tocar no trecho. Isso não pode ser desfeito.`)) return;
  if (i == null) ch.punches = [];
  else ch.punches.splice(i, 1);
  await saveNow();
  await app.store.gc(S.project);
  await saveNow();
  await loadChannelAudio(ch);
  app.stage.dropUnused(S.project);
  app.touch(true);
};

// ---------------------------------------------------------------- Teclado (RNF-12)

function onKey(e) {
  if (!S.project || document.querySelector('dialog[open]')) return;
  const t = e.target;
  const tag = t.tagName;
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type)) || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  if (typing) return; // nos campos de texto o Ctrl+Z é o do próprio campo
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); app.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); app.redo(); }
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyR') { e.preventDefault(); app.recordFrom(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); app.togglePlay(); }
  else if (S.livePlay && e.key === 'Escape') { e.preventDefault(); app.setLivePlay(false); }
  else if (S.livePlay && LIVE_KEYS.includes(e.key.toLowerCase())) {
    // Modo "tocar pelo teclado": as letras viram pads (Shift = mais forte)
    e.preventDefault();
    const pad = S.project.drums?.pads[LIVE_KEYS.indexOf(e.key.toLowerCase())];
    if (pad && !e.repeat) app.hitPad(pad, e.shiftKey ? 1 : 0.8);
  }
  else if (e.key === 'R' && e.shiftKey) { e.preventDefault(); if (S.transport === 'recording') app.toggleRecord(); else app.startPunch(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); app.toggleRecord(); }
  else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); app.toggleLoop(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); app.addNote(); }
  else if ((e.key === 'b' || e.key === 'B') && e.shiftKey) { e.preventDefault(); app.setDrumsMin(!(S.drumsOpen && S.drumsMin)); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); app.toggleDrums(); }
  else if (/^[1-6]$/.test(e.key)) {
    const ch = S.project.channels[+e.key - 1];
    if (ch && S.transport !== 'recording') { e.preventDefault(); app.select(ch.id); }
  }
}

// ---------------------------------------------------------------- Laço de desenho

/** Canais gravando que saturaram há pouco (o quadro mostra "CLIP" por 1,5 s). */
function liveClipIds(now) {
  const rec = S.recorder;
  if (S.transport !== 'recording' || !rec?.clips) return [];
  const seen = S.clipSeen || (S.clipSeen = { rec: null, L: 0, R: 0, atL: 0, atR: 0 });
  if (seen.rec !== rec) Object.assign(seen, { rec, L: 0, R: 0, atL: 0, atR: 0 });
  for (const k of ['L', 'R']) {
    if (rec.clips[k] > seen[k]) { seen[k] = rec.clips[k]; seen[`at${k}`] = now; }
  }
  return S.recording.channelIds.filter((id) => {
    const c = S.project.channels.find((x) => x.id === id);
    return c && usedInputs(c).some((k) => now - seen[`at${k}`] < 1500 && seen[`at${k}`] > 0);
  });
}

function startLoop() {
  cancelAnimationFrame(S.raf);
  const frame = () => {
    if (!S.project || !S.ui) { S.raf = 0; return; }
    S.raf = requestAnimationFrame(frame);
    const pos = app.engine.position;
    // Vigia: tocando/gravando com o relógio de áudio parado = saída de áudio do sistema travada.
    const now = performance.now();
    const clock = app.engine.ctx?.currentTime;
    if (S.transport === 'stopped' || clock !== S.clockSeen) { S.clockSeen = clock; S.clockSeenAt = now; }
    else if (now - S.clockSeenAt > 1500) {
      S.clockSeenAt = now;
      if (S.transport === 'playing') {
        // Tocando: para e reinicia o áudio (o próximo play já sai no contexto novo).
        app.engine.stop();
        S.transport = 'stopped';
        updateTransport(app, S.ui.transport, app.engine.position);
        recoverAudio().then((ok) => { if (!ok) audioStalled(); });
      } else audioStalled(); // gravando: não derruba a entrada no meio da tomada
    }
    if (S.transport === 'playing') {
      const dur = projectDuration(S.project);
      if (dur > 0 && pos > dur + 0.25 && !app.engine.loop) {
        app.engine.stop();
        app.engine.seek(dur);
        S.transport = 'stopped';
      }
    }
    let overlay = null;
    const punch = S.transport === 'recording' ? S.recording.punch : null;
    if (punch) {
      // Pré-roll do punch-in: conta os tempos até o trecho; para sozinho meio compasso depois do fim.
      if (pos < punch.start) overlay = `${punch.open ? 'Grava em' : 'Punch em'} ${Math.ceil((punch.start - pos) / (60 / S.project.bpm) - 1e-6)}`;
      if (pos > punch.end + barSec(S.project) / 2) stopRecording();
    } else if (S.transport === 'recording' && S.recording.from > 0) {
      if (pos < S.recording.from) overlay = `Grava em ${Math.ceil((S.recording.from - pos) / (60 / S.project.bpm) - 1e-6)}`;
    } else if (S.transport === 'recording' && pos < 0) {
      overlay = String(Math.ceil(-pos / (60 / S.project.bpm) - 1e-6));
    }
    const liveIds = S.transport === 'recording' ? S.recording.channelIds : (S.armed ? [S.armedChannelId] : []);
    app.stage.update(pos, S.transport, {
      liveIds,
      recordingIds: S.transport === 'recording' ? S.recording.channelIds : [],
      selectedId: S.selectedId,
      overlay,
      clipIds: liveClipIds(now),
    });
    tickLevelTest();
    updateTransport(app, S.ui.transport, pos);
    updateMeters(app, S.ui.mixer);
    updateDrumsPanel(app, S.ui.drums, pos);
    app.tracks.update(pos, projectDuration(S.project));
    updateInputMeters(app, S.ui.inspector);
  };
  S.raf = requestAnimationFrame(frame);
}

boot();
