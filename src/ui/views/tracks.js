// Faixas: uma linha por canal com a onda do som, a faixa de trocas de layout, a guia e a bateria.
// - Clique numa faixa: seleciona o canal e põe o cursor ali (em qualquer ponto).
// - Bordas da tomada (corte de início/fim) e dos punch-ins: arraste para ajustar (Shift encaixa no tempo).
// - Faixa "Layout": arraste uma troca para mudar de lugar, clique para editar, duplo clique cria uma.
// - Faixa "Seções": clique numa seção seleciona o trecho para o loop (e para ✂, punch-in…); duplo clique
//   edita (nome, cor, duplicar, remover); duplo clique no vazio cria; arraste as pontas para mudar.
// - Faixa "Letra": duplo clique cria uma frase; arraste para mover, as pontas para mudar a duração;
//   clique para editar o texto. "✎ Letra…" cola a letra inteira e escolhe o estilo.
// - Ctrl+roda: zoom; Shift+roda (ou roda na horizontal): anda para os lados.
// - Modos Volume e Pan: cada faixa (canais e bateria) mostra a linha. Clique na linha cria um ponto;
//   arraste um ponto ou o pedaço de linha entre dois pontos para cima/baixo; duplo clique num ponto apaga.
import { DRUMS_ID } from '../../engine/drums.js';
import { LAYOUTS, layoutSteps, usesFeatured } from '../../engine/layout.js';
import { GUIDE_ID } from '../../engine/mix-graph.js';
import {
  AUTO_MAX_DB, AUTO_MIN_DB, autoValueAt, barSec, baseExtent, beatsPerBar, channelPieces, cutsFor, guidePieces, mapRanges,
  normalizePunches, punchLimits, SECTION_COLORS,
} from '../../engine/project.js';
import { fmtTime, uid } from '../../engine/util.js';
import { LYRIC_POSITIONS } from '../../engine/compositor.js';
import { checkbox, h, openDialog, select, slider, toast } from '../dom.js';

// Largura da coluna dos nomes: menor em telas estreitas (celular), para sobrar espaço para a onda.
let LABEL_W = 112;
const RULER_H = 16;
const LAYOUT_H = 20;
const SECTIONS_H = 20;
const SECTION_NAMES = ['Intro', 'Verso', 'Pré-refrão', 'Refrão', 'Ponte', 'Solo', 'Instrumental', 'Final'];
const LYRICS_H = 22;
const LANE_H = 28;
const GUIDE_H = 22;
const DRUMS_H = 18;
const MIN_BARS = 8;
const PEAK_RATE = 200; // picos por segundo guardados para desenhar a onda
const GRAB = 6; // px de tolerância para pegar uma borda
const OPEN_KEY = 'mc.tracksOpen';
const VOL_KEY = 'mc.tracksVol';
const VOL_LANE_H = 56; // faixa mais alta no modo Volume, para mexer na linha com precisão
const PT_R = 4; // raio do ponto da linha de volume

const fmtDb = (db) => (db <= AUTO_MIN_DB + 1e-6 ? 'mudo' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1).replace('.', ',')} dB`);
const fmtPan = (v) => (Math.abs(v) < 0.005 ? 'centro' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'esquerda' : 'direita'}`);

/**
 * As duas linhas: onde fica o valor (key/f), limites, o que vai em cima e embaixo da faixa, o valor sem
 * pontos (def) e como mostrar. Volume: em cima +6 dB, embaixo mudo. Pan: em cima esquerda, embaixo direita.
 */
const LINES = {
  vol: {
    key: 'volAuto', f: 'db', lo: AUTO_MIN_DB, hi: AUTO_MAX_DB, top: AUTO_MAX_DB, bottom: AUTO_MIN_DB, ref: 0,
    def: () => 0, color: '#ffd54a', fmt: fmtDb, label: 'volume', topText: '+6 dB', bottomText: 'mudo',
    snap: (v) => { const r = Math.round(v * 2) / 2; return Math.abs(r) <= 0.75 ? 0 : r; },
  },
  pan: {
    key: 'panAuto', f: 'v', lo: -1, hi: 1, top: -1, bottom: 1, ref: 0,
    def: (o) => o.pan || 0, color: '#6fe3ff', fmt: fmtPan, label: 'pan', topText: 'E', bottomText: 'D',
    snap: (v) => { const r = Math.round(v * 50) / 50; return Math.abs(r) <= 0.04 ? 0 : r; },
  },
};

const peakCache = new WeakMap();

/** Picos (máximo absoluto dos dois lados) a cada 1/PEAK_RATE s de um AudioBuffer. */
function peaksOf(buf) {
  let pk = peakCache.get(buf);
  if (pk) return pk;
  const n = Math.max(1, Math.ceil(buf.duration * PEAK_RATE));
  pk = new Float32Array(n);
  const step = buf.sampleRate / PEAK_RATE;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let k = 0; k < n; k++) {
      let m = pk[k];
      const a = Math.floor(k * step);
      const b = Math.min(d.length, Math.floor((k + 1) * step));
      for (let i = a; i < b; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > m) m = v;
      }
      pk[k] = m;
    }
  }
  peakCache.set(buf, pk);
  return pk;
}

/** Altura da onda (0–1) numa escala em dB: sons baixos continuam visíveis. */
const ampH = (v) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 48) / 48));

export class Tracks {
  constructor(app) {
    this.app = app;
    this.open = localStorage.getItem(OPEN_KEY) !== '0';
    const m = localStorage.getItem(VOL_KEY);
    this.mode = m === 'pan' ? 'pan' : m === 'vol' || m === '1' ? 'vol' : null; // linha mostrada: volume, pan ou nenhuma
    this.lastTarget = null;
    this.panHas = new WeakMap(); // a faixa tinha linha de pan? (o mixer troca o botão pelo aviso)
    this.view = null; // null = música inteira; senão { start, len } em segundos
    this.canvas = h('canvas');
    this.cursor = h('div', { class: 'tr-cursor' });
    this.tip = h('div', { class: 'tr-tip', hidden: true });
    this.area = h('div', { class: 'tr-area', tabindex: 0, 'aria-label': 'Faixas dos canais' }, this.canvas, this.cursor, this.tip);
    this.head = h('div', { class: 'tr-head' },
      h('strong', null, 'Faixas'),
      h('div', { class: 'tr-zoom', role: 'group', 'aria-label': 'Zoom' },
        h('button', { class: 'icon small', title: 'Afastar (Ctrl+roda)', onClick: () => this.zoom(1.6) }, '−'),
        h('button', { class: 'icon small', title: 'Aproximar (Ctrl+roda)', onClick: () => this.zoom(1 / 1.6) }, '+'),
        h('button', { class: 'ghost small', title: 'Mostrar a música inteira', onClick: () => { this.view = null; this.key = ''; } }, 'Tudo')),
      h('button', { class: 'ghost small', title: 'Troca o layout da grade a partir do cursor (duplo clique na faixa Layout também cria)', onClick: () => this.addLayoutChange() }, '+ Trocar layout aqui'),
      h('button', { class: 'ghost small', title: 'Marca uma seção da música (verso, refrão…) no trecho do loop ou a partir do cursor', onClick: () => this.addSection() }, '+ Seção'),
      h('button', { class: 'ghost small', title: 'Letra ou legenda na tela: colar a letra, escolher o estilo (duplo clique na faixa Letra cria uma frase)', onClick: () => this.openLyrics() }, '✎ Letra…'),
      this.btnVol = h('button', {
        class: 'ghost small tr-vol', 'aria-pressed': 'false', onClick: () => this.setMode(this.mode === 'vol' ? null : 'vol'),
        title: 'Linha de volume de cada faixa: clique na linha para criar um ponto e arraste para cima ou para baixo',
      }, '〽 Volume'),
      this.btnPan = h('button', {
        class: 'ghost small tr-vol tr-pan', 'aria-pressed': 'false', onClick: () => this.setMode(this.mode === 'pan' ? null : 'pan'),
        title: 'Linha de pan de cada faixa: em cima é esquerda, embaixo é direita',
      }, '↔ Pan'),
      this.btnVolClear = h('button', { class: 'ghost small', onClick: () => this.clearLine(), title: 'Tira todos os pontos da linha da última faixa em que você mexeu (ou do canal selecionado)' }, 'Limpar linha'),
      this.help = h('span', { class: 'muted tr-help' }));
    this.legend = h('div', { class: 'tr-legend', 'aria-label': 'O que cada cor quer dizer' });
    this.el = h('section', { class: 'tracks', 'aria-label': 'Faixas' }, this.head, this.area, this.legend);
    this.g = this.canvas.getContext('2d');
    this.key = '';
    this.drag = null;
    this.ro = new ResizeObserver(() => { this.key = ''; });
    this.ro.observe(this.area);
    const a = this.area;
    a.addEventListener('pointerdown', (e) => this.onDown(e));
    a.addEventListener('pointermove', (e) => this.onMove(e));
    a.addEventListener('pointerup', (e) => this.onUp(e));
    a.addEventListener('pointercancel', () => this.cancelDrag());
    a.addEventListener('dblclick', (e) => this.onDbl(e));
    a.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    a.addEventListener('pointerleave', () => { if (!this.drag) this.tip.hidden = true; });
    this.setOpen(this.open);
    this.setMode(this.mode);
  }

  /** Legenda das cores (muda com o modo Volume/Pan). */
  renderLegend() {
    const sw = (cls, text, title) => h('span', { class: 'tr-lg', title: title || text }, h('i', { class: `tr-sw ${cls}` }), text);
    const items = [
      sw('sw-base', 'gravação principal', 'Azul: a tomada principal do canal'),
      sw('sw-punch', 'trecho regravado', 'Laranja: punch-in, "Gravar daqui" num canal gravado ou trecho de outra tomada. Ele toca no lugar do azul.'),
      this.mode ? null : sw('sw-edge', 'borda: arraste para ajustar', 'Branco: começo e fim de cada trecho; arraste para ajustar (Shift encaixa no tempo)'),
      this.mode === 'vol' ? sw('sw-vol', 'linha de volume') : null,
      this.mode === 'pan' ? sw('sw-pan', 'linha de pan (em cima E, embaixo D)') : null,
      sw('sw-section', 'seções', 'Faixa Seções: verso, refrão… (clique seleciona para o loop)'),
      sw('sw-layout', 'troca de layout'),
      sw('sw-lyric', 'letra'),
      sw('sw-drums', 'blocos da bateria'),
      sw('sw-loop', 'trecho do loop'),
    ].filter(Boolean);
    this.legend.replaceChildren(...items);
  }

  /** Descrição do que está sob o mouse numa faixa de canal (dica ao parar o mouse). */
  describeAt(row, x) {
    if (row?.kind !== 'ch') return '';
    const t = this.tOf(x);
    const pc = channelPieces(this.p, row.ch).find((g) => t >= g.from && t < g.to);
    if (!pc) return '';
    const when = this.app.takeWhen?.(pc.take) || '';
    const span = `${fmtTime(pc.from)}–${fmtTime(pc.to)}`;
    return pc.bufId.includes('#')
      ? `Trecho regravado (${span}), da tomada de ${when}. Toca no lugar da gravação principal.`
      : `Gravação principal de "${row.ch.name}" (${span}), tomada de ${when}.`;
  }

  /** Há uma linha (volume ou pan) sendo mostrada. */
  get volMode() { return !!this.mode; }
  get L() { return LINES[this.mode]; }

  /** Dono da linha numa faixa: o canal ou a bateria (id = o do strip no mixer). */
  target(row) {
    let tg = null;
    if (row?.kind === 'ch') tg = { o: row.ch, id: row.ch.id, name: row.ch.name };
    else if (row?.kind === 'drums' && this.p.drums) tg = { o: this.p.drums, id: DRUMS_ID, name: 'Bateria' };
    if (tg && !this.panHas.has(tg.o)) this.panHas.set(tg.o, !!tg.o.panAuto?.length);
    return tg;
  }

  setMode(m) {
    this.mode = m;
    localStorage.setItem(VOL_KEY, m || '0');
    for (const [b, k] of [[this.btnVol, 'vol'], [this.btnPan, 'pan']]) {
      b.classList.toggle('active', m === k);
      b.setAttribute('aria-pressed', String(m === k));
    }
    this.btnVolClear.hidden = !m;
    this.help.textContent = this.help.title = m
      ? `${m === 'vol' ? 'Volume' : 'Pan (em cima = esquerda, embaixo = direita)'}: clique na linha para criar um ponto; arraste um ponto ou o pedaço entre dois pontos para cima/baixo (Shift: só na vertical). Duplo clique apaga o ponto.`
      : 'Arraste as bordas claras para ajustar o início e o fim de cada trecho (Shift encaixa no tempo; Ctrl+Z desfaz). Ctrl+roda: zoom.';
    this.key = '';
    this.renderLegend();
  }

  clearLine() {
    const L = this.L;
    if (!L) return;
    const ch = this.app.selected?.();
    const tg = this.lastTarget || (ch && { o: ch, id: ch.id, name: ch.name });
    if (tg && !this.panHas.has(tg.o)) this.panHas.set(tg.o, !!tg.o.panAuto?.length);
    if (!tg?.o[L.key]?.length) { toast(`A linha de ${L.label} de "${tg?.name || 'canal'}" já está sem pontos.`, 'info'); return; }
    tg.o[L.key] = [];
    this.lineChanged(tg);
    toast(`Linha de ${L.label} de "${tg.name}" sem pontos${this.mode === 'pan' ? ': volta a valer o pan do mixer' : ''}. Ctrl+Z desfaz.`, 'info');
  }

  /** Depois de mexer na linha: salva, entra no Ctrl+Z e, tocando, o som segue a linha nova na hora. */
  lineChanged(tg) {
    this.lastTarget = tg;
    const has = !!tg.o.panAuto?.length;
    const had = this.panHas.get(tg.o);
    this.panHas.set(tg.o, has);
    this.app.touch(had !== undefined && had !== has); // o mixer redesenha quando o pan passa a ser da linha
    this.app.engine.sync?.(this.p); // pan: o botão do mixer deixa de valer (ou volta a valer)
    this.app.engine.refreshAuto?.(tg.o, tg.id);
    this.key = '';
  }

  /** Compatível com quem já chamava volChanged(canal). */
  volChanged(ch) { this.lineChanged({ o: ch, id: ch.id, name: ch.name }); }

  yOf(r, v) { const L = this.L; return r.y + 5 + ((v - L.top) / (L.bottom - L.top)) * (r.h - 10); }

  vOfY(r, y) {
    const L = this.L;
    const v = L.top + ((y - r.y - 5) / (r.h - 10)) * (L.bottom - L.top);
    return L.snap(Math.min(L.hi, Math.max(L.lo, v)));
  }

  lineAt(tg, t) { const L = this.L; return autoValueAt(tg.o[L.key], t, L.f, L.def(tg.o)); }

  /** O que há sob o mouse na linha: um ponto (índice) ou a linha. */
  volHit(row, x, y) {
    const tg = this.target(row);
    if (!tg || !this.mode || x < LABEL_W) return null;
    const L = this.L;
    const pts = tg.o[L.key] || [];
    let best = null;
    pts.forEach((q, i) => {
      const d = Math.hypot(this.xOf(q.t) - x, this.yOf(row, q[L.f]) - y);
      if (d <= PT_R + 4 && (!best || d < best.d)) best = { kind: 'pt', i, d };
    });
    if (best) return best;
    const t = this.tOf(x);
    if (Math.abs(this.yOf(row, this.lineAt(tg, t)) - y) <= 6) return { kind: 'line', t };
    return null;
  }

  get p() { return this.app.project; }
  get busy() { return this.app.S.transport === 'recording'; }

  /** Aberto/fechado: quem mostra e esconde é o bloco da tela (igual ao mixer); aqui só para de desenhar. */
  setOpen(v) {
    this.open = v;
    localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    if (this.btnVolClear) this.btnVolClear.hidden = !this.mode;
    this.key = '';
  }

  // ------------------------------------------------------------ geometria

  rows() {
    const p = this.p;
    const out = [
      { kind: 'ruler', y: 0, h: RULER_H },
      { kind: 'sections', y: RULER_H, h: SECTIONS_H },
      { kind: 'layout', y: RULER_H + SECTIONS_H, h: LAYOUT_H },
      { kind: 'lyrics', y: RULER_H + SECTIONS_H + LAYOUT_H, h: LYRICS_H },
    ];
    let y = RULER_H + SECTIONS_H + LAYOUT_H + LYRICS_H;
    const lh = this.laneH(this.volMode ? VOL_LANE_H : LANE_H);
    p.channels.forEach((ch, i) => { out.push({ kind: 'ch', ch, i, y, h: lh }); y += lh; });
    if (p.guide?.duration) { out.push({ kind: 'guide', y, h: GUIDE_H }); y += GUIDE_H; }
    if (p.drums?.blocks?.length) { const dh = this.mode ? VOL_LANE_H : DRUMS_H; out.push({ kind: 'drums', y, h: dh }); y += dh; }
    return { rows: out, H: y };
  }

  /** Altura de cada faixa de canal: ao lado da prévia, as faixas crescem até ocupar a altura que há. */
  laneH(base) {
    const slot = this.el.parentNode;
    if (!this.fill || !slot) return base;
    const p = this.p;
    const fixed = RULER_H + SECTIONS_H + LAYOUT_H + LYRICS_H + (p.guide?.duration ? GUIDE_H : 0) + (p.drums?.blocks?.length ? (this.mode ? VOL_LANE_H : DRUMS_H) : 0);
    const avail = slot.clientHeight - this.head.offsetHeight - this.legend.offsetHeight - 18 - fixed;
    return Math.max(base, Math.min(110, Math.floor(avail / Math.max(1, p.channels.length))));
  }

  /** Trecho mostrado (segundos). */
  span(pos) {
    const p = this.p;
    const bar = barSec(p);
    if (this.view) return this.view;
    const dur = this.dur ?? 0;
    const end = Math.max(dur, p.loop.end * bar, pos, MIN_BARS * bar);
    return { start: 0, len: Math.ceil(end / bar - 1e-6) * bar };
  }

  zoom(f, atSec = null) {
    const v = this.span(Math.max(0, this.app.engine.position));
    const full = this.span(0);
    const len = Math.min(Math.max(v.len * f, 0.5), Math.max(full.len, this.view ? 0 : full.len) * 1.5);
    const c = atSec ?? (this.app.engine.position >= v.start && this.app.engine.position <= v.start + v.len ? this.app.engine.position : v.start + v.len / 2);
    const k = (c - v.start) / v.len;
    this.view = { start: Math.max(0, c - k * len), len };
    this.key = '';
  }

  xOf(t) { return LABEL_W + ((t - this.vs.start) / this.vs.len) * (this.W - LABEL_W); }
  tOf(x) { return this.vs.start + ((x - LABEL_W) / (this.W - LABEL_W)) * this.vs.len; }

  local(e) {
    const r = this.area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  rowAt(y) { return this.layoutRows?.find((r) => y >= r.y && y < r.y + r.h) || null; }

  /** Bordas que dá para arrastar numa faixa de canal. */
  handles(ch) {
    const p = this.p;
    const out = [];
    if (this.volMode) return out; // no modo Volume o mouse mexe só na linha
    const ext = baseExtent(p, ch);
    if (ext) {
      const s = Math.max(ext.from, ch.trimStart || 0);
      const e = ext.to - Math.max(0, ch.trimEnd || 0);
      if (e > s) out.push({ kind: 'trimStart', t: s }, { kind: 'trimEnd', t: e });
    }
    (ch.punches || []).forEach((x, i) => {
      // um punch-in num trecho duplicado aparece duas vezes (cada uma com as suas bordas)
      for (const [s, e] of mapRanges(x.start, x.end, cutsFor(p, x))) {
        if (e - s >= 0.005) out.push({ kind: 'pStart', t: Math.max(0, s), i }, { kind: 'pEnd', t: e, i });
      }
    });
    return out;
  }

  handleAt(row, x) {
    if (row?.kind !== 'ch') return null;
    let best = null;
    for (const hd of this.handles(row.ch)) {
      const d = Math.abs(this.xOf(hd.t) - x);
      // punch-in ganha da tomada principal quando estão no mesmo lugar
      if (d <= GRAB && (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && hd.kind[0] === 'p'))) best = { ...hd, d };
    }
    return best;
  }

  /** Seção sob o mouse: { sec, part: 'start' | 'end' | 'body' }. */
  sectionAt(x) {
    const bar = barSec(this.p);
    for (const sc of this.p.sections || []) {
      const a = this.xOf(sc.start * bar);
      const b = this.xOf(sc.end * bar);
      if (x < a - 4 || x > b + 4) continue;
      const part = b - a > 16 && Math.abs(x - a) <= 5 ? 'start' : b - a > 16 && Math.abs(x - b) <= 5 ? 'end' : 'body';
      return { sec: sc, part };
    }
    return null;
  }

  /** Frase da letra sob o mouse: { item, part: 'start' | 'end' | 'body' }. */
  lyricAt(x) {
    const spb = 60 / this.p.bpm;
    for (const it of this.p.lyrics || []) {
      const a = this.xOf(it.beat * spb);
      const b = this.xOf(it.end * spb);
      if (x < a - 4 || x > b + 4) continue;
      const part = b - a > 14 && Math.abs(x - a) <= 5 ? 'start' : b - a > 14 && Math.abs(x - b) <= 5 ? 'end' : 'body';
      return { item: it, part };
    }
    return null;
  }

  changeAt(x) {
    const st = layoutSteps(this.p).slice(1);
    let best = null;
    for (const s of st) {
      const d = Math.abs(this.xOf(s.t) - x);
      if (d <= GRAB && (!best || d < best.d)) best = { id: s.id, d };
    }
    return best && this.p.layoutChanges.find((c) => c.id === best.id);
  }

  // ------------------------------------------------------------ mouse

  snap(t, e) {
    if (!e.shiftKey) return Math.max(0, t);
    const spb = 60 / this.p.bpm;
    return Math.max(0, Math.round(t / spb) * spb);
  }

  onDown(e) {
    if (!this.p || e.button !== 0 || !this.vs) return;
    const { x, y } = this.local(e);
    if (x < LABEL_W) {
      const row = this.rowAt(y);
      if (row?.kind === 'ch') this.app.select(row.ch.id);
      return;
    }
    this.area.setPointerCapture(e.pointerId);
    this.area.focus({ preventScroll: true });
    const row = this.rowAt(y);
    const t = this.tOf(x);
    if (this.busy) return;
    if (row?.kind === 'sections') {
      const hit = this.sectionAt(x);
      if (hit) {
        this.drag = { kind: 'sec', ...hit, x0: x, start0: hit.sec.start, end0: hit.sec.end, moved: false };
        if (hit.part !== 'body') this.app.holdHistory(true);
        return;
      }
    }
    if (row?.kind === 'lyrics') {
      const hit = this.lyricAt(x);
      if (hit) {
        this.drag = { kind: 'ly', ...hit, x0: x, t0: this.tOf(x), beat0: hit.item.beat, end0: hit.item.end, moved: false };
        this.app.holdHistory(true);
        return;
      }
    }
    if (row?.kind === 'layout') {
      const c = this.changeAt(x);
      if (c) { this.drag = { kind: 'lc', c, x0: x, moved: false, beat0: c.beat }; this.app.holdHistory(true); return; }
    }
    if (this.mode) {
      const vh = this.volHit(row, x, y);
      if (vh) {
        const tg = this.target(row);
        const L = this.L;
        if (row.kind === 'ch') this.app.select(row.ch.id);
        tg.o[L.key] ||= [];
        const pts = tg.o[L.key];
        let d;
        if (vh.kind === 'pt') d = { kind: 'vpt', tg, row, i: vh.i, x0: x, y0: y, t0: pts[vh.i].t, moved: false };
        else {
          // Pedaço da linha entre os pontos vizinhos (sem ponto nenhum: a linha inteira)
          let a = -1;
          pts.forEach((q, j) => { if (q.t <= vh.t) a = j; });
          const b = a + 1 < pts.length ? a + 1 : -1;
          d = { kind: 'vseg', tg, row, a, b, t: vh.t, x0: x, y0: y, base: pts.map((q) => q[L.f]), v0: this.lineAt(tg, vh.t), moved: false };
        }
        this.drag = d;
        this.lastTarget = tg;
        this.app.holdHistory(true);
        this.showTip(x, y, vh.kind === 'pt' ? pts[vh.i].t : vh.t, vh.kind === 'pt' ? pts[vh.i][L.f] : this.lineAt(tg, vh.t));
        return;
      }
    }
    const hd = this.handleAt(row, x);
    if (hd && this.app.S.transport === 'stopped') {
      const ch = row.ch;
      this.app.select(ch.id);
      const d = { kind: hd.kind, ch, moved: false, x0: x };
      if (hd.kind[0] === 'p') {
        normalizePunches(this.p, ch); // na escala de agora para editar
        const list = ch.punches;
        let best = 0;
        list.forEach((q, j) => {
          const v = hd.kind === 'pStart' ? q.start : q.end;
          const b = hd.kind === 'pStart' ? list[best].start : list[best].end;
          if (Math.abs(v - hd.t) < Math.abs(b - hd.t)) best = j;
        });
        d.i = best;
        d.lim = punchLimits(this.p, ch, best);
      } else {
        d.ext = baseExtent(this.p, ch);
      }
      this.drag = d;
      this.app.holdHistory(true); // o arrasto inteiro vira um passo do Ctrl+Z
      this.showTip(x, y, hd.t);
      return;
    }
    if (row?.kind === 'ch') this.app.select(row.ch.id);
    this.drag = { kind: 'seek', t: Math.max(0, t) };
    this.app.seek(Math.max(0, t));
  }

  onMove(e) {
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      // só o cursor do mouse: mostra quando dá para arrastar
      const row = this.rowAt(y);
      const vh = this.mode && !this.busy ? this.volHit(row, x, y) : null;
      const can = !this.busy && x >= LABEL_W && ((row?.kind === 'layout' && this.changeAt(x)) || (this.app.S.transport === 'stopped' && this.handleAt(row, x)));
      const sc = !this.busy && row?.kind === 'sections' && x >= LABEL_W ? this.sectionAt(x) : null;
      const ly = !this.busy && row?.kind === 'lyrics' && x >= LABEL_W ? this.lyricAt(x) : (sc ? { part: sc.part === 'body' ? 'pick' : sc.part } : null);
      this.area.style.cursor = vh ? (vh.kind === 'pt' ? 'move' : 'ns-resize') : ly ? (ly.part === 'pick' ? 'pointer' : ly.part === 'body' ? 'grab' : 'ew-resize') : can ? 'ew-resize' : '';
      const tip = x >= LABEL_W ? this.describeAt(row, x) : '';
      if (this.area.title !== tip) this.area.title = tip;
      return;
    }
    if (d.kind === 'vpt' || d.kind === 'vseg') { this.moveVol(d, x, y, e); return; }
    const t = this.snap(this.tOf(x), e);
    if (Math.abs(x - d.x0) > 2) d.moved = true;
    if (d.kind === 'seek') {
      d.t = Math.max(0, this.tOf(x));
      this.app.seek(d.t);
      return;
    }
    if (d.kind === 'ly') { this.moveLyric(d, x, y, e); return; }
    if (d.kind === 'sec') { this.moveSection(d, x, y); return; }
    if (d.kind === 'lc') {
      if (!d.moved) return;
      const spb = 60 / this.p.bpm;
      const tt = e.altKey ? Math.max(0, this.tOf(x)) : Math.round(Math.max(0, this.tOf(x)) / spb) * spb;
      d.c.beat = Math.max(spb / 100, tt) / spb;
      this.p.layoutChanges.sort((a, b) => a.beat - b.beat);
      this.showTip(x, y, d.c.beat * spb);
      this.key = '';
      this.app.touch();
      return;
    }
    const ch = d.ch;
    let v;
    if (d.kind === 'trimStart') {
      const end = d.ext.to - Math.max(0, ch.trimEnd || 0);
      v = Math.min(Math.max(t, d.ext.from), end - 0.05);
      this.app.setChannelTiming(ch, { trimStart: v <= d.ext.from + 1e-4 ? 0 : v });
    } else if (d.kind === 'trimEnd') {
      const st = Math.max(d.ext.from, ch.trimStart || 0);
      v = Math.max(Math.min(t, d.ext.to), st + 0.05);
      this.app.setChannelTiming(ch, { trimEnd: Math.max(0, d.ext.to - v) });
    } else {
      const q = ch.punches[d.i];
      if (!q) return;
      if (d.kind === 'pStart') { v = Math.min(Math.max(t, d.lim.min), q.end - 0.05); q.start = v; } else { v = Math.max(Math.min(t, d.lim.max), q.start + 0.05); q.end = v; }
      this.app.setChannelTiming(ch, {});
    }
    this.showTip(x, y, v);
    this.key = '';
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    this.tip.hidden = true;
    this.key = '';
    if (!d) return;
    if (d.kind === 'vseg' && !d.moved && this.L) {
      // Clique simples na linha: cria um ponto ali, no valor que a linha tem
      const L = this.L;
      const pts = d.tg.o[L.key];
      pts.push({ t: Math.max(0, d.t), [L.f]: L.snap(d.v0) });
      pts.sort((a, b) => a.t - b.t);
      this.lineChanged(d.tg);
    }
    if (d.kind !== 'seek' && d.kind !== 'sec') this.app.holdHistory(false);
    if (d.kind === 'lc' && !d.moved) this.editLayoutChange(d.c);
    if (d.kind === 'ly' && !d.moved) this.editLyric(d.item);
    if (d.kind === 'sec' && d.part !== 'body') this.app.holdHistory(false);
    if (d.kind === 'sec' && !d.moved) this.pickSection(d.sec);
    void e;
  }

  cancelDrag() {
    if (this.drag && this.drag.kind !== 'seek' && !(this.drag.kind === 'sec' && this.drag.part === 'body')) this.app.holdHistory(false);
    this.drag = null;
    this.tip.hidden = true;
    this.key = '';
  }

  onDbl(e) {
    if (!this.p || this.busy) return;
    const { x, y } = this.local(e);
    if (this.mode) {
      const row = this.rowAt(y);
      const vh = this.volHit(row, x, y);
      if (vh?.kind === 'pt') {
        const tg = this.target(row);
        tg.o[this.L.key].splice(vh.i, 1);
        this.lineChanged(tg);
        return;
      }
    }
    if (x >= LABEL_W && this.rowAt(y)?.kind === 'sections') {
      const hit = this.sectionAt(x);
      if (hit) this.editSection(hit.sec); else this.addSection(this.tOf(x));
      return;
    }
    if (x >= LABEL_W && this.rowAt(y)?.kind === 'lyrics' && !this.lyricAt(x)) { this.addLyric(this.tOf(x)); return; }
    if (x < LABEL_W || this.rowAt(y)?.kind !== 'layout' || this.changeAt(x)) return;
    this.addLayoutChange(this.tOf(x));
  }

  onWheel(e) {
    if (!this.p || !this.vs) return;
    const { x } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, x >= LABEL_W ? this.tOf(x) : null);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const v = this.span(0);
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) || 0;
      const cur = this.view || v;
      this.view = { start: Math.max(0, cur.start + (dx / Math.max(1, this.W - LABEL_W)) * cur.len), len: cur.len };
      this.key = '';
    }
  }

  moveVol(d, x, y, e) {
    const L = this.L;
    if (!L) return;
    const f = L.f;
    const pts = d.tg.o[L.key];
    const r = d.row;
    if (Math.abs(x - d.x0) > 2 || Math.abs(y - d.y0) > 2) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'vpt') {
      const q = pts[d.i];
      if (!q) return;
      q[f] = this.vOfY(r, y);
      if (!e.shiftKey) {
        // anda no tempo sem passar dos vizinhos
        const lo = d.i > 0 ? pts[d.i - 1].t + 0.001 : 0;
        const hi = d.i + 1 < pts.length ? pts[d.i + 1].t - 0.001 : Infinity;
        q.t = Math.min(hi, Math.max(lo, this.tOf(x)));
      } else q.t = d.t0;
      this.showTip(x, y, q.t, q[f]);
    } else {
      // O pedaço sobe ou desce inteiro: os pontos das duas pontas andam o mesmo tanto
      if (!pts.length) { pts.push({ t: 0, [f]: d.v0 }); d.a = 0; d.b = -1; d.base = [d.v0]; d.all = true; }
      if (!d.anchored && !d.all) {
        // Fora do pedaço a linha fica onde estava: um ponto de apoio logo antes/depois, com rampa curta
        d.anchored = true;
        const R = 0.05;
        if (d.a === 0 && pts[0].t > 0) {
          pts.unshift({ t: Math.max(0, pts[0].t - R), [f]: pts[0][f] });
          d.a += 1;
          if (d.b >= 0) d.b += 1;
        }
        if (d.b >= 0 && d.b === pts.length - 1) pts.push({ t: pts[d.b].t + R, [f]: pts[d.b][f] });
        d.base = pts.map((q) => q[f]);
      }
      // quanto o mouse andou, na escala da linha
      const span = (L.bottom - L.top) / (r.h - 10);
      const delta = (y - d.y0) * span;
      const idx = d.all || (d.a < 0 && d.b < 0) ? pts.map((_, j) => j) : [d.a, d.b].filter((j) => j >= 0);
      for (const j of idx) pts[j][f] = L.snap(Math.min(L.hi, Math.max(L.lo, d.base[j] + delta)));
      this.showTip(x, y, d.t, this.lineAt(d.tg, d.t));
    }
    this.lineChanged(d.tg);
  }

  showTip(x, y, t, val = null) {
    const p = this.p;
    const spb = 60 / p.bpm;
    const bpb = beatsPerBar(p.timeSig);
    const beats = t / spb;
    const bar = Math.floor(beats / bpb) + 1;
    const beat = (beats % bpb) + 1;
    this.tip.textContent = `${val != null && this.L ? `${this.L.fmt(val)} · ` : ''}${fmtTime(t)}.${String(Math.floor((t * 1000) % 100)).padStart(2, '0')} · compasso ${bar}, tempo ${beat.toFixed(2).replace('.', ',')}`;
    this.tip.hidden = false;
    this.tip.style.left = `${Math.min(x + 10, this.W - 230)}px`;
    this.tip.style.top = `${Math.max(0, y - 26)}px`;
  }

  // ------------------------------------------------------------ seções

  /** Clique numa seção: vira o trecho do loop (para ouvir em loop, cortar, punch-in, "Usar em…"). */
  pickSection(sc) {
    this.app.setLoop(sc.start, sc.end, this.p.loop.on);
    this.app.seek(sc.start * barSec(this.p));
    toast(`"${sc.name}" (compassos ${sc.start + 1}–${sc.end}) selecionada: o loop, o ✂, o punch-in e "Usar em…" passam a valer para ela. Duplo clique na seção para duplicar, remover ou renomear.`, 'info', 5000);
  }

  /** Arrastar a ponta de uma seção: encaixa no compasso, sem invadir a vizinha. */
  moveSection(d, x, y) {
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    if (!d.moved || d.part === 'body') return;
    const p = this.p;
    const list = p.sections;
    const i = list.indexOf(d.sec);
    const b = Math.round(Math.max(0, this.tOf(x)) / barSec(p));
    if (d.part === 'start') d.sec.start = Math.min(Math.max(b, i > 0 ? list[i - 1].end : 0), d.sec.end - 1);
    else d.sec.end = Math.max(Math.min(b, i + 1 < list.length ? list[i + 1].start : Infinity), d.sec.start + 1);
    this.showTip(x, y, (d.part === 'start' ? d.sec.start : d.sec.end) * barSec(p));
    this.key = '';
    this.app.touch();
  }

  /** Nova seção: no trecho do loop (se estiver livre) ou a partir do compasso do cursor/clique. */
  addSection(at = null) {
    const p = this.p;
    if (!p || this.busy) return;
    const bar = barSec(p);
    const list = p.sections;
    const free = (a, b) => !list.some((x) => x.start < b && x.end > a);
    let a;
    let b;
    const l = p.loop;
    if (at == null && l.end > l.start && free(l.start, l.end)) { a = l.start; b = l.end; } else {
      a = Math.floor(Math.max(0, at ?? this.app.engine.position) / bar);
      if (!free(a, a + 1)) { toast('Já existe uma seção nesse compasso. Duplo clique nela para editar.', 'info'); return; }
      const next = list.find((x) => x.start > a);
      b = Math.min(a + 4, next ? next.start : Infinity);
    }
    // sugere o próximo nome que faz sentido (Verso, Refrão, Verso, Refrão…)
    const last = [...list].reverse().find((x) => x.end <= a);
    const guess = !list.length ? (a === 0 ? 'Intro' : 'Verso') : last?.name === 'Verso' ? 'Refrão' : 'Verso';
    const sc = { id: uid('sc'), start: a, end: b, name: guess, color: SECTION_COLORS[list.length % SECTION_COLORS.length] };
    list.push(sc);
    list.sort((x, y) => x.start - y.start);
    this.key = '';
    this.app.touch();
    this.editSection(sc, true);
  }

  editSection(sc, isNew = false) {
    const p = this.p;
    const upd = () => { this.key = ''; this.app.touch(); };
    const label = () => `compassos ${sc.start + 1}–${sc.end} (${sc.end - sc.start} compasso${sc.end - sc.start > 1 ? 's' : ''})`;
    const name = h('input', {
      type: 'text', value: sc.name, list: 'mc-section-names', maxlength: 40,
      onInput: (e) => { sc.name = e.target.value.trim() || 'Seção'; upd(); },
    });
    const colors = h('div', { class: 'sec-colors', role: 'group', 'aria-label': 'Cor' },
      SECTION_COLORS.map((c) => h('button', {
        class: `sec-color${sc.color === c ? ' on' : ''}`, style: `background:${c}`, 'aria-label': `Cor ${c}`,
        onClick: (e) => { sc.color = c; colors.querySelectorAll('.sec-color').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); upd(); },
      })));
    const busy = this.app.S.transport !== 'stopped';
    const dlg = openDialog(isNew ? 'Nova seção' : `Seção "${sc.name}"`, [
      h('p', { class: 'muted' }, `${label()}. Para mudar o começo ou o fim, arraste as pontas da seção na faixa Seções.`),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Nome ', name),
        h('datalist', { id: 'mc-section-names' }, SECTION_NAMES.map((n) => h('option', { value: n })))),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Cor'), colors),
      h('div', { class: 'row sec-actions' },
        h('button', { class: 'ghost', onClick: () => { dlg.close(); this.pickSection(sc); } }, 'Selecionar para o loop'),
        h('button', {
          class: 'ghost', disabled: busy, title: 'Copia a seção inteira (gravações, bateria, letra…) logo depois dela',
          onClick: () => { dlg.close(); this.app.duplicateBars(sc.start, sc.end, sc.name); },
        }, 'Duplicar seção'),
        h('button', {
          class: 'ghost danger', disabled: busy, title: 'Tira estes compassos da música inteira (como o ✂)',
          onClick: () => { dlg.close(); this.app.removeBars(sc.start, sc.end); },
        }, 'Remover da música'),
        h('button', {
          class: 'ghost', title: 'Tira só a marcação; a música não muda',
          onClick: () => { p.sections = p.sections.filter((x) => x !== sc); upd(); dlg.close(); },
        }, 'Apagar só a marcação'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'primary', onClick: () => dlg.close() }, 'OK')),
    ]);
    setTimeout(() => { name.focus(); name.select(); }, 50);
  }

  // ------------------------------------------------------------ letra

  /** Arrastar uma frase (corpo) ou uma das pontas. Encaixa no tempo; com Alt fica livre. */
  moveLyric(d, x, y, e) {
    const p = this.p;
    const spb = 60 / p.bpm;
    if (Math.abs(x - d.x0) > 2) d.moved = true;
    if (!d.moved) return;
    const list = p.lyrics;
    const it = d.item;
    const i = list.indexOf(it);
    const prevEnd = i > 0 ? list[i - 1].end : 0;
    const nextStart = i + 1 < list.length ? list[i + 1].beat : Infinity;
    const q = (b) => (e.altKey ? Math.round(b * 100) / 100 : Math.round(b));
    const db = (this.tOf(x) - d.t0) / spb;
    if (d.part === 'body') {
      const len = d.end0 - d.beat0;
      const b = Math.min(Math.max(q(d.beat0 + db), prevEnd), nextStart - len);
      it.beat = Math.max(0, b);
      it.end = it.beat + len;
    } else if (d.part === 'start') {
      it.beat = Math.min(Math.max(q(d.beat0 + db), prevEnd, 0), it.end - 0.25);
    } else {
      it.end = Math.max(Math.min(q(d.end0 + db), nextStart), it.beat + 0.25);
    }
    this.showTip(x, y, (d.part === 'end' ? it.end : it.beat) * spb);
    this.key = '';
    this.app.touch();
  }

  /** Nova frase no ponto (encaixa no tempo), com 1 compasso ou até a próxima frase. */
  addLyric(t) {
    const p = this.p;
    const spb = 60 / p.bpm;
    const bpb = beatsPerBar(p.timeSig);
    const beat = Math.max(0, Math.round(t / spb));
    const next = (p.lyrics || []).find((x) => x.beat >= beat);
    const end = Math.min(beat + bpb, next ? next.beat : Infinity);
    if (end - beat < 0.25) return;
    const text = prompt('Texto desta parte da letra (aparece no vídeo):', '');
    if (!text?.trim()) return;
    p.lyrics.push({ id: uid('ly'), beat, end, text: text.trim() });
    p.lyrics.sort((a, b) => a.beat - b.beat);
    this.key = '';
    this.app.touch();
  }

  editLyric(it) {
    const p = this.p;
    const text = prompt('Texto desta parte da letra (deixe vazio para apagar):', it.text);
    if (text == null) return;
    if (text.trim()) it.text = text.trim();
    else p.lyrics.splice(p.lyrics.indexOf(it), 1);
    this.key = '';
    this.app.touch();
  }

  /** Janela da letra: colar várias linhas de uma vez (cada uma vira uma frase) e o estilo na tela. */
  openLyrics() {
    const p = this.p;
    if (!p) return;
    const spb = 60 / p.bpm;
    const bpb = beatsPerBar(p.timeSig);
    const st = p.lyricStyle;
    const upd = () => { this.key = ''; this.app.touch(); };
    const start = Math.max(0, Math.round(Math.max(0, this.app.engine.position) / spb));
    const area = h('textarea', { rows: 8, placeholder: 'Cole a letra aqui: cada linha vira uma frase na tela.\nUma linha vazia deixa uma pausa sem texto.', style: 'width: 100%' });
    let each = bpb;
    const where = `compasso ${Math.floor(start / bpb) + 1}, tempo ${(start % bpb) + 1}`;
    const dlg = openDialog('Letra na tela', [
      h('p', { class: 'muted' }, `As frases entram a partir do cursor (${where}), uma atrás da outra. Depois dá para ajustar cada uma na faixa Letra: arraste para mover, puxe as pontas para mudar a duração, clique para editar.`),
      area,
      h('div', { class: 'row' },
        select({
          label: 'Cada linha dura', value: each,
          options: [[1, '1 tempo'], [2, '2 tempos'], [bpb, '1 compasso'], [2 * bpb, '2 compassos'], [4 * bpb, '4 compassos']],
          onChange: (v) => { each = +v; },
        }),
        h('button', {
          class: 'primary', onClick: () => {
            const lines = area.value.split(/\r?\n/);
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
            if (!lines.some((l) => l.trim())) { toast('Cole pelo menos uma linha de texto.', 'warn'); return; }
            const end = start + lines.length * each;
            // o que já havia nesse trecho sai, para não sobrepor
            p.lyrics = p.lyrics.filter((x) => x.end <= start || x.beat >= end);
            lines.forEach((l, i) => {
              if (l.trim()) p.lyrics.push({ id: uid('ly'), beat: start + i * each, end: start + (i + 1) * each, text: l.trim() });
            });
            p.lyrics.sort((a, b) => a.beat - b.beat);
            upd();
            toast(`${lines.filter((l) => l.trim()).length} frases colocadas. Ctrl+Z desfaz.`, 'info');
            dlg.close();
          },
        }, 'Colocar as frases')),
      h('fieldset', null, h('legend', null, 'Como aparece no vídeo'),
        h('div', { class: 'row' },
          select({ label: 'Posição', options: Object.entries(LYRIC_POSITIONS), value: st.pos, onChange: (v) => { st.pos = v; upd(); } }),
          h('label', { class: 'field' }, 'Cor ', h('input', { type: 'color', value: st.color, onInput: (e) => { st.color = e.target.value; upd(); } })),
          checkbox({ label: 'Fundo escuro atrás do texto', checked: st.box !== false, onChange: (v) => { st.box = v; upd(); } })),
        slider({ label: 'Tamanho', min: 2, max: 12, step: 0.5, value: st.size, onInput: (v) => { st.size = v; upd(); }, format: (v) => `${String(v).replace('.', ',')}%` })),
      p.lyrics.length ? h('div', { class: 'row' },
        h('span', { class: 'muted' }, `${p.lyrics.length} frase${p.lyrics.length > 1 ? 's' : ''} na música.`),
        h('button', {
          class: 'ghost danger', onClick: () => {
            if (!confirm('Apagar toda a letra? (Ctrl+Z desfaz)')) return;
            p.lyrics = [];
            upd();
            dlg.close();
          },
        }, 'Apagar toda a letra')) : null,
    ].filter(Boolean));
    setTimeout(() => area.focus(), 50);
  }

  // ------------------------------------------------------------ trocas de layout

  addLayoutChange(at = null) {
    const p = this.p;
    if (!p || this.busy) return;
    const spb = 60 / p.bpm;
    const t = at ?? Math.max(0, this.app.engine.position);
    const beat = Math.round(t / spb);
    if (beat < 1) {
      toast('No começo da música vale o layout escolhido lá em cima, em "Layout". Ponha o cursor mais para frente para trocar no meio.', 'info', 7000);
      return;
    }
    const old = p.layoutChanges.find((c) => Math.abs(c.beat - beat) < 1e-6);
    if (old) { this.editLayoutChange(old); return; }
    const st = layoutSteps(p);
    let cur = st[0];
    for (const s of st) if (s.t <= beat * spb) cur = s;
    // Sugere outro layout (o seguinte da lista), para a troca já fazer diferença
    const opts = LAYOUTS[p.channels.length];
    const next = opts[(opts.findIndex((o) => o.id === cur.layout.id) + 1) % opts.length];
    const c = { id: uid('lc'), beat, layoutId: next.id, featured: cur.featured };
    p.layoutChanges.push(c);
    p.layoutChanges.sort((a, b) => a.beat - b.beat);
    this.app.touch(true); // o seletor de cima passa a dizer "Layout no início"
    this.editLayoutChange(c, true);
  }

  editLayoutChange(c, isNew = false) {
    const p = this.p;
    const spb = 60 / p.bpm;
    const bpb = beatsPerBar(p.timeSig);
    const where = () => {
      const b = c.beat;
      const beat = (b % bpb) + 1;
      return `compasso ${Math.floor(b / bpb) + 1}, tempo ${Number.isInteger(Math.round(beat * 100) / 100) ? beat : beat.toFixed(2).replace('.', ',')}`;
    };
    const opts = LAYOUTS[p.channels.length];
    const featBox = h('div');
    const renderFeat = () => {
      const lay = opts.find((o) => o.id === c.layoutId);
      featBox.replaceChildren(usesFeatured(lay) ? select({
        label: 'Destaque', options: p.channels.map((ch, i) => [i, `${i + 1} · ${ch.name}`]), value: c.featured,
        onChange: (v) => { c.featured = +v; this.app.touch(); },
      }) : h('span'));
    };
    renderFeat();
    const dlg = openDialog(isNew ? 'Nova troca de layout' : 'Troca de layout', [
      h('p', { class: 'muted' }, `A partir do ${where()} (${fmtTime(c.beat * spb)}). Os quadros deslizam até o lugar novo. Para mudar o ponto, arraste a marca na faixa Layout.`),
      select({ label: 'Layout', options: opts.map((o) => [o.id, o.label]), value: c.layoutId, onChange: (v) => { c.layoutId = v; renderFeat(); this.app.touch(); } }),
      featBox,
      h('div', { class: 'row' },
        h('button', {
          class: 'ghost', onClick: () => {
            p.layoutChanges = p.layoutChanges.filter((x) => x.id !== c.id);
            this.app.touch(true);
            dlg.close();
          },
        }, 'Apagar esta troca'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'primary', onClick: () => dlg.close() }, 'OK')),
    ]);
    this.app.seek(c.beat * spb); // a prévia mostra o layout novo
  }

  // ------------------------------------------------------------ desenho

  /** Chamado a cada quadro. */
  update(pos, dur) {
    const p = this.p;
    if (!p || !this.open) return;
    this.dur = dur;
    const W = this.area.clientWidth;
    const { rows, H } = this.rows();
    if (this.area.style.height !== `${H}px`) this.area.style.height = `${H}px`;
    if (!W) return;
    // Seguir o cursor tocando, quando o zoom não mostra a música toda
    const S = this.app.S;
    if (this.view && S.transport !== 'stopped' && !this.drag) {
      const v = this.view;
      if (pos > v.start + v.len * 0.95 || pos < v.start) { this.view = { start: Math.max(0, pos - v.len * 0.05), len: v.len }; }
    }
    LABEL_W = W < 520 ? 82 : 112;
    const vs = this.span(Math.max(0, pos));
    const buffers = this.app.engine.buffers;
    const chKey = p.channels.map((ch) => [
      ch.id, ch.name, ch.mute, ch.trimStart, ch.trimEnd, ch.offsetMs, ch.takeId, JSON.stringify(ch.punches), ch.id === S.selectedId, JSON.stringify(ch.volAuto), JSON.stringify(ch.panAuto), ch.pan,
      buffers.get(ch.id)?.length, (ch.punches || []).map((x) => buffers.get(`${ch.id}#${x.takeId}`)?.length).join(','),
    ].join(':')).join('|');
    const key = [W, H, this.mode, JSON.stringify(p.drums?.volAuto), JSON.stringify(p.drums?.panAuto), p.drums?.pan, vs.start, vs.len, dur, p.bpm, p.timeSig, p.loop.on, p.loop.start, p.loop.end, p.cuts.length, chKey,
      JSON.stringify(p.layoutChanges), JSON.stringify(p.lyrics), JSON.stringify(p.sections), p.layoutId, p.featured, p.guide?.offsetMs, buffers.get(GUIDE_ID)?.length,
      JSON.stringify(p.drums?.blocks), S.transport, S.recording?.channelIds?.join()].join('#');
    if (key !== this.key) {
      this.key = key;
      this.W = W;
      this.H = H;
      this.vs = vs;
      this.layoutRows = rows;
      this.draw(rows, W, H);
    }
    // Cursor (fora do desenho principal, que só muda quando algo muda)
    const x = this.xOf(Math.max(0, pos));
    const inView = x >= LABEL_W - 1 && x <= W;
    this.cursor.hidden = !inView;
    if (inView) this.cursor.style.transform = `translateX(${Math.round(x) - 1}px)`;
    this.cursor.classList.toggle('rec', S.transport === 'recording');
  }

  draw(rows, W, H) {
    const p = this.p;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(this.el);
    const C = (n, f) => css.getPropertyValue(n).trim() || f;
    const accent = C('--accent', '#7aa2ff');
    const muted = C('--muted', '#8d96a8');
    const line = C('--line', '#2a3142');
    const text = C('--text', '#e7eaf0');
    const bar = barSec(p);
    const bpb = beatsPerBar(p.timeSig);
    const spb = 60 / p.bpm;
    const vs = this.vs;
    const x0 = LABEL_W;
    const pxPerSec = (W - x0) / vs.len;

    // Fundo das faixas
    for (const r of rows) {
      g.fillStyle = r.kind === 'ruler' ? 'rgba(255,255,255,0.03)' : r.kind === 'ch' && r.ch.id === this.app.S.selectedId ? 'rgba(122,162,255,0.08)' : (r.i ?? 0) % 2 ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.28)';
      g.fillRect(0, r.y, W, r.h);
    }

    // Loop
    const l = p.loop;
    if (l.on && l.end > l.start) {
      const a = this.xOf(l.start * bar);
      const b = this.xOf(l.end * bar);
      g.fillStyle = 'rgba(122,162,255,0.07)';
      g.fillRect(Math.max(x0, a), RULER_H, Math.max(0, b - Math.max(x0, a)), H - RULER_H);
    }

    // Grade: compassos e tempos
    g.save();
    g.beginPath();
    g.rect(x0, 0, W - x0, H);
    g.clip();
    const barPx = bar * pxPerSec;
    let every = 1;
    while (barPx * every < 30) every *= 2;
    const b0 = Math.max(0, Math.floor(vs.start / bar));
    const b1 = Math.ceil((vs.start + vs.len) / bar);
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(this.xOf(b * bar)) + 0.5;
      const lab = b % every === 0;
      g.fillStyle = lab ? 'rgba(141,150,168,0.35)' : 'rgba(141,150,168,0.15)';
      g.fillRect(x - 0.5, lab ? 0 : RULER_H - 5, 1, H);
      if (lab) { g.fillStyle = text; g.fillText(String(b + 1), x + 3, RULER_H / 2 + 0.5); }
      if (spb * pxPerSec >= 8) {
        g.fillStyle = 'rgba(141,150,168,0.10)';
        for (let k = 1; k < bpb; k++) g.fillRect(Math.round(this.xOf(b * bar + k * spb)), RULER_H, 1, H - RULER_H);
      }
    }
    g.restore();

    for (const r of rows) {
      if (r.kind === 'layout') this.drawLayoutLane(g, r, W, accent, text, muted);
      else if (r.kind === 'lyrics') this.drawLyricsLane(g, r, W);
      else if (r.kind === 'sections') this.drawSectionsLane(g, r, W);
      else if (r.kind === 'ch') this.drawChannel(g, r, W, accent);
      else if (r.kind === 'guide') this.drawGuide(g, r, W);
      else if (r.kind === 'drums') {
        this.drawDrums(g, r, W, bar);
        if (this.mode) { g.save(); g.beginPath(); g.rect(LABEL_W, r.y, W - LABEL_W, r.h); g.clip(); this.drawLine(g, r, W, this.target(r)); g.restore(); }
      }
    }

    // Rótulos à esquerda
    g.fillStyle = C('--panel', '#151a24');
    g.fillRect(0, 0, x0, H);
    g.fillStyle = line;
    g.fillRect(x0 - 1, 0, 1, H);
    g.fillRect(0, RULER_H - 0.5, W, 1);
    g.font = '600 11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const r of rows) {
      let label = '';
      if (r.kind === 'layout') label = 'Layout';
      else if (r.kind === 'lyrics') label = 'Letra';
      else if (r.kind === 'sections') label = 'Seções';
      else if (r.kind === 'ch') label = `${r.i + 1} · ${r.ch.name}`;
      else if (r.kind === 'guide') label = 'Guia';
      else if (r.kind === 'drums') label = 'Bateria';
      if (!label) continue;
      const sel = r.kind === 'ch' && r.ch.id === this.app.S.selectedId;
      const rec = r.kind === 'ch' && this.app.S.recording?.channelIds.includes(r.ch.id);
      g.fillStyle = rec ? '#ff3b4a' : sel ? accent : r.kind === 'ch' && r.ch.mute ? muted : text;
      while (label.length > 2 && g.measureText(label).width > x0 - 12) label = label.slice(0, -2) + '…';
      g.fillText(label, 8, r.y + r.h / 2);
      if (r.kind === 'ch' && r.ch.mute) { g.fillStyle = muted; g.font = '10px system-ui, sans-serif'; g.fillText('mudo', x0 - 34, r.y + r.h / 2); g.font = '600 11px system-ui, sans-serif'; }
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, r.y + r.h - 1, W, 1);
    }
  }

  drawLayoutLane(g, r, W, accent, text, muted) {
    const p = this.p;
    const st = layoutSteps(p);
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    st.forEach((s, i) => {
      const a = Math.max(LABEL_W, s.t === -Infinity ? LABEL_W : this.xOf(s.t));
      const b = i + 1 < st.length ? this.xOf(st[i + 1].t) : W;
      if (b <= LABEL_W || a >= W) return;
      g.fillStyle = i % 2 ? 'rgba(232,179,58,0.14)' : 'rgba(232,179,58,0.07)';
      g.fillRect(a, r.y + 2, b - a, r.h - 4);
      let label = s.layout.label + (usesFeatured(s.layout) ? ` · destaque ${s.featured + 1}` : '');
      const room = b - a - 12;
      g.fillStyle = i ? text : muted;
      if (room > 20) {
        while (label.length > 2 && g.measureText(label).width > room) label = label.slice(0, -2) + '…';
        g.fillText(label, a + 7, r.y + r.h / 2);
      }
      if (i > 0) {
        // Marca da troca (arrastável)
        const x = Math.round(this.xOf(s.t));
        g.fillStyle = '#e8b33a';
        g.fillRect(x - 1, r.y, 2, r.h);
        g.beginPath();
        g.moveTo(x - 5, r.y);
        g.lineTo(x + 5, r.y);
        g.lineTo(x, r.y + 6);
        g.fill();
      }
    });
    g.restore();
    void accent;
  }

  drawSectionsLane(g, r, W) {
    const p = this.p;
    const bar = barSec(p);
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    g.font = '600 11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    if (!p.sections?.length) {
      g.font = '11px system-ui, sans-serif';
      g.fillStyle = 'rgba(141,150,168,0.55)';
      g.fillText('duplo clique para marcar uma seção (verso, refrão…) ou use + Seção', LABEL_W + 8, r.y + r.h / 2);
    }
    const l = p.loop;
    for (const sc of p.sections || []) {
      const a = this.xOf(sc.start * bar);
      const b = this.xOf(sc.end * bar);
      if (b < LABEL_W || a > W) continue;
      const sel = l.start === sc.start && l.end === sc.end;
      g.fillStyle = sc.color;
      g.globalAlpha = sel ? 0.95 : 0.6;
      g.fillRect(a + 1, r.y + 2, Math.max(2, b - a - 2), r.h - 4);
      g.globalAlpha = 1;
      if (sel) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(a + 1.5, r.y + 2.5, b - a - 3, r.h - 5); g.lineWidth = 1; }
      let label = sc.name;
      const room = b - a - 10;
      if (room > 12) {
        while (label.length > 2 && g.measureText(label).width > room) label = label.slice(0, -2) + '…';
        g.fillStyle = '#fff';
        g.fillText(label, Math.max(LABEL_W, a) + 5, r.y + r.h / 2);
      }
    }
    g.restore();
  }

  drawLyricsLane(g, r, W) {
    const p = this.p;
    const spb = 60 / p.bpm;
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    if (!p.lyrics?.length) {
      g.fillStyle = 'rgba(141,150,168,0.55)';
      g.fillText('duplo clique para escrever uma frase da letra (ou ✎ Letra… para colar a letra inteira)', LABEL_W + 8, r.y + r.h / 2);
    }
    for (const it of p.lyrics || []) {
      const a = this.xOf(it.beat * spb);
      const b = this.xOf(it.end * spb);
      if (b < LABEL_W || a > W) continue;
      g.fillStyle = 'rgba(190,140,255,0.28)';
      g.fillRect(a + 1, r.y + 2, Math.max(2, b - a - 2), r.h - 4);
      g.fillStyle = '#c9a6ff';
      g.fillRect(a + 1, r.y + 2, 2, r.h - 4);
      g.fillRect(b - 3, r.y + 2, 2, r.h - 4);
      let label = it.text.replace(/\s+/g, ' ');
      const room = b - a - 12;
      if (room > 14) {
        while (label.length > 2 && g.measureText(label).width > room) label = label.slice(0, -2) + '…';
        g.fillStyle = '#efe4ff';
        g.fillText(label, Math.max(LABEL_W, a) + 6, r.y + r.h / 2);
      }
    }
    g.restore();
  }

  drawChannel(g, r, W, accent) {
    const p = this.p;
    const ch = r.ch;
    const buffers = this.app.engine.buffers;
    const mid = r.y + r.h / 2;
    const half = r.h / 2 - 3;
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    const pieces = channelPieces(p, ch);
    const tStart = this.vs.start;
    const tEnd = tStart + this.vs.len;
    const secPx = this.vs.len / (W - LABEL_W);
    for (const pc of pieces) {
      if (pc.to < tStart || pc.from > tEnd) continue;
      const punch = pc.bufId.includes('#');
      const col = punch ? '#f08a4b' : accent;
      const xa = Math.max(LABEL_W, this.xOf(pc.from));
      const xb = Math.min(W, this.xOf(pc.to));
      g.fillStyle = punch ? 'rgba(240,138,75,0.14)' : 'rgba(122,162,255,0.10)';
      g.fillRect(xa, r.y + 1, xb - xa, r.h - 2);
      const buf = buffers.get(pc.bufId);
      g.fillStyle = ch.mute ? 'rgba(141,150,168,0.5)' : col;
      if (!buf) continue;
      const pk = peaksOf(buf);
      for (let x = Math.floor(xa); x < xb; x++) {
        const t0 = this.tOf(x) - pc.tlStart;
        const k0 = Math.max(0, Math.floor(t0 * PEAK_RATE));
        const k1 = Math.min(pk.length, Math.max(k0 + 1, Math.ceil((t0 + secPx) * PEAK_RATE)));
        let m = 0;
        for (let k = k0; k < k1; k++) if (pk[k] > m) m = pk[k];
        const hh = Math.max(0.5, ampH(m) * half);
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
    if (!pieces.length) {
      g.fillStyle = 'rgba(141,150,168,0.6)';
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText(ch.show === 'drums' ? 'mostra a bateria' : 'vazio', LABEL_W + 8, mid);
    }
    // Bordas arrastáveis
    for (const hd of this.handles(ch)) {
      const x = Math.round(this.xOf(hd.t));
      if (x < LABEL_W - 4 || x > W + 4) continue;
      const punch = hd.kind[0] === 'p';
      g.fillStyle = punch ? '#ffc29a' : '#cfdcff';
      g.fillRect(x - 1, r.y + 1, 2, r.h - 2);
      const left = hd.kind === 'trimStart' || hd.kind === 'pStart';
      g.fillRect(left ? x : x - 5, r.y + 1, 5, 4);
      g.fillRect(left ? x : x - 5, r.y + r.h - 5, 5, 4);
    }
    if (this.mode) this.drawLine(g, r, W, { o: ch, id: ch.id });
    g.restore();
  }

  /** Linha (volume ou pan): atravessa a faixa inteira; os pontos são bolinhas. */
  drawLine(g, r, W, tg) {
    const L = this.L;
    const pts = tg.o[L.key] || [];
    g.fillStyle = 'rgba(255,255,255,0.10)'; // referência: 0 dB ou centro
    g.fillRect(LABEL_W, Math.round(this.yOf(r, L.ref)), W - LABEL_W, 1);
    g.font = '9px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.textBaseline = 'top';
    g.fillText(L.topText, W - 34, r.y + 2);
    g.textBaseline = 'bottom';
    g.fillText(L.bottomText, W - 34, r.y + r.h - 1);
    g.strokeStyle = L.color;
    g.lineWidth = 2;
    g.globalAlpha = pts.length ? 1 : 0.6; // sem pontos: a linha mostra o valor do mixer
    g.beginPath();
    g.moveTo(LABEL_W, this.yOf(r, this.lineAt(tg, this.tOf(LABEL_W))));
    for (const q of pts) g.lineTo(this.xOf(q.t), this.yOf(r, q[L.f]));
    g.lineTo(W, this.yOf(r, this.lineAt(tg, this.tOf(W))));
    g.stroke();
    g.globalAlpha = 1;
    for (const q of pts) {
      const x = this.xOf(q.t);
      if (x < LABEL_W - PT_R || x > W + PT_R) continue;
      g.fillStyle = L.color;
      g.beginPath();
      g.arc(x, this.yOf(r, q[L.f]), PT_R, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#1d2a30';
      g.lineWidth = 1;
      g.stroke();
    }
    g.lineWidth = 1;
  }

  drawGuide(g, r, W) {
    const p = this.p;
    const buf = this.app.engine.buffers.get(GUIDE_ID);
    const mid = r.y + r.h / 2;
    const half = r.h / 2 - 3;
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    const secPx = this.vs.len / (W - LABEL_W);
    const pk = buf && peaksOf(buf);
    for (const pc of guidePieces(p)) {
      const xa = Math.max(LABEL_W, this.xOf(pc.from));
      const xb = Math.min(W, this.xOf(pc.to));
      if (xb <= xa) continue;
      g.fillStyle = 'rgba(141,150,168,0.10)';
      g.fillRect(xa, r.y + 1, xb - xa, r.h - 2);
      if (!pk) continue;
      g.fillStyle = p.guide.mute ? 'rgba(141,150,168,0.35)' : 'rgba(180,190,210,0.75)';
      for (let x = Math.floor(xa); x < xb; x++) {
        const t0 = this.tOf(x) - pc.tlStart;
        const k0 = Math.max(0, Math.floor(t0 * PEAK_RATE));
        const k1 = Math.min(pk.length, Math.max(k0 + 1, Math.ceil((t0 + secPx) * PEAK_RATE)));
        let m = 0;
        for (let k = k0; k < k1; k++) if (pk[k] > m) m = pk[k];
        const hh = Math.max(0.5, ampH(m) * half);
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
    g.restore();
  }

  drawDrums(g, r, W, bar) {
    const d = this.p.drums;
    g.save();
    g.beginPath();
    g.rect(LABEL_W, r.y, W - LABEL_W, r.h);
    g.clip();
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const k of d.blocks) {
      const a = this.xOf(k.start * bar);
      const b = this.xOf((k.start + k.bars) * bar);
      if (b < LABEL_W || a > W) continue;
      const pat = d.patterns.find((x) => x.id === k.pattern);
      g.fillStyle = 'rgba(120,200,140,0.22)';
      g.fillRect(a + 1, r.y + 2, b - a - 2, r.h - 4);
      let label = pat?.name || '';
      const room = b - a - 8;
      if (room > 16 && label) {
        while (label.length > 2 && g.measureText(label).width > room) label = label.slice(0, -2) + '…';
        g.fillStyle = '#cfe9d6';
        g.fillText(label, Math.max(LABEL_W, a) + 4, r.y + r.h / 2);
      }
    }
    g.restore();
  }
}
