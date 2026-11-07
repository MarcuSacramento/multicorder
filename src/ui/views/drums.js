// Painel da bateria: padrões (A, B, C…), faixa da música com os blocos e editor de pads × tempo com zoom.
import {
  activeGrid, createPad, createPattern, drumsEndBar, GM_NOTE, GRIDS, KITS, LIVE_KEYS, gridTicks, KIT, padGlow, placeBlock, PPQ, PUNCH_SOUNDS, secPerTick, SOUND_NAMES, ticksPerBar,
} from '../../engine/drums.js';
import { barSec, beatsPerBar, projectDuration } from '../../engine/project.js';
import { fmtDb, uid } from '../../engine/util.js';
import { checkbox, h, numberField, openDialog, select, slider } from '../dom.js';

const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff';

const ROW = 22;
const RULER = 16;
const PAD_COL = 190;
/** Duração em figuras: 1/16, 3/8… (ou ticks, se não fechar em nenhuma). */
function lenLabel(p, len) {
  const den = parseInt(String(p.timeSig).split('/')[1], 10) || 4;
  for (const n of [1, 2, 4, 8, 16, 32, 64]) {
    const unit = (PPQ * den) / n; // ticks de uma figura 1/n (PPQ = um tempo do compasso)
    if (Number.isInteger(unit) && len % unit === 0) return `${len / unit}/${n}`;
  }
  return `${len} ticks`;
}

const gridLabel = (g) => (g === 'auto' ? 'Automática (segue o zoom)' : g.endsWith('T') ? `${g.slice(0, -1)} tercina` : g);

const currentPattern = (d) => d.patterns.find((x) => x.id === d.sel) || d.patterns[0];

export function renderDrumsPanel(app, el) {
  const S = app.S;
  const p = app.project;
  el.hidden = !S.drumsOpen;
  const old = el._ed;
  const scroll = old ? { left: old.view.scrollLeft, top: old.view.scrollTop } : el._scroll;
  el._lane = el._ed = null;
  el.classList.toggle('min', !!(S.drumsMin && p.drums));
  if (!S.drumsOpen) return;
  if (!p.drums) {
    el.replaceChildren(h('div', { class: 'dr-empty' },
      h('div', null,
        h('strong', null, 'Bateria'),
        h('p', { class: 'muted small' }, 'Monte levadas em pads (bumbo, caixa, chimbal…) e espalhe os padrões ao longo da música. Toca junto na gravação e sai no vídeo exportado.')),
      h('button', { class: 'primary', onClick: () => app.addDrums() }, '+ Adicionar bateria'),
      midiImportButton(app, 'song', 'Importar MIDI…')));
    return;
  }
  const d = p.drums;
  const pat = currentPattern(d);
  const rerender = () => renderDrumsPanel(app, el);
  if (S.drumsMin) {
    // Minimizado: só a faixa da música (blocos), para ver onde a bateria toca sem ocupar a tela
    const lane = new ArrangeLane(app, rerender);
    el.replaceChildren(h('div', { class: 'dr-min' },
      h('button', { class: 'ghost small', title: 'Mostrar o editor da bateria (Shift+B)', onClick: () => app.setDrumsMin(false) }, '▴ Bateria'),
      lane.el,
      h('button', { class: 'icon small', 'aria-label': 'Fechar o painel da bateria (B)', title: 'Fechar (B)', onClick: () => app.toggleDrums() }, '✕')));
    el._lane = lane;
    el._scroll = scroll;
    requestAnimationFrame(() => lane.draw(app.engine.position, true));
    return;
  }
  const change = () => { app.touch(); rerender(); };

  const tabs = h('div', { class: 'dr-tabs', role: 'tablist', 'aria-label': 'Padrões' },
    d.patterns.map((x) => h('button', {
      class: `dr-tab${x.id === pat.id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(x.id === pat.id),
      title: 'Clique para editar · duplo clique para renomear',
      onClick: () => { d.sel = x.id; change(); },
      onDblclick: () => {
        const n = prompt('Nome do padrão:', x.name);
        if (n?.trim()) { x.name = n.trim().slice(0, 12); change(); }
      },
    }, x.name)),
    h('button', { class: 'icon small', title: 'Novo padrão vazio', onClick: () => { const n = createPattern(d, pat.bars); d.patterns.push(n); d.sel = n.id; change(); } }, '+'));

  const maxZoom = () => Math.min(768, 30000 / ((devicePixelRatio || 1) * pat.bars * beatsPerBar(p.timeSig)));
  // Cada clique dobra (ou divide) o zoom: na grade automática, um nível de subdivisão por clique.
  const zoomBy = (k) => { d.zoom = Math.max(12, Math.min(maxZoom(), d.zoom * k)); app.touch(); rerender(); };
  const gridNow = h('span', { class: 'dr-grid-now', title: 'Subdivisão em que os cliques encaixam agora' });

  const toolbar = h('div', { class: 'dr-toolbar' },
    select({
      label: 'Kit', value: d.kit, options: Object.entries(KITS).map(([k, x]) => [k, x.label]),
      onChange: (v) => { d.kit = v; app.touch(); rerender(); app.auditionPad(d.pads.find((x) => x.sound === 'snare') || d.pads[0], 0.85); },
    }),
    tabs,
    h('button', {
      class: 'ghost small', title: 'Copiar este padrão para um novo',
      onClick: () => {
        const n = { ...createPattern(d, pat.bars), hits: pat.hits.map((x) => ({ ...x })) };
        d.patterns.push(n); d.sel = n.id; change();
      },
    }, 'Duplicar'),
    h('button', {
      class: 'ghost small danger', disabled: d.patterns.length < 2, title: 'Apagar este padrão (e os blocos dele na música)',
      onClick: () => {
        if (!confirm(`Apagar o padrão ${pat.name}?`)) return;
        d.patterns = d.patterns.filter((x) => x !== pat);
        d.blocks = d.blocks.filter((b) => b.pattern !== pat.id);
        d.sel = d.patterns[0].id;
        change();
      },
    }, 'Apagar'),
    select({ label: 'Tamanho', value: pat.bars, options: [1, 2, 4, 8].map((n) => [n, `${n} compasso${n > 1 ? 's' : ''}`]), onChange: (v) => { pat.bars = +v; d.zoom = Math.min(d.zoom, maxZoom()); change(); } }),
    select({
      label: 'Grade', value: d.grid, options: GRIDS.filter((g) => g === 'auto' || g.endsWith('T') === !!d.triplet).map((g) => [g, gridLabel(g)]),
      onChange: (v) => { d.grid = v; change(); },
    }),
    checkbox({
      label: 'Tercina', checked: !!d.triplet, title: 'Divide o tempo em 3 (1/8 tercina, 1/16 tercina…)',
      onChange: (v) => { d.triplet = v; if (d.grid !== 'auto') d.grid = d.grid.replace('T', '') + (v ? 'T' : ''); change(); },
    }),
    h('div', { class: 'dr-zoom', role: 'group', 'aria-label': 'Zoom' },
      h('button', { class: 'icon small', 'aria-label': 'Diminuir zoom', title: 'Afastar: subdivisões maiores (Ctrl + rolagem)', onClick: () => zoomBy(1 / 2) }, '−'),
      gridNow,
      h('button', { class: 'icon small', 'aria-label': 'Aumentar zoom', title: 'Aproximar: subdivisões menores, até 1/64 (Ctrl + rolagem)', onClick: () => zoomBy(2) }, '+')),
    h('button', { class: 'ghost small', onClick: () => { if (pat.hits.length && confirm(`Limpar todas as batidas do padrão ${pat.name}?`)) { pat.hits = []; change(); } } }, 'Limpar'),
    h('button', { class: 'ghost small', title: 'Copiar as batidas deste padrão (Ctrl+C). Vale também para outro projeto.', onClick: () => app.copyDrumPattern(pat) }, 'Copiar'),
    h('button', { class: 'ghost small', title: 'Colar somando às batidas deste padrão (Ctrl+V)', onClick: () => app.pasteDrumPattern(pat) }, 'Colar'),
    h('div', { class: 'dr-swing', title: 'Swing: atrasa as notas do contratempo. 50% = reto; 66% ≈ tercina.' },
      slider({ label: 'Swing', min: 50, max: 75, step: 1, value: d.swing, onInput: (v) => { d.swing = v; app.touch(); }, format: (v) => (v === 50 ? 'reto' : `${v}%`) }),
      select({ label: 'em', value: d.swingGrid, options: [['1/16', '1/16'], ['1/8', '1/8']], onChange: (v) => { d.swingGrid = v; app.touch(); } })),
    select({
      label: 'MIDI', value: '', options: [['', '⬇ .mid…'], ['song', 'Música inteira'], ['pattern', `Só o padrão ${pat.name}`]],
      onChange: (v) => { if (v) app.exportDrumsMidi(v === 'pattern' ? pat.id : null); rerender(); },
    }),
    midiImportSelect(app, pat),
    select({
      label: 'Novo pad', value: '', options: [['', '+ Pad…'], ...KIT],
      onChange: (v) => { if (v) { d.pads.push(createPad(v)); change(); } },
    }),
    h('button', {
      class: 'ghost small', onClick: () => app.removeUnusedPads(),
      title: 'Tira os pads que não têm nenhuma batida nos padrões que estão na música (Ctrl+Z desfaz)',
    }, '🧹 Tirar pads sem uso'),
    h('div', { class: 'dr-live', role: 'group', 'aria-label': 'Tocar ao vivo' },
      h('button', {
        class: `small${S.livePlay ? ' on' : ''}`, 'aria-pressed': String(S.livePlay),
        title: 'As letras do teclado (Q W E R… A S D… Z X C…) tocam os pads, na ordem da lista. Shift = mais forte. Esc sai.',
        onClick: () => app.setLivePlay(!S.livePlay),
      }, '⌨ Tocar'),
      h('button', {
        class: `small rec-hits${S.liveRec ? ' on' : ''}`, 'aria-pressed': String(S.liveRec),
        title: 'Com a música tocando (ou gravando), o que você toca no teclado/MIDI entra na grade do padrão daquele compasso.',
        onClick: () => app.setLiveRec(!S.liveRec),
      }, '● Gravar toques'),
      select({ label: 'Encaixe', value: S.liveSnap, options: [['grid', 'na grade'], ['free', 'livre']], onChange: (v) => { S.liveSnap = v; } }),
      h('button', {
        class: `small${S.midi ? ' on' : ''}`, onClick: () => app.connectMidi(),
        title: S.midi ? `Conectado: ${S.midi.names.join(', ') || 'nenhum controlador'}` : 'Ligar um controlador MIDI USB (teclado ou pads)',
      }, S.midi ? `MIDI: ${S.midi.names.length || 0}` : 'MIDI USB')),
    h('button', {
      class: `small dr-follow${S.drumFollow ? ' on' : ''}`, 'aria-pressed': String(S.drumFollow),
      title: 'Com a música tocando, o editor mostra o padrão que está tocando, acompanha o cursor e acende os pads',
      onClick: () => { S.drumFollow = !S.drumFollow; rerender(); },
    }, '👁 Seguir'),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted small dr-help' }, 'Clique põe/tira · arraste na vertical = força · na horizontal = duração (Shift+clique volta ao som inteiro) · aproxime (+ ou Ctrl+rolagem) para encaixar em notas menores · Alt = fora da grade · arraste um arquivo de áudio sobre um pad para usar seu som'),
    h('button', { class: 'ghost small danger', onClick: () => app.removeDrums() }, 'Remover bateria'),
    h('button', { class: 'ghost small', title: 'Minimizar: deixa só a faixa com os blocos (Shift+B)', onClick: () => app.setDrumsMin(true) }, '▾ Minimizar'));

  // Ctrl+C / Ctrl+V com o foco no painel
  if (!el._keys) {
    el._keys = true;
    el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const dd = app.project?.drums;
      if (!dd) return;
      const cur = currentPattern(dd);
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); app.copyDrumPattern(cur); }
      else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); app.pasteDrumPattern(cur); }
    });
  }
  const lane = new ArrangeLane(app, rerender);
  const ed = new StepEditor(app, pat, rerender);
  ed.gridLabel = gridNow;
  el.replaceChildren(toolbar, lane.el, ed.view);
  el._lane = lane;
  el._ed = ed;
  ed.draw();
  if (scroll) { ed.view.scrollLeft = scroll.left; ed.view.scrollTop = scroll.top; }
  el._scroll = scroll;
  requestAnimationFrame(() => lane.draw(app.engine.position, true));
}

// ---------------------------------------------------------------- Importar .mid

const MIDI_ACCEPT = '.mid,.midi,.kar,.rmi,audio/midi,audio/x-midi';

// Um seletor só, fora do painel: o painel pode ser redesenhado com a janela de arquivo aberta.
let midiInput = null;
let midiMode = 'song';
function pickDrumsMidi(app, mode) {
  midiMode = mode;
  if (!midiInput) {
    midiInput = h('input', {
      type: 'file', accept: MIDI_ACCEPT, hidden: true,
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) app.importDrumsMidi(f, midiMode); },
    });
    document.body.append(midiInput);
  }
  midiInput.click();
}

function midiImportButton(app, mode, label) {
  return h('button', { class: 'ghost', title: 'Abre um arquivo .mid de bateria (notas General MIDI, canal 10) e monta os padrões e blocos', onClick: () => pickDrumsMidi(app, mode) }, label);
}

/** "⬆ .mid…": importa para a música inteira (padrões + blocos) ou só para o padrão aberto. */
function midiImportSelect(app, pat) {
  const sel = select({
    label: 'Importar', value: '', options: [['', '⬆ .mid…'], ['song', 'Importar na música'], ['pattern', `Importar no padrão ${pat.name}`]],
    onChange: (v) => { sel.querySelector('select').value = ''; if (v) pickDrumsMidi(app, v); },
  });
  sel.title = 'Importar um arquivo MIDI de bateria (notas General MIDI, canal 10)';
  return sel;
}

/** Chamado a cada quadro (cursor de reprodução). */
export function updateDrumsPanel(app, el, pos) {
  if (!el || el.hidden) return;
  const S = app.S;
  const p = app.project;
  const playing = S.transport !== 'stopped';
  const follow = playing && S.drumFollow;
  // Seguir: abre o padrão do bloco que está tocando (não interrompe quem está arrastando)
  if (follow && p?.drums && el._ed && !el._ed.drag && !el._lane?.drag) {
    const b = Math.floor(pos / barSec(p));
    const blk = pos >= 0 && p.drums.blocks.find((x) => b >= x.start && b < x.start + x.bars);
    if (blk && blk.pattern !== el._ed.pat.id && p.drums.patterns.some((x) => x.id === blk.pattern)) {
      p.drums.sel = blk.pattern;
      renderDrumsPanel(app, el);
    }
  }
  el._lane?.draw(pos);
  el._ed?.playhead(pos, follow);
  el._ed?.glow(playing ? pos : null);
}

// ---------------------------------------------------------------- Faixa da música (blocos)

class ArrangeLane {
  constructor(app, rerender) {
    this.app = app;
    this.rerender = rerender;
    this.canvas = h('canvas');
    this.el = h('div', {
      class: 'dr-lane', title: 'Clique ou arraste para colocar o padrão selecionado · arraste um bloco para mover · clique direito apaga o bloco',
    }, this.canvas);
    this.g = this.canvas.getContext('2d');
    this.drag = null;
    this.key = '';
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', () => this.up());
    this.el.addEventListener('pointercancel', () => { this.drag = null; this.key = ''; });
  }

  get d() { return this.app.project.drums; }

  nBars() {
    const p = this.app.project;
    const bar = barSec(p);
    return Math.max(16, Math.ceil(projectDuration(p) / bar) + 2, drumsEndBar(this.d) + 4, p.loop.end + 1);
  }

  barAt(e) {
    const r = this.el.getBoundingClientRect();
    return Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * this.span));
  }

  down(e) {
    const b = this.barAt(e);
    const blk = this.d.blocks.find((x) => b >= x.start && b < x.start + x.bars);
    if (e.button === 2) {
      if (blk) { placeBlock(this.d, blk.start, blk.bars, null); this.app.touch(); this.key = ''; }
      return;
    }
    if (e.button !== 0) return;
    this.el.setPointerCapture(e.pointerId);
    this.drag = blk ? { kind: 'move', blk, from: b, to: b } : { kind: 'new', a: b, b };
    this.key = '';
  }

  move(e) {
    if (!this.drag) return;
    const b = this.barAt(e);
    if (this.drag.kind === 'move') this.drag.to = b;
    else this.drag.b = b;
    this.key = '';
  }

  up() {
    const dr = this.drag;
    this.drag = null;
    this.key = '';
    if (!dr) return;
    const d = this.d;
    if (dr.kind === 'move') {
      if (dr.to === dr.from) {
        if (d.sel !== dr.blk.pattern) { d.sel = dr.blk.pattern; this.app.touch(); this.rerender(); }
        return;
      }
      const start = Math.max(0, dr.blk.start + dr.to - dr.from);
      d.blocks = d.blocks.filter((x) => x !== dr.blk);
      placeBlock(d, start, dr.blk.bars, dr.blk.pattern);
    } else {
      const pat = currentPattern(d);
      const s = Math.min(dr.a, dr.b);
      const n = dr.a === dr.b ? pat.bars : Math.abs(dr.a - dr.b) + 1;
      placeBlock(d, s, n, pat.id);
    }
    this.app.touch();
  }

  draw(pos, force = false) {
    const p = this.app.project;
    const d = p.drums;
    if (!d) return;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const span = (this.span = this.nBars());
    const barPx = W / span;
    const bar = barSec(p);
    const xPos = Math.round((Math.max(0, pos) / bar) * barPx);
    const dr = this.drag;
    const key = [W, H, span, xPos, d.sel, JSON.stringify(d.blocks), d.patterns.map((x) => x.name).join(), dr && JSON.stringify([dr.kind, dr.a, dr.b, dr.from, dr.to])].join('|');
    if (!force && key === this.key) return;
    this.key = key;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr)) this.canvas.width = Math.round(W * dpr);
    if (this.canvas.height !== Math.round(H * dpr)) this.canvas.height = Math.round(H * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, W, H);
    let every = 1;
    while (barPx * every < 22) every *= 2;
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    for (let b = 0; b <= span; b++) {
      const x = Math.round(b * barPx) + 0.5;
      g.fillStyle = b % every === 0 ? '#3a4256' : '#232937';
      g.fillRect(x - 0.5, 0, 1, H);
      if (b % every === 0 && b < span) { g.fillStyle = '#8d96a8'; g.fillText(String(b + 1), x + 3, 2); }
    }
    let blocks = d.blocks;
    if (dr?.kind === 'move') blocks = blocks.map((x) => (x === dr.blk ? { ...x, start: Math.max(0, x.start + dr.to - dr.from) } : x));
    for (const b of blocks) {
      const pat = d.patterns.find((x) => x.id === b.pattern);
      const x0 = b.start * barPx;
      const w = b.bars * barPx;
      const sel = b.pattern === d.sel;
      g.fillStyle = sel ? 'rgba(232,179,58,0.85)' : 'rgba(232,179,58,0.38)';
      g.fillRect(x0 + 1, 14, w - 2, H - 16);
      // marca cada repetição do padrão dentro do bloco
      if (pat) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        for (let k = pat.bars; k < b.bars; k += pat.bars) g.fillRect(x0 + k * barPx, 16, 1, H - 20);
      }
      g.fillStyle = '#1a1400';
      g.font = '600 11px system-ui, sans-serif';
      if (w > 14) g.fillText(pat?.name ?? '?', x0 + 4, 17);
    }
    if (dr?.kind === 'new') {
      const s = Math.min(dr.a, dr.b);
      const n = dr.a === dr.b ? currentPattern(d).bars : Math.abs(dr.a - dr.b) + 1;
      g.strokeStyle = '#ffffff';
      g.setLineDash([4, 3]);
      g.strokeRect(s * barPx + 1.5, 14.5, n * barPx - 3, H - 17);
      g.setLineDash([]);
    }
    g.fillStyle = '#ffffff';
    g.fillRect(xPos - 1, 0, 2, H);
  }
}

// ---------------------------------------------------------------- Editor de pads × tempo

class StepEditor {
  constructor(app, pat, rerender) {
    this.app = app;
    this.pat = pat;
    this.rerender = rerender;
    const d = app.project.drums;
    this.rows = [];
    this.canvas = h('canvas');
    this.line = h('div', { class: 'dr-playhead', hidden: true });
    this.wrap = h('div', { class: 'dr-grid' }, this.canvas, this.line);
    this.pads = h('div', { class: 'dr-pads', style: { width: `${PAD_COL}px` } },
      h('div', { class: 'dr-pads-ruler', style: { height: `${RULER}px` } }),
      d.pads.map((pad, i) => this.padRow(pad, i)));
    this.view = h('div', { class: 'dr-editor', tabindex: 0, 'aria-label': 'Grade de batidas' }, h('div', { class: 'dr-inner' }, this.pads, this.wrap));
    this.g = this.canvas.getContext('2d');
    this.drag = null;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', () => this.up());
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; });
    this.view.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  get d() { return this.app.project.drums; }
  get ppt() { return this.d.zoom / PPQ; }
  get cell() { return gridTicks(this.app.project, activeGrid(this.app.project)); }
  get lenTicks() { return this.pat.bars * ticksPerBar(this.app.project); }

  padRow(pad, i) {
    const tog = (label, key, cls, title) => h('button', {
      class: `toggle ${cls}${pad[key] ? ' on' : ''}`, 'aria-pressed': String(pad[key]), title,
      onClick: () => { pad[key] = !pad[key]; this.app.touch(); this.rerender(); },
    }, label);
    const S = this.app.S;
    const row = this.rows[i] = h('div', {
      class: `dr-pad${pad.sample ? ' own' : ''}`, style: { height: `${ROW}px` }, dataset: { pad: pad.id },
      onDragover: (e) => { if ([...e.dataTransfer.items].some((x) => x.kind === 'file')) { e.preventDefault(); row.classList.add('drop'); } },
      onDragleave: () => row.classList.remove('drop'),
      onDrop: (e) => {
        e.preventDefault();
        row.classList.remove('drop');
        const f = e.dataTransfer.files[0];
        if (f) this.app.setPadSample(pad, f);
      },
    },
      S.livePlay && LIVE_KEYS[i] ? h('kbd', { class: 'dr-key', title: `Tecla ${LIVE_KEYS[i].toUpperCase()}` }, LIVE_KEYS[i].toUpperCase()) : null,
      h('button', {
        class: 'dr-pad-name', title: `Ouvir ${pad.name}${pad.sample ? ` (arquivo: ${pad.sample.name})` : pad.name !== SOUND_NAMES[pad.sound] ? ` (${SOUND_NAMES[pad.sound]})` : ''}`,
        onClick: () => this.app.auditionPad(pad),
      }, pad.name),
      tog('M', 'mute', 'mute', `Mudo ${pad.name}`),
      tog('S', 'solo', 'solo', `Solo ${pad.name}`),
      h('button', { class: 'icon small', 'aria-label': `Ajustes de ${pad.name}`, title: 'Som, afinação, volume…', onClick: () => openPadDialog(this.app, pad, i, this.rerender) }, '⋯'));
    return row;
  }

  /** Posição → linha (pad) e tick. */
  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, row: Math.floor((y - RULER) / ROW), t: x / this.ppt };
  }

  hitW() { return Math.max(5, this.cell * this.ppt - 2); }

  /** Largura desenhada de uma batida: a duração, se tiver; senão, uma célula da grade. */
  widthOf(hit) { return hit.len > 0 ? Math.max(3, hit.len * this.ppt - 1) : this.hitW(); }

  findHit(row, x) {
    const pad = this.d.pads[row];
    if (!pad) return null;
    // a batida mais próxima à esquerda do ponteiro, dentro da largura desenhada
    let best = null;
    for (const hit of this.pat.hits) {
      if (hit.pad !== pad.id || hit.t >= this.lenTicks) continue;
      const hx = hit.t * this.ppt;
      if (x >= hx - 1 && x <= hx + this.widthOf(hit) && (!best || hit.t > best.t)) best = hit;
    }
    return best;
  }

  /** Nova duração com o ponteiro em `t`: encaixa na grade (Alt = livre), de uma célula até o fim do padrão. */
  lenAt(hit, t, free) {
    const c = free ? 1 : this.cell;
    const end = Math.round(t / c) * c;
    return Math.max(free ? 2 : c, Math.min(this.lenTicks - hit.t, end - hit.t));
  }

  snap(t, free) {
    if (free) return Math.max(0, Math.min(this.lenTicks - 1, Math.round(t)));
    const c = this.cell;
    return Math.max(0, Math.min(this.lenTicks - 1, Math.floor(t / c) * c));
  }

  add(row, t) {
    const pad = this.d.pads[row];
    if (!pad || this.pat.hits.some((x) => x.pad === pad.id && x.t === t)) return false;
    this.pat.hits.push({ pad: pad.id, t, v: 0.8 });
    this.app.auditionPad(pad, 0.8);
    return true;
  }

  down(e) {
    const { x, y, row, t } = this.at(e);
    if (y < RULER || row < 0 || row >= this.d.pads.length) return;
    const hit = this.findHit(row, x);
    if (e.button === 2) {
      if (hit) { this.pat.hits.splice(this.pat.hits.indexOf(hit), 1); this.changed(); }
      return;
    }
    if (e.button !== 0) return;
    this.view.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    if (hit && e.shiftKey) {
      // Shift+clique: volta ao som inteiro (sem duração)
      if (hit.len) { delete hit.len; this.changed(); }
      return;
    }
    if (hit) {
      // O primeiro movimento decide: vertical muda a força, horizontal muda a duração.
      this.drag = { kind: 'hit', mode: null, hit, x0: e.clientX, y0: e.clientY, v0: hit.v };
    } else {
      const st = this.snap(t, e.altKey);
      this.add(row, st);
      this.drag = { kind: 'paint', row, last: st };
      this.changed();
    }
  }

  move(e) {
    const dr = this.drag;
    if (!dr) return;
    if (dr.kind === 'hit') {
      const dx = e.clientX - dr.x0;
      const dy = dr.y0 - e.clientY;
      if (!dr.mode && Math.max(Math.abs(dx), Math.abs(dy)) > 4) dr.mode = Math.abs(dx) > Math.abs(dy) ? 'len' : 'vel';
      if (dr.mode === 'vel') {
        dr.hit.v = Math.max(0.05, Math.min(1, dr.v0 + dy / 80));
        this.draw();
        this.tip(e, `força ${Math.round(dr.hit.v * 100)}%`);
      } else if (dr.mode === 'len') {
        const len = this.lenAt(dr.hit, this.at(e).t, e.altKey);
        if (len !== dr.hit.len) { dr.hit.len = len; this.draw(); }
        this.tip(e, `duração ${lenLabel(this.app.project, len)} (Shift+clique volta ao som inteiro)`);
      }
    } else {
      const st = this.snap(this.at(e).t, e.altKey);
      if (st !== dr.last) {
        dr.last = st;
        if (this.add(dr.row, st)) this.changed();
      }
    }
  }

  up() {
    const dr = this.drag;
    this.drag = null;
    this.tip(null);
    if (!dr) return;
    if (dr.kind === 'hit') {
      if (!dr.mode) this.pat.hits.splice(this.pat.hits.indexOf(dr.hit), 1); // clique sem arrastar: tira a batida
      this.changed();
    }
  }

  tip(e, text) {
    if (!e) { this.canvas.title = ''; return; }
    this.canvas.title = text;
  }

  changed() {
    this.app.touch();
    this.draw();
  }

  wheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const d = this.d;
    const r = this.canvas.getBoundingClientRect();
    const t = (e.clientX - r.left) / this.ppt;
    const offset = e.clientX - this.view.getBoundingClientRect().left - PAD_COL;
    const p = this.app.project;
    const max = Math.min(768, 30000 / ((devicePixelRatio || 1) * this.pat.bars * beatsPerBar(p.timeSig)));
    d.zoom = Math.max(12, Math.min(max, d.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    this.draw();
    this.view.scrollLeft = Math.max(0, t * this.ppt - offset);
    this.app.touch();
  }

  draw() {
    const p = this.app.project;
    const d = this.d;
    const ppt = this.ppt;
    const W = Math.ceil(this.lenTicks * ppt) + 1;
    const H = RULER + d.pads.length * ROW;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.wrap.style.width = `${W}px`;
    if (this.canvas.width !== Math.round(W * dpr)) this.canvas.width = Math.round(W * dpr);
    if (this.canvas.height !== Math.round(H * dpr)) this.canvas.height = Math.round(H * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Linhas alternadas por pad
    for (let i = 0; i < d.pads.length; i++) {
      g.fillStyle = i % 2 ? '#151922' : '#191e29';
      g.fillRect(0, RULER + i * ROW, W, ROW);
    }
    g.fillStyle = '#10131a';
    g.fillRect(0, 0, W, RULER);

    // Grade: célula (fraca), tempo (média), compasso (forte)
    const bpb = beatsPerBar(p.timeSig);
    const cell = this.cell;
    const cellPx = cell * ppt;
    if (cellPx >= 4) {
      // Linhas mais fortes nas subdivisões maiores (colcheia > semicolcheia > fusa…), como numa régua
      for (let t = 0; t < this.lenTicks; t += cell) {
        if (t % PPQ === 0) continue;
        const a = t % (PPQ / 2) === 0 ? 0.16 : t % (PPQ / 4) === 0 ? 0.1 : t % (PPQ / 8) === 0 ? 0.07 : 0.045;
        g.fillStyle = `rgba(255,255,255,${a})`;
        g.fillRect(Math.round(t * ppt), RULER, 1, H - RULER);
      }
    }
    if (this.gridLabel) {
      const gNow = activeGrid(p);
      this.gridLabel.textContent = d.grid === 'auto' ? `${gridLabel(gNow)} (auto)` : gridLabel(gNow);
    }
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let beat = 0; beat <= this.pat.bars * bpb; beat++) {
      const x = Math.round(beat * PPQ * ppt);
      const isBar = beat % bpb === 0;
      g.fillStyle = isBar ? '#5a6480' : '#343c50';
      g.fillRect(x, isBar ? 0 : RULER - 5, isBar ? 1.5 : 1, isBar ? H : H - RULER + 5);
      if (beat < this.pat.bars * bpb && (d.zoom >= 28 || isBar)) {
        g.fillStyle = isBar ? '#e7eaf0' : '#8d96a8';
        g.fillText(`${Math.floor(beat / bpb) + 1}.${(beat % bpb) + 1}`, x + 3, RULER / 2 + 0.5);
      }
    }

    // Batidas
    const rowOf = new Map(d.pads.map((x, i) => [x.id, i]));
    const w = this.hitW();
    for (const hit of this.pat.hits) {
      const row = rowOf.get(hit.pad);
      if (row == null || hit.t >= this.lenTicks) continue;
      const pad = d.pads[row];
      const x = hit.t * ppt;
      const y = RULER + row * ROW + 3;
      const alpha = 0.35 + 0.65 * hit.v;
      const hw = hit.len > 0 ? this.widthOf(hit) : w;
      g.fillStyle = pad.mute ? `rgba(141,150,168,${alpha * 0.6})` : `rgba(232,179,58,${alpha})`;
      g.fillRect(x + 0.5, y, hw, ROW - 6);
      if (hit.len > 0) {
        // som cortado: borda clara no fim, onde ele para
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillRect(x + 0.5 + hw - 2, y, 2, ROW - 6);
      }
      // barrinha da força na base
      g.fillStyle = 'rgba(26,20,0,0.55)';
      g.fillRect(x + 0.5, y + (ROW - 6) - 2, Math.max(2, Math.min(w, hw) * hit.v), 2);
    }
  }

  /** Cursor dentro do padrão quando a música passa por um bloco dele. `follow`: rola junto. */
  playhead(pos, follow = false) {
    const p = this.app.project;
    const d = this.d;
    const bar = barSec(p);
    const b = Math.floor(pos / bar);
    const blk = pos >= 0 && d.blocks.find((x) => b >= x.start && b < x.start + x.bars);
    if (!blk || blk.pattern !== this.pat.id) { if (!this.line.hidden) this.line.hidden = true; return; }
    const local = (pos - blk.start * bar) / secPerTick(p);
    const t = local % this.lenTicks;
    const x = Math.round(t * this.ppt);
    this.line.hidden = false;
    this.line.style.transform = `translateX(${x}px)`;
    if (follow) {
      // rola por páginas: quando o cursor sai da área visível, ele volta para perto da esquerda
      const v = this.view;
      const visible = v.clientWidth - PAD_COL;
      if (visible > 60 && (x < v.scrollLeft || x > v.scrollLeft + visible - 24)) v.scrollLeft = Math.max(0, x - 24);
    }
  }

  /** Acende o nome dos pads que acabaram de tocar (pos = null apaga). */
  glow(pos) {
    const tl = this.app.S.drumTL;
    const on = pos != null && this.app.S.drumFollow;
    this.d.pads.forEach((pad, i) => {
      const row = this.rows[i];
      if (!row) return;
      const g = on ? padGlow(tl, pad.id, pos) : 0;
      const k = Math.round(g * 20) / 20;
      if (row._glow === k) return;
      row._glow = k;
      row.style.background = k > 0 ? `rgba(232,179,58,${(k * 0.55).toFixed(2)})` : '';
    });
  }
}

// ---------------------------------------------------------------- Ajustes de um pad

function openPadDialog(app, pad, index, rerender) {
  const d = app.project.drums;
  const picker = h('input', {
    type: 'file', accept: AUDIO_ACCEPT, hidden: true,
    onChange: (e) => { const f = e.target.files[0]; if (f) { app.setPadSample(pad, f); dlg.close(); } },
  });
  const u = () => app.touch();
  const move = (k) => {
    const j = index + k;
    if (j < 0 || j >= d.pads.length) return;
    [d.pads[index], d.pads[j]] = [d.pads[j], d.pads[index]];
    index = j;
    u();
    rerender();
  };
  const dlg = openDialog(`Pad: ${pad.name}`, [
    h('div', { class: 'field' }, h('label', null, 'Nome'),
      h('input', { value: pad.name, maxlength: 24, onChange: (e) => { pad.name = e.target.value.trim() || SOUND_NAMES[pad.sound]; u(); } })),
    select({
      label: pad.sample ? 'Som do kit (usado no .mid)' : 'Som', value: pad.sound, options: KIT,
      onChange: (v) => { if (pad.name === SOUND_NAMES[pad.sound]) pad.name = SOUND_NAMES[v]; pad.sound = v; u(); app.auditionPad(pad); },
    }),
    h('div', { class: 'row' },
      pad.sample
        ? [h('span', { class: 'small ok' }, `Som próprio: ${pad.sample.name}`),
          h('button', { class: 'ghost small', onClick: () => { app.clearPadSample(pad); dlg.close(); } }, 'Voltar ao som do kit')]
        : h('span', { class: 'small muted' }, 'Som do kit sintetizado.'),
      h('button', { class: 'small', onClick: () => picker.click() }, pad.sample ? 'Trocar arquivo…' : 'Usar arquivo de áudio…')),
    picker,
    h('div', { class: 'row' },
      numberField({
        label: 'Nota MIDI', value: pad.midiNote ?? '', min: 0, max: 127, width: '4.5em',
        onChange: (v) => { pad.midiNote = Number.isFinite(v) ? v : null; u(); },
      }),
      h('button', { class: 'small', onClick: () => { app.learnMidi(pad); } }, 'Aprender do controlador'),
      h('span', { class: 'small muted' }, pad.midiNote == null ? `Vazio = padrão General MIDI (${GM_NOTE[pad.sound] ?? '—'})` : '')),
    slider({ label: 'Afinação', min: -12, max: 12, step: 1, value: pad.tune, onInput: (v) => { pad.tune = v; u(); }, format: (v) => `${v > 0 ? '+' : ''}${v} st` }),
    PUNCH_SOUNDS.has(pad.sound) ? slider({
      label: 'Pancada', min: 0, max: 100, step: 5, value: Math.round((pad.punch || 0) * 100),
      onInput: (v) => { pad.punch = v / 100; u(); },
      format: (v) => (v ? `${v}%` : 'desligada'),
      title: (/^kick/.test(pad.sound)
        ? 'Estalo da baqueta, soco no começo da batida e grave no peito (~60 Hz).'
        : pad.sound === 'rim'
          ? 'Estalo da baqueta no aro e soco no começo da batida.'
          : 'Estalo da esteira, soco no começo da batida e corpo da caixa (~200 Hz).') + ' Solte o controle e clique em ▶ Ouvir.',
    }) : null,
    slider({ label: 'Volume', min: -30, max: 6, step: 0.5, value: pad.volumeDb, onInput: (v) => { pad.volumeDb = v; u(); }, format: (v) => `${fmtDb(v)} dB` }),
    slider({ label: 'Pan', min: -1, max: 1, step: 0.05, value: pad.pan, onInput: (v) => { pad.pan = v; u(); }, format: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) }),
    h('div', { class: 'row' },
      h('button', { onClick: () => app.auditionPad(pad) }, '▶ Ouvir'),
      h('button', { class: 'ghost', onClick: () => move(-1) }, '↑ Subir'),
      h('button', { class: 'ghost', onClick: () => move(1) }, '↓ Descer'),
      h('button', {
        class: 'ghost',
        onClick: () => {
          const n = { ...pad, id: uid('d'), name: `${pad.name} 2`, solo: false };
          d.pads.splice(index + 1, 0, n);
          u();
          dlg.close();
        },
      }, 'Duplicar pad'),
      h('button', {
        class: 'ghost danger', disabled: d.pads.length < 2,
        onClick: () => {
          const used = d.patterns.reduce((s, x) => s + x.hits.filter((y) => y.pad === pad.id).length, 0);
          if (used && !confirm(`Remover o pad ${pad.name} e suas ${used} batidas?`)) return;
          d.pads = d.pads.filter((x) => x !== pad);
          for (const x of d.patterns) x.hits = x.hits.filter((y) => y.pad !== pad.id);
          u();
          dlg.close();
          app.cleanDrumFiles();
        },
      }, 'Remover pad')),
    h('p', { class: 'muted small' }, 'Mudanças valem na hora. Afinação e volume deste pad entram no áudio da bateria; o volume geral e os efeitos ficam no canal "Bateria" do mixer.'),
  ], { onClose: rerender });
}
