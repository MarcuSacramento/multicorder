// Geometria da grade (RF-02, RF-03, RF-40). Puro: usado na prévia e no Worker de exportação.

/*
 * Tipos de layout:
 * - rows: `rows` = quantos quadros em cada linha, de cima para baixo (os layouts originais).
 * - cols: `cols` = quantos quadros em cada coluna, da esquerda para a direita.
 * - feat: um canal em destaque (`project.featured`, posição na grade) e os outros numa faixa
 *   embaixo (`side: 'bottom'`) ou à direita (`side: 'right'`).
 * - L: destaque ocupando 2/3 × 2/3 e os outros 5 em volta, em L (só 6 canais).
 * - pip: destaque na tela toda e os outros em miniaturas por cima, no canto de baixo.
 * `family` liga layouts equivalentes entre quantidades de canais (ao mudar de 4 para 5 canais,
 * "coluna única" continua coluna única).
 */
const ROW = (n) => ({ id: 'linha', kind: 'rows', rows: [n], family: 'linha', label: `Linha única (${n} lado a lado)` });
const COL = (n) => ({ id: 'coluna', kind: 'rows', rows: Array(n).fill(1), family: 'coluna', label: `Coluna única (${n} empilhados)` });
const FEAT = [
  { id: 'dest-baixo', kind: 'feat', side: 'bottom', family: 'dest-baixo', label: 'Destaque + outros embaixo' },
  { id: 'dest-lado', kind: 'feat', side: 'right', family: 'dest-lado', label: 'Destaque + outros ao lado' },
  { id: 'pip', kind: 'pip', family: 'pip', label: 'Imagem na imagem (PiP)' },
];
const rows = (id, r, label) => ({ id, kind: 'rows', rows: r, family: id, label });
const cols = (id, c, label) => ({ id, kind: 'cols', cols: c, family: id, label });

/** O primeiro de cada lista é o padrão. Os ids antigos não mudam (projetos salvos continuam iguais). */
export const LAYOUTS = {
  2: [
    { id: '1x2', kind: 'rows', rows: [2], family: 'linha', label: '1×2 (lado a lado)' },
    { id: '2x1', kind: 'rows', rows: [1, 1], family: 'coluna', label: '2×1 (empilhado)' },
    ...FEAT,
  ],
  3: [
    { id: '1x3', kind: 'rows', rows: [3], family: 'linha', label: '1×3' },
    rows('2+1', [2, 1], '2+1'),
    COL(3),
    rows('1+2', [1, 2], '1+2 (1 em cima, 2 embaixo)'),
    cols('1|2', [1, 2], '1 à esquerda, 2 à direita'),
    cols('2|1', [2, 1], '2 à esquerda, 1 à direita'),
    ...FEAT,
  ],
  4: [
    rows('2x2', [2, 2], '2×2'),
    ROW(4), COL(4),
    rows('1+3', [1, 3], '1+3 (1 em cima, 3 embaixo)'),
    rows('3+1', [3, 1], '3+1 (3 em cima, 1 embaixo)'),
    cols('1|3', [1, 3], '1 à esquerda, 3 à direita'),
    ...FEAT,
  ],
  5: [
    rows('3+2', [3, 2], '3+2'),
    rows('2+3', [2, 3], '2+3'),
    rows('1+4', [1, 4], '1+4 (1 em cima, 4 embaixo)'),
    rows('2+1+2', [2, 1, 2], '2+1+2'),
    cols('2|3', [2, 3], '2 à esquerda, 3 à direita'),
    ROW(5), COL(5),
    ...FEAT,
  ],
  6: [
    { id: '2x3', kind: 'rows', rows: [2, 2, 2], family: '2x3', label: '2×3 (2 colunas, 3 linhas)' },
    { id: '3x2', kind: 'rows', rows: [3, 3], family: '3x2', label: '3×2 (3 colunas, 2 linhas)' },
    rows('1+2+3', [1, 2, 3], '1+2+3'),
    rows('2+4', [2, 4], '2+4'),
    ROW(6), COL(6),
    FEAT[0], FEAT[1],
    { id: 'dest-L', kind: 'L', family: 'dest-L', label: 'Destaque + 5 em L' },
    FEAT[2],
  ],
};

/** Layouts que usam um canal em destaque (mostram o seletor "Destaque"). */
export const usesFeatured = (layout) => ['feat', 'L', 'pip'].includes(layout?.kind);

export const ASPECTS = { '9:16': [9, 16], '1:1': [1, 1], '16:9': [16, 9] };

export function layoutOf(project) {
  const opts = LAYOUTS[project.channels.length] || LAYOUTS[2];
  return opts.find((o) => o.id === project.layoutId) || opts[0];
}

/** Layout para `n` canais: o mesmo id, senão um da mesma família, senão o padrão. */
export function pickLayout(n, layoutId) {
  const opts = LAYOUTS[n];
  if (!opts) return layoutId;
  if (opts.some((o) => o.id === layoutId)) return layoutId;
  const fam = Object.values(LAYOUTS).flat().find((o) => o.id === layoutId)?.family;
  return (fam && opts.find((o) => o.family === fam)?.id) || opts[0].id;
}

/**
 * Retângulos dos quadros, um por canal, na ordem dos canais. `z` > 0 = desenhado por cima (PiP).
 * featured = posição do canal em destaque.
 */
export function layoutRects(layout, n, W, H, gap, featured = 0) {
  if (layout.kind === 'rows') return tileRects(layout.rows, W, H, gap);
  if (layout.kind === 'cols') {
    return tileRects(layout.cols, H, W, gap).map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }));
  }
  const f = Math.min(Math.max(0, featured | 0), n - 1);
  const k = n - 1;
  const box = { x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap };
  let big;
  let small;
  if (layout.kind === 'feat') {
    const frac = Math.min(1 / 3, Math.max(0.2, 1 / k)); // tamanho da faixa dos outros
    if (layout.side === 'right') {
      const sw = (box.w - gap) * frac;
      big = { ...box, w: box.w - gap - sw };
      small = split({ x: box.x + big.w + gap, y: box.y, w: sw, h: box.h }, k, 'v', gap);
    } else {
      const sh = (box.h - gap) * frac;
      big = { ...box, h: box.h - gap - sh };
      small = split({ x: box.x, y: box.y + big.h + gap, w: box.w, h: sh }, k, 'h', gap);
    }
  } else if (layout.kind === 'L') {
    // grade 3×3: destaque nas 4 células de cima à esquerda; 2 à direita e 3 embaixo
    const cw = (box.w - 2 * gap) / 3;
    const ch = (box.h - 2 * gap) / 3;
    big = { x: box.x, y: box.y, w: 2 * cw + gap, h: 2 * ch + gap };
    small = [
      { x: box.x + 2 * (cw + gap), y: box.y, w: cw, h: ch },
      { x: box.x + 2 * (cw + gap), y: box.y + ch + gap, w: cw, h: ch },
      ...[0, 1, 2].map((c) => ({ x: box.x + c * (cw + gap), y: box.y + 2 * (ch + gap), w: cw, h: ch })),
    ];
  } else {
    // pip: miniaturas com a proporção do vídeo, enfileiradas no canto de baixo à direita
    big = box;
    const m = Math.max(gap, Math.min(W, H) * 0.03);
    const sc = Math.min(0.26, (box.w - m * (k + 1)) / k / box.w);
    const iw = box.w * sc;
    const ih = box.h * sc;
    const y = box.y + box.h - m - ih;
    small = Array.from({ length: k }, (_, i) => ({ x: box.x + box.w - m - iw - (k - 1 - i) * (iw + m), y, w: iw, h: ih, z: 1 }));
  }
  const out = [];
  let s = 0;
  for (let i = 0; i < n; i++) out.push(i === f ? big : small[s++]);
  return out;
}

/** Duração da animação de uma troca de layout (os quadros deslizam até o lugar novo). */
export const LAYOUT_MORPH = 0.4;

/** Layout de um id para a quantidade de canais do projeto (o mesmo, da mesma família ou o padrão). */
export function layoutById(project, id) {
  const n = project.channels.length;
  const opts = LAYOUTS[n] || LAYOUTS[2];
  const pid = pickLayout(n, id);
  return opts.find((o) => o.id === pid) || opts[0];
}

/**
 * Trocas de layout ao longo da música: project.layoutChanges = [{ id, beat, layoutId, featured }],
 * em ordem. Antes da primeira vale o layout do projeto. Devolve a lista com o instante (s) de cada uma.
 */
export function layoutSteps(project) {
  const spb = 60 / project.bpm;
  const n = project.channels.length;
  const clampF = (f) => Math.min(Math.max(0, f | 0), n - 1);
  const out = [{ t: -Infinity, layout: layoutOf(project), featured: clampF(project.featured) }];
  for (const c of project.layoutChanges || []) {
    out.push({ t: c.beat * spb, layout: layoutById(project, c.layoutId), featured: clampF(c.featured), id: c.id });
  }
  return out;
}

/** Layout e destaque valendo no instante t (s). */
export function layoutAt(project, t) {
  const st = layoutSteps(project);
  let i = 0;
  while (i + 1 < st.length && st[i + 1].t <= t) i++;
  return st[i];
}

/**
 * Retângulos do layout do projeto num quadro W×H, no instante t (s) da música. Logo depois de uma
 * troca de layout, os quadros deslizam do lugar antigo para o novo por LAYOUT_MORPH segundos.
 */
export function projectRects(project, W, H, gap, t = -Infinity) {
  const n = project.channels.length;
  const st = layoutSteps(project);
  let i = 0;
  while (i + 1 < st.length && st[i + 1].t <= t) i++;
  const cur = st[i];
  const to = layoutRects(cur.layout, n, W, H, gap, cur.featured);
  const k = i > 0 ? (t - cur.t) / LAYOUT_MORPH : 1;
  if (k >= 1) return to;
  const prev = st[i - 1];
  const from = layoutRects(prev.layout, n, W, H, gap, prev.featured);
  const e = k * k * (3 - 2 * k); // suave no começo e no fim
  return to.map((r, j) => {
    const a = from[j];
    if (!a || !r) return r;
    const z = Math.max(r.z || 0, a.z || 0);
    return { x: a.x + (r.x - a.x) * e, y: a.y + (r.y - a.y) * e, w: a.w + (r.w - a.w) * e, h: a.h + (r.h - a.h) * e, ...(z ? { z } : {}) };
  });
}

/** Divide uma caixa em `k` partes iguais, na horizontal ('h') ou vertical ('v'), com `gap` entre elas. */
function split(b, k, dir, gap) {
  const out = [];
  if (dir === 'h') {
    const w = (b.w - gap * (k - 1)) / k;
    for (let i = 0; i < k; i++) out.push({ x: b.x + i * (w + gap), y: b.y, w, h: b.h });
  } else {
    const h = (b.h - gap * (k - 1)) / k;
    for (let i = 0; i < k; i++) out.push({ x: b.x, y: b.y + i * (h + gap), w: b.w, h });
  }
  return out;
}

export function tileRects(rows, W, H, gap) {
  const rects = [];
  const nr = rows.length;
  const rh = (H - gap * (nr + 1)) / nr;
  rows.forEach((cols, ri) => {
    const cw = (W - gap * (cols + 1)) / cols;
    for (let c = 0; c < cols; c++) {
      rects.push({ x: gap + c * (cw + gap), y: gap + ri * (rh + gap), w: cw, h: rh });
    }
  });
  return rects;
}

/** Recorte da fonte para preencher o quadro (object-fit: cover) com zoom e posição. */
export function coverRect(srcW, srcH, dstW, dstH, zoom = 1, panX = 0, panY = 0) {
  const scale = Math.max(dstW / srcW, dstH / srcH) * Math.max(1, zoom);
  const sw = dstW / scale;
  const sh = dstH / scale;
  const cx = srcW / 2 + panX * (srcW - sw) / 2;
  const cy = srcH / 2 + panY * (srcH - sh) / 2;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** Tamanho de exportação: res = lado menor (720 ou 1080). */
export function exportSize(aspect, res) {
  const [a, b] = ASPECTS[aspect] || ASPECTS['16:9'];
  const even = (n) => Math.round(n / 2) * 2;
  if (a >= b) return [even(res * a / b), res];
  return [res, even(res * b / a)];
}

/** Quadro sob o ponto (o de cima, quando há sobreposição como no PiP). */
export function hitTest(rects, x, y) {
  let best = -1;
  rects.forEach((r, i) => {
    if (!r || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;
    if (best < 0 || (r.z || 0) >= (rects[best].z || 0)) best = i;
  });
  return best;
}
