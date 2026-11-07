// Barra de tempo com régua de compassos e região de loop.
// Régua (parte de cima, com os números): clique vai para o início do compasso; arrastar define o loop.
// Trilha (parte de baixo): clique ou arraste para mudar a posição.
import { barSec, beatsPerBar } from '../../engine/project.js';
import { fmtTime } from '../../engine/util.js';
import { h } from '../dom.js';

const RULER_H = 15;
const MIN_BARS = 8;

export class Timeline {
  constructor(app) {
    this.app = app;
    this.canvas = h('canvas');
    this.el = h('div', {
      class: 'timeline', tabindex: 0, role: 'slider', 'aria-label': 'Posição (régua de compassos)',
      title: 'Clique para mudar a posição. Arraste sobre os números dos compassos para escolher o loop.',
    }, this.canvas);
    this.g = this.canvas.getContext('2d');
    this.drag = null;
    this.key = '';
    this.ro = new ResizeObserver(() => { this.key = ''; this.draw(this.lastPos ?? 0); });
    this.ro.observe(this.el);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => { this.drag = null; this.key = ''; });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  get disabled() { return this.app.S.transport === 'recording'; }

  /** Comprimento mostrado: música, loop e posição, arredondado para compassos inteiros. */
  span(p, pos) {
    const bar = barSec(p);
    const dur = this.dur ?? 0;
    const end = Math.max(dur, p.loop.end * bar, pos, MIN_BARS * bar);
    return Math.ceil(end / bar - 1e-6) * bar;
  }

  xToSec(e) {
    const r = this.el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return f * this.spanSec;
  }

  onDown(e) {
    if (this.disabled || !this.app.project || e.button !== 0) return;
    const r = this.el.getBoundingClientRect();
    const inRuler = e.clientY - r.top < RULER_H;
    const p = this.app.project;
    const bar = barSec(p);
    const s = this.xToSec(e);
    this.el.setPointerCapture(e.pointerId);
    this.el.focus({ preventScroll: true });
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const boxes = this.noteBoxes || [];
    // Primeiro o rótulo exatamente sob o clique; senão, a linha da bandeira mais próxima (±4 px).
    const note = !inRuler && (boxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 - 1 && y <= b.y1 + 1)
      || boxes.find((b) => Math.abs(x - b.x0) <= 4));
    if (note) {
      this.drag = { kind: 'note', id: note.id };
    } else if (inRuler) {
      const b = Math.floor(s / bar);
      this.drag = { kind: 'loop', anchor: b, a: b, b: b + 1, moved: false };
    } else {
      this.drag = { kind: 'seek', pos: s };
    }
    this.key = '';
    this.draw(this.lastPos ?? 0);
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const s = this.xToSec(e);
    if (d.kind === 'note') return;
    if (d.kind === 'seek') d.pos = s;
    else {
      const b = Math.max(0, Math.floor(s / barSec(this.app.project)));
      if (b !== d.anchor) d.moved = true;
      d.a = Math.min(d.anchor, b);
      d.b = Math.max(d.anchor, b) + 1;
    }
    this.key = '';
    this.draw(this.lastPos ?? 0);
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    this.key = '';
    if (!d) return;
    if (d.kind === 'note') this.app.editNote(d.id);
    else if (d.kind === 'seek') this.app.seek(d.pos);
    else if (d.moved) this.app.setLoop(d.a, d.b, true);
    else this.app.seek(d.anchor * barSec(this.app.project));
  }

  onKey(e) {
    if (this.disabled || !this.app.project) return;
    const p = this.app.project;
    const bar = barSec(p);
    const pos = Math.max(0, this.app.engine.position);
    let to = null;
    // Shift+←/→ anda um tempo (para escolher o ponto de gravar); ← vai para o início do compasso atual
    // (ou do anterior, se já estiver nele); → para o próximo.
    const spb = 60 / p.bpm;
    if (e.shiftKey && e.key === 'ArrowLeft') to = Math.max(0, Math.ceil(pos / spb - 0.02) - 1) * spb;
    else if (e.shiftKey && e.key === 'ArrowRight') to = (Math.floor(pos / spb + 0.02) + 1) * spb;
    else if (e.key === 'ArrowLeft') to = Math.max(0, Math.ceil(pos / bar - 0.02) - 1) * bar;
    else if (e.key === 'ArrowRight') to = (Math.floor(pos / bar + 0.02) + 1) * bar;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = this.dur || 0;
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    this.app.seek(to);
  }

  /** Chamado a cada quadro; só redesenha quando algo visível mudou. */
  draw(pos, dur = this.dur) {
    this.dur = dur;
    this.lastPos = pos;
    const p = this.app.project;
    if (!p) return;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const span = this.span(p, Math.max(0, pos));
    this.spanSec = span;
    const px = (t) => (t / span) * W;
    const key = [W, H, Math.round(px(Math.max(0, pos)) * 2), span, dur, p.bpm, p.timeSig, p.loop.on, p.loop.start, p.loop.end, this.disabled, JSON.stringify(p.notes), JSON.stringify(p.sections)].join('|');
    if (key === this.key && !this.drag) return;
    this.key = key;

    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.el);
    const C = (n, f) => css.getPropertyValue(n).trim() || f;
    const accent = C('--accent', '#7aa2ff');
    const muted = C('--muted', '#8d96a8');
    const line = C('--line', '#2a3142');
    const text = C('--text', '#e7eaf0');
    g.clearRect(0, 0, W, H);

    // Fundo da régua e da trilha
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, RULER_H, W, H - RULER_H);

    // Seções (verso, refrão…): faixa fina embaixo dos números da régua
    for (const sc of p.sections || []) {
      const b = barSec(p);
      g.fillStyle = sc.color;
      g.globalAlpha = 0.85;
      g.fillRect(px(sc.start * b) + 1, RULER_H - 3, px((sc.end - sc.start) * b) - 2, 3);
      g.globalAlpha = 1;
    }

    // Trecho com áudio gravado
    if (dur > 0) {
      g.fillStyle = 'rgba(122,162,255,0.10)';
      g.fillRect(0, RULER_H, px(dur), H - RULER_H);
    }

    // Região de loop (a que está sendo arrastada tem prioridade)
    const bar = barSec(p);
    let loop = null;
    let loopOn = p.loop.on;
    if (this.drag?.kind === 'loop') { loop = { start: this.drag.a * bar, end: this.drag.b * bar }; loopOn = true; }
    else if (p.loop.end > p.loop.start) loop = { start: p.loop.start * bar, end: p.loop.end * bar };
    if (loop) {
      const x0 = px(loop.start);
      const x1 = px(loop.end);
      g.fillStyle = loopOn ? hexA(accent, 0.55) : 'rgba(141,150,168,0.22)';
      g.fillRect(x0, 0, x1 - x0, RULER_H);
      if (loopOn) {
        g.fillStyle = hexA(accent, 0.10);
        g.fillRect(x0, RULER_H, x1 - x0, H - RULER_H);
        g.fillStyle = accent;
        g.fillRect(x0, 0, 1.5, H);
        g.fillRect(x1 - 1.5, 0, 1.5, H);
      }
    }

    // Compassos e batidas
    const bpb = beatsPerBar(p.timeSig);
    const nBars = Math.round(span / bar);
    const barPx = W / nBars;
    const beatPx = barPx / bpb;
    let every = 1;
    while (barPx * every < 26) every *= 2; // não amontoa os números
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let b = 0; b <= nBars; b++) {
      const x = Math.round(b * barPx) + 0.5;
      const labeled = b % every === 0;
      g.fillStyle = labeled ? muted : line;
      g.fillRect(x - 0.5, labeled ? 0 : RULER_H - 5, 1, labeled ? H : 5 + (H - RULER_H));
      if (labeled && b < nBars) {
        g.fillStyle = text;
        g.fillText(String(b + 1), x + 3, RULER_H / 2 + 0.5);
      }
      if (beatPx >= 7 && b < nBars) {
        g.fillStyle = line;
        for (let k = 1; k < bpb; k++) g.fillRect(Math.round(x + k * beatPx) - 0.5, H - 6, 1, 6);
      }
    }
    g.fillStyle = line;
    g.fillRect(0, RULER_H - 0.5, W, 1);

    // Observações: bandeira amarela com o texto na trilha
    const warn = C('--warn', '#e8b33a');
    const spb = 60 / p.bpm;
    this.noteBoxes = [];
    g.font = '10px system-ui, sans-serif';
    let prevEnd = -Infinity;
    let row = 0;
    for (const n of p.notes) {
      const x = Math.round(px(n.beat * spb)) + 0.5;
      if (x > W) continue;
      const maxW = 140;
      let label = n.text;
      while (label.length > 1 && g.measureText(label).width > maxW) label = label.slice(0, -2) + '…';
      const tw = g.measureText(label).width + 8;
      row = x < prevEnd + 2 ? 1 - row : 0; // alterna a altura quando duas notas se encostam
      const y = RULER_H + 2 + row * 12;
      g.fillStyle = warn;
      g.fillRect(x - 0.5, RULER_H, 1.5, H - RULER_H);
      g.fillStyle = hexA(warn, 0.9);
      g.fillRect(x, y, tw, 11);
      g.fillStyle = '#1a1400';
      g.fillText(label, x + 4, y + 6);
      if (row === 0) prevEnd = x + tw;
      this.noteBoxes.push({ id: n.id, x0: x, x1: x + tw, y0: y, y1: y + 11 });
    }

    // Cursor de posição
    const shown = this.drag?.kind === 'seek' ? this.drag.pos : Math.max(0, pos);
    const xp = Math.round(px(shown)) + 0.5;
    g.fillStyle = this.disabled ? '#ff3b4a' : '#ffffff';
    g.fillRect(xp - 1, 0, 2, H);
    g.beginPath();
    g.moveTo(xp - 5, 0);
    g.lineTo(xp + 5, 0);
    g.lineTo(xp, 6);
    g.fill();

    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', String(Math.round(span * 10) / 10));
    this.el.setAttribute('aria-valuenow', String(Math.round(shown * 10) / 10));
    this.el.setAttribute('aria-valuetext', `${fmtTime(shown)}, compasso ${Math.floor(shown / bar) + 1}`);
    this.el.classList.toggle('disabled', this.disabled);
  }
}

/** Posição musical "compasso.tempo" (base 1) de um instante. */
export function barBeat(p, t) {
  const spb = 60 / p.bpm;
  const bpb = beatsPerBar(p.timeSig);
  const beat = Math.floor(Math.max(0, t) / spb + 1e-6);
  return `${Math.floor(beat / bpb) + 1}.${(beat % bpb) + 1}`;
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
