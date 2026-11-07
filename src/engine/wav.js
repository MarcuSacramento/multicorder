// RF-52: WAV PCM (padrão 48 kHz, 24 bits).

export function encodeWav(channels, sampleRate, bits = 24) {
  const n = channels[0].length;
  const nc = channels.length;
  const bps = bits / 8;
  const dataLen = n * nc * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * bps, true);
  v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  const bytes = new Uint8Array(buf);
  let o = 44;
  const max = bits === 24 ? 8388607 : 32767;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      let s = channels[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      const x = Math.round(s * max);
      bytes[o++] = x & 255;
      bytes[o++] = (x >> 8) & 255;
      if (bits === 24) bytes[o++] = (x >> 16) & 255;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
