// Editor de efeitos do canal (RF-30 a RF-34, RF-36, RF-37). Mudanças valem na hora, inclusive tocando.
import { defaultFx, ECHO_SYNC, normalizeProject, REVERB_TYPES } from '../../engine/project.js';
import { fmtDb, uid } from '../../engine/util.js';
import { checkbox, fill, h, openDialog, select, slider, toast } from '../dom.js';

const KEY = 'mc.fxPresets';

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function savePresets(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ok */ }
}

/**
 * Predefinições por instrumento: ponto de partida pensado para cada tipo de som (EQ, compressor, efeitos).
 * Só o que muda do padrão está aqui; o resto volta ao padrão. Depois dá para ajustar à vontade.
 */
const EQ = (hp, low, mid, high) => ({ on: true, hpOn: hp > 0, hpFreq: hp || 80, low: { freq: low[0], gain: low[1] }, mid: { freq: mid[0], gain: mid[1], q: mid[2] ?? 1 }, high: { freq: high[0], gain: high[1] } });
const COMP = (thr, ratio, att, rel, mk) => ({ on: true, thresholdDb: thr, ratio, attackMs: att, releaseMs: rel, makeupDb: mk });
export const INSTRUMENT_PRESETS = [
  {
    id: 'voz', name: 'Voz principal', tip: 'Presença e brilho na voz, compressor firme e um plate curto. Dica: em Som da gravação, ligue “Tirar puffs”.',
    fx: { eq: EQ(100, [200, -2], [3000, 2, 1], [10000, 3]), comp: COMP(-20, 3, 5, 120, 4), reverb: { on: true, type: 'plate', preDelayMs: 30, mix: 0.15 } },
  },
  {
    id: 'voz-suave', name: 'Voz suave / intimista', tip: 'Compressor mais macio e uma sala pequena: a voz fica perto e quente.',
    fx: { eq: EQ(90, [180, 1], [2500, 1, 0.8], [9000, 2]), comp: COMP(-24, 2.5, 10, 200, 4), reverb: { on: true, type: 'room', preDelayMs: 15, mix: 0.18 } },
  },
  {
    id: 'backing', name: 'Backing vocal / coro', tip: 'Menos grave e a voz dobrada nos lados, para ficar atrás da voz principal.',
    fx: { eq: EQ(150, [250, -3], [2000, 0, 1], [9000, 2]), comp: COMP(-22, 4, 8, 150, 3), double: { on: true, width: 0.9, detune: 0.6, mix: 0.6 }, reverb: { on: true, type: 'hall', preDelayMs: 25, mix: 0.25 } },
  },
  {
    id: 'rap', name: 'Rap / fala', tip: 'Muita clareza nas palavras, compressor rápido e quase sem reverb.',
    fx: { eq: EQ(100, [180, -1], [3500, 3, 1.2], [9000, 1]), comp: COMP(-18, 5, 3, 80, 5), reverb: { on: true, type: 'small', preDelayMs: 10, mix: 0.08 } },
  },
  {
    id: 'violao', name: 'Violão', tip: 'Tira o “embolado” do corpo (médio-grave) e realça as cordas.',
    fx: { eq: EQ(80, [200, -2], [800, -2, 1.5], [10000, 2]), comp: COMP(-20, 2.5, 15, 150, 3), reverb: { on: true, type: 'room', preDelayMs: 15, mix: 0.18 } },
  },
  {
    id: 'guitarra-limpa', name: 'Guitarra limpa', tip: 'Chorus leve e um eco curto no ritmo.',
    fx: { eq: EQ(90, [150, 0], [1500, 1, 1], [7000, 1]), comp: COMP(-20, 3, 10, 150, 3), chorus: { on: true, rateHz: 0.6, depth: 0.4, mix: 0.35 }, echo: { on: true, sync: '1/8.', timeMs: 375, feedback: 0.25, mix: 0.15, filterHz: 4000 }, reverb: { on: true, type: 'room', preDelayMs: 10, mix: 0.15 } },
  },
  {
    id: 'guitarra-dist', name: 'Guitarra com distorção', tip: 'Distorção média, médios na frente e eco discreto.',
    fx: { eq: EQ(100, [120, 0], [900, 2, 1], [6000, -1]), dist: { on: true, drive: 0.6, tone: 4500, level: 0.8 }, echo: { on: true, sync: '1/4', timeMs: 375, feedback: 0.2, mix: 0.12, filterHz: 3500 }, reverb: { on: true, type: 'room', preDelayMs: 10, mix: 0.12 } },
  },
  {
    id: 'baixo', name: 'Baixo', tip: 'Grave firme, definição nos médios e compressor segurando as notas iguais. Sem reverb.',
    fx: { eq: EQ(35, [80, 2], [700, 2, 1], [5000, -3]), comp: COMP(-22, 4, 20, 200, 4) },
  },
  {
    id: 'teclado', name: 'Teclado / piano', tip: 'Um pouco menos de grave para não brigar com o baixo, e um salão.',
    fx: { eq: EQ(50, [200, -1], [1000, 0, 1], [8000, 1]), comp: COMP(-18, 2, 15, 200, 2), reverb: { on: true, type: 'hall', preDelayMs: 20, mix: 0.2 } },
  },
  {
    id: 'sopro', name: 'Sopro (sax, trompete, flauta)', tip: 'Tira a aspereza dos médios-altos e põe um plate.',
    fx: { eq: EQ(120, [200, 0], [2500, -1, 1], [8000, 1]), comp: COMP(-20, 3, 10, 150, 3), reverb: { on: true, type: 'plate', preDelayMs: 25, mix: 0.2 } },
  },
  {
    id: 'percussao', name: 'Percussão (cajón, pandeiro)', tip: 'Grave do cajón na frente, menos “caixa de papelão” e ataque rápido.',
    fx: { eq: EQ(60, [90, 2], [400, -3, 1.5], [6000, 2]), comp: COMP(-18, 3, 2, 100, 3), reverb: { on: true, type: 'room', preDelayMs: 5, mix: 0.1 } },
  },
  {
    id: 'vintage', name: 'Guitarra vintage (tremolo)', tip: 'Tremolo no ritmo e uma sala, estilo amplificador antigo.',
    fx: { eq: EQ(90, [150, 0], [1200, 1, 1], [6000, -2]), trem: { on: true, sync: '1/8', rateHz: 5, depth: 0.45 }, reverb: { on: true, type: 'hall', preDelayMs: 15, mix: 0.22 } },
  },
];

const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);

/** Slider com escala logarítmica para frequências. */
function freqSlider(label, min, max, value, onInput) {
  const toPos = (f) => (1000 * Math.log(f / min)) / Math.log(max / min);
  const toF = (p) => min * Math.pow(max / min, p / 1000);
  return slider({ label, min: 0, max: 1000, step: 1, value: Math.round(toPos(value)), onInput: (p) => onInput(Math.round(toF(p))), format: (p) => fmtHz(toF(p)) });
}

export function openFx(app, chId) {
  const ch = chId === 'drums' ? app.project.drums && Object.assign(app.project.drums, { name: 'Bateria' }) : app.project.channels.find((c) => c.id === chId);
  if (!ch) return;
  const body = h('div', { class: 'fx' });
  const u = () => app.touch();
  const dB = (v) => `${fmtDb(v)} dB`;
  const pct = (v) => `${Math.round(v * 100)}%`;
  // Velocidade de wah/tremolo: no ritmo da música (figura) ou livre (Hz)
  const rateField = (o) => h('div', null,
    select({ label: 'Velocidade', options: Object.entries(ECHO_SYNC).map(([k, t]) => [k, k === 'off' ? 'Livre (Hz)' : t]), value: o.sync, onChange: (v) => { o.sync = v; u(); render(); } }),
    o.sync === 'off'
      ? slider({ label: 'Velocidade (Hz)', min: 0.1, max: 12, step: 0.05, value: o.rateHz, onInput: (v) => { o.rateHz = v; u(); }, format: (v) => `${v.toFixed(2)} Hz` })
      : h('p', { class: 'muted small' }, `No ritmo da música (${app.project.bpm} BPM).`));

  const section = (title, obj, controls, cls = '') => h('fieldset', { class: `fx-sec ${cls}` },
    h('legend', null, checkbox({ label: title, checked: obj.on, onChange: (v) => { obj.on = v; u(); }, title: 'Liga/desliga sem cliques' })),
    controls);

  // Predefinição por instrumento: troca todos os efeitos do canal por um ponto de partida
  const instrumentBox = () => {
    let chosen = INSTRUMENT_PRESETS[0].id;
    const tip = h('p', { class: 'muted small' }, INSTRUMENT_PRESETS[0].tip);
    return h('div', { class: 'row presets instrument' },
      select({
        label: 'Predefinição para', options: INSTRUMENT_PRESETS.map((x) => [x.id, x.name]), value: chosen,
        onChange: (v) => { chosen = v; tip.textContent = INSTRUMENT_PRESETS.find((x) => x.id === v).tip; },
      }),
      h('button', {
        class: 'ghost small', title: 'Troca os efeitos do canal por esta predefinição (Ctrl+Z desfaz)', onClick: () => {
          const pr = INSTRUMENT_PRESETS.find((x) => x.id === chosen);
          const base = defaultFx();
          for (const [k, v] of Object.entries(pr.fx)) base[k] = { ...base[k], ...structuredClone(v) };
          base.bypassAll = false;
          ch.fx = base;
          u();
          render();
          toast(`Efeitos de "${ch.name}": ${pr.name}. Ajuste à vontade; Ctrl+Z desfaz.`, 'info', 4000);
        },
      }, 'Aplicar'),
      tip);
  };

  const presetsBox = () => {
    const list = loadPresets();
    let chosen = list[0]?.id || '';
    return h('div', { class: 'row presets' },
      list.length ? select({ label: 'Presets', options: list.map((p) => [p.id, p.name]), value: chosen, onChange: (v) => { chosen = v; } }) : h('span', { class: 'muted small' }, 'Sem presets salvos'),
      list.length ? h('button', {
        class: 'ghost small', onClick: () => {
          const pr = loadPresets().find((p) => p.id === chosen);
          if (!pr) return;
          ch.fx = normalizeProject({ channels: [{ fx: structuredClone(pr.fx) }] }).channels[0].fx;
          u();
          render();
        },
      }, 'Aplicar') : null,
      h('button', {
        class: 'ghost small', onClick: () => {
          const name = prompt('Nome do preset:', `${ch.name} — preset`);
          if (!name) return;
          const l = loadPresets();
          l.push({ id: uid('fx'), name: name.trim(), fx: structuredClone(ch.fx) });
          savePresets(l);
          render();
        },
      }, 'Salvar como…'),
      list.length ? h('button', {
        class: 'ghost small', onClick: () => {
          const l = loadPresets();
          const pr = l.find((p) => p.id === chosen);
          const name = pr && prompt('Novo nome:', pr.name);
          if (!name) return;
          pr.name = name.trim();
          savePresets(l);
          render();
        },
      }, 'Renomear') : null,
      list.length ? h('button', {
        class: 'ghost small danger', onClick: () => {
          if (!confirm('Excluir este preset?')) return;
          savePresets(loadPresets().filter((p) => p.id !== chosen));
          render();
        },
      }, 'Excluir') : null);
  };

  const render = () => {
    const fx = ch.fx;
    fill(body,
      h('div', { class: 'row between' },
        checkbox({ label: 'Efeitos deste canal ligados', checked: !fx.bypassAll, onChange: (v) => { fx.bypassAll = !v; u(); } }),
        h('button', { class: 'ghost small', onClick: () => { if (confirm('Voltar todos os efeitos ao padrão?')) { ch.fx = defaultFx(); u(); render(); } } }, 'Restaurar padrão')),
      instrumentBox(),
      presetsBox(),
      h('div', { class: 'fx-grid' },
        section('Equalizador', fx.eq, [
          checkbox({ label: 'Filtro passa-altas', checked: fx.eq.hpOn, onChange: (v) => { fx.eq.hpOn = v; u(); } }),
          freqSlider('Passa-altas', 20, 500, fx.eq.hpFreq, (v) => { fx.eq.hpFreq = v; u(); }),
          freqSlider('Graves (shelf)', 40, 500, fx.eq.low.freq, (v) => { fx.eq.low.freq = v; u(); }),
          slider({ label: 'Ganho graves', min: -18, max: 18, step: 0.5, value: fx.eq.low.gain, onInput: (v) => { fx.eq.low.gain = v; u(); }, format: dB }),
          freqSlider('Médios (peak)', 150, 10000, fx.eq.mid.freq, (v) => { fx.eq.mid.freq = v; u(); }),
          slider({ label: 'Ganho médios', min: -18, max: 18, step: 0.5, value: fx.eq.mid.gain, onInput: (v) => { fx.eq.mid.gain = v; u(); }, format: dB }),
          slider({ label: 'Q médios', min: 0.1, max: 10, step: 0.1, value: fx.eq.mid.q, onInput: (v) => { fx.eq.mid.q = v; u(); }, format: (v) => v.toFixed(1) }),
          freqSlider('Agudos (shelf)', 1500, 16000, fx.eq.high.freq, (v) => { fx.eq.high.freq = v; u(); }),
          slider({ label: 'Ganho agudos', min: -18, max: 18, step: 0.5, value: fx.eq.high.gain, onInput: (v) => { fx.eq.high.gain = v; u(); }, format: dB }),
        ]),
        h('div', { class: 'fx-col' },
          section('Noise gate', fx.gate, [
            slider({ label: 'Limiar', min: -90, max: 0, step: 1, value: fx.gate.thresholdDb, onInput: (v) => { fx.gate.thresholdDb = v; u(); }, format: dB }),
            slider({ label: 'Release', min: 10, max: 1000, step: 5, value: fx.gate.releaseMs, onInput: (v) => { fx.gate.releaseMs = v; u(); }, format: (v) => `${v} ms` }),
          ]),
          section('Compressor', fx.comp, [
            slider({ label: 'Limiar', min: -60, max: 0, step: 1, value: fx.comp.thresholdDb, onInput: (v) => { fx.comp.thresholdDb = v; u(); }, format: dB }),
            slider({ label: 'Razão', min: 1, max: 20, step: 0.5, value: fx.comp.ratio, onInput: (v) => { fx.comp.ratio = v; u(); }, format: (v) => `${v}:1` }),
            slider({ label: 'Ataque', min: 0.5, max: 100, step: 0.5, value: fx.comp.attackMs, onInput: (v) => { fx.comp.attackMs = v; u(); }, format: (v) => `${v} ms` }),
            slider({ label: 'Release', min: 10, max: 1000, step: 5, value: fx.comp.releaseMs, onInput: (v) => { fx.comp.releaseMs = v; u(); }, format: (v) => `${v} ms` }),
            slider({ label: 'Ganho', min: 0, max: 24, step: 0.5, value: fx.comp.makeupDb, onInput: (v) => { fx.comp.makeupDb = v; u(); }, format: dB }),
          ])),
        h('div', { class: 'fx-col' },
          section('Dobrar a voz', fx.double, [
            h('p', { class: 'muted small' }, 'Duas cópias levemente atrasadas e desafinadas, uma em cada lado: a voz fica mais cheia.'),
            slider({ label: 'Mix', min: 0, max: 1, step: 0.01, value: fx.double.mix, onInput: (v) => { fx.double.mix = v; u(); }, format: pct }),
            slider({ label: 'Abertura', min: 0, max: 1, step: 0.01, value: fx.double.width, onInput: (v) => { fx.double.width = v; u(); }, format: pct }),
            slider({ label: 'Desafinar', min: 0, max: 1, step: 0.01, value: fx.double.detune, onInput: (v) => { fx.double.detune = v; u(); }, format: pct }),
          ]),
          section('Chorus', fx.chorus, [
            slider({ label: 'Velocidade', min: 0.1, max: 5, step: 0.05, value: fx.chorus.rateHz, onInput: (v) => { fx.chorus.rateHz = v; u(); }, format: (v) => `${v.toFixed(2)} Hz` }),
            slider({ label: 'Profundidade', min: 0, max: 1, step: 0.01, value: fx.chorus.depth, onInput: (v) => { fx.chorus.depth = v; u(); }, format: pct }),
            slider({ label: 'Mix', min: 0, max: 1, step: 0.01, value: fx.chorus.mix, onInput: (v) => { fx.chorus.mix = v; u(); }, format: pct }),
          ]),
          section('Distorção', fx.dist, [
            slider({ label: 'Drive', min: 0, max: 1, step: 0.01, value: fx.dist.drive, onInput: (v) => { fx.dist.drive = v; u(); }, format: pct }),
            freqSlider('Tom', 500, 16000, fx.dist.tone, (v) => { fx.dist.tone = v; u(); }),
            slider({ label: 'Nível', min: 0, max: 1.5, step: 0.01, value: fx.dist.level, onInput: (v) => { fx.dist.level = v; u(); }, format: pct }),
          ])),
        h('div', { class: 'fx-col' },
          section('Wah automático', fx.wah, [
            rateField(fx.wah),
            slider({ label: 'Profundidade', min: 0, max: 1, step: 0.01, value: fx.wah.depth, onInput: (v) => { fx.wah.depth = v; u(); }, format: pct }),
            slider({ label: 'Ressonância', min: 0.5, max: 12, step: 0.1, value: fx.wah.q, onInput: (v) => { fx.wah.q = v; u(); }, format: (v) => v.toFixed(1) }),
          ]),
          section('Tremolo', fx.trem, [
            rateField(fx.trem),
            slider({ label: 'Profundidade', min: 0, max: 1, step: 0.01, value: fx.trem.depth, onInput: (v) => { fx.trem.depth = v; u(); }, format: pct }),
          ])),
        h('div', { class: 'fx-col' },
          section('Echo / delay', fx.echo, [
            select({ label: 'Tempo', options: Object.entries(ECHO_SYNC), value: fx.echo.sync, onChange: (v) => { fx.echo.sync = v; u(); render(); } }),
            fx.echo.sync === 'off'
              ? slider({ label: 'Tempo (ms)', min: 10, max: 2000, step: 1, value: fx.echo.timeMs, onInput: (v) => { fx.echo.timeMs = v; u(); }, format: (v) => `${v} ms` })
              : h('p', { class: 'muted small' }, `Sincronizado ao BPM (${app.project.bpm}).`),
            slider({ label: 'Realimentação', min: 0, max: 0.95, step: 0.01, value: fx.echo.feedback, onInput: (v) => { fx.echo.feedback = v; u(); }, format: (v) => `${Math.round(v * 100)}%` }),
            slider({ label: 'Mix', min: 0, max: 1, step: 0.01, value: fx.echo.mix, onInput: (v) => { fx.echo.mix = v; u(); }, format: (v) => `${Math.round(v * 100)}%` }),
            freqSlider('Filtro no retorno', 500, 16000, fx.echo.filterHz, (v) => { fx.echo.filterHz = v; u(); }),
          ]),
          section('Reverb (insert)', fx.reverb, [
            select({ label: 'Tipo', options: Object.entries(REVERB_TYPES), value: fx.reverb.type, onChange: (v) => { fx.reverb.type = v; u(); } }),
            slider({ label: 'Pré-delay', min: 0, max: 200, step: 1, value: fx.reverb.preDelayMs, onInput: (v) => { fx.reverb.preDelayMs = v; u(); }, format: (v) => `${v} ms` }),
            slider({ label: 'Mix', min: 0, max: 1, step: 0.01, value: fx.reverb.mix, onInput: (v) => { fx.reverb.mix = v; u(); }, format: (v) => `${Math.round(v * 100)}%` }),
          ]),
          h('fieldset', { class: 'fx-sec' }, h('legend', null, 'Envio ao reverb compartilhado'),
            slider({ label: 'Envio', min: -60, max: 6, step: 0.5, value: fx.send.reverbDb, onInput: (v) => { fx.send.reverbDb = v; u(); }, format: dB }),
            h('p', { class: 'muted small' }, 'O tipo e o retorno do reverb compartilhado ficam no master.')))),
    );
  };
  render();
  openDialog(`Efeitos — ${ch.name}`, body, { wide: true });
}
