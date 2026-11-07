// Codificador AAC-LC em WebAssembly, para navegadores sem AAC no WebCodecs (ex.: Firefox no Windows).
// Usa o codificador AAC nativo do FFmpeg (LGPL-2.1) compilado pelo projeto Mediabunny
// (pacote @mediabunny/aac-encoder, MPL-2.0). Carregado sob demanda do CDN, só quando necessário.

const URL_AAC = 'https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.65.1/dist/modules/build/aac.js/+esm';

let modP = null;

async function loadModule() {
  if (!modP) {
    modP = import(URL_AAC)
      .then((lib) => {
        const create = typeof lib.default === 'function' ? lib.default : lib.default?.default;
        return create();
      })
      .catch((e) => { modP = null; throw e; });
  }
  return modP;
}

/**
 * Cria o codificador. `output(chunk, meta)` recebe EncodedAudioChunk como no AudioEncoder do WebCodecs.
 * O AAC tem atraso de início ("priming"): os primeiros primingFrames de saída são silêncio.
 */
export async function createAacEncoder({ sampleRate, numberOfChannels, bitrate, output }) {
  const M = await loadModule();
  const fn = (name, ret, args) => M.cwrap(name, ret, args);
  const init = fn('init_encoder', 'number', ['number', 'number', 'number']);
  const frameSizeOf = fn('get_encoder_frame_size', 'number', ['number']);
  const extraPtr = fn('get_encoder_extradata', 'number', ['number']);
  const extraSize = fn('get_encoder_extradata_size', 'number', ['number']);
  const inputPtr = fn('get_encode_input_ptr', 'number', ['number', 'number']);
  const sendFrame = fn('send_frame', 'number', ['number', 'number']);
  const receive = fn('receive_packet', 'number', ['number']);
  const flushStart = fn('flush_encoder_start', null, ['number']);
  const dataPtr = fn('get_encoded_data', 'number', ['number']);
  const ptsOf = fn('get_encoded_pts', 'number', ['number']);
  const durOf = fn('get_encoded_duration', 'number', ['number']);
  const close = fn('close_encoder', null, ['number']);

  const ctx = init(numberOfChannels, sampleRate, bitrate);
  if (!ctx) throw new Error('Falha ao iniciar o codificador AAC.');
  const frameSize = frameSizeOf(ctx);
  const ep = extraPtr(ctx);
  const description = M.HEAPU8.slice(ep, ep + extraSize(ctx));
  let meta = { decoderConfig: { codec: 'mp4a.40.2', sampleRate, numberOfChannels, description } };

  const ch = numberOfChannels;
  const frame = new Float32Array(frameSize * ch); // intercalado (L R L R…)
  let filled = 0;
  let nextPts = 0; // em amostras
  let primingFrames = null;

  const drain = () => {
    let size;
    while ((size = receive(ctx)) > 0) {
      const p = dataPtr(ctx);
      const data = M.HEAPU8.slice(p, p + size);
      const pts = Number(ptsOf(ctx));
      if (primingFrames == null) primingFrames = Math.max(0, -pts);
      const dur = durOf(ctx) || frameSize;
      output(new EncodedAudioChunk({
        type: 'key', data,
        // O empacotador não aceita tempo negativo: o priming vira o início da trilha (toca como silêncio).
        timestamp: Math.round(((pts + primingFrames) * 1e6) / sampleRate),
        duration: Math.round((dur * 1e6) / sampleRate),
      }), meta);
      meta = undefined;
    }
    if (size < 0) throw new Error(`Erro no codificador AAC (${size}).`);
  };

  const encodeFrame = () => {
    const bytes = new Uint8Array(frame.buffer);
    const ptr = inputPtr(ctx, bytes.length);
    if (!ptr) throw new Error('Sem memória para o codificador AAC.');
    M.HEAPU8.set(bytes, ptr);
    // pts é int64 no C: o cwrap com 'number' + WASM_BIGINT aceita BigInt
    const r = sendFrame(ctx, BigInt(nextPts));
    if (r < 0) throw new Error(`Erro no codificador AAC (${r}).`);
    nextPts += frameSize;
    filled = 0;
    drain();
  };

  return {
    frameSize,
    get primingFrames() { return primingFrames ?? 1024; },
    /** Recebe canais separados (Float32Array cada), de qualquer tamanho. */
    encode(planes) {
      const n = planes[0].length;
      let i = 0;
      while (i < n) {
        const take = Math.min(frameSize - filled, n - i);
        for (let k = 0; k < take; k++) {
          for (let c = 0; c < ch; c++) frame[(filled + k) * ch + c] = planes[c][i + k];
        }
        filled += take;
        i += take;
        if (filled === frameSize) encodeFrame();
      }
    },
    flush() {
      if (filled > 0) { frame.fill(0, filled * ch); encodeFrame(); }
      flushStart(ctx);
      drain();
      close(ctx);
    },
  };
}
