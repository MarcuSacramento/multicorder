// Proteção de pico do áudio exportado (vídeo MP4/WebM).
//
// O mix sai do OfflineAudioContext em ponto flutuante e pode passar de ±1,0 (limitador do master
// desligado, ou o resto que o compressor deixa escapar). Amostras acima de 1,0 são cortadas pelo
// codificador AAC do Chrome (som rachado) ou gravadas assim pelo AAC em WebAssembly do Firefox:
// o arquivo toca, mas qualquer conversor que passe para 16 bits corta os picos e o áudio estoura.
// Além disso o AAC cria picos entre as amostras. Este limitador, com antecipação e medindo o pico
// entre amostras (sobreamostragem 4×), segura tudo abaixo do teto pedido (−1,5 dBTP na exportação), com folga para a recodificação das plataformas.

const OS = 4; // sobreamostragem para estimar o pico entre amostras
const TAPS = 8; // amostras de cada lado no interpolador

/** Filtros polifásicos (sinc com janela de Hann) para as posições 1/4, 2/4 e 3/4 entre amostras. */
function phases() {
  const out = [];
  for (let ph = 1; ph < OS; ph++) {
    const f = ph / OS;
    const h = new Float32Array(2 * TAPS);
    for (let k = 0; k < 2 * TAPS; k++) {
      const x = k - (TAPS - 1) - f; // distância da amostra n−TAPS+1+k ao ponto n+f
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 0.5));
      h[k] = s * w;
    }
    out.push(h);
  }
  return out;
}
const H = phases();

/** Maior |valor| entre as amostras n e n+1 (incluindo n), estimado por interpolação. */
function peakAround(x, n, len) {
  let m = Math.abs(x[n]);
  for (const h of H) {
    let acc = 0;
    for (let k = 0; k < 2 * TAPS; k++) {
      const i = n - TAPS + 1 + k;
      if (i >= 0 && i < len) acc += h[k] * x[i];
    }
    const a = Math.abs(acc);
    if (a > m) m = a;
  }
  return m;
}

/** Pico verdadeiro (estimado) dos canais, em valor linear. */
export function truePeak(chs) {
  let p = 0;
  for (const x of chs) {
    const len = x.length;
    for (let n = 0; n < len; n++) {
      const a = Math.abs(x[n]);
      if (a > p) p = a;
      // Só vale interpolar onde há sinal forte por perto; o resto não chega no pico.
      if (a > p * 0.5 || (n + 1 < len && Math.abs(x[n + 1]) > p * 0.5)) {
        const t = peakAround(x, n, len);
        if (t > p) p = t;
      }
    }
  }
  return p;
}

/**
 * Limita os canais (Float32Array, alterados no lugar) a `ceilingDb` de pico verdadeiro.
 * Também troca NaN/infinito por silêncio. Devolve números para o aviso da exportação.
 */
export function guardPeaks(chs, sampleRate, { ceilingDb = -1, lookaheadMs = 1.5, releaseMs = 80 } = {}) {
  const len = chs[0].length;
  let bad = 0;
  for (const x of chs) {
    for (let n = 0; n < len; n++) if (!Number.isFinite(x[n])) { x[n] = 0; bad++; }
  }
  const ceil = Math.pow(10, ceilingDb / 20);
  const before = truePeak(chs);
  const res = { peakInDb: 20 * Math.log10(before || 1e-9), peakOutDb: 0, reductionDb: 0, invalid: bad };
  if (before <= ceil) { res.peakOutDb = res.peakInDb; return res; }

  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const g = new Float32Array(len);
  const m = new Float32Array(len);
  // Alguma margem a cada passada: a interpolação é uma estimativa e o ganho muda dentro da janela.
  for (let pass = 0, target = ceil * 0.995; pass < 4; pass++, target *= 0.99) {
    // 1. Ganho necessário em cada amostra (pico verdadeiro dos canais juntos, para não mexer no estéreo).
    let need = false;
    for (let n = 0; n < len; n++) {
      let a = 0;
      for (const x of chs) { const v = Math.abs(x[n]); if (v > a) a = v; }
      if (a > target * 0.5) for (const x of chs) { const v = peakAround(x, n, len); if (v > a) a = v; }
      g[n] = a > target ? target / a : 1;
      if (a > target) need = true;
    }
    if (!need) break;
    // 2. Mínimo numa janela de ±L (fila monotônica): o ganho já está baixo antes do pico chegar.
    const q = new Int32Array(len + 2 * L + 1);
    let qh = 0, qt = 0;
    for (let n = 0; n < len + L; n++) {
      if (n < len) {
        while (qt > qh && g[q[qt - 1]] >= g[n]) qt--;
        q[qt++] = n;
      }
      const c = n - L;
      if (c < 0) continue;
      while (q[qh] < c - L) qh++;
      m[c] = g[q[qh]];
    }
    // 3. Média móvel de ±L sobre o mínimo: rampa suave, e continua ≤ ganho necessário em cada ponto.
    let sum = 0;
    const W = 2 * L + 1;
    for (let n = -L; n <= L; n++) sum += n < 0 ? 1 : m[Math.min(n, len - 1)];
    for (let n = 0; n < len; n++) {
      g[n] = sum / W;
      const add = n + L + 1;
      const drop = n - L;
      sum += (add < len ? m[add] : 1) - (drop >= 0 ? m[drop] : 1);
    }
    // 4. Volta devagar (release) e aplica.
    let r = 1;
    let minG = 1;
    for (let n = 0; n < len; n++) {
      r = Math.min(g[n], r + (1 - r) * rel);
      if (r < minG) minG = r;
      if (r < 1) for (const x of chs) x[n] *= r;
    }
    res.reductionDb += 20 * Math.log10(minG);
  }
  res.peakOutDb = 20 * Math.log10(truePeak(chs) || 1e-9);
  return res;
}
