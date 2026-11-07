// Leitor mínimo de WebM/Matroska: extrai os quadros da trilha de vídeo.
// Tolera tamanhos desconhecidos (MediaRecorder) e arquivos cortados (aba fechada no meio da tomada).

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
};
// Elementos "contêiner": entramos neles em vez de pular.
const MASTER = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.BlockGroup]);

export function demuxWebM(buffer) {
  const u8 = new Uint8Array(buffer);
  const len = u8.length;
  let pos = 0;

  const readId = () => {
    const b = u8[pos];
    let n = 1;
    if (b & 0x80) n = 1; else if (b & 0x40) n = 2; else if (b & 0x20) n = 3; else if (b & 0x10) n = 4; else return null;
    if (pos + n > len) return null;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8[pos + i];
    pos += n;
    return v;
  };
  const readVint = () => {
    const b = u8[pos];
    let n = 1;
    while (n <= 8 && !(b & (0x80 >> (n - 1)))) n++;
    if (n > 8 || pos + n > len) return null;
    let v = b & (0xff >> n);
    let allOnes = v === (0xff >> n);
    for (let i = 1; i < n; i++) {
      v = v * 256 + u8[pos + i];
      if (u8[pos + i] !== 0xff) allOnes = false;
    }
    pos += n;
    return allOnes ? -1 : v; // -1 = tamanho desconhecido
  };
  const uint = (start, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + u8[start + i]; return v; };
  const str = (start, size) => new TextDecoder().decode(u8.subarray(start, start + size)).replace(/\0+$/, '');

  let scale = 1e6; // ns por unidade de timecode
  let clusterTc = 0;
  const tracks = [];
  let track = null;
  const blocks = [];

  const parseBlock = (start, size, simple) => {
    const save = pos;
    pos = start;
    const tn = readVint();
    if (tn == null || pos + 3 > start + size) { pos = save; return; }
    const rel = (u8[pos] << 24 >> 16) | u8[pos + 1]; // int16 com sinal
    const flags = u8[pos + 2];
    pos += 3;
    const lacing = (flags >> 1) & 3;
    if (lacing === 0) {
      blocks.push({
        track: tn,
        tc: clusterTc + rel,
        key: simple ? !!(flags & 0x80) : null,
        data: u8.subarray(pos, start + size),
      });
    }
    pos = save;
  };

  while (pos < len) {
    const id = readId();
    if (id == null) break;
    const size = readVint();
    if (size == null) break;
    if (MASTER.has(id)) {
      if (id === ID.TrackEntry) { track = {}; tracks.push(track); }
      continue; // desce no contêiner
    }
    if (size < 0) break;
    const start = pos;
    if (start + size > len) break; // final truncado
    switch (id) {
      case ID.TimecodeScale: scale = uint(start, size); break;
      case ID.Timecode: clusterTc = uint(start, size); break;
      case ID.TrackNumber: if (track) track.number = uint(start, size); break;
      case ID.TrackType: if (track) track.type = uint(start, size); break;
      case ID.CodecID: if (track) track.codec = str(start, size); break;
      case ID.CodecPrivate: if (track) track.priv = u8.slice(start, start + size); break;
      case ID.PixelWidth: if (track) track.width = uint(start, size); break;
      case ID.PixelHeight: if (track) track.height = uint(start, size); break;
      case ID.SimpleBlock: parseBlock(start, size, true); break;
      case ID.Block: parseBlock(start, size, false); break;
      default: break;
    }
    pos = start + size;
  }

  const video = tracks.find((t) => t.type === 1) || tracks.find((t) => /^V_/.test(t.codec || ''));
  if (!video) return null;
  const vb = blocks.filter((b) => b.track === video.number);
  if (!vb.length) return null;
  const t0 = vb[0].tc;
  const frames = vb.map((b, i) => ({
    timestamp: Math.round(((b.tc - t0) * scale) / 1000), // µs, começa em 0
    key: b.key ?? i === 0,
    data: b.data,
  }));
  return { codec: webcodecsCodec(video.codec), rawCodec: video.codec, width: video.width, height: video.height, description: video.priv, frames };
}

function webcodecsCodec(c) {
  switch (c) {
    case 'V_VP8': return 'vp8';
    case 'V_VP9': return 'vp09.00.10.08';
    case 'V_AV1': return 'av01.0.04M.08';
    case 'V_MPEG4/ISO/AVC': return 'avc1.42e01f';
    default: return null;
  }
}
