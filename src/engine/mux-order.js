// Tempos de decodificação (DTS) para vídeo com quadros B e ordem de escrita no MP4.
//
// O VideoEncoder entrega os quadros na ordem de decodificação, mas só informa o tempo de exibição
// (PTS). Com quadros B o PTS volta para trás (ex.: 0, 66667, 33333…), e o MP4 exige DTS crescente.
// Como os quadros têm intervalo fixo, o k-ésimo quadro recebe DTS = k·intervalo − atraso, com o
// atraso mínimo que garante DTS ≤ PTS (a tabela ctts do empacotador não aceita deslocamento negativo).

/**
 * @param {number[]} pts PTS (µs) na ordem em que o codificador entregou os quadros
 * @param {number} frameUs intervalo entre quadros (µs)
 * @returns {{ dts: number[], delayUs: number }}
 */
export function planDecodeTimes(pts, frameUs) {
  let delayUs = 0;
  for (let k = 0; k < pts.length; k++) delayUs = Math.max(delayUs, k * frameUs - pts[k]);
  delayUs = Math.ceil(delayUs);
  return { dts: pts.map((_, k) => Math.round(k * frameUs) - delayUs), delayUs };
}

/**
 * Junta vídeo e áudio em ordem de DTS (vídeo primeiro no empate), para o arquivo ficar intercalado.
 * O primeiro item é sempre de vídeo quando o atraso > 0, o que o modo 'cross-track-offset'
 * do empacotador precisa para deslocar as duas trilhas igualmente.
 */
export function interleave(video, audio) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < video.length || j < audio.length) {
    if (j >= audio.length || (i < video.length && video[i].dts <= audio[j].dts)) out.push(video[i++]);
    else out.push(audio[j++]);
  }
  return out;
}

/** true se os PTS estiverem fora de ordem (há quadros B). */
export const hasReorder = (pts) => pts.some((t, k) => k > 0 && t < pts[k - 1]);
