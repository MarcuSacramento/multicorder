// AudioWorklet: gravador de entrada (PCM float32 com carimbo de quadro) e noise gate.

/**
 * Captura a entrada em estéreo intercalado e envia blocos com o número do quadro
 * (currentFrame) da primeira amostra. Isso dá a posição exata no relógio do AudioContext.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.block = 4096;
    this.buf = new Float32Array(this.block * 2);
    this.n = 0;
    this.bufFrame = -1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'start') {
        this.on = true; this.n = 0; this.bufFrame = -1;
      } else if (m.cmd === 'stop') {
        if (this.on) this.flush();
        this.on = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n * 2);
      this.port.postMessage({ type: 'data', frame: this.bufFrame, data: out }, [out.buffer]);
    }
    this.n = 0;
    this.bufFrame = -1;
  }

  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0];
    const L = inp && inp[0];
    const R = (inp && inp[1]) || L;
    const len = L ? L.length : 128;
    for (let i = 0; i < len; i++) {
      if (this.bufFrame < 0) this.bufFrame = currentFrame + i;
      this.buf[this.n * 2] = L ? L[i] : 0;
      this.buf[this.n * 2 + 1] = R ? R[i] : 0;
      this.n++;
      if (this.n === this.block) this.flush();
    }
    return true;
  }
}

/** Noise gate (RF-34) com hold e release; ataque de 1 ms. */
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'thresholdDb', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 120, minValue: 5, maxValue: 2000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 0;
    this.hold = 0;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || inp.length === 0) return true;
    const thr = Math.pow(10, params.thresholdDb[0] / 20);
    const rel = Math.exp(-1 / (params.releaseMs[0] * 0.001 * sampleRate));
    const atk = Math.exp(-1 / (0.001 * sampleRate));
    const envRel = Math.exp(-1 / (0.01 * sampleRate));
    const holdN = 0.05 * sampleRate;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < inp.length; c++) {
        const a = Math.abs(inp[c][i]);
        if (a > m) m = a;
      }
      this.env = m > this.env ? m : this.env * envRel;
      if (this.env > thr) this.hold = holdN;
      else if (this.hold > 0) this.hold--;
      const target = this.hold > 0 ? 1 : 0;
      const k = target > this.gain ? atk : rel;
      this.gain = target + (this.gain - target) * k;
      for (let c = 0; c < out.length; c++) {
        const src = inp[c] || inp[0];
        out[c][i] = src[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
registerProcessor('noise-gate', NoiseGateProcessor);
