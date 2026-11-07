// Exportação (RF-50 a RF-54): vídeo MP4/WebM, WAV do mix e stems, com progresso e cancelamento.
// Fica na coluna da direita da tela do projeto (renderExportPanel), sempre à mão.
import { exportStems, exportVideo, exportWavMix } from '../../engine/exporter.js';
import { WM_POSITIONS } from '../../engine/compositor.js';
import { exportSize } from '../../engine/layout.js';
import { projectDuration } from '../../engine/project.js';
import { EXPORT_RES, exportBitrate, loadVideoPrefs, mbPerMin, QUALITY, saveVideoPrefs } from '../../engine/quality.js';
import { fmtBytes, fmtTime } from '../../engine/util.js';
import { checkbox, download, h, safeName, slider, toast } from '../dom.js';

/**
 * Predefinições por destino. `aspect` muda a proporção do projeto (a grade é montada para ela);
 * null mantém a do projeto. Todas em MP4 (H.264 + AAC), o que as redes e o WhatsApp esperam.
 */
const PRESETS = [
  { id: 'reels', label: 'Reels / TikTok / Shorts', aspect: '9:16', res: 1080, fps: 30, quality: 'alta', hint: 'vertical, 1080×1920' },
  { id: 'youtube', label: 'YouTube', aspect: '16:9', res: 1440, fps: 30, quality: 'alta', hint: 'horizontal, 2560×1440: a partir de 1440p o YouTube costuma comprimir menos' },
  { id: 'instagram', label: 'Instagram (feed)', aspect: '1:1', res: 1080, fps: 30, quality: 'alta', hint: 'quadrado, 1080×1080' },
  { id: 'whatsapp', label: 'WhatsApp', aspect: null, res: 720, fps: 30, quality: 'normal', hint: '720p, arquivo pequeno para mandar' },
];
const ASPECT_NAMES = { '9:16': '9:16 (vertical)', '1:1': '1:1 (quadrado)', '16:9': '16:9 (horizontal)' };

/** Desenha (ou atualiza) o painel de exportação em `el`. Durante uma exportação só o progresso muda. */
export function renderExportPanel(app, el) {
  if (!el._exp || el._exp.project !== app.project) {
    el._exp = buildExport(app, el);
  }
  if (!el._exp.st.busy) el._exp.render();
}

/** Botão "Exportar" da barra de cima: abre a coluna da direita e leva até o botão de exportar. */
export function openExport(app) {
  app.showExportPanel?.();
}

function buildExport(app, body) {
  const p = app.project;
  const c = app.caps;
  const prefs = loadVideoPrefs();
  const st = { format: c.canExportMp4 ? 'mp4' : 'webm', res: prefs.expRes, fps: prefs.expFps, quality: prefs.expQuality, busy: false, ctrl: null };
  const remember = () => { Object.assign(prefs, { expRes: st.res, expFps: st.fps, expQuality: st.quality }); saveVideoPrefs(prefs); };
  body.classList.add('export');
  const prog = h('progress', { max: 1, value: 0 });
  const label = h('span', { class: 'small' });
  const results = h('ul', { class: 'results' });
  // Resumo do que vai sair (refeito a cada desenho: o projeto muda enquanto o painel está aberto)
  const stats = () => {
    const dur = projectDuration(p);
    const recorded = p.channels.filter((ch) => ch.takeId && p.takes[ch.takeId]?.status === 'done');
    if (p.drums?.blocks.length) recorded.push({ name: 'Bateria', solo: p.drums.solo, mute: p.drums.mute });
    const soloed = recorded.filter((ch) => ch.solo);
    const muted = recorded.filter((ch) => ch.mute || (soloed.length && !ch.solo));
    const mixNote = soloed.length
      ? `Solo ligado em ${soloed.map((ch) => ch.name).join(', ')}: só ${soloed.length > 1 ? 'esses canais saem' : 'esse canal sai'} no áudio exportado.`
      : muted.length ? `Sem som na exportação (mute): ${muted.map((ch) => ch.name).join(', ')}.` : null;
    const allSilent = recorded.length > 0 && muted.length === recorded.length && (!p.guide || p.guide.mute);
    return { dur, mixNote, allSilent };
  };
  const mp4Audio = c.mp4Audio === 'opus' ? 'Opus' : 'AAC';

  const addResult = (blob, name, extra = '') => {
    const url = URL.createObjectURL(blob);
    results.append(h('li', null, h('a', { href: url, download: name }, name), ` · ${fmtBytes(blob.size)}${extra}`));
  };

  const setBusy = (b) => { st.busy = b; render(); };

  const run = async (kind) => {
    if (app.S.transport !== 'stopped') { toast('Pare a música (ou a gravação) para exportar.', 'warn'); return; }
    const dur = projectDuration(p);
    st.ctrl = new AbortController();
    setBusy(true);
    prog.value = 0;
    const t0 = performance.now();
    try {
      await app.flushDrums(); // garante o áudio da bateria com a última edição
      if (kind === 'video') {
        const res = await exportVideo({
          project: p, store: app.store, buffers: app.engine.buffers, format: st.format, resolution: st.res, fps: st.fps, quality: st.quality,
          signal: st.ctrl.signal,
          onProgress: (m) => {
            const names = { audio: 'Mixando o áudio…', prepare: 'Preparando…', video: 'Codificando o vídeo…', mux: 'Finalizando o arquivo…' };
            label.textContent = `${names[m.stage] || ''} ${m.stage === 'video' ? `${Math.round(m.p * 100)}%` : ''}`;
            prog.value = m.stage === 'audio' ? m.p * 0.05 : m.stage === 'video' ? 0.05 + m.p * 0.93 : m.stage === 'mux' ? 0.99 : prog.value;
          },
        });
        const secs = (performance.now() - t0) / 1000;
        const ext = res.info.format === 'mp4' ? 'mp4' : 'webm';
        const pre = presetNow();
        const name = `${safeName(p.name)}${pre ? `-${pre.id}` : ''}-${res.info.height >= res.info.width ? res.info.width : res.info.height}p.${ext}`;
        addResult(res.blob, name, ` · ${res.info.width}×${res.info.height} ${res.info.fps} fps · ${(res.info.bitrate / 1e6).toFixed(0)} Mbps · ${res.info.video} + ${res.info.audio} · ${(dur / secs).toFixed(1)}× o tempo real`);
        download(res.blob, name);
        for (const n of res.info.notes) toast(n, 'warn', 12000);
        label.textContent = `Pronto em ${fmtTime(secs)}.`;
      } else if (kind === 'wav') {
        label.textContent = 'Mixando…';
        const blob = await exportWavMix(p, app.engine.buffers);
        const name = `${safeName(p.name)}-mix.wav`;
        addResult(blob, name, ' · 48 kHz / 24 bits');
        download(blob, name);
        label.textContent = 'Pronto.';
      } else if (kind === 'stems') {
        const stems = await exportStems(p, app.engine.buffers, (f, nm) => { prog.value = f; label.textContent = nm ? `Renderizando ${nm}…` : 'Pronto.'; });
        for (const s of stems) {
          const name = `${safeName(p.name)}-${safeName(s.name)}.wav`;
          addResult(s.blob, name);
          download(s.blob, name);
        }
      }
      prog.value = 1;
    } catch (e) {
      if (e.name === 'AbortError') label.textContent = 'Exportação cancelada.';
      else { label.textContent = `Erro: ${e.message}`; console.error(e); }
    } finally {
      st.ctrl = null;
      setBusy(false);
    }
  };

  const presetNow = () => PRESETS.find((x) => (!x.aspect || x.aspect === p.aspect) && x.res === st.res && x.fps === st.fps && x.quality === st.quality && st.format === 'mp4');

  const applyPreset = (x) => {
    st.format = c.canExportMp4 || c.webcodecs ? 'mp4' : 'webm';
    Object.assign(st, { res: x.res, fps: x.fps, quality: x.quality });
    remember();
    st.aspectNote = null;
    if (x.aspect && p.aspect !== x.aspect) {
      st.aspectNote = `A proporção do projeto mudou de ${ASPECT_NAMES[p.aspect]} para ${ASPECT_NAMES[x.aspect]}, e a grade foi remontada (veja a prévia). Ctrl+Z desfaz.`;
      p.aspect = x.aspect;
      app.touch(true);
      app.stage.resize();
    }
    render();
  };

  const presetBlock = () => {
    const cur = presetNow();
    return h('fieldset', null, h('legend', null, 'Para onde vai o vídeo'),
      h('div', { class: 'preset-row' },
        PRESETS.map((x) => h('button', {
          class: `preset${cur === x ? ' on' : ''}`, 'aria-pressed': String(cur === x), disabled: st.busy, title: x.hint,
          onClick: () => applyPreset(x),
        }, h('strong', null, x.label), h('span', { class: 'small muted' }, x.hint)))),
      st.aspectNote ? h('p', { class: 'warn small' }, st.aspectNote) : null,
      cur && mp4Audio === 'Opus' ? h('p', { class: 'warn small' }, `Neste navegador o áudio do MP4 sai em Opus, e ${cur.label} pode receber o vídeo sem som. Exporte pelo Chrome ou Edge para sair em AAC.`) : null,
      h('p', { class: 'muted small' }, 'Escolhe formato, tamanho e qualidade de uma vez. Dá para ajustar à mão logo abaixo.'));
  };

  const radio = (name, value, cur, text, onPick, disabled) => h('label', { class: disabled ? 'disabled' : '' },
    h('input', { type: 'radio', name, value, checked: cur === value, disabled: disabled || st.busy, onChange: () => onPick(value) }), text);

  // Marca d'água: texto ou imagem (logo) por cima do vídeo final; a prévia mostra igual.
  const watermarkBlock = () => {
    const wm = p.watermark;
    const upd = () => app.touch();
    const pickImage = async (file) => {
      if (!file) return;
      try {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height)); // logo pequeno: o projeto guarda a imagem
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k));
        cv.height = Math.max(1, Math.round(bmp.height * k));
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        bmp.close?.();
        wm.image = cv.toDataURL('image/png');
        wm.kind = 'image';
        wm.on = true;
        upd();
        render();
      } catch {
        toast('Não deu para abrir essa imagem. Use PNG, JPG ou WebP.', 'warn');
      }
    };
    return h('fieldset', null, h('legend', null, "Marca d'água"),
      checkbox({ label: "Pôr marca d'água no vídeo (a prévia já mostra como fica)", checked: wm.on, disabled: st.busy, onChange: (v) => { wm.on = v; upd(); render(); } }),
      wm.on ? h('div', { class: 'wm-opts' },
        h('div', { class: 'radio-group' },
          radio('wmk', 'text', wm.kind, 'Texto', (v) => { wm.kind = v; upd(); render(); }),
          radio('wmk', 'image', wm.kind, 'Imagem (logo)', (v) => { wm.kind = v; upd(); render(); })),
        wm.kind === 'text'
          ? h('div', { class: 'row' },
            h('label', { class: 'field' }, 'Texto ', h('input', { type: 'text', value: wm.text, placeholder: '@seu.perfil', maxlength: 80, onInput: (e) => { wm.text = e.target.value; upd(); } })),
            h('label', { class: 'field' }, 'Cor ', h('input', { type: 'color', value: wm.color || '#ffffff', onInput: (e) => { wm.color = e.target.value; upd(); } })))
          : h('div', { class: 'row' },
            wm.image ? h('img', { class: 'wm-thumb', src: wm.image, alt: "Imagem da marca d'água" }) : h('span', { class: 'muted' }, 'Nenhuma imagem escolhida.'),
            h('label', { class: 'ghost button-like' }, wm.image ? 'Trocar imagem…' : 'Escolher imagem…',
              h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true, onChange: (e) => pickImage(e.target.files[0]) })),
            h('span', { class: 'muted small' }, 'PNG com fundo transparente fica melhor.')),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, 'Posição ',
            h('select', { onChange: (e) => { wm.pos = e.target.value; upd(); } },
              Object.entries(WM_POSITIONS).map(([k, t]) => h('option', { value: k, selected: wm.pos === k }, t))))),
        slider({ label: 'Tamanho', min: 4, max: 60, value: wm.size, onInput: (v) => { wm.size = v; upd(); }, format: (v) => `${v}% da largura` }),
        slider({ label: 'Opacidade', min: 10, max: 100, step: 5, value: Math.round(wm.opacity * 100), onInput: (v) => { wm.opacity = v / 100; upd(); }, format: (v) => `${v}%` })) : null);
  };

  const render = () => {
    const { dur, mixNote, allSilent } = stats();
    const [w, hh] = exportSize(p.aspect, st.res);
    body.replaceChildren(...[
      presetBlock(),
      h('fieldset', null, h('legend', null, 'Formato do vídeo'),
        h('div', { class: 'radio-group' },
          radio('fmt', 'mp4', st.format, `MP4 (H.264 + ${mp4Audio})${c.canExportMp4 ? '' : ' — indisponível aqui'}`, (v) => { st.format = v; render(); }, !c.canExportMp4 && !c.webcodecs),
          radio('fmt', 'webm', st.format, `WebM (VP9/VP8 + Opus)${c.canExportWebm ? '' : ' — indisponível'}`, (v) => { st.format = v; render(); }, !c.canExportWebm)),
        !c.canExportMp4 && c.canExportWebm ? h('p', { class: 'muted small' }, 'O WebCodecs deste navegador/sistema não oferece H.264/AAC. Se escolher MP4, o app tenta e cai para WebM automaticamente.') : null,
        c.canExportMp4 && mp4Audio === 'Opus' ? h('p', { class: 'muted small' }, 'Este navegador não tem codificador AAC, então o áudio do MP4 sai em Opus: toca em navegadores e no VLC, mas o player do Windows, o WhatsApp e o iPhone podem abrir sem som. Para esses, exporte pelo Chrome ou Edge.')
          : c.canExportMp4 && c.aacWasm ? h('p', { class: 'muted small' }, 'Áudio AAC gerado por um codificador embutido (baixa cerca de 1 MB na primeira exportação; precisa de internet).') : null),
      h('fieldset', null, h('legend', null, 'Qualidade do vídeo'),
        h('div', { class: 'radio-group' },
          EXPORT_RES.map((r) => radio('res', r, st.res, r === 2160 ? '4K (2160p)' : r === 1440 ? '2K (1440p)' : `${r}p`, (v) => { st.res = +v; remember(); render(); }))),
        h('div', { class: 'radio-group' },
          Object.entries(QUALITY).map(([k, q]) => radio('q', k, st.quality, q.label, (v) => { st.quality = v; remember(); render(); }))),
        h('div', { class: 'radio-group' },
          radio('fps', 30, st.fps, '30 quadros/s', (v) => { st.fps = +v; remember(); render(); }),
          radio('fps', 60, st.fps, '60 quadros/s', (v) => { st.fps = +v; remember(); render(); })),
        (() => {
          const br = exportBitrate(w, hh, st.fps, st.quality);
          const mb = mbPerMin(br + 192000) * Math.max(dur, 1) / 60;
          return h('p', { class: 'muted small' },
            `${(br / 1e6).toFixed(0)} Mbps · arquivo de ~${mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`}. `,
            st.res > 1080 ? 'Acima de 1080p cada quadro da grade fica mais nítido (as câmeras costumam gravar em 1080p: o ganho é maior com poucos canais). Exporta mais devagar; se o computador não aceitar, o app desce a resolução e avisa. ' : '',
            st.fps === 60 ? '60 quadros/s só deixa o movimento mais suave se as câmeras gravaram a 60 (veja Áudio e configurações → Qualidade da câmera). ' : '',
            st.quality === 'maxima' ? 'Máxima gera arquivos grandes; para redes sociais, Alta já basta (elas recomprimem).' : '');
        })()),
      watermarkBlock(),
      // Por último: o resumo do que vai sair, os botões e o progresso
      h('div', { class: 'export-final' },
        dur <= 0
          ? h('p', { class: 'warn' }, 'Grave pelo menos um canal antes de exportar.')
          : h('p', null, `Duração: ${fmtTime(dur)} · grade ${p.channels.length} canais · ${p.aspect} · ${w}×${hh} a ${st.fps} fps`),
        mixNote ? h('div', { class: 'notes' }, allSilent ? `${mixNote} Nenhum canal gravado vai soar.` : mixNote) : null,
        h('div', { class: 'row export-actions' },
          h('button', { class: 'primary', 'data-export-video': '', disabled: st.busy || dur <= 0 || !(c.canExportMp4 || c.canExportWebm), onClick: () => run('video') }, 'Exportar vídeo'),
          h('button', { class: 'ghost', disabled: st.busy || dur <= 0, onClick: () => run('wav') }, 'WAV do mix'),
          h('button', { class: 'ghost', disabled: st.busy || dur <= 0, onClick: () => run('stems') }, 'Faixas separadas (WAV)'),
          st.busy ? h('button', { class: 'ghost danger', onClick: () => st.ctrl?.abort() }, 'Cancelar') : null),
        h('div', { class: 'progress-row' }, prog, label),
        results,
      ),
      h('p', { class: 'muted small' }, 'A exportação roda offline (mais rápido que o tempo real): o áudio é mixado com o mesmo grafo da reprodução e o vídeo é composto e codificado num Worker. Na primeira exportação o app baixa o empacotador MP4/WebM (~30 KB) de cdn.jsdelivr.net.'),
    ].filter((x) => x != null && x !== false));
    app.collapsible?.(body, 'exp'); // seções recolhíveis (lembra quais ficaram fechadas)
  };
  return { project: p, st, render };
}
