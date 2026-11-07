// Gravação de uma tomada (RF-10, RNF-10, RU-06).
// Áudio: PCM float32 capturado no AudioWorklet, com o quadro exato do relógio do AudioContext.
// Vídeo: MediaRecorder (WebM) só com a trilha de vídeo.
// Os dois são salvos em blocos de 500 ms no OPFS: se a aba fechar, perde-se no máximo ~0,5 s.

/** Amostra neste nível (≈ −0,01 dBFS) ou acima = a entrada saturou. */
export const CLIP_LEVEL = 0.999;

export class TakeRecorder {
  constructor({ engine, store, projectId, takeId, videoStream, mimeType, videoBitrate, onMeta, onDeviceLost, onError }) {
    Object.assign(this, { engine, store, projectId, takeId, videoStream, mimeType, videoBitrate, onMeta, onDeviceLost, onError });
    this.audioIdx = 0;
    this.videoIdx = 0;
    this.pending = [];
    this.frames = 0;
    this.firstFrame = null;
    this.writeChain = Promise.resolve();
    this.lost = () => this.onDeviceLost?.();
    this.tracks = [];
    // Clipes por entrada física: cada trecho seguido de amostras no máximo conta uma vez.
    this.clips = { L: 0, R: 0 };
    this.inClip = [false, false];
  }

  _queue(fn) {
    this.writeChain = this.writeChain.then(fn).catch((e) => this.onError?.(e));
  }

  async start() {
    this.engine.startCapture((m) => this._onAudio(m));
    this.flushTimer = setInterval(() => this._flushAudio(), 500);

    const vt = this.videoStream?.getVideoTracks().filter((t) => t.readyState === 'live') || [];
    if (vt.length && this.mimeType) {
      const ms = new MediaStream(vt);
      const h = vt[0].getSettings().height || 720;
      this.mr = new MediaRecorder(ms, { mimeType: this.mimeType, videoBitsPerSecond: this.videoBitrate || (h >= 1000 ? 8e6 : 5e6) });
      this.mr.ondataavailable = (e) => {
        if (!e.data?.size) return;
        const i = this.videoIdx++;
        this._queue(() => this.store.writeChunk(this.projectId, this.takeId, 'v', i, e.data));
      };
      this.mr.onstart = () => this.onMeta?.({ videoStartCtx: this.engine.now });
      this.mrStopped = new Promise((r) => { this.mr.onstop = r; });
      this.mr.onerror = (e) => this.onError?.(e.error || new Error('Falha no MediaRecorder'));
      this.mr.start(500);
    }

    this.tracks = [...(this.engine.input?.stream.getTracks() || []), ...vt];
    for (const t of this.tracks) t.addEventListener('ended', this.lost);
  }

  _onAudio(m) {
    if (m.type !== 'data') return;
    if (this.firstFrame === null) {
      this.firstFrame = m.frame;
      this.onMeta?.({ firstFrame: m.frame });
    }
    this.pending.push(m.data);
    // Pico da tomada: zero absoluto = a entrada entregou silêncio digital (dispositivo travado).
    if (!this.peak) for (let i = 0; i < m.data.length; i++) if (m.data[i] !== 0) { this.peak = 1; break; }
    this._countClips(m.data);
  }

  _countClips(d) {
    const st = this.inClip;
    for (let i = 0; i < d.length; i++) {
      const k = i & 1;
      const hot = d[i] >= CLIP_LEVEL || d[i] <= -CLIP_LEVEL;
      if (hot && !st[k]) this.clips[k ? 'R' : 'L']++;
      st[k] = hot;
    }
  }

  _flushAudio() {
    if (!this.pending.length) return;
    const total = this.pending.reduce((s, a) => s + a.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const a of this.pending) { out.set(a, o); o += a.length; }
    this.pending = [];
    this.frames += total / 2;
    const i = this.audioIdx++;
    this._queue(() => this.store.writeChunk(this.projectId, this.takeId, 'a', i, out));
  }

  async stop() {
    clearInterval(this.flushTimer);
    for (const t of this.tracks) t.removeEventListener('ended', this.lost);
    await this.engine.stopCapture();
    this._flushAudio();
    if (this.mr && this.mr.state !== 'inactive') {
      try { this.mr.stop(); } catch { /* ok */ }
    }
    if (this.mr) await Promise.race([this.mrStopped, new Promise((r) => setTimeout(r, 2500))]);
    await this.writeChain;
    return { frames: this.frames, firstFrame: this.firstFrame, hasVideo: this.videoIdx > 0, silent: !this.peak, clips: { ...this.clips } };
  }
}
