// Processamento da gravação fora da tela (Worker): tirar estalos, puffs e chiado, silenciar as partes
// sem som e mudar o tom sem mudar a velocidade. Recebe os lados do áudio (Float32Array) e devolve os
// processados; o arquivo gravado nunca muda (o app processa de novo ao abrir o projeto).

// ---------------------------------------------------------------- FFT (radix-2, complexa, no lugar)

const fftCache = new Map();

function fftPlan(n) {
  let p = fftCache.get(n);
  if (p) return p;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  p = { rev, cos, sin };
  fftCache.set(n, p);
  return p;
}

/** FFT no lugar; inverse = true faz a inversa (sem dividir por n). */
function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = fftPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sg = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let st = 0; st < n; st += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sg * sin[k * step];
        const a = st + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };

// ---------------------------------------------------------------- Estalos

/**
 * Estalos: picos que um preditor simples (reta pelos 2 pontos anteriores) não explica, muito acima do
 * erro típico em volta. O trecho marcado (até 4 ms) é refeito por uma curva suave entre os vizinhos.
 */
function declick(x, sr, amount) {
  const n = x.length;
  const e = new Float32Array(n);
  for (let i = 2; i < n; i++) e[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
  // erro típico: média móvel de 10 ms
  const W = Math.max(8, Math.round(sr * 0.01));
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + e[i];
  const k = 22 - 14 * amount; // mais força = mais sensível
  const mark = new Uint8Array(n);
  const pad = Math.max(1, Math.round(sr * 0.0005));
  for (let i = 2; i < n; i++) {
    const a = Math.max(0, i - W);
    const b = Math.min(n, i + W);
    const avg = (cum[b] - cum[a]) / (b - a);
    if (e[i] > k * avg && e[i] > 0.02) for (let j = Math.max(0, i - pad); j <= Math.min(n - 1, i + pad); j++) mark[j] = 1;
  }
  const maxRun = Math.round(sr * 0.004);
  let fixed = 0;
  for (let i = 0; i < n; i++) {
    if (!mark[i]) continue;
    let j = i;
    while (j < n && mark[j]) j++;
    const a = i - 1;
    const b = j;
    if (a >= 1 && b < n - 1 && j - i <= maxRun) {
      // Hermite cúbica entre x[a] e x[b], com as inclinações dos vizinhos
      const y0 = x[a]; const y1 = x[b];
      const m0 = (x[a] - x[a - 1]) * (b - a);
      const m1 = (x[b + 1] - x[b]) * (b - a);
      for (let t = a + 1; t < b; t++) {
        const u = (t - a) / (b - a);
        const u2 = u * u; const u3 = u2 * u;
        x[t] = (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1;
      }
      fixed++;
    }
    i = j;
  }
  return fixed;
}

// ---------------------------------------------------------------- Puffs ("p" e "b" no microfone)

/** Passa-baixas de 2ª ordem (Butterworth), ida e volta (sem atraso de fase). */
function lowpassZero(x, sr, fc) {
  const w = Math.tan((Math.PI * fc) / sr);
  const q = Math.SQRT1_2;
  const n0 = (w * w) / (1 + w / q + w * w);
  const b0 = n0; const b1 = 2 * n0; const b2 = n0;
  const a1 = (2 * (w * w - 1)) / (1 + w / q + w * w);
  const a2 = (1 - w / q + w * w) / (1 + w / q + w * w);
  const run = (src) => {
    const y = new Float32Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < src.length; i++) {
      const v = b0 * src[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = src[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  };
  const f = run(x);
  f.reverse();
  const g = run(f);
  return g.reverse();
}

/**
 * Puff: rajada de grave (abaixo de ~150 Hz) muito mais forte que o resto do som ao mesmo tempo.
 * Só o grave desse instante é abaixado; o resto da voz fica igual.
 */
function deplosive(x, sr, amount) {
  const lp = lowpassZero(x, sr, 150);
  const n = x.length;
  const W = Math.max(16, Math.round(sr * 0.004));
  const ratio = 4 - 2.2 * amount; // grave mais forte que o resto por esse fator = puff
  const rel = Math.exp(-1 / (sr * 0.04));
  let g = 1;
  let hits = 0;
  const gains = new Float32Array(Math.ceil(n / W));
  for (let f = 0; f * W < n; f++) {
    let sl = 0, sh = 0;
    const a = f * W; const b = Math.min(n, a + W);
    for (let i = a; i < b; i++) { const l = lp[i]; const hh = x[i] - l; sl += l * l; sh += hh * hh; }
    const el = Math.sqrt(sl / (b - a));
    const eh = Math.sqrt(sh / (b - a));
    gains[f] = el > 0.03 && el > ratio * eh ? Math.max(0.12, (eh * 1.2) / el) : 1;
    if (gains[f] < 1) hits++;
  }
  for (let f = 0; f < gains.length; f++) {
    const a = f * W; const b = Math.min(n, a + W);
    for (let i = a; i < b; i++) {
      g = gains[f] < g ? gains[f] : 1 - (1 - g) * rel; // abaixa na hora, volta em ~40 ms
      x[i] = x[i] - lp[i] * (1 - g);
    }
  }
  return hits;
}

// ---------------------------------------------------------------- Chiado e ruído de fundo

/**
 * Redução de ruído espectral: aprende o ruído nos 15% mais silenciosos da gravação e tira dele, banda
 * por banda, o quanto a força pede. A volta é suave no tempo para não deixar o "som de água" no fundo.
 */
function denoise(x, sr, amount) {
  const N = 2048; const H = 512;
  const n = x.length;
  const w = hann(N);
  const frames = Math.max(1, Math.ceil((n + N) / H));
  const nb = N / 2 + 1;
  const pow = new Float32Array(frames * nb);
  const energy = new Float64Array(frames);
  const re = new Float64Array(N); const im = new Float64Array(N);
  const start = -N / 2;
  for (let f = 0; f < frames; f++) {
    const o = start + f * H;
    for (let i = 0; i < N; i++) { const j = o + i; re[i] = j >= 0 && j < n ? x[j] * w[i] : 0; im[i] = 0; }
    fft(re, im);
    let e = 0;
    for (let k = 0; k < nb; k++) { const p = re[k] * re[k] + im[k] * im[k]; pow[f * nb + k] = p; e += p; }
    energy[f] = e;
  }
  // perfil do ruído: os quadros mais silenciosos (ignorando silêncio digital)
  const idx = [...energy.keys()].filter((f) => energy[f] > 1e-12).sort((a, b) => energy[a] - energy[b]);
  const take = idx.slice(0, Math.max(4, Math.floor(idx.length * 0.15)));
  const noise = new Float64Array(nb);
  for (const f of take) for (let k = 0; k < nb; k++) noise[k] += pow[f * nb + k];
  for (let k = 0; k < nb; k++) noise[k] /= Math.max(1, take.length);
  const over = 1.2 + 2.3 * amount;
  const floor = Math.pow(10, -(8 + 22 * amount) / 20);
  const out = new Float32Array(n);
  const prev = new Float64Array(nb).fill(1);
  const g = new Float64Array(nb);
  for (let f = 0; f < frames; f++) {
    const o = start + f * H;
    for (let i = 0; i < N; i++) { const j = o + i; re[i] = j >= 0 && j < n ? x[j] * w[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < nb; k++) {
      const p = pow[f * nb + k];
      let v = p > 0 ? Math.sqrt(Math.max(0, 1 - (over * noise[k]) / p)) : 0;
      v = Math.max(floor, v);
      v = Math.max(v, prev[k] * 0.7); // volta devagar: menos "som de água"
      g[k] = v;
    }
    for (let k = 0; k < nb; k++) {
      const s = (g[Math.max(0, k - 1)] + 2 * g[k] + g[Math.min(nb - 1, k + 1)]) / 4; // suaviza entre bandas
      prev[k] = g[k];
      re[k] *= s; im[k] *= s;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      const j = o + i;
      if (j >= 0 && j < n) out[j] += (re[i] / N) * w[i];
    }
  }
  // Hann na análise e na síntese com passo N/4 soma 1,5
  for (let i = 0; i < n; i++) x[i] = out[i] / 1.5;
}

// ---------------------------------------------------------------- Partes sem som

/**
 * Silencia os trechos que ficam abaixo do limiar por mais de `holdMs` (só ruído entre as frases),
 * com rampas de 15 ms e uma folga antes do som voltar, para não cortar o começo das notas.
 */
function stripSilence(chans, sr, thresholdDb, holdMs) {
  const n = chans[0].length;
  const W = Math.max(32, Math.round(sr * 0.01));
  const thr = Math.pow(10, thresholdDb / 20);
  const nf = Math.ceil(n / W);
  const loud = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0; let c = 0;
    for (const x of chans) for (let i = f * W; i < Math.min(n, (f + 1) * W); i++) { s += x[i] * x[i]; c++; }
    loud[f] = Math.sqrt(s / Math.max(1, c)) >= thr ? 1 : 0;
  }
  // folga: 60 ms antes e 120 ms depois do som continuam abertos
  const pre = Math.ceil(0.06 / (W / sr));
  const post = Math.ceil(0.12 / (W / sr));
  const open = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) if (loud[f]) for (let j = Math.max(0, f - pre); j <= Math.min(nf - 1, f + post); j++) open[j] = 1;
  // só fecha trechos longos o bastante
  const hold = Math.ceil(holdMs / 1000 / (W / sr));
  for (let f = 0; f < nf;) {
    if (open[f]) { f++; continue; }
    let j = f;
    while (j < nf && !open[j]) j++;
    if (j - f < hold) for (let q = f; q < j; q++) open[q] = 1;
    f = j;
  }
  const ramp = Math.round(sr * 0.015);
  let g = open[0] ? 1 : 0;
  const step = 1 / ramp;
  let muted = 0;
  for (let i = 0; i < n; i++) {
    const t = open[Math.floor(i / W)] ? 1 : 0;
    g = t > g ? Math.min(1, g + step) : t < g ? Math.max(0, g - step) : g;
    if (g < 1) muted++;
    for (const x of chans) x[i] *= g;
  }
  return muted / sr;
}

// ---------------------------------------------------------------- Mudar o tom

/**
 * Muda o tom em `semis` semitons sem mudar a duração: estica o som no tempo com um vocoder de fase
 * (com trava de fase nos picos, que soa mais natural) e depois reamostra de volta ao tamanho original.
 */
function pitchShift(x, sr, semis) {
  const r = Math.pow(2, semis / 12);
  const N = 2048; const Ha = 512; const Hs = Math.round(Ha * r);
  const n = x.length;
  const w = hann(N);
  const nb = N / 2 + 1;
  const frames = Math.max(1, Math.ceil((n + N) / Ha));
  const outLen = Math.ceil(frames * Hs + N);
  const y = new Float64Array(outLen);
  const re = new Float64Array(N); const im = new Float64Array(N);
  const prevPhase = new Float64Array(nb);
  const synPhase = new Float64Array(nb);
  const mag = new Float64Array(nb);
  const ph = new Float64Array(nb);
  const omega = new Float64Array(nb);
  for (let k = 0; k < nb; k++) omega[k] = (2 * Math.PI * Ha * k) / N;
  const start = -N / 2;
  let first = true;
  for (let f = 0; f < frames; f++) {
    const o = start + f * Ha;
    for (let i = 0; i < N; i++) { const j = o + i; re[i] = j >= 0 && j < n ? x[j] * w[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < nb; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
    // picos (máximos locais) e a fase avançada de cada um
    const peaks = [];
    for (let k = 1; k < nb - 1; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks.push(k);
    if (first) {
      for (let k = 0; k < nb; k++) synPhase[k] = ph[k];
      first = false;
    } else {
      for (const k of peaks) {
        let d = ph[k] - prevPhase[k] - omega[k];
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        synPhase[k] += ((omega[k] + d) * Hs) / Ha;
      }
      // cada banda segue o pico mais perto (trava de fase)
      let pi = 0;
      for (let k = 0; k < nb; k++) {
        while (pi + 1 < peaks.length && Math.abs(peaks[pi + 1] - k) < Math.abs(peaks[pi] - k)) pi++;
        const pk = peaks[pi];
        if (pk == null) { synPhase[k] += omega[k] * Hs / Ha; continue; }
        if (pk !== k) synPhase[k] = synPhase[pk] + (ph[k] - ph[pk]);
      }
    }
    for (let k = 0; k < nb; k++) prevPhase[k] = ph[k];
    for (let k = 0; k < nb; k++) {
      re[k] = mag[k] * Math.cos(synPhase[k]);
      im[k] = mag[k] * Math.sin(synPhase[k]);
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    const so = f * Hs;
    for (let i = 0; i < N; i++) y[so + i] += (re[i] / N) * w[i];
  }
  // soma das janelas na síntese (passo Hs): normaliza amostra a amostra
  const norm = new Float64Array(outLen);
  for (let f = 0; f < frames; f++) for (let i = 0; i < N; i++) norm[f * Hs + i] += w[i] * w[i];
  // o começo do quadro 0 está em −N/2 na entrada: na saída, em −N/2 também
  const out = new Float32Array(n);
  const off = N / 2;
  for (let i = 0; i < n; i++) {
    const pos = off + i * r; // reamostra: lê a versão esticada r vezes mais rápido
    const a = Math.floor(pos);
    const t = pos - a;
    const va = a < outLen ? y[a] / Math.max(1e-3, norm[a]) : 0;
    const vb = a + 1 < outLen ? y[a + 1] / Math.max(1e-3, norm[a + 1]) : 0;
    out[i] = va + (vb - va) * t;
  }
  return out;
}

// ---------------------------------------------------------------- Mensagens

self.onmessage = (e) => {
  const { id, chans, sr, clean } = e.data;
  try {
    const info = {};
    let cs = chans;
    if (clean.declick?.on) info.clicks = cs.reduce((n, x) => n + declick(x, sr, clean.declick.amount ?? 0.5), 0);
    if (clean.deplosive?.on) info.puffs = cs.reduce((n, x) => n + deplosive(x, sr, clean.deplosive.amount ?? 0.5), 0);
    if (clean.denoise?.on) for (const x of cs) denoise(x, sr, clean.denoise.amount ?? 0.5);
    if (clean.strip?.on) info.mutedSec = stripSilence(cs, sr, clean.strip.thresholdDb ?? -45, clean.strip.holdMs ?? 300);
    const semis = (clean.pitch?.semis || 0) + (clean.pitch?.cents || 0) / 100;
    if (Math.abs(semis) > 0.001) cs = cs.map((x) => pitchShift(x, sr, semis));
    self.postMessage({ id, chans: cs, info }, cs.map((x) => x.buffer));
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
