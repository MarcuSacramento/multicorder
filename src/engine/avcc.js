// Configuração H.264 do MP4 (caixa avcC, ISO/IEC 14496-15), montada a partir do SPS/PPS do próprio vídeo.
//
// O avcC que o VideoEncoder entrega nem sempre está certo: o do Firefox no Windows vem com o byte de
// cabeçalho do SPS e do PPS repetido (67 67 64…, 68 68 ce…) e com os bits reservados zerados.
// Players de computador se viram com o SPS/PPS repetido dentro dos quadros-chave, mas celulares
// (e o Instagram/TikTok) leem o avcC e recusam o arquivo. Por isso o app remonta o avcC sempre.

/** Separa as unidades NAL de um quadro em formato MP4 (cada uma com tamanho de `lenSize` bytes na frente). */
export function splitNals(data, lenSize = 4) {
  const out = [];
  let p = 0;
  while (p + lenSize <= data.length) {
    let n = 0;
    for (let i = 0; i < lenSize; i++) n = n * 256 + data[p + i];
    p += lenSize;
    if (n <= 0 || p + n > data.length) break;
    out.push(data.subarray(p, p + n));
    p += n;
  }
  return out;
}

/** Lê os conjuntos de parâmetros de um avcC; conserta o byte de cabeçalho repetido. */
export function parseAvcC(desc) {
  const b = desc instanceof Uint8Array ? desc : new Uint8Array(desc.buffer ?? desc, desc.byteOffset ?? 0, desc.byteLength);
  if (b.length < 7 || b[0] !== 1) return null;
  const lenSize = (b[4] & 3) + 1;
  let p = 5;
  const read = (count) => {
    const sets = [];
    for (let i = 0; i < count && p + 2 <= b.length; i++) {
      const n = (b[p] << 8) | b[p + 1];
      p += 2;
      if (p + n > b.length) break;
      sets.push(b.subarray(p, p + n));
      p += n;
    }
    return sets;
  };
  let sps = read(b[5] & 31);
  let pps = p < b.length ? read(b[p++]) : [];
  // Cabeçalho repetido: o 2º byte é de novo um cabeçalho NAL do mesmo tipo.
  const dup = (s, type) => s.length > 2 && (s[0] & 31) === type && s[1] === s[0];
  if (sps.some((s) => dup(s, 7))) {
    sps = sps.map((s) => (dup(s, 7) ? s.subarray(1) : s));
    pps = pps.map((s) => (dup(s, 8) ? s.subarray(1) : s));
  }
  return { lenSize, sps, pps };
}

/** Leitor de bits do SPS (exp-Golomb), sem os bytes de prevenção 00 00 03. */
function spsFormat(sps) {
  const r = [];
  for (let i = 1; i < sps.length; i++) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    r.push(sps[i]);
  }
  let pos = 24; // pula profile_idc, flags e level_idc
  const bit = () => (r[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const ue = () => { let z = 0; while (z < 32 && !bit()) z++; let v = 0; for (let i = 0; i < z; i++) v = v * 2 + bit(); return 2 ** z - 1 + v; };
  ue(); // seq_parameter_set_id
  const chroma = ue();
  if (chroma === 3) bit();
  return { chroma, depthLuma: ue() + 8, depthChroma: ue() + 8 };
}

/** Monta um avcC conforme a especificação (bits reservados em 1 e, nos perfis High, o bloco de croma). */
export function buildAvcC(spsList, ppsList, lenSize = 4) {
  const sps = spsList[0];
  const parts = [Uint8Array.of(1, sps[1], sps[2], sps[3], 0xfc | (lenSize - 1), 0xe0 | spsList.length)];
  for (const s of spsList) parts.push(Uint8Array.of(s.length >> 8, s.length & 255), s);
  parts.push(Uint8Array.of(ppsList.length));
  for (const s of ppsList) parts.push(Uint8Array.of(s.length >> 8, s.length & 255), s);
  if ([100, 110, 122, 144].includes(sps[1])) {
    let f = { chroma: 1, depthLuma: 8, depthChroma: 8 };
    try { f = spsFormat(sps); } catch { /* fica 4:2:0 8 bits */ }
    parts.push(Uint8Array.of(0xfc | (f.chroma & 3), 0xf8 | ((f.depthLuma - 8) & 7), 0xf8 | ((f.depthChroma - 8) & 7), 0));
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/**
 * avcC confiável para o vídeo: usa o SPS/PPS que o codificador pôs no 1º quadro-chave (se houver)
 * e, senão, os do avcC dele (consertados). Devolve null se não achar SPS e PPS.
 */
export function fixAvcDescription(desc, keyframe) {
  const given = desc ? parseAvcC(desc) : null;
  const lenSize = given?.lenSize ?? 4;
  let sps = [];
  let pps = [];
  if (keyframe) {
    for (const n of splitNals(keyframe, lenSize)) {
      const t = n[0] & 31;
      if (t === 7 && !sps.length) sps.push(n);
      else if (t === 8 && !pps.length) pps.push(n);
    }
  }
  if (!sps.length || !pps.length) {
    if (!given?.sps.length || !given.pps.length) return null;
    ({ sps, pps } = given);
  }
  if ((sps[0][0] & 31) !== 7 || (pps[0][0] & 31) !== 8) return null;
  return buildAvcC(sps, pps, lenSize);
}
