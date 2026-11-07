// Desenha a grade num contexto 2D (canvas da prévia ou OffscreenCanvas da exportação).
// O mesmo código nos dois lados garante que a prévia é igual ao vídeo final.
import { padGlow, PAD_HUE } from './drums.js';
import { coverRect, projectRects } from './layout.js';

/**
 * sources: { [channelId]: { image, width, height } } — image pode ser <video> ou VideoFrame.
 * opts (só prévia): labels, selectedId, recordingId, overlay
 * opts (prévia e exportação): time (s na linha do tempo), drumTL (drumTimeline), flash (Map padId → 0–1),
 *   layoutTime (s; instante que escolhe o layout, padrão = time), wmImage (imagem da marca d'água)
 */
export function drawGrid(g, W, H, project, sources, opts = {}) {
  const grid = project.grid;
  const s = Math.min(W, H) / 1080; // medidas da grade são relativas a 1080 px
  const gap = grid.gap * s;
  const radius = grid.radius * s;
  const bw = grid.borderWidth * s;
  g.fillStyle = grid.bg;
  g.fillRect(0, 0, W, H);
  const rects = projectRects(project, W, H, gap, opts.layoutTime ?? opts.time ?? -Infinity);
  // Quadros com z maior (miniaturas do PiP) por cima dos outros
  const order = project.channels.map((_, i) => i).sort((a, b) => (rects[a]?.z || 0) - (rects[b]?.z || 0));
  for (const i of order) {
    const ch = project.channels[i];
    const r = rects[i];
    if (!r) continue;
    g.save();
    g.beginPath();
    if (radius > 0 && g.roundRect) g.roundRect(r.x, r.y, r.w, r.h, radius);
    else g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    const src = sources[ch.id];
    if (ch.show === 'drums' && project.drums) {
      drawPads(g, r, project, opts, s);
    } else if (src && src.width && src.height) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const c = coverRect(src.width, src.height, r.w, r.h, ch.zoom, ch.panX, ch.panY);
      if (ch.mirror) {
        g.translate(r.x + r.w, r.y);
        g.scale(-1, 1);
        g.drawImage(src.image, c.sx, c.sy, c.sw, c.sh, 0, 0, r.w, r.h);
      } else {
        g.drawImage(src.image, c.sx, c.sy, c.sw, c.sh, r.x, r.y, r.w, r.h);
      }
    } else {
      g.fillStyle = opts.labels ? '#1b2030' : '#111111';
      g.fillRect(r.x, r.y, r.w, r.h);
    }
    g.restore();
    if (bw > 0) {
      g.save();
      g.lineWidth = bw;
      g.strokeStyle = grid.borderColor;
      g.beginPath();
      if (radius > 0 && g.roundRect) g.roundRect(r.x + bw / 2, r.y + bw / 2, r.w - bw, r.h - bw, radius);
      else g.rect(r.x + bw / 2, r.y + bw / 2, r.w - bw, r.h - bw);
      g.stroke();
      g.restore();
    }
    if (opts.labels) drawLabel(g, r, i, ch, project, opts, sources[ch.id] || (ch.show === 'drums' && project.drums));
  }
  drawLyrics(g, W, H, project, opts.layoutTime ?? opts.time ?? -1);
  drawWatermark(g, W, H, project.watermark, opts.wmImage);
  return rects;
}

/** Posições da letra na tela. */
export const LYRIC_POSITIONS = { bottom: 'Embaixo', middle: 'No meio', top: 'Em cima' };

const LYRIC_FADE = 0.12; // s de entrada e saída suave

/** Quebra o texto em linhas que cabem em `maxW` (respeita as quebras de linha do texto). */
function wrapText(g, text, maxW) {
  const out = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${w}` : w;
      if (line && g.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** Letra/legenda do instante t (s), por cima da grade. */
export function drawLyrics(g, W, H, project, t) {
  const list = project.lyrics;
  if (!list?.length || t < 0) return;
  const spb = 60 / project.bpm;
  const cur = list.find((x) => t >= x.beat * spb && t < x.end * spb);
  if (!cur) return;
  const st = project.lyricStyle || {};
  const a = cur.beat * spb;
  const b = cur.end * spb;
  const alpha = Math.max(0, Math.min(1, (t - a) / LYRIC_FADE, (b - t) / LYRIC_FADE));
  if (alpha <= 0) return;
  const S = Math.min(W, H);
  const fs = Math.max(10, (S * Math.min(15, Math.max(2, st.size || 5))) / 100);
  g.save();
  g.globalAlpha = alpha;
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrapText(g, cur.text, W * 0.88);
  const lh = fs * 1.22;
  const blockH = lh * lines.length;
  const m = S * 0.06;
  const cy = st.pos === 'top' ? m + blockH / 2 : st.pos === 'middle' ? H / 2 : H - m - blockH / 2;
  const y0 = cy - blockH / 2 + lh / 2;
  if (st.box !== false) {
    const tw = Math.max(...lines.map((l) => g.measureText(l).width));
    const px = fs * 0.5;
    const py = fs * 0.25;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.beginPath();
    const bx = W / 2 - tw / 2 - px;
    const by = cy - blockH / 2 - py;
    if (g.roundRect) g.roundRect(bx, by, tw + 2 * px, blockH + 2 * py, fs * 0.3); else g.rect(bx, by, tw + 2 * px, blockH + 2 * py);
    g.fill();
  } else {
    g.shadowColor = 'rgba(0,0,0,.85)';
    g.shadowBlur = fs * 0.18;
    g.shadowOffsetY = fs * 0.05;
  }
  g.fillStyle = st.color || '#ffffff';
  lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * lh));
  g.restore();
}

/** Posições da marca d'água: cantos e centro. */
export const WM_POSITIONS = {
  br: 'Canto de baixo à direita', bl: 'Canto de baixo à esquerda', tr: 'Canto de cima à direita', tl: 'Canto de cima à esquerda', c: 'Centro',
};

/**
 * Marca d'água por cima de tudo. wm = { on, kind: 'text'|'image', text, pos, size (% da largura),
 * opacity (0–1) }; img = imagem já carregada (ImageBitmap ou <img>) quando kind = 'image'.
 */
export function drawWatermark(g, W, H, wm, img) {
  if (!wm?.on) return;
  const m = Math.min(W, H) * 0.035;
  const maxW = W * Math.min(90, Math.max(3, wm.size || 20)) / 100;
  let w;
  let h;
  let text = null;
  if (wm.kind === 'image') {
    const iw = img?.width || img?.naturalWidth;
    const ih = img?.height || img?.naturalHeight;
    if (!iw || !ih) return;
    w = maxW;
    h = (w * ih) / iw;
    if (h > H * 0.5) { h = H * 0.5; w = (h * iw) / ih; }
  } else {
    text = String(wm.text || '').trim();
    if (!text) return;
    // A fonte cresce até o texto ocupar a largura escolhida (com limite de altura).
    g.save();
    g.font = '700 100px system-ui, sans-serif';
    const tw = g.measureText(text).width || 1;
    g.restore();
    const fs = Math.min((100 * maxW) / tw, Math.min(W, H) * 0.2);
    w = (tw * fs) / 100;
    h = fs;
    text = { fs, value: text };
  }
  const pos = wm.pos || 'br';
  const x = pos === 'c' ? (W - w) / 2 : pos.endsWith('l') ? m : W - m - w;
  const y = pos === 'c' ? (H - h) / 2 : pos.startsWith('t') ? m : H - m - h;
  g.save();
  g.globalAlpha = Math.min(1, Math.max(0.05, wm.opacity ?? 0.7));
  if (text) {
    g.font = `700 ${text.fs}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = text.fs * 0.12;
    g.shadowOffsetY = text.fs * 0.04;
    g.fillStyle = wm.color || '#ffffff';
    g.fillText(text.value, x, y + text.fs * 0.05);
  } else {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, x, y, w, h);
  }
  g.restore();
}

/** Quadro "pads da bateria": cada pad acende quando toca (mesmas batidas do áudio). */
function drawPads(g, r, project, opts, s) {
  const pads = project.drums.pads;
  const n = pads.length;
  g.fillStyle = '#0b0d12';
  g.fillRect(r.x, r.y, r.w, r.h);
  if (!n) return;
  const pad = Math.max(4, Math.min(r.w, r.h) * 0.06);
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * r.w) / r.h))));
  const rows = Math.ceil(n / cols);
  const gap = Math.max(3, Math.min(r.w, r.h) * 0.025);
  const cw = (r.w - 2 * pad - gap * (cols - 1)) / cols;
  const chh = (r.h - 2 * pad - gap * (rows - 1)) / rows;
  const side = Math.max(4, Math.min(cw, chh));
  // centraliza o bloco de pads (quadrados) no quadro
  const ox = r.x + (r.w - (side * cols + gap * (cols - 1))) / 2;
  const oy = r.y + (r.h - (side * rows + gap * (rows - 1))) / 2;
  const rad = side * 0.12;
  const fs = Math.max(8, side * 0.13);
  pads.forEach((p, i) => {
    const x = ox + (i % cols) * (side + gap);
    const y = oy + Math.floor(i / cols) * (side + gap);
    const hue = PAD_HUE[p.sound] ?? (i * 47) % 360;
    const glow = Math.min(1, Math.max(padGlow(opts.drumTL, p.id, opts.time ?? -1), opts.flash?.get(p.id) || 0));
    g.save();
    if (glow > 0.02) {
      g.shadowColor = `hsla(${hue}, 95%, 60%, ${glow})`;
      g.shadowBlur = side * 0.45 * glow;
    }
    g.fillStyle = `hsl(${hue}, ${45 + 50 * glow}%, ${14 + 50 * glow}%)`;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, side, side, rad); else g.rect(x, y, side, side);
    g.fill();
    g.restore();
    g.lineWidth = Math.max(1, s * 2);
    g.strokeStyle = `hsla(${hue}, 70%, ${35 + 40 * glow}%, 0.9)`;
    g.beginPath();
    if (g.roundRect) g.roundRect(x + 0.5, y + 0.5, side - 1, side - 1, rad); else g.rect(x + 0.5, y + 0.5, side - 1, side - 1);
    g.stroke();
    if (side > 44) {
      g.save();
      g.font = `600 ${fs}px system-ui, sans-serif`;
      g.fillStyle = glow > 0.5 ? 'rgba(10,10,10,.85)' : 'rgba(255,255,255,.7)';
      g.textBaseline = 'bottom';
      let label = p.name;
      while (label.length > 1 && g.measureText(label).width > side - fs) label = label.slice(0, -2) + '…';
      g.fillText(label, x + fs * 0.5, y + side - fs * 0.4);
      g.restore();
    }
  });
}

function drawLabel(g, r, i, ch, project, opts, hasSrc) {
  const fs = Math.max(11, Math.min(18, r.w / 14));
  g.save();
  g.font = `600 ${fs}px system-ui, sans-serif`;
  const text = `${i + 1} · ${ch.name}`;
  const tw = g.measureText(text).width;
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.fillRect(r.x + 6, r.y + 6, tw + 12, fs + 8);
  g.fillStyle = '#fff';
  g.textBaseline = 'top';
  g.fillText(text, r.x + 12, r.y + 10);
  if (!hasSrc) {
    const take = ch.takeId && project.takes[ch.takeId];
    g.fillStyle = 'rgba(255,255,255,.45)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(take ? (take.hasVideo ? 'carregando…' : 'só áudio') : 'vazio', r.x + r.w / 2, r.y + r.h / 2);
  }
  if (opts.recordingId === ch.id || opts.selectedId === ch.id) {
    g.lineWidth = opts.recordingId === ch.id ? 4 : 2;
    g.strokeStyle = opts.recordingId === ch.id ? '#ff3b4a' : '#7aa2ff';
    g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }
  if (opts.clipIds?.includes(ch.id)) {
    // Prévia: a entrada deste canal saturou agora há pouco (a exportação não passa clipIds).
    const t = 'CLIP';
    const w = g.measureText(t).width + 14;
    g.fillStyle = '#ff3b4a';
    g.fillRect(r.x + r.w - w - 6, r.y + 6, w, fs + 8);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(t, r.x + r.w - w / 2 - 6, r.y + 10);
    g.textAlign = 'left';
  }
  if (opts.recordingId === ch.id && opts.overlay) {
    g.fillStyle = 'rgba(0,0,0,.5)';
    g.fillRect(r.x, r.y + r.h / 2 - fs * 1.6, r.w, fs * 3.2);
    g.fillStyle = '#fff';
    g.font = `700 ${fs * 2}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(opts.overlay, r.x + r.w / 2, r.y + r.h / 2);
  }
  g.restore();
}
