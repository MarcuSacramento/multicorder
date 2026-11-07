// Mixer: strips por canal (RF-20 a RF-24), faixa-guia (RF-13) e master (RF-26, RF-27).
import { DRUMS_ID, drumsEndBar } from '../../engine/drums.js';
import { GUIDE_ID } from '../../engine/mix-graph.js';
import { barSec, channelPieces, REVERB_TYPES, showsDrums } from '../../engine/project.js';
import { fmtDb, fmtTime } from '../../engine/util.js';
import { checkbox, drawMeter, h, numberField, openDialog, select, slider } from '../dom.js';
import { openFx } from './fx.js';
import { toggleSpectrum } from './spectrum.js';

const panFmt = (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);

function toggle(label, on, aria, onChange, cls = '') {
  const b = h('button', {
    class: `toggle ${cls}${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': aria, title: aria,
    onClick: () => {
      const v = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(v));
      b.classList.toggle('on', v);
      onChange(v);
    },
  }, label);
  return b;
}

function fader(label, value, onInput) {
  return slider({ label, min: -60, max: 6, step: 0.5, value, vertical: true, onInput, format: (v) => fmtDb(v) });
}

function channelStrip(app, ch, i) {
  const S = app.S;
  const p = app.project;
  const take = ch.takeId && p.takes[ch.takeId];
  const sel = ch.id === S.selectedId;
  const busy = S.transport !== 'stopped';
  const recNow = S.recording?.channelIds.includes(ch.id);
  let takeLabel = 'vazio';
  if (recNow) takeLabel = '● gravando';
  else if (take) {
    const pcs = channelPieces(p, ch); // considera corte, punch-ins e compassos removidos
    takeLabel = fmtTime(pcs.length ? Math.max(0, pcs[pcs.length - 1].to - pcs[0].from) : 0);
  }
  return h('div', { class: `strip${sel ? ' selected' : ''}${recNow ? ' recording' : ''}`, role: 'group', 'aria-label': `Canal ${i + 1}: ${ch.name}` },
    h('button', { class: 'strip-name', 'aria-pressed': String(sel), onClick: () => app.select(ch.id), title: `Selecionar (tecla ${i + 1})` },
      h('span', { class: 'num' }, i + 1), h('span', { class: 'nm' }, ch.name)),
    h('div', { class: `take${take ? ' has' : ''}` }, takeLabel),
    h('div', { class: 'fader-row' },
      h('canvas', { class: 'meter', width: 10, height: 130, 'data-meter': ch.id, 'aria-hidden': 'true' }),
      fader(`Volume ${ch.name}`, ch.volumeDb, (v) => { ch.volumeDb = v; app.touch(); })),
    ch.panAuto?.length ? panByLine() : slider({ label: 'Pan', min: -1, max: 1, step: 0.02, value: ch.pan, onInput: (v) => { ch.pan = v; app.touch(); }, format: panFmt }),
    h('div', { class: 'row tight' },
      toggle('M', ch.mute, `Mudo ${ch.name}`, (v) => { ch.mute = v; app.touch(); }, 'mute'),
      toggle('S', ch.solo, `Solo ${ch.name}`, (v) => { ch.solo = v; app.touch(); }, 'solo')),
    h('div', { class: 'row tight' },
      h('button', { class: 'ghost small', onClick: () => openFx(app, ch.id), 'aria-label': `Efeitos ${ch.name}` }, 'FX'),
      toggle('⏻', !ch.fx.bypassAll, `Efeitos ligados em ${ch.name} (bypass)`, (v) => { ch.fx.bypassAll = !v; app.touch(); }, 'power')),
    numberField({ label: 'Sinc. ms', value: ch.offsetMs, min: -500, max: 500, step: 1, onChange: (v) => app.setChannelTiming(ch, { offsetMs: v }), width: '4.2em' }),
    h('div', { class: 'row tight' },
      h('button', { class: 'icon small', 'aria-label': `Mover ${ch.name} para trás na grade`, disabled: i === 0 || busy, onClick: () => app.swapChannels(i, i - 1) }, '◀'),
      h('button', { class: 'icon small', 'aria-label': `Mover ${ch.name} para frente na grade`, disabled: i === p.channels.length - 1 || busy, onClick: () => app.swapChannels(i, i + 1) }, '▶')));
}

function guideStrip(app) {
  const g = app.project.guide;
  const picker = guidePicker(app);
  return h('div', { class: 'strip guide', role: 'group', 'aria-label': 'Faixa-guia' },
    h('div', { class: 'strip-name static', title: g.name }, h('span', { class: 'num' }, '♪'), h('span', { class: 'nm' }, 'Guia')),
    h('div', { class: 'take has', title: g.url ? `${g.name}\n${g.url}` : g.name },
      g.source === 'midi' ? `MIDI · ${fmtTime(g.duration)}` : fmtTime(g.duration)),
    h('div', { class: 'fader-row' },
      h('canvas', { class: 'meter', width: 10, height: 130, 'data-meter': GUIDE_ID, 'aria-hidden': 'true' }),
      fader('Volume da faixa-guia', g.volumeDb, (v) => { g.volumeDb = v; app.touch(); })),
    h('div', { class: 'row tight' }, toggle('M', g.mute, 'Mudo faixa-guia', (v) => { g.mute = v; app.touch(); }, 'mute')),
    numberField({ label: 'Início ms', value: g.offsetMs, min: -60000, max: 600000, step: 1, onChange: (v) => { g.offsetMs = v; app.touch(); }, width: '5em' }),
    checkbox({ label: 'No vídeo final', checked: g.includeInExport !== false, onChange: (v) => { g.includeInExport = v; app.touch(); } }),
    h('div', { class: 'row tight' },
      h('button', { class: 'ghost small', onClick: () => picker.click(), title: 'Trocar por um arquivo de áudio ou MIDI' }, 'Trocar')),
    h('div', { class: 'row tight' },
      h('button', { class: 'ghost small danger', onClick: () => { if (confirm('Remover a faixa-guia?')) app.removeGuide(); } }, 'Remover')),
    picker);
}

function drumsStrip(app) {
  const d = app.project.drums;
  const end = drumsEndBar(d);
  return h('div', { class: 'strip drums', role: 'group', 'aria-label': 'Bateria' },
    h('button', { class: 'strip-name', onClick: () => app.setDrumsMin(false), title: 'Abrir o editor da bateria (B)' },
      h('span', { class: 'num' }, '🥁'), h('span', { class: 'nm' }, 'Bateria')),
    h('div', { class: `take${end ? ' has' : ''}` }, end ? fmtTime(end * barSec(app.project)) : 'sem blocos'),
    h('div', { class: 'fader-row' },
      h('canvas', { class: 'meter', width: 10, height: 130, 'data-meter': DRUMS_ID, 'aria-hidden': 'true' }),
      fader('Volume da bateria', d.volumeDb, (v) => { d.volumeDb = v; app.touch(); })),
    slider({
      label: 'Ganho', min: 0, max: 18, step: 0.5, value: d.driveDb || 0,
      title: 'Sobe o corpo da bateria com saturação suave; o pico fica em −1 dB. Use quando o fader no máximo ainda fica baixo.',
      onInput: (v) => { d.driveDb = v; app.touch(); }, format: fmtDb,
    }),
    d.panAuto?.length ? panByLine() : slider({ label: 'Pan', min: -1, max: 1, step: 0.02, value: d.pan, onInput: (v) => { d.pan = v; app.touch(); }, format: panFmt }),
    h('div', { class: 'row tight' },
      toggle('M', d.mute, 'Mudo bateria', (v) => { d.mute = v; app.touch(); }, 'mute'),
      toggle('S', d.solo, 'Solo bateria', (v) => { d.solo = v; app.touch(); }, 'solo')),
    h('div', { class: 'row tight' },
      h('button', { class: 'ghost small', onClick: () => openFx(app, DRUMS_ID), 'aria-label': 'Efeitos da bateria' }, 'FX'),
      toggle('⏻', !d.fx.bypassAll, 'Efeitos ligados na bateria (bypass)', (v) => { d.fx.bypassAll = !v; app.touch(); }, 'power')),
    h('button', {
      class: 'ghost small', disabled: app.S.transport !== 'stopped',
      title: 'Mede os canais gravados e deixa a bateria no mesmo volume do mais alto',
      onClick: () => app.matchDrumsLevel(),
    }, 'Igualar volume'));
}

const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a';
const MIDI_ACCEPT = '.mid,.midi,.kar,.rmi,audio/midi,audio/x-midi';

/** Seletor de arquivo da guia. `kind`: 'audio', 'midi' ou 'any'. */
function guidePicker(app, kind = 'any') {
  const accept = kind === 'audio' ? AUDIO_ACCEPT : kind === 'midi' ? MIDI_ACCEPT : `${AUDIO_ACCEPT},${MIDI_ACCEPT}`;
  return h('input', {
    type: 'file', accept, hidden: true,
    onChange: (e) => { const f = e.target.files[0]; if (f) app.importGuide(f); },
  });
}

function masterStrip(app) {
  const p = app.project;
  return h('div', { class: 'strip master', role: 'group', 'aria-label': 'Master' },
    h('div', { class: 'strip-name static' }, h('span', { class: 'nm' }, 'Master')),
    h('div', { class: 'take' }, ' '),
    h('div', { class: 'fader-row' },
      h('canvas', { class: 'meter', width: 14, height: 130, 'data-meter': 'master', 'aria-hidden': 'true' }),
      fader('Volume master', p.master.volumeDb, (v) => { p.master.volumeDb = v; app.touch(); })),
    checkbox({ label: 'Limitador', checked: p.master.limiter, onChange: (v) => { p.master.limiter = v; app.touch(); } }),
    h('button', { class: 'ghost small', title: 'Analisador de frequências do mix (quanto de grave, médio e agudo)', onClick: () => toggleSpectrum(app) }, '📈 Espectro'),
    select({
      label: 'Reverb compart.', value: p.sharedReverb.type,
      options: Object.entries(REVERB_TYPES), onChange: (v) => { p.sharedReverb.type = v; app.touch(); },
    }),
    slider({ label: 'Retorno', min: -60, max: 6, step: 0.5, value: p.sharedReverb.returnDb, onInput: (v) => { p.sharedReverb.returnDb = v; app.touch(); }, format: fmtDb }));
}

/** Botão que alterna entre o mixer completo e o compacto. */
function minButton(app) {
  const min = app.S.mixerMin;
  return h('button', {
    class: 'ghost small mixer-min-btn', 'aria-pressed': String(min),
    'aria-label': min ? 'Expandir o mixer' : 'Minimizar o mixer',
    title: min ? 'Expandir o mixer (todos os controles)' : 'Minimizar o mixer: só mudo e solo de cada canal',
    onClick: () => app.setMixerMin(!min),
  }, min ? '▴ Mixer' : '▾ Min.');
}

/** Faixa compacta: nome, mudo, solo e um medidor fino. `solo` = null para quem não tem solo. */
function compactStrip(app, { id, num, name, cls = '', obj, label, solo = true, selected = false, onName }) {
  return h('div', { class: `cstrip ${cls}${selected ? ' selected' : ''}`, role: 'group', 'aria-label': label },
    h(onName ? 'button' : 'div', { class: `cstrip-name${onName ? '' : ' static'}`, title: name, onClick: onName },
      num != null ? h('span', { class: 'num' }, num) : null, h('span', { class: 'nm' }, name)),
    obj ? h('div', { class: 'row tight' },
      toggle('M', obj.mute, `Mudo ${label}`, (v) => { obj.mute = v; app.touch(); }, 'mute'),
      solo ? toggle('S', obj.solo, `Solo ${label}`, (v) => { obj.solo = v; app.touch(); }, 'solo') : null) : null,
    h('canvas', { class: 'meter h', width: 80, height: 5, 'data-meter': id, 'aria-hidden': 'true' }));
}

function renderCompact(app, el) {
  const p = app.project;
  const S = app.S;
  const strips = p.channels.map((ch, i) => (showsDrums(p, ch) ? null : compactStrip(app, {
    id: ch.id, num: i + 1, name: ch.name, obj: ch, label: ch.name, selected: ch.id === S.selectedId,
    cls: S.recording?.channelIds.includes(ch.id) ? 'recording' : '', onName: () => app.select(ch.id),
  }))).filter(Boolean);
  if (p.drums) strips.push(compactStrip(app, { id: DRUMS_ID, num: '🥁', name: 'Bateria', cls: 'drums', obj: p.drums, label: 'bateria' }));
  if (p.guide) strips.push(compactStrip(app, { id: GUIDE_ID, num: '♪', name: 'Guia', cls: 'guide', obj: p.guide, label: 'faixa-guia', solo: false }));
  strips.push(compactStrip(app, { id: 'master', name: 'Master', cls: 'master', label: 'master' }));
  el.replaceChildren(h('div', { class: 'strips compact' }, minButton(app), strips));
  el._meters = [...el.querySelectorAll('canvas[data-meter]')];
  el._state ??= new Map();
}

/** No lugar do botão de pan quando a faixa tem linha de pan (quem manda é a linha). */
const panByLine = () => h('div', { class: 'pan-line muted small', title: 'O pan segue a linha de pan desta faixa (painel Faixas → ↔ Pan). Limpe a linha para voltar a usar o botão.' }, 'Pan: linha ↔');

export function renderMixer(app, el) {
  const p = app.project;
  if (!p) return;
  el.classList.toggle('min', !!app.S.mixerMin);
  if (app.S.mixerMin) return renderCompact(app, el);
  const strips = p.channels.map((ch, i) => (showsDrums(p, ch) ? null : channelStrip(app, ch, i))).filter(Boolean);
  if (p.drums) strips.push(drumsStrip(app));
  if (p.guide) strips.push(guideStrip(app));
  else {
    const audio = guidePicker(app, 'audio');
    const midi = guidePicker(app, 'midi');
    strips.push(h('div', { class: 'strip add-guide' },
      h('button', { class: 'ghost small', onClick: () => audio.click(), title: 'WAV, MP3, OGG, FLAC, M4A' }, '+ Guia (áudio)'),
      h('button', { class: 'ghost small', onClick: () => midi.click(), title: 'Arquivo .mid: o app toca as notas com sons sintetizados (canal 10 = bateria)' }, '+ Guia (MIDI)'),
      h('p', { class: 'muted small' }, 'Referência (base, playback) em áudio ou MIDI. Não ocupa quadro na grade.'),
      audio, midi));
  }
  strips.push(masterStrip(app));
  el.replaceChildren(h('div', { class: 'strips' }, minButton(app), strips));
  el._meters = [...el.querySelectorAll('canvas[data-meter]')];
  el._state ??= new Map();
}

/** RF-23: pico e RMS por canal e no master. */
export function updateMeters(app, el) {
  const g = app.engine.graph;
  if (!el._meters || !g) return;
  const now = performance.now();
  for (const c of el._meters) {
    const id = c.dataset.meter;
    const m = id === 'master' ? g.meter : g.strips.get(id)?.meter;
    if (!m) continue;
    const { peak, rms } = m.read();
    let st = el._state.get(id);
    if (!st) { st = { held: 0, clipUntil: 0 }; el._state.set(id, st); }
    st.held = Math.max(peak, st.held * 0.97);
    if (peak >= 1) st.clipUntil = now + 2000;
    drawMeter(c, peak, rms, st.held, now < st.clipUntil);
  }
}
