// Estrutura da tela de projeto: barra superior, prévia, transporte, inspetor, mixer e status.
import { LAYOUTS, layoutOf, usesFeatured } from '../../engine/layout.js';
import { projectDuration, setChannelCount, TIME_SIGNATURES } from '../../engine/project.js';
import { fmtBytes, fmtTime } from '../../engine/util.js';
import { checkbox, fill, h, numberField, openDialog, select, slider } from '../dom.js';
import { openExport } from './export.js';
import { openSettings } from './settings.js';
import { barBeat, Timeline } from './timeline.js';

/*
 * Tela do projeto:
 *   barra de cima
 *   [coluna esquerda: canal selecionado] [centro: só a prévia do vídeo] [coluna direita: exportar]
 *   gravação (botões, régua de compassos, relógio) · faixas · bateria · mixer · barra de status
 * As colunas recolhem para uma tira fina; os blocos de baixo também recolhem. O app lembra tudo.
 */
export function buildWorkspace(app, root) {
  const ui = {
    topbar: h('header', { class: 'topbar' }),
    stageWrap: h('div', { class: 'stage-wrap' }),
    transport: h('div', { class: 'transport', role: 'toolbar', 'aria-label': 'Gravação e transporte' }),
    inspector: h('div', { class: 'inspector', 'aria-label': 'Canal selecionado' }),
    exportbar: h('div', { class: 'exportbar', 'aria-label': 'Exportar' }),
    drums: h('section', { class: 'drums-panel', 'aria-label': 'Bateria', hidden: true }),
    mixer: h('section', { class: 'mixer', 'aria-label': 'Mixer' }),
    status: h('footer', { class: 'statusbar' }),
    tracksBelow: h('div', { class: 'tracks-below' }),
  };
  buildTransport(app, ui.transport);
  ui.left = sideCol(app, 'left', 'Canal', ui.inspector);
  ui.right = sideCol(app, 'right', 'Exportar', ui.exportbar);
  ui.transportBlock = foldBlock('transport', 'Gravação', ui.transport);
  ui.mixerBlock = foldBlock('mixer', 'Mixer', ui.mixer);
  // Faixas: mesmo jeito de mostrar/esconder do mixer
  ui.tracksBlock = foldBlock('tracks', 'Faixas', ui.tracksBelow, { initialClosed: !app.tracks.open, onToggle: (closed) => app.tracks.setOpen(!closed) });
  root.replaceChildren(h('div', { class: 'workspace' },
    ui.topbar,
    h('div', { class: 'main' }, ui.left, h('section', { class: 'stage-col' }, ui.stageWrap), ui.right),
    ui.transportBlock,
    ui.tracksBlock,
    ui.drums,
    ui.mixerBlock,
    ui.status));
  ui.tracksBelow.append(app.tracks.el);
  return ui;
}

/** Coluna lateral recolhível: título com ◂/▸; recolhida, vira uma tira com o nome em pé. */
function sideCol(app, side, title, content) {
  const key = `mc.side.${side}`;
  const col = h('aside', { class: `side side-${side}`, 'aria-label': title });
  const head = h('div', { class: 'side-head' });
  const rail = h('button', { class: 'side-rail', title: `Mostrar: ${title}`, onClick: () => set(false) }, h('span', null, title));
  const set = (closed) => {
    col.classList.toggle('collapsed', closed);
    try { localStorage.setItem(key, closed ? '1' : '0'); } catch { /* ok */ }
    head.replaceChildren(
      h('strong', null, title),
      h('button', {
        class: 'icon small', title: `Recolher: ${title}`, 'aria-label': `Recolher ${title}`, onClick: () => set(true),
      }, side === 'left' ? '◂' : '▸'));
    app.stage?.resize();
  };
  col.append(rail, head, content);
  col._set = set;
  set(localStorage.getItem(key) === '1');
  return col;
}

/** Bloco de baixo recolhível: uma tira fina com o nome quando fechado; aberto, uma seta no canto. */
function foldBlock(id, title, content, { initialClosed = false, onToggle = null } = {}) {
  const key = `mc.block.${id}`;
  const wrap = h('div', { class: `fold-block fold-${id}` });
  const bar = h('button', { class: 'fold-bar', title: `Mostrar: ${title}` });
  const corner = h('button', { class: 'fold-corner icon small', title: `Recolher: ${title}`, 'aria-label': `Recolher ${title}` }, '▾');
  const set = (closed) => {
    wrap.classList.toggle('closed', closed);
    bar.textContent = `▸ ${title}`;
    content.hidden = closed;
    corner.hidden = closed;
    bar.hidden = !closed;
    try { localStorage.setItem(key, closed ? '1' : '0'); } catch { /* ok */ }
    onToggle?.(closed);
    if (wrap.isConnected) window.dispatchEvent(new Event('mc-layout')); // a prévia recalcula a altura
  };
  bar.addEventListener('click', () => set(false));
  corner.addEventListener('click', () => set(true));
  wrap.append(bar, corner, content);
  const saved = localStorage.getItem(key);
  set(saved == null ? initialClosed : saved === '1');
  return wrap;
}

export function placeTracks(app) {
  // As faixas ficam sempre embaixo da gravação; o centro da tela é só da prévia.
  const ui = app.S.ui;
  if (!ui) return;
  if (app.tracks.el.parentNode !== ui.tracksBelow) ui.tracksBelow.append(app.tracks.el);
  app.tracks.fill = false;
  fitMain(ui);
}

/**
 * Altura do centro (colunas e prévia): pelo menos 58% da janela; com os blocos de baixo recolhidos,
 * ocupa o que sobrar, para a prévia crescer.
 */
export function fitMain() {
  // A altura do centro agora vem do CSS (a tela cabe na janela; ver .workspace em styles.css).
}

export function renderTopbar(app, el) {
  const p = app.project;
  const busy = app.S.transport !== 'stopped';
  const layouts = LAYOUTS[p.channels.length];
  fill(el,
    h('button', { class: 'ghost', onClick: () => app.goHome(), disabled: busy, title: 'Voltar para a lista de projetos' }, '← Projetos'),
    h('input', {
      class: 'project-name', value: p.name, 'aria-label': 'Nome do projeto',
      onChange: (e) => { p.name = e.target.value.trim() || 'Sem nome'; app.touch(); },
    }),
    numberField({ label: 'BPM', value: p.bpm, min: 40, max: 240, onChange: (v) => { p.bpm = Math.round(v); app.touch(); }, width: '4.5em' }),
    select({ label: 'Compasso', options: TIME_SIGNATURES.map((t) => [t, t]), value: p.timeSig, onChange: (v) => { p.timeSig = v; app.touch(); } }),
    select({
      label: 'Canais', options: [2, 3, 4, 5, 6].map((n) => [n, n]), value: p.channels.length, disabled: busy,
      onChange: (v) => {
        const n = +v;
        const lost = p.channels.slice(n).filter((c) => c.takeId);
        if (lost.length && !confirm(`Remover ${lost.map((c) => `"${c.name}"`).join(', ')}? As tomadas desses canais serão apagadas.`)) {
          renderTopbar(app, el);
          return;
        }
        setChannelCount(p, n);
        if (!p.channels.some((c) => c.id === app.S.selectedId)) app.S.selectedId = p.channels[0].id;
        app.touch(true);
        app.saveNow().then(() => app.store.gc(p)).then(() => app.saveNow()).then(() => app.loadAllMedia());
      },
    }),
    select({ label: p.layoutChanges?.length ? 'Layout no início' : 'Layout', options: layouts.map((l) => [l.id, l.label]), value: p.layoutId, onChange: (v) => { p.layoutId = v; renderTopbar(app, el); app.touch(); } }),
    // Destaque: posição do quadro grande (arrastar outro quadro sobre ele também troca)
    usesFeatured(layoutOf(p)) ? select({
      label: 'Destaque', options: p.channels.map((c, i) => [i, `${i + 1} · ${c.name}`]), value: p.featured,
      onChange: (v) => { p.featured = +v; app.touch(); },
    }) : null,
    select({ label: 'Proporção', options: [['9:16', '9:16 (vertical)'], ['1:1', '1:1'], ['16:9', '16:9']], value: p.aspect, onChange: (v) => { p.aspect = v; app.touch(); app.stage.resize(); } }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'undo-group', role: 'group', 'aria-label': 'Desfazer e refazer' },
      h('button', { class: 'icon', 'data-undo': '', onClick: () => app.undo(), title: 'Desfazer (Ctrl+Z)', 'aria-label': 'Desfazer' }, '↶'),
      h('button', { class: 'icon', 'data-redo': '', onClick: () => app.redo(), title: 'Refazer (Ctrl+Y)', 'aria-label': 'Refazer' }, '↷')),
    h('button', { class: 'ghost', onClick: () => openAppearance(app) }, 'Aparência'),
    h('button', { class: 'ghost', onClick: () => openSettings(app) }, 'Áudio e configurações'),
    h('button', { class: 'primary', onClick: () => openExport(app), disabled: busy }, 'Exportar'),
  );
  app.updateUndoButtons?.();
}

/** RF-42: espaçamento, borda e fundo da grade. */
function openAppearance(app) {
  const g = app.project.grid;
  const upd = () => app.touch();
  openDialog('Aparência da grade', [
    slider({ label: 'Espaçamento', min: 0, max: 40, value: g.gap, onInput: (v) => { g.gap = v; upd(); }, format: (v) => `${v}px` }),
    slider({ label: 'Cantos arredondados', min: 0, max: 60, value: g.radius, onInput: (v) => { g.radius = v; upd(); }, format: (v) => `${v}px` }),
    slider({ label: 'Borda', min: 0, max: 20, value: g.borderWidth, onInput: (v) => { g.borderWidth = v; upd(); }, format: (v) => `${v}px` }),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'Cor do fundo ', h('input', { type: 'color', value: g.bg, onInput: (e) => { g.bg = e.target.value; upd(); } })),
      h('label', { class: 'field' }, 'Cor da borda ', h('input', { type: 'color', value: g.borderColor, onInput: (e) => { g.borderColor = e.target.value; upd(); } }))),
    h('p', { class: 'muted' }, 'Medidas relativas a um vídeo de 1080 px; a prévia mostra exatamente o que vai para o arquivo final.'),
  ]);
}

function buildTransport(app, el) {
  const S = app.S;
  const refs = {};
  refs.rew = h('button', { class: 'icon', 'aria-label': 'Voltar ao início', title: 'Voltar ao início', onClick: () => app.rewind() }, '⏮');
  refs.play = h('button', { class: 'icon big', 'aria-label': 'Tocar (Espaço)', title: 'Tocar / parar (Espaço)', onClick: () => app.togglePlay() }, '▶');
  refs.rec = h('button', { class: 'rec', title: 'Gravar o canal selecionado (R)', onClick: () => app.toggleRecord() }, '● Gravar');
  refs.recFrom = h('button', {
    class: 'rec-from', onClick: () => app.recordFrom(),
    title: 'Gravar o canal selecionado a partir do cursor (Alt+R), em qualquer ponto. Clique na linha do tempo para pôr o cursor; Shift+←/→ anda um tempo. Toca a contagem antes do ponto.',
  }, '● Gravar daqui');
  refs.loop = h('button', {
    class: 'icon loop', 'aria-pressed': 'false', onClick: () => app.toggleLoop(),
    title: 'Loop (L). Arraste sobre os números dos compassos na régua para escolher o trecho.',
  }, '⟳', h('span', { class: 'loop-range' }));
  // Remove o trecho do loop da música inteira (o que vem depois anda para trás).
  refs.cut = h('button', {
    class: 'icon cut-btn', onClick: () => { const l = app.project.loop; app.removeBars(l.start, l.end); },
  }, '✂', h('span', { class: 'cut-range' }));
  // Insere compassos vazios no ponto do cursor (o contrário do ✂)
  refs.ins = h('button', {
    class: 'icon ins-btn', onClick: () => app.insertBars(),
    title: 'Inserir compassos vazios antes do compasso do cursor; o que vem depois anda para frente. Ctrl+Z desfaz.',
  }, '⇥ Inserir');
  refs.note = h('button', {
    class: 'icon note-btn', onClick: () => app.addNote(),
    title: 'Adicionar observação na posição atual (N). Clique numa observação na régua para editar ou apagar.',
  }, '+ Nota');
  refs.drums = h('button', {
    class: 'icon drums-btn', 'aria-pressed': 'false', onClick: () => app.toggleDrums(),
    title: 'Mostrar/esconder a bateria (B)',
  }, '🥁 Bateria');
  refs.time = h('span', { class: 'time', 'aria-live': 'off' }, h('span', { class: 'clock' }, '0:00.0'), h('span', { class: 'bars' }));
  refs.timeline = new Timeline(app);
  refs.seek = refs.timeline.el;
  refs.countIn = h('div', { class: 'cluster' });
  refs.metro = h('div', { class: 'cluster' });
  el.replaceChildren(refs.rew, refs.play, refs.rec, refs.recFrom, refs.loop, refs.cut, refs.ins, refs.time, refs.seek, refs.note, refs.drums, refs.countIn, refs.metro);
  el._refs = refs;
  refs.renderSettings = () => {
    const p = app.project;
    refs.countIn.replaceChildren(select({
      label: 'Contagem', options: [[1, '1 compasso'], [2, '2 compassos'], [4, '4 compassos']], value: p.countInBars,
      onChange: (v) => { p.countInBars = +v; app.touch(); },
    }));
    refs.metro.replaceChildren(
      checkbox({ label: 'Metrônomo', checked: p.metronome.on, onChange: (v) => { p.metronome.on = v; app.touch(); }, title: 'Ouvido só no fone; nunca é gravado' }),
      slider({ label: 'Vol. metrônomo', min: 0, max: 1, step: 0.05, value: p.metronome.volume, onInput: (v) => { p.metronome.volume = v; app.touch(); }, format: (v) => `${Math.round(v * 100)}%` }),
    );
    refs.settingsFor = p;
  };
  void S;
}

export function updateTransport(app, el, pos) {
  const r = el._refs;
  if (!r) return;
  const S = app.S;
  if (r.settingsFor !== app.project) r.renderSettings();
  const dur = projectDuration(app.project);
  const state = S.transport;
  if (r.state !== state) {
    r.state = state;
    r.play.textContent = state === 'stopped' ? '▶' : '■';
    r.play.setAttribute('aria-label', state === 'stopped' ? 'Tocar (Espaço)' : 'Parar (Espaço)');
    r.rec.textContent = state === 'recording' ? '■ Parar gravação' : '● Gravar';
    r.rec.classList.toggle('active', state === 'recording');
    r.rew.disabled = r.loop.disabled = state === 'recording';
    r.recFrom.hidden = state === 'recording';
    r.cut.disabled = r.ins.disabled = state !== 'stopped'; // cortar com a música tocando bagunçaria o que está agendado
    r.countIn.querySelector('select')?.toggleAttribute('disabled', state === 'recording');
  }
  const p = app.project;
  const text = `${fmtTime(pos)} / ${fmtTime(dur)}`;
  if (r.time.firstChild.textContent !== text) r.time.firstChild.textContent = text;
  // Próxima observação (ajuda a lembrar o que vem a seguir)
  const spb = 60 / p.bpm;
  const next = p.notes.find((n) => n.beat * spb > Math.max(0, pos) + 0.02);
  const bb = (pos < 0 ? '' : `compasso ${barBeat(p, pos)}`) + (next ? ` · ▸ ${barBeat(p, next.beat * spb)} ${next.text}` : '');
  if (r.time.lastChild.textContent !== bb) r.time.lastChild.textContent = bb;
  const l = p.loop;
  const lk = `${l.on}|${l.start}|${l.end}`;
  if (r.loopKey !== lk) {
    r.loopKey = lk;
    r.loop.classList.toggle('active', l.on);
    r.loop.setAttribute('aria-pressed', String(l.on));
    r.loop.setAttribute('aria-label', `Loop ${l.on ? 'ligado' : 'desligado'}, compassos ${l.start + 1} a ${l.end}`);
    r.loop.lastChild.textContent = ` ${l.start + 1}–${l.end}`;
    const what = l.end - l.start > 1 ? `os compassos ${l.start + 1}–${l.end}` : `o compasso ${l.start + 1}`;
    r.cut.lastChild.textContent = ` ${l.end - l.start > 1 ? `${l.start + 1}–${l.end}` : l.start + 1}`;
    r.cut.title = `Remover ${what} (o trecho do loop) da música inteira; o que vem depois anda para trás. Ctrl+Z desfaz.`;
    r.cut.setAttribute('aria-label', `Remover ${what} da música inteira`);
  }
  if (r.drumsOpen !== S.drumsOpen) {
    r.drumsOpen = S.drumsOpen;
    r.drums.classList.toggle('active', S.drumsOpen);
    r.drums.setAttribute('aria-pressed', String(S.drumsOpen));
  }
  r.timeline.draw(pos, dur);
}

export function renderStatus(app, el) {
  const S = app.S;
  const c = app.caps;
  const lat = app.latency();
  const l = app.engine.latency();
  const parts = [
    `${c.browser.name} ${c.browser.version}`,
    `Áudio interno ${app.engine.sampleRate / 1000} kHz`,
    `Latência ${lat.calibrated ? 'calibrada' : 'estimada'}: ${Math.round(lat.ms)} ms`,
    `Saída: ${app.engine.canSetSink() ? (S.sinkLabel || 'padrão') : 'padrão do sistema'}`,
  ];
  if (S.storage?.quota) parts.push(`Armazenamento: ${fmtBytes(S.storage.usage)} de ${fmtBytes(S.storage.quota)}`);
  fill(el,
    ...parts.map((t) => h('span', null, t)),
    !lat.calibrated ? h('button', { class: 'link', onClick: () => openSettings(app, 'latency') }, 'Calibrar latência') : null,
    S.livePlay ? h('span', { class: 'warn' }, 'Modo tocar: as letras do teclado tocam os pads (Shift = forte) · Esc sai') : null,
    (() => {
      const keys = 'Atalhos: Espaço tocar/parar · R gravar · Alt+R gravar do cursor · Shift+R punch-in · Ctrl+Z/Ctrl+Y desfazer/refazer · L loop · N nota · B bateria (Shift+B minimiza) · ←→ compasso · Shift+←→ tempo · 1–6 canal';
      return h('span', { class: 'muted', title: `${keys}
baseLatency ${l.baseMs.toFixed(1)} ms · outputLatency ${l.outputMs.toFixed(1)} ms` }, keys);
    })(),
  );
}
