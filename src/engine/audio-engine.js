// Motor de áudio ao vivo: AudioContext, mixer, transporte, metrônomo, entrada, monitoração e captura.
import { MixGraph } from './mix-graph.js';
import { beatsPerBar } from './project.js';
import { dbToGain } from './util.js';

export const PROCESSORS_URL = new URL('./worklets/processors.js', import.meta.url).href;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.graph = null;
    this.project = null;
    this.buffers = new Map();
    this.playing = false;
    this.atCtx = 0;
    this.fromPos = 0;
    this.stopPos = 0;
    this.metroTimer = null;
    this.clicks = new Set();
    this.input = null;
    this.monitor = { on: false, mode: 'L', gainDb: 0 };
    this.captureCb = null;
    this.workletOk = false;
  }

  /** RNF-07: pede 48 kHz. Sem `sampleRate` usa a taxa padrão do sistema. */
  async init({ sampleRate } = {}) {
    await this.close();
    const opts = { latencyHint: 'interactive' };
    if (sampleRate) opts.sampleRate = sampleRate;
    this.ctx = new AudioContext(opts);
    try {
      await this.ctx.audioWorklet.addModule(PROCESSORS_URL);
      this.workletOk = true;
    } catch (e) {
      console.warn('AudioWorklet indisponível', e);
      this.workletOk = false;
    }
    this.graph = new MixGraph(this.ctx, this.ctx.destination, { gate: this.workletOk });
    this.metroGain = this.ctx.createGain();
    this.metroGain.connect(this.ctx.destination);
    this.calGain = this.ctx.createGain();
    this.calGain.connect(this.ctx.destination);
    if (this.project) this.sync(this.project, true);
  }

  async close() {
    if (!this.ctx) return;
    this.stop();
    this.closeInput();
    try { await this.ctx.close(); } catch { /* ok */ }
    this.ctx = null;
  }

  get now() { return this.ctx.currentTime; }
  get sampleRate() { return this.ctx.sampleRate; }

  /** Liga o áudio. Com a saída do sistema travada, resume() pode nunca terminar: desiste após `ms`. */
  async resume(ms = 2500) {
    if (!this.ctx || this.ctx.state === 'running') return;
    let timer;
    await Promise.race([
      this.ctx.resume().catch(() => {}),
      new Promise((r) => { timer = setTimeout(r, ms); }),
    ]);
    clearTimeout(timer);
  }

  /** O relógio de áudio anda? Parado = a saída de áudio do sistema não está entregando som. */
  async clockAlive(ms = 300) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const t0 = this.ctx.currentTime;
    await new Promise((r) => setTimeout(r, ms));
    return this.ctx.currentTime > t0;
  }

  latency() {
    return {
      baseMs: (this.ctx.baseLatency || 0) * 1000,
      outputMs: (this.ctx.outputLatency || 0) * 1000,
    };
  }

  canSetSink() { return !!this.ctx && typeof this.ctx.setSinkId === 'function'; }
  async setSink(id) { if (this.canSetSink()) await this.ctx.setSinkId(id || ''); }

  sync(project, immediate = false) {
    this.project = project;
    this.graph.sync(project, immediate);
    this.metroGain.gain.setTargetAtTime(project.metronome.volume, this.now, 0.01);
    this.applyMonitor();
  }

  setBuffer(id, buf) {
    if (buf) this.buffers.set(id, buf);
    else this.buffers.delete(id);
  }

  // ---------- Transporte ----------

  /**
   * Toca a partir de `fromPos` (linha do tempo) no instante `at` do contexto.
   * `countInFrom`: instante a partir do qual a contagem regressiva soa (gravação).
   */
  /**
   * `loop` = { start, end } em segundos: ao chegar em `end` volta para `start` sem emenda.
   * Cada volta é um "segmento" agendado ~0,6 s antes, sempre pelo relógio do AudioContext.
   */
  /**
   * Punch-in: `countInUntil` = até quando o clique soa mesmo com o metrônomo desligado (o pré-roll);
   * `cutAt` (Map canal → posição) faz a tomada antiga do canal parar onde a nova começa.
   */
  play(fromPos = 0, { at = null, exclude = [], countInFrom = null, countInUntil = null, loop = null, cutAt = null } = {}) {
    this.stop();
    at = at ?? this.now + 0.08;
    if (loop && !(loop.end - loop.start >= 0.05)) loop = null;
    if (loop && fromPos >= loop.end - 0.01) fromPos = loop.start;
    this.atCtx = at;
    this.fromPos = fromPos;
    this.playing = true;
    this.loop = loop;
    this.exclude = new Set(exclude);
    this.cutAt = cutAt;
    this.segments = [];
    this._addSegment(at, fromPos, loop ? loop.end : Infinity);
    this._startScheduler(countInFrom ?? at, countInFrom != null ? (countInUntil ?? at) : null);
    return at;
  }

  _addSegment(at, from, to) {
    this.segments.push({ at, from, to });
    if (this.segments.length > 8) {
      this.segments.splice(0, this.segments.length - 8);
      this.mSeg = Math.max(0, (this.mSeg ?? 0) - 1); // mantém o índice do metrônomo válido
    }
    // No loop a rampa é de 1 ms: evita estalo na emenda sem amaciar um ataque no tempo 1.
    this.graph.schedule(this.project, this.buffers, at, from, { exclude: this.exclude, toPos: to, fade: this.loop ? 0.001 : 0.004, cutAt: this.cutAt });
  }

  /** Posição atual na linha do tempo (negativa durante a contagem regressiva). */
  get position() {
    if (!this.playing) return this.stopPos;
    const now = this.now;
    const segs = this.segments;
    let s = segs[0];
    for (const x of segs) if (x.at <= now) s = x;
    return s.from + (now - s.at);
  }

  /**
   * Troca o áudio de uma fonte (ex.: bateria recém-editada) sem parar a música: a fonte antiga sai
   * com rampa curta e a nova entra no mesmo ponto, em todos os segmentos (voltas do loop) já agendados.
   */
  refreshSource(id) {
    if (!this.playing) return;
    const at = this.now + 0.05;
    this.graph.stopSource(id, at);
    for (const s of this.segments) {
      const end = s.at + (s.to - s.from);
      if (end <= at + 0.01) continue;
      const start = Math.max(at, s.at);
      this.graph.schedule(this.project, this.buffers, start, s.from + (start - s.at), {
        exclude: this.exclude, toPos: s.to, only: id, fade: start > at ? (this.loop ? 0.001 : 0.004) : 0.005, cutAt: this.cutAt,
      });
    }
  }

  /** Linha de volume ou pan mudou tocando: reagenda só as rampas (o som não reinicia). id = strip. */
  refreshAuto(o, id = o.id) {
    if (!this.playing || !this.graph) return;
    const at = this.now + 0.03;
    for (const s of this.segments) {
      const end = s.at + (s.to - s.from);
      if (end <= at + 0.01) continue;
      const start = Math.max(at, s.at);
      this.graph.scheduleAuto(o, id, start, s.from + (start - s.at), s.to);
    }
  }

  stop() {
    if (this.graph) this.graph.stop();
    if (this.playing) this.stopPos = Math.max(0, this.position);
    this.playing = false;
    clearInterval(this.metroTimer);
    this.metroTimer = null;
    for (const o of this.clicks) { try { o.stop(); } catch { /* ok */ } }
    this.clicks.clear();
  }

  seek(pos) { this.stopPos = Math.max(0, pos); }

  // RF-12: metrônomo só na saída (nunca entra no grafo de mixagem nem na exportação).
  _startScheduler(fromCtx, countInEnd) {
    const p = this.project;
    const spb = 60 / p.bpm;
    const bpb = beatsPerBar(p.timeSig);
    const first = this.segments[0];
    this.mSeg = 0;
    // Batida k fica na posição k·spb da linha do tempo; negativa = contagem regressiva.
    this.mK = Math.ceil((first.from + (fromCtx - first.at)) / spb - 1e-6);
    const tick = () => {
      const now = this.now;
      // Próxima volta do loop.
      if (this.loop) {
        const last = this.segments[this.segments.length - 1];
        const endCtx = last.at + (last.to - last.from);
        if (endCtx - now < 0.6) this._addSegment(endCtx, this.loop.start, this.loop.end);
      }
      const horizon = now + 0.15;
      for (;;) {
        const s = this.segments[this.mSeg];
        const pos = this.mK * spb;
        if (pos >= s.to - 1e-6) {
          if (this.mSeg + 1 >= this.segments.length) break;
          this.mSeg++;
          this.mK = Math.ceil(this.segments[this.mSeg].from / spb - 1e-6);
          continue;
        }
        const t = s.at + (pos - s.from);
        if (t > horizon) break;
        const inCountIn = countInEnd != null && t < countInEnd - 1e-6;
        if ((inCountIn || this.project.metronome.on) && t >= now - 0.005) {
          this._click(t, ((this.mK % bpb) + bpb) % bpb === 0);
        }
        this.mK++;
      }
    };
    tick();
    this.metroTimer = setInterval(tick, 25); // o timer só alimenta a fila; o tempo vem do AudioContext
  }

  _click(t, accent) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 1 : 0.6, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.metroGain);
    o.start(t);
    o.stop(t + 0.06);
    this.clicks.add(o);
    o.onended = () => { this.clicks.delete(o); try { g.disconnect(); } catch { /* ok */ } };
  }

  // ---------- Entrada ----------

  /** Pode lançar NotSupportedError no Firefox se a taxa do dispositivo ≠ taxa do contexto. */
  openInput(stream) {
    this.closeInput();
    const c = this.ctx;
    const src = c.createMediaStreamSource(stream);
    const split = c.createChannelSplitter(2);
    src.connect(split);
    const anL = c.createAnalyser();
    const anR = c.createAnalyser();
    anL.fftSize = anR.fftSize = 1024;
    split.connect(anL, 0);
    split.connect(anR, 1);
    let rec = null;
    const sink = c.createGain();
    sink.gain.value = 0;
    if (this.workletOk) {
      rec = new AudioWorkletNode(c, 'recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      src.connect(rec);
      rec.connect(sink).connect(c.destination); // mantém o nó sendo processado
      rec.port.onmessage = (e) => this.captureCb?.(e.data);
    }
    // Afinador: janela de 4096 amostras (~85 ms) para pegar notas graves (baixo, mi grave).
    const anT = c.createAnalyser();
    anT.fftSize = 4096;
    const monSel = c.createGain();
    const monGain = c.createGain();
    monGain.gain.value = 0;
    monSel.connect(monGain).connect(c.destination);
    this.input = {
      stream, src, split, anL, anR, anT, rec, sink, monSel, monGain, wired: null, tunerWired: null,
      bufL: new Float32Array(1024), bufR: new Float32Array(1024), bufT: new Float32Array(4096),
    };
    this.applyMonitor();
  }

  closeInput() {
    const i = this.input;
    if (!i) return;
    try { i.rec?.port.postMessage({ cmd: 'stop' }); } catch { /* ok */ }
    for (const n of [i.src, i.split, i.rec, i.sink, i.monSel, i.monGain, i.anT]) {
      try { n?.disconnect(); } catch { /* ok */ }
    }
    this.input = null;
  }

  get inputOpen() { return !!this.input; }

  /** RF-15: monitoração da própria entrada (com o modo L/R/estéreo e o ganho do canal). */
  setMonitor(m) {
    this.monitor = { ...this.monitor, ...m };
    this.applyMonitor();
  }

  applyMonitor() {
    const i = this.input;
    if (!i || !this.ctx) return;
    const m = this.monitor;
    if (i.wired !== m.mode) {
      try { i.split.disconnect(i.monSel); } catch { /* ok */ }
      try { i.src.disconnect(i.monSel); } catch { /* ok */ }
      if (m.mode === 'L') i.split.connect(i.monSel, 0);
      else if (m.mode === 'R') i.split.connect(i.monSel, 1);
      else i.src.connect(i.monSel);
      i.wired = m.mode;
    }
    i.monGain.gain.setTargetAtTime(m.on ? dbToGain(m.gainDb) : 0, this.now, 0.01);
  }

  /** Amostras recentes da entrada para o afinador ('L', 'R' ou 'stereo' = soma das duas). */
  tunerSamples(mode = 'L') {
    const i = this.input;
    if (!i) return null;
    if (i.tunerWired !== mode) {
      try { i.split.disconnect(i.anT); } catch { /* ok */ }
      try { i.src.disconnect(i.anT); } catch { /* ok */ }
      if (mode === 'R') i.split.connect(i.anT, 1);
      else if (mode === 'stereo') i.src.connect(i.anT);
      else i.split.connect(i.anT, 0);
      i.tunerWired = mode;
    }
    i.anT.getFloatTimeDomainData(i.bufT);
    return i.bufT;
  }

  /** Picos das entradas físicas 1 (L) e 2 (R), antes do ganho digital. */
  inputLevels() {
    const i = this.input;
    if (!i) return null;
    const peak = (an, b) => {
      an.getFloatTimeDomainData(b);
      let p = 0;
      for (let k = 0; k < b.length; k++) { const a = Math.abs(b[k]); if (a > p) p = a; }
      return p;
    };
    return { L: peak(i.anL, i.bufL), R: peak(i.anR, i.bufR) };
  }

  startCapture(cb) {
    if (!this.input?.rec) throw new Error('Entrada de áudio não está aberta.');
    this.captureSession = (this.captureSession || 0) + 1;
    this.captureCb = cb;
    this.input.rec.port.postMessage({ cmd: 'start' });
  }

  stopCapture() {
    return new Promise((resolve) => {
      if (!this.input?.rec || !this.captureCb) { this.captureCb = null; resolve(); return; }
      // O id impede que o tempo-limite desta parada encerre uma captura iniciada depois.
      const session = this.captureSession;
      const prev = this.captureCb;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        if (this.captureSession === session) this.captureCb = null;
        resolve();
      };
      this.captureCb = (m) => { prev(m); if (m.type === 'stopped') done(); };
      this.input.rec.port.postMessage({ cmd: 'stop' });
      setTimeout(done, 1500);
    });
  }

  /** Cliques de calibração: rajada curta de 1 kHz começando no pico (início nítido). */
  playClicks(times) {
    const c = this.ctx;
    const n = Math.floor(c.sampleRate * 0.004);
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.cos(2 * Math.PI * 1000 * i / c.sampleRate) * (1 - i / n) * 0.9;
    for (const t of times) {
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(this.calGain);
      s.start(t);
    }
  }
}
