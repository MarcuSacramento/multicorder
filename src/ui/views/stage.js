// Prévia da grade em canvas (mesmo compositor da exportação) + vídeos das tomadas sincronizados ao áudio.
import { drawGrid } from '../../engine/compositor.js';
import { ASPECTS, hitTest } from '../../engine/layout.js';
import { takeSpans, videoTimeAt } from '../../engine/project.js';
import { h } from '../dom.js';

export class Stage {
  constructor(app) {
    this.app = app;
    this.videos = new Map(); // takeId → { el, url, lastTarget, starting }
    this.rects = [];
    this.drag = null;
    this.canvas = h('canvas', {
      class: 'stage-canvas',
      role: 'img',
      'aria-label': 'Prévia da grade de vídeo. Clique num quadro para selecionar o canal; arraste um quadro sobre outro para trocar a ordem.',
    });
    this.g = this.canvas.getContext('2d');
    // Os vídeos ficam dentro da página, num canto de 2 px quase transparente: fora do documento
    // (ou com display:none) o navegador pode suspender a decodificação, e o quadro ficava em "carregando…".
    this.pool = h('div', { class: 'video-pool', 'aria-hidden': 'true' });
    document.body.append(this.pool);
    this.live = document.createElement('video');
    this.live.muted = true;
    this.live.playsInline = true;
    this.pool.append(this.live);
    this.canvas.addEventListener('pointerdown', (e) => {
      const i = this.hit(e);
      if (i < 0) return;
      this.drag = { from: i };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      const i = this.drag.from;
      this.drag = null;
      const j = this.hit(e);
      const p = this.app.project;
      if (j < 0 || !p) return;
      if (i === j) this.app.select(p.channels[i].id);
      else this.app.swapChannels(i, j); // RF-04
    });
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    return hitTest(this.rects, x, y);
  }

  mount(wrap) {
    this.wrap = wrap;
    wrap.append(this.canvas);
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    this.resize();
  }

  resize() {
    const p = this.app.project;
    if (!p || !this.wrap) return;
    this.app.layoutCenter?.(); // faixas ao lado ou embaixo da prévia, conforme a proporção
    const [a, b] = ASPECTS[p.aspect];
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    if (!W || !H) return;
    let w = W;
    let hh = (W * b) / a;
    if (hh > H) { hh = H; w = (H * a) / b; }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    const scale = Math.min(Math.min(2, devicePixelRatio || 1), 1600 / Math.max(w, hh));
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(hh * scale);
    // Redimensionar limpa o canvas: redesenha já, sem esperar o próximo quadro.
    this.update(this.app.engine.position, this.app.S.transport, this.lastOpts || {});
  }

  setLive(stream) {
    this.live.srcObject = stream || null;
    if (stream) this.live.play().catch(() => {});
  }

  async loadTakeVideo(pid, take) {
    if (this.videos.has(take.id)) return;
    this.videos.set(take.id, null); // carregando: evita ler o mesmo arquivo duas vezes
    let blob = null;
    try {
      blob = await this.app.store.readTakeVideo(pid, take.id, take.videoMime);
    } catch (e) {
      // Sem isso o "vazio" ficava guardado e o vídeo nunca mais era lido.
      console.warn('Não foi possível ler o vídeo da tomada', take.id, e);
    }
    if (this.videos.get(take.id) !== null) return; // a tomada saiu do projeto enquanto lia
    if (!blob) { this.videos.delete(take.id); return; }
    this.videos.set(take.id, this._makeVideo(blob));
  }

  _makeVideo(blob) {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.src = url;
    this.pool.append(el);
    return { el, url, blob, lastTarget: NaN, starting: false, stuckSince: 0, nudges: 0 };
  }

  _release(v) {
    v.el.pause();
    v.el.removeAttribute('src');
    v.el.load();
    v.el.remove();
    URL.revokeObjectURL(v.url);
  }

  /**
   * Vigia: um vídeo que devia aparecer e está sem imagem há mais de 2,5 s é cutucado (nova busca no
   * mesmo ponto); se não voltar, é recriado a partir do arquivo. Devolve o vídeo em uso.
   */
  _watch(id, v) {
    const now = performance.now();
    if (v.el.readyState >= 2 && !v.el.error) { v.stuckSince = 0; v.nudges = 0; return v; }
    if (!v.stuckSince) { v.stuckSince = now; return v; }
    if (now - v.stuckSince < 2500) return v;
    v.stuckSince = now;
    if (!v.el.error && v.el.networkState !== 3 && v.nudges < 2) {
      v.nudges++;
      const t = Number.isFinite(v.lastTarget) ? v.lastTarget : v.el.currentTime;
      try { v.el.currentTime = Math.max(0, t) + 0.001; } catch { /* ok */ }
      return v;
    }
    console.warn('Vídeo travado, recriando', id, v.el.error?.message || `readyState ${v.el.readyState}`);
    const fresh = this._makeVideo(v.blob);
    fresh.lastTarget = NaN;
    this._release(v);
    this.videos.set(id, fresh);
    return fresh;
  }

  dropUnused(p) {
    const keep = new Set(p ? p.channels.flatMap((c) => [c.takeId, ...(c.punches || []).map((x) => x.takeId)]) : []);
    for (const [id, v] of this.videos) {
      if (keep.has(id)) continue;
      if (v) this._release(v);
      this.videos.delete(id);
    }
  }

  clear() {
    this.dropUnused(null);
    this.setLive(null);
    this.ro?.disconnect();
    this.wrap = null;
  }

  syncVideo(v, target, playing) {
    const el = v.el;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    const tgt = Math.max(0, Math.min(target, dur - 0.05));
    if (!playing || target < 0 || target > dur) {
      if (!el.paused) el.pause();
      if (Math.abs(tgt - v.lastTarget) > 0.03 && !el.seeking) { el.currentTime = tgt; v.lastTarget = tgt; }
      return;
    }
    if (el.paused) {
      if (v.starting) return;
      v.starting = true;
      el.currentTime = tgt;
      v.lastTarget = tgt;
      el.play().catch(() => {}).finally(() => { v.starting = false; });
      return;
    }
    const drift = el.currentTime - tgt;
    if (Math.abs(drift) > 0.25) {
      if (!el.seeking) el.currentTime = tgt;
    } else {
      const r = Math.max(0.94, Math.min(1.06, 1 - drift));
      if (Math.abs(el.playbackRate - r) > 0.01) el.playbackRate = r;
    }
    v.lastTarget = tgt;
  }

  update(pos, transport, opts) {
    const { liveIds = [], recordingIds = [], selectedId = this.app.S.selectedId, overlay, clipIds = [] } = opts;
    this.lastOpts = opts;
    const p = this.app.project;
    if (!p || !this.canvas.width) return;
    const playing = transport !== 'stopped' && pos >= 0;
    const sources = {};
    for (const ch of p.channels) {
      if (liveIds.includes(ch.id) && transport !== 'playing') {
        if (this.live.readyState >= 2) sources[ch.id] = { image: this.live, width: this.live.videoWidth, height: this.live.videoHeight };
        continue;
      }
      // Com punch-in o quadro troca de vídeo no trecho regravado; os vídeos fora de uso ficam parados
      // já no ponto em que vão entrar, para a troca sair sem atraso.
      const tl = Math.max(0, pos);
      const spans = takeSpans(p, ch);
      const cur = spans.find((x) => tl >= x.from && tl < x.to);
      const ready = new Set([cur?.take]);
      for (const sp of spans) {
        if (ready.has(sp.take) || sp.from <= tl) continue;
        ready.add(sp.take); // só o próximo trecho de cada tomada
        const w = this.videos.get(sp.take.id);
        if (w) this.syncVideo(w, videoTimeAt(ch, sp.take, sp.from, sp.shift, sp.freeze), false);
      }
      const t = cur?.take;
      let v = t && this.videos.get(t.id);
      if (!v) continue;
      v = this._watch(t.id, v);
      // `shift`: o trecho andou para trás com compassos removidos; na emenda o vídeo pula para frente.
      const frozen = cur.freeze != null && tl > cur.freeze;
      this.syncVideo(v, videoTimeAt(ch, t, tl, cur.shift, cur.freeze), playing && !frozen);
      if (v.el.readyState >= 2) sources[ch.id] = { image: v.el, width: v.el.videoWidth, height: v.el.videoHeight };
    }
    // Toques ao vivo (teclado/MIDI) acendem os pads da prévia na hora
    const S = this.app.S;
    let flash = null;
    if (S.padFlash.size) {
      flash = new Map();
      const now = performance.now();
      for (const [id, f] of S.padFlash) {
        const age = (now - f.at) / 1000;
        if (age > 0.6) S.padFlash.delete(id);
        else flash.set(id, (0.35 + 0.65 * f.v) * Math.exp(-age / 0.13));
      }
    }
    this.rects = drawGrid(this.g, this.canvas.width, this.canvas.height, p, sources, {
      labels: true, selectedId, recordingId: recordingIds[0], overlay, clipIds,
      time: transport === 'stopped' ? -1 : pos, drumTL: S.drumTL, flash,
      layoutTime: Math.max(0, pos), wmImage: this.wmImage(p),
    });
  }

  /** Imagem da marca d'água (data URL do projeto), carregada uma vez. */
  wmImage(p) {
    const src = p.watermark?.on && p.watermark.kind === 'image' ? p.watermark.image : null;
    if (!src) return null;
    if (this._wm?.src !== src) {
      const img = new Image();
      img.src = src;
      this._wm = { src, img };
    }
    return this._wm.img.complete && this._wm.img.naturalWidth ? this._wm.img : null;
  }
}
