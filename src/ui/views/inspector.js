// Painel do canal selecionado: câmera, entrada, modo L/R/estéreo, ganho, medidores, monitoração, imagem e tomada.
import { detectPitch, noteFromFreq, smoothPitch } from '../../engine/pitch.js';
import { fmtDb, gainToDb } from '../../engine/util.js';
import { checkbox, collapsible, drawMeter, fill, h, numberField, select, slider } from '../dom.js';
import { openFx } from './fx.js';

export function renderInspector(app, el) {
  const S = app.S;
  const p = app.project;
  const ch = app.selected();
  if (!p || !ch) { el.replaceChildren(); return; }
  const idx = p.channels.indexOf(ch);
  const busy = S.transport !== 'stopped';
  const take = ch.takeId && p.takes[ch.takeId];
  const armedHere = S.armed && S.armedChannelId === ch.id;
  const info = S.inputInfo;
  const stereoOk = (info?.settings?.channelCount ?? 2) >= 2;
  const reArm = () => { if (S.armed) app.arm(); };
  const lat = app.latency();

  const devV = S.devices.videoIn;
  const devA = S.devices.audioIn;

  const modes = [['L', 'Entrada 1 (L)'], ['R', 'Entrada 2 (R)'], ['stereo', 'Estéreo (L+R)']];
  const inputMode = h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Entrada física da interface' },
    modes.map(([v, t]) => h('label', null,
      h('input', {
        type: 'radio', name: `inmode-${ch.id}`, value: v, checked: ch.inputMode === v,
        disabled: busy || (v !== 'L' && !stereoOk),
        onChange: () => { ch.inputMode = v; app.touch(); app.reloadChannelAudio(ch); },
      }), t)));

  const meterRow = (k, label) => h('div', { class: 'in-meter' },
    h('span', null, label),
    h('canvas', { width: 220, height: 10, 'data-in': k, 'aria-hidden': 'true' }),
    h('span', { class: 'db', 'data-db': k, title: 'Pico recente em dBFS (0 = máximo)' }, '−∞'),
    h('span', { class: 'clip', 'data-clip': k }, 'CLIP'));

  const others = p.channels.filter((c) => c.id !== ch.id);

  fill(el,
    h('div', { class: 'row between' },
      h('h2', null, `Canal ${idx + 1}`),
      h('button', { class: 'ghost small', onClick: () => openFx(app, ch.id) }, 'Efeitos…')),
    h('input', {
      class: 'ch-name', value: ch.name, 'aria-label': 'Nome do canal',
      onChange: (e) => { ch.name = e.target.value.trim() || `Canal ${idx + 1}`; app.touch(true); },
    }),
    p.drums ? select({
      label: 'O quadro mostra', value: ch.show || 'video',
      options: [['video', 'Câmera / vídeo gravado'], ['drums', 'Pads da bateria (animados)']],
      onChange: (v) => { ch.show = v; app.touch(true); },
    }) : null,
    p.drums && ch.show === 'drums' ? h('p', { class: 'muted small' },
      'Este quadro só mostra a bateria: o canal fica fora da mixagem (sem strip e sem som da tomada). O volume da bateria fica no strip "Bateria".') : null,
    h('div', { class: 'row' },
      armedHere
        ? h('button', { class: 'ghost', onClick: () => app.disarm(), disabled: busy }, 'Desligar câmera e entrada')
        : h('button', { class: 'primary', onClick: () => app.arm(), disabled: S.arming || busy }, S.arming ? 'Abrindo…' : 'Ligar câmera e entrada')),
    armedHere && info
      ? h('p', { class: 'muted small' },
        `${info.label || 'Entrada'} · ${info.settings.channelCount ?? '?'} canal(is) · ${info.settings.sampleRate ? `${info.settings.sampleRate} Hz` : `${app.engine.sampleRate} Hz`}`,
        info.videoSettings ? ` · câmera ${info.videoSettings.width}×${info.videoSettings.height}` : ' · sem câmera')
      : h('p', { class: 'muted small' }, 'Ligue a entrada para ver a câmera, medir o nível e gravar.'),

    h('fieldset', null, h('legend', null, 'Entrada'),
      select({
        label: 'Câmera', value: ch.videoDeviceId, disabled: busy,
        options: [['', 'Padrão'], ...devV.map((d) => [d.id, d.label]), ['none', 'Sem vídeo (só áudio)']],
        onChange: (v) => { ch.videoDeviceId = v; if (v) p.inputDefaults.videoDeviceId = v; app.touch(); reArm(); },
      }),
      select({
        label: 'Entrada de áudio', value: ch.audioDeviceId, disabled: busy,
        options: [['', 'Padrão do sistema'], ...devA.map((d) => [d.id, d.label])],
        onChange: (v) => { ch.audioDeviceId = v; p.inputDefaults.audioDeviceId = v; app.touch(); reArm(); },
      }),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Entrada física'), inputMode),
      !stereoOk ? h('p', { class: 'muted small' }, 'O dispositivo entregou 1 canal: só a Entrada 1 está disponível.') : null,
      slider({
        label: 'Ganho digital', min: -24, max: 24, step: 0.5, value: ch.inputGainDb,
        onInput: (v) => { ch.inputGainDb = v; app.touch(); }, format: (v) => `${fmtDb(v)} dB`,
        title: 'Ganho digital do canal. O ganho analógico fica na interface.',
      }),
      h('div', { class: 'in-meters', 'aria-label': 'Nível das entradas físicas' }, meterRow('L', '1 · L'), meterRow('R', '2 · R')),
      h('p', { class: 'clip-msg small', 'data-clipmsg': '', hidden: true, role: 'status' }),
      armedHere ? levelTestBlock(app, ch) : null,
      checkbox({ label: 'Ouvir a entrada no fone (monitoração)', checked: S.monitor, onChange: (v) => { app.setMonitor(v); renderInspector(app, el); } }),
      S.monitor ? h('p', { class: lat.ms > 20 ? 'warn small' : 'muted small' },
        `Latência de monitoração ≈ ${Math.round(lat.ms)} ms${lat.calibrated ? '' : ' (estimada)'}. `,
        lat.ms > 20 ? 'Acima de 20 ms o atraso incomoda; prefira a monitoração direta da interface.' : '') : null,
      select({
        label: 'Gravar junto com (entrada 2)', value: ch.linkWith || '', disabled: busy,
        options: [['', '—'], ...others.map((c) => [c.id, c.name])],
        onChange: (v) => {
          ch.linkWith = v || null;
          const o = others.find((c) => c.id === v);
          if (o && o.inputMode === ch.inputMode) {
            if (ch.inputMode === 'stereo') ch.inputMode = 'L';
            o.inputMode = ch.inputMode === 'L' ? 'R' : 'L';
            app.reloadChannelAudio(o);
            app.reloadChannelAudio(ch);
          }
          app.touch(true);
        },
      }),
      ch.linkWith ? h('p', { class: 'muted small' }, 'Os dois canais são gravados na mesma tomada, cada um com a sua entrada física (ex.: voz na 1, violão na 2) e a mesma câmera.') : null),

    armedHere ? tunerBlock(app, ch) : null,

    h('fieldset', null, h('legend', null, 'Imagem'),
      checkbox({ label: 'Espelhar imagem', checked: ch.mirror, onChange: (v) => { ch.mirror = v; app.touch(); } }),
      slider({ label: 'Zoom', min: 1, max: 3, step: 0.05, value: ch.zoom, onInput: (v) => { ch.zoom = v; app.touch(); }, format: (v) => `${v.toFixed(2)}×` }),
      slider({ label: 'Posição horizontal', min: -1, max: 1, step: 0.02, value: ch.panX, onInput: (v) => { ch.panX = v; app.touch(); }, format: (v) => v.toFixed(2) }),
      slider({ label: 'Posição vertical', min: -1, max: 1, step: 0.02, value: ch.panY, onInput: (v) => { ch.panY = v; app.touch(); }, format: (v) => v.toFixed(2) })),

    h('fieldset', null, h('legend', null, 'Tomada'),
      take
        ? [
          h('p', { class: 'small' },
            `${(take.frames / take.sampleRate).toFixed(1)} s · ${take.hasVideo ? 'vídeo + áudio' : 'só áudio'} · latência compensada ${Math.round(take.latencyMs)} ms${take.latencyCalibrated ? '' : ' (estimada)'}`,
            take.recovered ? ' · recuperada após interrupção' : ''),
          takeClips(take, ch) ? h('p', { class: 'warn small' },
            `⚠ A tomada saturou ${takeClips(take, ch)} vez${takeClips(take, ch) > 1 ? 'es' : ''} (clipping). Se der para ouvir a distorção, abaixe o ganho da interface e regrave o trecho.`) : null,
          h('div', { class: 'row' },
            numberField({ label: 'Sincronia (ms)', value: ch.offsetMs, min: -500, max: 500, step: 1, onChange: (v) => app.setChannelTiming(ch, { offsetMs: v }), width: '5em' }),
            numberField({ label: 'Corte início (s)', value: ch.trimStart, min: 0, step: 0.1, onChange: (v) => app.setChannelTiming(ch, { trimStart: v }), width: '5em' }),
            numberField({ label: 'Corte fim (s)', value: ch.trimEnd, min: 0, step: 0.1, onChange: (v) => app.setChannelTiming(ch, { trimEnd: v }), width: '5em' })),
          punchBlock(app, ch, busy),
          h('button', { class: 'ghost small danger', disabled: busy, onClick: () => app.deleteTake(ch) }, 'Apagar tomada'),
        ]
        : h('p', { class: 'muted small' }, 'Nenhuma tomada ainda. Pressione R ou “● Gravar”. A contagem começa e os outros canais tocam junto.'),
      altTakesBlock(app, ch, busy)),
    take ? cleanBlock(app, ch) : null,
  );
  collapsible(el, 'canal');
  el._meters = {
    L: el.querySelector('[data-in=L]'), R: el.querySelector('[data-in=R]'),
    cL: el.querySelector('[data-clip=L]'), cR: el.querySelector('[data-clip=R]'),
    dL: el.querySelector('[data-db=L]'), dR: el.querySelector('[data-db=R]'),
    msg: el.querySelector('[data-clipmsg]'),
    tuner: el.querySelector('.tuner-display'),
  };
  el._state = { L: { held: 0, clipUntil: 0, dbAt: 0 }, R: { held: 0, clipUntil: 0, dbAt: 0 } };
}

/** Punch-in: regravar só o trecho do loop, e a lista dos trechos já regravados. */
/**
 * Som da gravação: limpeza (chiado, estalos, puffs, partes sem som) e tom. É processado fora da tela a
 * partir do arquivo gravado, que não muda; vale para tocar e para exportar.
 */
function cleanBlock(app, ch) {
  const c = ch.clean;
  const set = () => app.setClean(ch);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const info = app.S.cleanInfo?.get(ch.id);
  const done = info ? [
    info.clicks ? `${info.clicks} estalo${info.clicks > 1 ? 's' : ''} corrigido${info.clicks > 1 ? 's' : ''}` : null,
    info.puffs ? `${info.puffs} puff${info.puffs > 1 ? 's' : ''} abafado${info.puffs > 1 ? 's' : ''}` : null,
    info.mutedSec ? `${info.mutedSec.toFixed(1).replace('.', ',')} s silenciados` : null,
  ].filter(Boolean) : [];
  const toggle = (label, o, title) => checkbox({ label, checked: o.on, title, onChange: (v) => { o.on = v; set(); renderInspector(app, app.S.ui.inspector); } });
  const semis = c.pitch.semis || 0;
  return h('fieldset', { class: 'clean' }, h('legend', null, 'Som da gravação'),
    h('p', { class: 'muted small' }, 'Limpeza e tom feitos pelo app a partir do arquivo gravado, que não muda. Valem para tocar e para exportar.'),
    toggle('Tirar chiado e ruído de fundo', c.denoise, 'Aprende o ruído nos trechos mais silenciosos da tomada e tira ele do som todo'),
    c.denoise.on ? slider({ label: 'Força', min: 0, max: 1, step: 0.05, value: c.denoise.amount, onInput: (v) => { c.denoise.amount = v; set(); }, format: pct }) : null,
    toggle('Tirar estalos', c.declick, 'Corrige estalos curtos (cliques digitais, mau contato)'),
    c.declick.on ? slider({ label: 'Sensibilidade', min: 0, max: 1, step: 0.05, value: c.declick.amount, onInput: (v) => { c.declick.amount = v; set(); }, format: pct }) : null,
    toggle('Tirar puffs (sopro do “p” e do “b”)', c.deplosive, 'Abaixa só o grave nas rajadas de ar no microfone'),
    c.deplosive.on ? slider({ label: 'Força', min: 0, max: 1, step: 0.05, value: c.deplosive.amount, onInput: (v) => { c.deplosive.amount = v; set(); }, format: pct }) : null,
    toggle('Silenciar sozinho as partes sem som', c.strip, 'Os trechos que são só ruído entre as frases ficam mudos (com rampa suave)'),
    c.strip.on ? h('div', null,
      slider({ label: 'Abaixo de', min: -75, max: -20, step: 1, value: c.strip.thresholdDb, onInput: (v) => { c.strip.thresholdDb = v; set(); }, format: (v) => `${v} dB` }),
      slider({ label: 'Por mais de', min: 100, max: 2000, step: 50, value: c.strip.holdMs, onInput: (v) => { c.strip.holdMs = v; set(); }, format: (v) => `${v} ms` })) : null,
    h('div', { class: 'row' },
      slider({
        label: 'Tom', min: -12, max: 12, step: 1, value: semis,
        onInput: (v) => { c.pitch.semis = v; set(); },
        format: (v) => (v ? `${v > 0 ? '+' : '−'}${Math.abs(v)} ${Math.abs(v) > 1 ? 'semitons' : 'semitom'}` : 'original'),
      }),
      slider({ label: 'Ajuste fino', min: -50, max: 50, step: 1, value: c.pitch.cents || 0, onInput: (v) => { c.pitch.cents = v; set(); }, format: (v) => `${v > 0 ? '+' : ''}${v} cents` })),
    semis || c.pitch.cents ? h('p', { class: 'muted small' }, 'O tom muda sem mudar a velocidade. Ex.: +2 transforma um Dó em Ré. O vídeo não muda.') : null,
    done.length ? h('p', { class: 'small ok' }, `✓ ${done.join(' · ')}.`) : null);
}

/** Outras tomadas do canal (as gravadas antes): usar no lugar, usar só no trecho do loop ou apagar. */
function altTakesBlock(app, ch, busy) {
  const p = app.project;
  const list = (ch.altTakes || []).filter((x) => p.takes[x.takeId]?.status === 'done');
  if (!list.length) return null;
  const r = app.punchRange();
  return h('div', { class: 'alt-takes' },
    h('div', { class: 'small' }, h('strong', null, `Outras tomadas (${list.length})`),
      h('span', { class: 'muted' }, ' · gravar de novo guarda a atual aqui')),
    h('ul', { class: 'punch-list' },
      ch.altTakes.map((x, i) => {
        const t = p.takes[x.takeId];
        if (t?.status !== 'done') return null;
        const inUse = (ch.punches || []).some((q) => q.takeId === x.takeId);
        return h('li', null,
          h('span', null, `${app.takeWhen(t)} · ${(t.frames / t.sampleRate).toFixed(1)} s${t.hasVideo ? '' : ' · só áudio'}${inUse ? ' · trecho em uso' : ''}`),
          h('span', { class: 'alt-btns' },
            h('button', { class: 'ghost small', disabled: busy, title: 'Usar esta tomada no canal inteiro (a atual vai para a lista)', onClick: () => app.useAltTake(ch, i) }, 'Usar esta'),
            h('button', {
              class: 'ghost small', disabled: busy || !r || !ch.takeId,
              title: r ? `Usar esta tomada só nos compassos ${app.punchLabel(r)} (o trecho do loop); vira um punch-in` : 'Escolha o trecho arrastando sobre os números dos compassos na régua',
              onClick: () => app.useAltTakeInLoop(ch, i),
            }, r ? `Usar em ${app.punchLabel(r)}` : 'Usar no trecho'),
            h('button', { class: 'icon small', disabled: busy, title: 'Apagar esta tomada', 'aria-label': 'Apagar esta tomada', onClick: () => app.deleteAltTake(ch, i) }, '×')));
      })));
}

function punchBlock(app, ch, busy) {
  const p = app.project;
  const r = app.punchRange();
  const pre = Math.max(1, p.countInBars);
  const list = ch.punches || [];
  return h('div', { class: 'punch' },
    h('button', {
      class: 'rec small', disabled: busy || !r, onClick: () => app.startPunch(),
      title: 'Atalho: Shift+R',
    }, r ? `● Punch-in nos compassos ${app.punchLabel(r)}` : '● Punch-in'),
    h('p', { class: 'muted small' },
      'Regrava só o trecho do loop (arraste sobre os números da régua para escolher). ',
      `Toca ${pre} compasso${pre > 1 ? 's' : ''} antes com a tomada atual, para você entrar no tempo, e para sozinho no fim do trecho. O vídeo também troca no trecho.`),
    list.length ? h('ul', { class: 'punch-list' },
      list.map((x, i) => h('li', null,
        h('span', null, `Compassos ${app.punchLabel(x)}`),
        h('button', { class: 'icon small', disabled: busy, title: 'Remover este punch-in', 'aria-label': `Remover punch-in dos compassos ${app.punchLabel(x)}`, onClick: () => app.removePunch(ch, i) }, '×')))) : null,
    list.length > 1 ? h('button', { class: 'ghost small', disabled: busy, onClick: () => app.removePunch(ch) }, 'Remover todos os punch-ins') : null);
}

const LEVEL_TARGET_DB = -10;

/** Teste de nível: o músico toca a parte mais forte por alguns segundos e o app sugere o ajuste. */
function levelTestBlock(app, ch) {
  const S = app.S;
  const t = S.levelTest;
  const running = t && t.channelId === ch.id && !t.done;
  const res = t && t.channelId === ch.id && t.done ? t : null;
  let result = null;
  if (res) {
    const pk = res.peakDb;
    const gainFix = Math.max(-24, Math.min(24, Math.round((LEVEL_TARGET_DB - pk) * 2) / 2));
    let kind = 'ok';
    let text;
    if (!Number.isFinite(pk) || pk < -45) {
      kind = 'warn';
      text = 'Quase nenhum sinal. Confira o cabo, a entrada física escolhida (1, 2 ou estéreo) e o ganho da interface.';
    } else if (res.clipped || pk >= -0.3) {
      kind = 'bad';
      text = `Saturou (pico ${fmtDb(pk)} dB). Abaixe o ganho na interface uns 6 a 10 dB e teste de novo. O Ganho digital não resolve: ele age depois da saturação.`;
    } else if (pk > -4) {
      kind = 'warn';
      text = `Pico ${fmtDb(pk)} dB: sem saturar, mas sem folga. Abaixe uns ${Math.round(pk - LEVEL_TARGET_DB)} dB na interface para não estourar numa nota mais forte.`;
    } else if (pk >= -20) {
      text = `Pico ${fmtDb(pk)} dB: bom nível (o ideal fica entre −12 e −6 dB).`;
    } else {
      kind = 'warn';
      text = `Pico ${fmtDb(pk)} dB: baixo. O melhor é subir uns ${Math.round(LEVEL_TARGET_DB - pk)} dB no ganho da interface; se não der, compense no Ganho digital.`;
    }
    const canFix = Number.isFinite(pk) && pk >= -45 && pk < -20 && Math.abs(gainFix - ch.inputGainDb) >= 0.5;
    result = h('div', { class: `level-result ${kind}` },
      h('p', { class: 'small' }, text),
      canFix ? h('button', {
        class: 'ghost small',
        onClick: () => { ch.inputGainDb = gainFix; S.levelTest = null; app.touch(true); },
      }, `Usar Ganho digital ${fmtDb(gainFix)} dB`) : null);
  }
  return h('div', { class: 'level-test' },
    h('button', {
      class: 'ghost small', disabled: running || S.transport === 'recording',
      onClick: () => app.startLevelTest(ch),
      title: 'Toque ou cante a parte mais forte da música durante 8 segundos.',
    }, running ? 'Testando… toque a parte mais forte' : 'Testar nível (8 s)'),
    result);
}

/** Afinador da entrada do canal (cromático, referência ajustável). */
function tunerBlock(app, ch) {
  const on = !!app.S.tunerOn;
  return h('fieldset', null, h('legend', null, 'Afinador'),
    h('div', { class: 'row between' },
      checkbox({ label: 'Ligar afinador', checked: on, onChange: (v) => app.setTuner(v) }),
      on ? numberField({
        label: 'Lá =', value: app.tunerA4(), min: 415, max: 466, step: 1, suffix: 'Hz', width: '4em',
        onChange: (v) => app.setTunerA4(v),
      }) : null),
    on ? h('div', { class: 'tuner-display idle' },
      h('div', { class: 'tuner-note' }, '—'),
      h('div', { class: 'tuner-scale', 'aria-hidden': 'true' }, h('span', { class: 'tick' }), h('span', { class: 'needle' })),
      h('div', { class: 'tuner-info small muted' }, 'Toque uma nota sozinha')) : null,
    on ? h('p', { class: 'muted small' },
      `Lê ${ch.inputMode === 'stereo' ? 'a soma das entradas 1 e 2' : `a Entrada ${ch.inputMode === 'R' ? '2' : '1'}`}. Toque uma nota de cada vez e deixe soar.`) : null);
}

/** Atualiza o afinador (chamado no laço de desenho; calcula ~15 vezes por segundo). */
function updateTuner(app, el) {
  const S = app.S;
  const d = el._meters?.tuner;
  if (!d || !S.tunerOn) return;
  const now = performance.now();
  if (now - (S.tunerAt || 0) < 66) return;
  S.tunerAt = now;
  const ch = app.selected();
  const buf = app.engine.tunerSamples(ch?.inputMode || 'L');
  if (!buf) return;
  S.tunerState ??= {};
  const f = smoothPitch(S.tunerState, detectPitch(buf, app.engine.sampleRate));
  const noteEl = d.querySelector('.tuner-note');
  const needle = d.querySelector('.needle');
  const info = d.querySelector('.tuner-info');
  if (!f) {
    d.classList.remove('in', 'near');
    d.classList.add('idle');
    info.textContent = 'Toque uma nota sozinha';
    return;
  }
  const n = noteFromFreq(f, app.tunerA4());
  const c = n.cents;
  const inTune = Math.abs(c) <= 5;
  d.classList.remove('idle');
  d.classList.toggle('in', inTune);
  d.classList.toggle('near', !inTune && Math.abs(c) <= 15);
  noteEl.replaceChildren(n.name, h('sub', null, String(n.octave)), h('span', { class: 'letter' }, `${n.letter}${n.octave}`));
  needle.style.left = `${50 + Math.max(-50, Math.min(50, c))}%`;
  info.textContent = `${f.toFixed(1)} Hz · ${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(0)} cents · ${inTune ? 'afinado' : c < 0 ? 'baixo: suba a afinação' : 'alto: desça a afinação'}`;
}

/** RF-17: medidor da entrada com indicação de clip (antes e durante a gravação). */
export function updateInputMeters(app, el) {
  const m = el._meters;
  if (!m?.L) return;
  const lv = app.engine.inputLevels() || { L: 0, R: 0 };
  const now = performance.now();
  const used = usedInputs(app.selected());
  const clipping = [];
  for (const k of ['L', 'R']) {
    const st = el._state[k];
    const peak = lv[k];
    st.held = Math.max(peak, st.held * 0.96);
    if (peak >= 0.99) st.clipUntil = now + 2000;
    const clip = now < st.clipUntil;
    drawMeter(m[k], peak, peak * 0.7, st.held, clip);
    const c = k === 'L' ? m.cL : m.cR;
    if (c.classList.contains('on') !== clip) c.classList.toggle('on', clip);
    // Pico em dB (o valor segurado), ~8 vezes por segundo para dar para ler.
    const dEl = k === 'L' ? m.dL : m.dR;
    if (dEl && now - st.dbAt > 120) {
      st.dbAt = now;
      dEl.textContent = app.engine.inputOpen ? fmtDb(gainToDb(st.held)) : '−∞';
      dEl.classList.toggle('hot', st.held >= 0.5);
    }
    if (clip && used.includes(k)) clipping.push(k === 'L' ? '1' : '2');
  }
  if (m.msg) {
    const text = clipping.length
      ? `A entrada ${clipping.join(' e ')} está saturando. Abaixe o ganho na interface (o Ganho digital não resolve: ele age depois da saturação).`
      : '';
    if (m.msg.textContent !== text) { m.msg.textContent = text; m.msg.hidden = !text; }
  }
  updateTuner(app, el);
}

/** Quantas vezes a tomada saturou nas entradas que o canal usa. */
export const takeClips = (take, ch) => (take?.clips ? usedInputs(ch).reduce((s, k) => s + (take.clips[k] || 0), 0) : 0);

/** Entradas físicas que o canal grava: ['L'], ['R'] ou ['L', 'R']. */
export const usedInputs = (ch) => (ch?.inputMode === 'stereo' ? ['L', 'R'] : [ch?.inputMode === 'R' ? 'R' : 'L']);
