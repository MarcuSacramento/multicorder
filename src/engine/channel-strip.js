// Strip de canal: fonte → ganho → gate → HP → EQ → compressor → distorção → wah → chorus → dobrar voz →
// tremolo → echo → reverb → pan → fader → volume na linha do tempo → mute → medidor.
// Funciona em AudioContext e OfflineAudioContext (o mesmo grafo serve à prévia e à exportação).
import { getImpulse } from './impulse.js';
import { echoTimeSec, lfoHz } from './project.js';
import { clamp, dbToGain, faderGain } from './util.js';

const TC = 0.012; // constante de tempo das rampas (sem cliques — RF-37)

/** Aplica um valor a um AudioParam com rampa curta; `immediate` para montagem inicial/offline. */
export function setParam(ctx, p, v, immediate, last) {
  if (!Number.isFinite(v)) v = 0;
  if (last) {
    if (!immediate && last.get(p) === v) return;
    last.set(p, v);
  }
  if (immediate) {
    p.cancelScheduledValues(0);
    p.value = v;
  } else {
    const t = ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(v, t, TC);
  }
}

/** Bloco com caminho seco e caminho de efeito; o bypass faz crossfade entre os dois. */
export class FxSlot {
  constructor(ctx, last) {
    this.ctx = ctx;
    this.last = last;
    this.in = ctx.createGain();
    this.out = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.in.connect(this.dry).connect(this.out);
    this.wet.connect(this.out);
    this.hasFx = false;
  }
  wire(entry, exit) {
    this.in.connect(entry);
    exit.connect(this.wet);
    this.hasFx = true;
  }
  set(on, immediate) {
    on = on && this.hasFx;
    setParam(this.ctx, this.dry.gain, on ? 0 : 1, immediate, this.last);
    setParam(this.ctx, this.wet.gain, on ? 1 : 0, immediate, this.last);
  }
}

export class Meter {
  constructor(ctx) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = 2048;
    this.buf = new Float32Array(this.node.fftSize);
  }
  read() {
    this.node.getFloatTimeDomainData(this.buf);
    let peak = 0, sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this.buf.length) };
  }
}

export class ChannelStrip {
  constructor(ctx, { masterIn, sendBus, gate = true }) {
    const c = (this.ctx = ctx);
    const last = (this.last = new Map());
    this.input = c.createGain();
    this.inGain = c.createGain();
    this.input.connect(this.inGain);

    // Gate (AudioWorklet)
    this.gateSlot = new FxSlot(c, last);
    if (gate) {
      try {
        this.gateNode = new AudioWorkletNode(c, 'noise-gate');
        this.gateSlot.wire(this.gateNode, this.gateNode);
      } catch { this.gateNode = null; }
    }

    // High-pass e EQ de 3 bandas
    this.hp = c.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.Q.value = 0.707;
    this.hpSlot = new FxSlot(c, last);
    this.hpSlot.wire(this.hp, this.hp);

    this.ls = c.createBiquadFilter(); this.ls.type = 'lowshelf';
    this.pk = c.createBiquadFilter(); this.pk.type = 'peaking';
    this.hs = c.createBiquadFilter(); this.hs.type = 'highshelf';
    this.ls.connect(this.pk).connect(this.hs);
    this.eqSlot = new FxSlot(c, last);
    this.eqSlot.wire(this.ls, this.hs);

    // Compressor
    this.comp = c.createDynamicsCompressor();
    this.makeup = c.createGain();
    this.comp.connect(this.makeup);
    this.compSlot = new FxSlot(c, last);
    this.compSlot.wire(this.comp, this.makeup);

    // ---- Efeitos de cor ----
    // LFO: oscilador senoidal que sempre roda (o efeito desligado só não passa o som por ele)
    const lfo = (hz) => { const o = c.createOscillator(); o.frequency.value = hz; o.start(); return o; };

    // Distorção: ganho → curva tanh → filtro de tom → nível
    this.distIn = c.createGain();
    this.shaper = c.createWaveShaper();
    this.shaper.oversample = '4x';
    this.distTone = c.createBiquadFilter(); this.distTone.type = 'lowpass';
    this.distOut = c.createGain();
    this.distIn.connect(this.shaper).connect(this.distTone).connect(this.distOut);
    this.distSlot = new FxSlot(c, last);
    this.distSlot.wire(this.distIn, this.distOut);
    this.drive = null;

    // Wah automático: pico ressonante que varre de ~350 Hz a ~2,2 kHz no ritmo
    this.wahF = c.createBiquadFilter(); this.wahF.type = 'peaking'; this.wahF.gain.value = 14;
    this.wahOut = c.createGain(); this.wahOut.gain.value = 0.85; // o pico soma volume; compensa
    this.wahLfo = lfo(2);
    this.wahDepth = c.createGain();
    this.wahLfo.connect(this.wahDepth).connect(this.wahF.frequency);
    this.wahF.connect(this.wahOut);
    this.wahSlot = new FxSlot(c, last);
    this.wahSlot.wire(this.wahF, this.wahOut);

    // Chorus: duas vozes atrasadas (~20 ms) com o atraso oscilando, uma para cada lado
    const voice = (base, hz, phaseInvert, pan, into) => {
      const d = c.createDelay(0.1);
      d.delayTime.value = base;
      const o = lfo(hz);
      const g = c.createGain();
      o.connect(g).connect(d.delayTime);
      const pn = c.createStereoPanner(); pn.pan.value = pan;
      const vg = c.createGain();
      d.connect(pn).connect(vg).connect(into);
      if (phaseInvert) g.gain.value = -g.gain.value;
      return { d, o, g, pn, vg, invert: phaseInvert };
    };
    this.choIn = c.createGain();
    this.choOut = c.createGain();
    this.choDry = c.createGain();
    this.choIn.connect(this.choDry).connect(this.choOut);
    this.choV = [voice(0.02, 0.8, false, -0.6, this.choOut), voice(0.024, 0.8, true, 0.6, this.choOut)];
    for (const v of this.choV) this.choIn.connect(v.d);
    this.choSlot = new FxSlot(c, last);
    this.choSlot.wire(this.choIn, this.choOut);

    // Dobrar a voz: duas cópias com atraso curto e um leve desafinar lento, abertas nos lados
    this.dblIn = c.createGain();
    this.dblOut = c.createGain();
    this.dblDry = c.createGain();
    this.dblIn.connect(this.dblDry).connect(this.dblOut);
    this.dblV = [voice(0.013, 0.31, false, -0.8, this.dblOut), voice(0.021, 0.37, true, 0.8, this.dblOut)];
    for (const v of this.dblV) this.dblIn.connect(v.d);
    this.dblSlot = new FxSlot(c, last);
    this.dblSlot.wire(this.dblIn, this.dblOut);

    // Tremolo: o volume sobe e desce no ritmo
    this.trem = c.createGain();
    this.tremLfo = lfo(5);
    this.tremDepth = c.createGain();
    this.tremLfo.connect(this.tremDepth).connect(this.trem.gain);
    this.tremSlot = new FxSlot(c, last);
    this.tremSlot.wire(this.trem, this.trem);

    // Echo: seco + delay com realimentação filtrada
    this.echoIn = c.createGain();
    this.echoOut = c.createGain();
    this.delay = c.createDelay(2.5);
    this.fbFilter = c.createBiquadFilter(); this.fbFilter.type = 'lowpass';
    this.fb = c.createGain();
    this.echoWet = c.createGain();
    this.echoIn.connect(this.echoOut);
    this.echoIn.connect(this.delay);
    this.delay.connect(this.fbFilter);
    this.fbFilter.connect(this.fb).connect(this.delay);
    this.fbFilter.connect(this.echoWet).connect(this.echoOut);
    this.echoSlot = new FxSlot(c, last);
    this.echoSlot.wire(this.echoIn, this.echoOut);

    // Reverb insert: seco + pré-delay → convolver
    this.revIn = c.createGain();
    this.revOut = c.createGain();
    this.revPre = c.createDelay(1);
    this.conv = c.createConvolver();
    this.revWet = c.createGain();
    this.revIn.connect(this.revOut);
    this.revIn.connect(this.revPre).connect(this.conv).connect(this.revWet).connect(this.revOut);
    this.revSlot = new FxSlot(c, last);
    this.revSlot.wire(this.revIn, this.revOut);
    this.revType = null;

    // Cadeia de efeitos com bypass geral do canal
    this.gateSlot.out.connect(this.hpSlot.in);
    this.hpSlot.out.connect(this.eqSlot.in);
    this.eqSlot.out.connect(this.compSlot.in);
    this.compSlot.out.connect(this.distSlot.in);
    this.distSlot.out.connect(this.wahSlot.in);
    this.wahSlot.out.connect(this.choSlot.in);
    this.choSlot.out.connect(this.dblSlot.in);
    this.dblSlot.out.connect(this.tremSlot.in);
    this.tremSlot.out.connect(this.echoSlot.in);
    this.echoSlot.out.connect(this.revSlot.in);
    this.fxSlot = new FxSlot(c, last);
    this.fxSlot.wire(this.gateSlot.in, this.revSlot.out);
    this.inGain.connect(this.fxSlot.in);

    // Pan → fader → mute → master / medidor / envio
    this.pan = c.createStereoPanner();
    this.fader = c.createGain();
    // Volume ao longo da música (linha de volume da faixa); o MixGraph agenda as rampas.
    this.auto = c.createGain();
    this.muteG = c.createGain();
    this.send = c.createGain();
    this.send.gain.value = 0;
    this.meter = new Meter(c);
    this.fxSlot.out.connect(this.pan).connect(this.fader).connect(this.auto).connect(this.muteG);
    this.muteG.connect(masterIn);
    this.muteG.connect(this.meter.node);
    this.muteG.connect(this.send).connect(sendBus);
  }

  /** Aplica os parâmetros do canal (modelo) aos nós. */
  apply(ch, { bpm, audible, immediate = false }) {
    const c = this.ctx;
    const P = (p, v) => setParam(c, p, v, immediate, this.last);
    const fx = ch.fx;

    P(this.inGain.gain, dbToGain(ch.inputGainDb || 0));
    this.fxSlot.set(!fx.bypassAll, immediate);

    this.gateSlot.set(fx.gate.on && !!this.gateNode, immediate);
    if (this.gateNode) {
      P(this.gateNode.parameters.get('thresholdDb'), fx.gate.thresholdDb);
      P(this.gateNode.parameters.get('releaseMs'), fx.gate.releaseMs);
    }

    this.hpSlot.set(fx.eq.on && fx.eq.hpOn, immediate);
    P(this.hp.frequency, clamp(fx.eq.hpFreq, 20, 1000));
    this.eqSlot.set(fx.eq.on, immediate);
    P(this.ls.frequency, fx.eq.low.freq);
    P(this.ls.gain, fx.eq.low.gain);
    P(this.pk.frequency, fx.eq.mid.freq);
    P(this.pk.gain, fx.eq.mid.gain);
    P(this.pk.Q, clamp(fx.eq.mid.q, 0.1, 18));
    P(this.hs.frequency, fx.eq.high.freq);
    P(this.hs.gain, fx.eq.high.gain);

    this.compSlot.set(fx.comp.on, immediate);
    P(this.comp.threshold, fx.comp.thresholdDb);
    P(this.comp.ratio, clamp(fx.comp.ratio, 1, 20));
    P(this.comp.attack, fx.comp.attackMs / 1000);
    P(this.comp.release, fx.comp.releaseMs / 1000);
    P(this.comp.knee, 6);
    P(this.makeup.gain, dbToGain(fx.comp.makeupDb));

    // Distorção: a curva só é refeita quando o "drive" muda
    const dv = fx.dist || {};
    this.distSlot.set(!!dv.on, immediate);
    const drive = clamp(dv.drive ?? 0.4, 0, 1);
    if (this.drive !== drive) {
      this.drive = drive;
      const k = 1 + drive * 40;
      const n = 2048;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
      this.shaper.curve = curve;
    }
    P(this.distIn.gain, 1);
    P(this.distTone.frequency, clamp(dv.tone ?? 5000, 500, 16000));
    // a curva aumenta muito os sons baixos: compensa para o volume ficar parecido com o sem distorção
    P(this.distOut.gain, (clamp(dv.level ?? 0.8, 0, 1.5) * 0.7) / (1 + drive * 4));

    const wv = fx.wah || {};
    this.wahSlot.set(!!wv.on, immediate);
    const wd = clamp(wv.depth ?? 0.8, 0, 1);
    P(this.wahF.frequency, 1200);
    P(this.wahDepth.gain, 850 * wd); // 1200 ± 850 Hz
    P(this.wahF.Q, clamp(wv.q ?? 4, 0.5, 12));
    P(this.wahLfo.frequency, lfoHz(wv, bpm));

    const cv = fx.chorus || {};
    this.choSlot.set(!!cv.on, immediate);
    const cd = clamp(cv.depth ?? 0.5, 0, 1) * 0.004;
    for (const v of this.choV) {
      P(v.g.gain, v.invert ? -cd : cd);
      P(v.o.frequency, clamp(cv.rateHz ?? 0.8, 0.05, 8));
      P(v.vg.gain, clamp(cv.mix ?? 0.45, 0, 1));
    }
    P(this.choDry.gain, 1 - clamp(cv.mix ?? 0.45, 0, 1) * 0.4);

    const bv = fx.double || {};
    this.dblSlot.set(!!bv.on, immediate);
    const det = clamp(bv.detune ?? 0.5, 0, 1) * 0.0018;
    const wdt = clamp(bv.width ?? 0.8, 0, 1);
    this.dblV.forEach((v, i) => {
      P(v.g.gain, v.invert ? -det : det);
      P(v.pn.pan, (i ? 1 : -1) * wdt);
      P(v.vg.gain, clamp(bv.mix ?? 0.6, 0, 1) * 0.8);
    });
    P(this.dblDry.gain, 1 - clamp(bv.mix ?? 0.6, 0, 1) * 0.25);

    const tv = fx.trem || {};
    this.tremSlot.set(!!tv.on, immediate);
    const td = clamp(tv.depth ?? 0.5, 0, 1);
    P(this.trem.gain, 1 - td / 2);
    P(this.tremDepth.gain, td / 2);
    P(this.tremLfo.frequency, lfoHz(tv, bpm));

    this.echoSlot.set(fx.echo.on, immediate);
    P(this.delay.delayTime, echoTimeSec(fx.echo, bpm));
    P(this.fb.gain, clamp(fx.echo.feedback, 0, 0.95));
    P(this.fbFilter.frequency, clamp(fx.echo.filterHz, 200, 20000));
    P(this.echoWet.gain, clamp(fx.echo.mix, 0, 1));

    if (this.revType !== fx.reverb.type) {
      this.revType = fx.reverb.type;
      this.conv.buffer = getImpulse(c, fx.reverb.type);
    }
    this.revSlot.set(fx.reverb.on, immediate);
    P(this.revPre.delayTime, clamp(fx.reverb.preDelayMs, 0, 500) / 1000);
    P(this.revWet.gain, clamp(fx.reverb.mix, 0, 1));

    // Com linha de pan, o MixGraph agenda o pan ao longo da música; sem ela, vale o botão do canal.
    if (ch.panAuto?.length) this.last.delete(this.pan.pan);
    else P(this.pan.pan, clamp(ch.pan, -1, 1));
    P(this.fader.gain, faderGain(ch.volumeDb));
    P(this.muteG.gain, audible ? 1 : 0);
    P(this.send.gain, faderGain(fx.send.reverbDb));
  }

  disconnect() {
    for (const n of [this.input, this.muteG, this.send, this.meter.node]) {
      try { n.disconnect(); } catch { /* já desconectado */ }
    }
  }
}
