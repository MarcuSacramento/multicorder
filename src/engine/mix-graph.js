// Grafo de mixagem completo: strips + reverb compartilhado + master com limitador (RF-26, RF-27).
import { ChannelStrip, FxSlot, Meter, setParam } from './channel-strip.js';
import { getImpulse } from './impulse.js';
import { DRUMS_ID } from './drums.js';
import { autoDbAt, autoGain, autoValueAt, channelPieces, defaultFx, guidePieces, PUNCH_XF, showsDrums } from './project.js';
import { faderGain } from './util.js';

const GUIDE = 'guide';

export class MixGraph {
  constructor(ctx, destination, { gate = true } = {}) {
    const c = (this.ctx = ctx);
    this.gate = gate;
    this.last = new Map();
    this.strips = new Map();
    this.sources = new Map(); // AudioBufferSourceNode → { id, env }

    this.masterIn = c.createGain();
    this.masterGain = c.createGain();
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    // O DynamicsCompressor deixa escapar ~1 dB acima do teto nos ataques. Um teto logo depois pega
    // esse resto: abaixo de −3 dBFS não mexe em nada; acima, arredonda suavemente (tanh) até −0,3 dBFS.
    // Um corte seco ali achatava os picos do bumbo e soava como chiado/estouro a cada batida.
    this.ceiling = c.createWaveShaper();
    this.ceiling.curve = softCeiling(Math.pow(10, -3 / 20), Math.pow(10, -0.3 / 20));
    // Sem sobreamostragem: ela atrasaria o som de todos os canais em ~4 ms, e o teto quase nunca age.
    this.limiter.connect(this.ceiling);
    this.limitSlot = new FxSlot(c, this.last);
    this.limitSlot.wire(this.limiter, this.ceiling);
    this.out = c.createGain();
    this.meter = new Meter(c);
    this.masterIn.connect(this.masterGain).connect(this.limitSlot.in);
    this.limitSlot.out.connect(this.out).connect(destination);
    this.out.connect(this.meter.node);
    // Analisador de frequências do master (painel 📈 Espectro)
    this.spectrum = c.createAnalyser();
    this.spectrum.fftSize = 8192;
    this.spectrum.smoothingTimeConstant = 0.6;
    this.out.connect(this.spectrum);

    // Reverb compartilhado (send/return)
    this.revIn = c.createGain();
    this.revConv = c.createConvolver();
    this.revReturn = c.createGain();
    this.revIn.connect(this.revConv).connect(this.revReturn).connect(this.masterIn);
    this.revType = null;
  }

  _strip(id) {
    let s = this.strips.get(id);
    let fresh = false;
    if (!s) {
      s = new ChannelStrip(this.ctx, { masterIn: this.masterIn, sendBus: this.revIn, gate: this.gate });
      this.strips.set(id, s);
      fresh = true;
    }
    return [s, fresh];
  }

  sync(project, immediate = false) {
    const ids = new Set(project.channels.map((c) => c.id));
    if (project.guide) ids.add(GUIDE);
    if (project.drums) ids.add(DRUMS_ID);
    for (const [id, s] of this.strips) {
      if (!ids.has(id)) { s.disconnect(); this.strips.delete(id); }
    }
    // Solo só vale em canal com gravação: um solo esquecido num canal vazio calaria a mixagem toda.
    const recorded = (c) => c.takeId && project.takes[c.takeId]?.status === 'done';
    const drums = project.drums;
    const drumsSolo = !!(drums?.solo && drums.blocks.length);
    const anySolo = drumsSolo || project.channels.some((c) => c.solo && recorded(c) && !showsDrums(project, c));
    for (const ch of project.channels) {
      const [s, fresh] = this._strip(ch.id);
      s.apply(ch, { bpm: project.bpm, audible: !showsDrums(project, ch) && !ch.mute && (!anySolo || ch.solo), immediate: immediate || fresh });
    }
    if (project.guide) {
      const g = project.guide;
      const [s, fresh] = this._strip(GUIDE);
      const fx = defaultFx();
      fx.eq.on = false;
      s.apply({ inputGainDb: 0, pan: 0, volumeDb: g.volumeDb, fx }, {
        bpm: project.bpm, audible: !g.mute, immediate: immediate || fresh,
      });
    }
    if (drums) {
      const [s, fresh] = this._strip(DRUMS_ID);
      s.apply({ inputGainDb: 0, pan: drums.pan, panAuto: drums.panAuto, volumeDb: drums.volumeDb, fx: drums.fx }, {
        bpm: project.bpm, audible: !drums.mute && (!anySolo || drums.solo), immediate: immediate || fresh,
      });
    }
    const P = (p, v) => setParam(this.ctx, p, v, immediate, this.last);
    P(this.masterGain.gain, faderGain(project.master.volumeDb));
    this.limitSlot.set(project.master.limiter, immediate);
    if (this.revType !== project.sharedReverb.type) {
      this.revType = project.sharedReverb.type;
      this.revConv.buffer = getImpulse(this.ctx, this.revType);
    }
    P(this.revReturn.gain, faderGain(project.sharedReverb.returnDb));
  }

  /**
   * Agenda as fontes: a posição `fromPos` da linha do tempo toca no instante `at` do contexto.
   * `toPos` corta o trecho (fim do loop). Tudo é agendado pelo relógio do AudioContext (RNF-04).
   * `cutAt` (Map canal → posição): o canal para de tocar ali (punch-in: a parte antiga some onde a nova começa).
   */
  schedule(project, buffers, at, fromPos, { exclude = new Set(), toPos = Infinity, fade = 0.004, only = null, cutAt = null } = {}) {
    const XF = 2 * PUNCH_XF;
    for (const ch of project.channels) {
      if (exclude.has(ch.id) || (only && only !== ch.id) || showsDrums(project, ch)) continue;
      this.scheduleAuto(ch, ch.id, at, fromPos, toPos);
      const cut = cutAt?.get(ch.id) ?? Infinity;
      for (const pc of channelPieces(project, ch)) {
        const buf = buffers.get(pc.bufId);
        if (!buf) continue;
        const to = Math.min(pc.to, toPos, cut);
        this._play(this.strips.get(ch.id), buf, at, fromPos, pc.tlStart, to, pc.from, fade, ch.id,
          pc.xfIn ? XF : null, pc.xfOut && to === pc.to ? XF : null);
      }
    }
    const g = project.guide;
    const gb = buffers.get(GUIDE);
    if (g && gb && this.strips.has(GUIDE) && (!only || only === GUIDE)) {
      // Em trechos: com compassos removidos a guia pula o pedaço cortado, com transição na emenda.
      for (const pc of guidePieces(project)) {
        const to = Math.min(pc.to, pc.tlStart + gb.duration, toPos);
        this._play(this.strips.get(GUIDE), gb, at, fromPos, pc.tlStart, to, pc.from, fade, GUIDE,
          pc.xfIn ? XF : null, pc.xfOut && to === pc.to ? XF : null);
      }
    }
    const db = buffers.get(DRUMS_ID);
    if (project.drums && db && this.strips.has(DRUMS_ID) && (!only || only === DRUMS_ID)) {
      this.scheduleAuto(project.drums, DRUMS_ID, at, fromPos, toPos);
      this._play(this.strips.get(DRUMS_ID), db, at, fromPos, 0, Math.min(db.duration, toPos), 0, fade, DRUMS_ID);
    }
  }

  _play(strip, buf, at, fromPos, tlStart, tlEnd, minStart, fade = 0.004, id = null, fadeIn = null, fadeOut = null) {
    if (!strip) return;
    const c = this.ctx;
    const start = Math.max(minStart, tlStart, fromPos);
    if (start >= tlEnd - 0.01) return;
    const when = at + (start - fromPos);
    const off = start - tlStart;
    const dur = tlEnd - start;
    const src = c.createBufferSource();
    src.buffer = buf;
    const env = c.createGain();
    // Bordas de punch-in usam a transição mais longa (só se o trecho começa de fato na borda).
    const fi = Math.min(fadeIn != null && start === minStart ? fadeIn : fade, dur / 2);
    const fo = Math.min(fadeOut ?? fade, dur / 2);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(1, when + fi);
    env.gain.setValueAtTime(1, when + dur - fo);
    env.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(env).connect(strip.input);
    src.start(when, off, dur);
    this.sources.set(src, { id, env });
    src.onended = () => { this.sources.delete(src); try { env.disconnect(); } catch { /* ok */ } };
  }

  /**
   * Linha de volume do canal: o trecho [fromPos, toPos] da linha do tempo toca a partir do instante `at`.
   * Entre dois pontos o volume anda em linha reta em dB (rampa exponencial do ganho).
   */
  scheduleAuto(o, id, at, fromPos, toPos = Infinity) {
    const s = this.strips.get(id);
    if (!s) return;
    this._schedulePan(s, o, at, fromPos, toPos);
    const g = s.auto.gain;
    const pts = o.volAuto || [];
    // Mantém o que já tocou até `at` (a volta do loop e a edição tocando emendam sem pulo).
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at); else g.cancelScheduledValues(at);
    g.setValueAtTime(autoGain(autoDbAt(pts, fromPos)), at);
    for (const x of pts) {
      if (x.t <= fromPos) continue;
      if (x.t >= toPos) {
        g.exponentialRampToValueAtTime(autoGain(autoDbAt(pts, toPos)), at + (toPos - fromPos));
        return;
      }
      g.exponentialRampToValueAtTime(autoGain(x.db), at + (x.t - fromPos));
    }
  }

  /** Linha de pan: entre os pontos o pan anda em linha reta. Sem pontos, o botão do canal manda. */
  _schedulePan(s, o, at, fromPos, toPos) {
    const pts = o.panAuto || [];
    if (!pts.length) return;
    const g = s.pan.pan;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at); else g.cancelScheduledValues(at);
    g.setValueAtTime(autoValueAt(pts, fromPos, 'v'), at);
    for (const x of pts) {
      if (x.t <= fromPos) continue;
      if (x.t >= toPos) { g.linearRampToValueAtTime(autoValueAt(pts, toPos, 'v'), at + (toPos - fromPos)); return; }
      g.linearRampToValueAtTime(x.v, at + (x.t - fromPos));
    }
  }

  stop() {
    for (const s of this.sources.keys()) { try { s.stop(); } catch { /* ok */ } }
    this.sources.clear();
    // Parado, a linha de volume não vale (pré-escuta dos pads, por exemplo, toca no volume do fader).
    for (const s of this.strips.values()) {
      try {
        s.auto.gain.cancelScheduledValues(0);
        s.auto.gain.setValueAtTime(1, this.ctx.currentTime);
      } catch { /* ok */ }
    }
  }

  /** Para (com rampa de 5 ms, sem estalo) só as fontes de um id, a partir do instante `at`. */
  stopSource(id, at) {
    for (const [src, x] of this.sources) {
      if (x.id !== id) continue;
      try {
        x.env.gain.cancelScheduledValues(at);
        x.env.gain.setValueAtTime(x.env.gain.value, at);
        x.env.gain.linearRampToValueAtTime(0, at + 0.005);
        src.stop(at + 0.006);
      } catch { /* já parou */ }
      this.sources.delete(src);
    }
  }
}

export const GUIDE_ID = GUIDE;

/** Curva do teto: linear até `knee`, depois tanh até `top` (contínua e sem quina na emenda). */
export function softCeiling(knee, top, n = 8193) {
  const curve = new Float32Array(n);
  const room = top - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
