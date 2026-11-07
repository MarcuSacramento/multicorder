// Analisador de frequências do master: painel flutuante (não trava o resto da tela) que mostra, ao
// vivo, quanto de grave, médio e agudo tem o mix. Escala logarítmica de 20 Hz a 20 kHz.
import { h } from '../dom.js';

const F_MIN = 20;
const F_MAX = 20000;
const DB_MIN = -90;
const DB_MAX = -10;
const BANDS = [
  [20, 60, 'Sub'], [60, 250, 'Grave'], [250, 500, 'Médio-grave'], [500, 2000, 'Médio'], [2000, 6000, 'Presença'], [6000, 20000, 'Brilho'],
];

let panel = null;

export function toggleSpectrum(app) {
  if (panel) { panel.close(); return; }
  panel = openPanel(app);
}

function openPanel(app) {
  const canvas = h('canvas', { width: 640, height: 260 });
  const note = h('p', { class: 'muted small' }, 'Toque a música. Linha clara: agora; linha amarela: o máximo dos últimos segundos.');
  const closeBtn = h('button', { class: 'icon small', 'aria-label': 'Fechar', title: 'Fechar', onClick: () => api.close() }, '✕');
  const head = h('div', { class: 'spec-head' }, h('strong', null, '📈 Espectro do master'), h('div', { class: 'spacer' }), closeBtn);
  const el = h('div', { class: 'spectrum-panel', role: 'dialog', 'aria-label': 'Espectro do master' }, head, canvas, note);
  document.body.append(el);
  // arrastar pelo título
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    el.style.left = `${Math.max(0, Math.min(innerWidth - 120, e.clientX - drag.dx))}px`;
    el.style.top = `${Math.max(0, Math.min(innerHeight - 60, e.clientY - drag.dy))}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  head.addEventListener('pointerup', () => { drag = null; });

  const g = canvas.getContext('2d');
  let data = null;
  let smooth = null;
  let peak = null;
  let raf = 0;
  const W = canvas.width;
  const H = canvas.height;
  const xOf = (f) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
  const yOf = (db) => H - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * (H - 18);

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const an = app.engine.graph?.spectrum;
    g.fillStyle = '#0b0d12';
    g.fillRect(0, 0, W, H);
    // faixas com nome
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    BANDS.forEach(([a, b, name], i) => {
      const x0 = xOf(a); const x1 = xOf(b);
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      g.fillRect(x0, 0, x1 - x0, H);
      g.fillStyle = 'rgba(200,210,230,0.7)';
      g.fillText(name, x0 + 4, 3);
    });
    // grade de frequência e dB
    g.fillStyle = 'rgba(141,150,168,0.5)';
    g.textBaseline = 'bottom';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(f)) + 0.5;
      g.fillRect(x, 16, 1, H - 16);
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 2);
    }
    for (let db = -80; db <= DB_MAX; db += 20) {
      const y = Math.round(yOf(db)) + 0.5;
      g.fillStyle = 'rgba(141,150,168,0.25)';
      g.fillRect(0, y, W, 1);
      g.fillStyle = 'rgba(141,150,168,0.6)';
      g.fillText(`${db} dB`, W - 40, y - 1);
    }
    if (!an) return;
    if (!data || data.length !== an.frequencyBinCount) {
      data = new Float32Array(an.frequencyBinCount);
      smooth = new Float32Array(W).fill(DB_MIN);
      peak = new Float32Array(W).fill(DB_MIN);
    }
    an.getFloatFrequencyData(data);
    const sr = an.context.sampleRate;
    const binHz = sr / 2 / data.length;
    // uma coluna por pixel: o maior valor das bandas que caem nela (graves: interpola)
    const cur = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, x / W);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (x + 1) / W);
      const k0 = f0 / binHz;
      const k1 = f1 / binHz;
      let v;
      if (k1 - k0 < 1) {
        const k = Math.floor(k0);
        const t = k0 - k;
        v = (data[k] ?? DB_MIN) * (1 - t) + (data[k + 1] ?? DB_MIN) * t;
      } else {
        v = -Infinity;
        for (let k = Math.floor(k0); k < Math.ceil(k1) && k < data.length; k++) v = Math.max(v, data[k]);
      }
      // compensação de inclinação (+3 dB/oitava a partir de 1 kHz): fica parecido com o que se ouve
      v += 3 * Math.log2(Math.max(f0, 1) / 1000);
      cur[x] = Number.isFinite(v) ? v : DB_MIN;
      smooth[x] = Math.max(cur[x], smooth[x] - 1.2);
      peak[x] = Math.max(smooth[x], peak[x] - 0.08);
    }
    // área do espectro
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#7aa2ff'); grad.addColorStop(0.5, '#2fbf71'); grad.addColorStop(1, '#f08a4b');
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x < W; x++) g.lineTo(x, yOf(smooth[x]));
    g.lineTo(W, H);
    g.closePath();
    g.globalAlpha = 0.35;
    g.fillStyle = grad;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = '#e7eaf0';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x < W; x++) (x ? g.lineTo : g.moveTo).call(g, x, yOf(smooth[x]));
    g.stroke();
    g.strokeStyle = '#ffd54a';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < W; x++) (x ? g.lineTo : g.moveTo).call(g, x, yOf(peak[x]));
    g.stroke();
  };
  raf = requestAnimationFrame(frame);

  const api = {
    close() {
      cancelAnimationFrame(raf);
      el.remove();
      panel = null;
    },
  };
  return api;
}
