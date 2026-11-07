// Áudio e configurações: calibração (RNF-02/03), saída (RC-03/RU-07), taxa (RU-05), recursos (RC-01), armazenamento (RNF-09).
import { loadVideoPrefs, mbPerMin, QUALITY, REC_RES, recordBitrate, saveVideoPrefs } from '../../engine/quality.js';
import { calibrateLatency } from '../../engine/calibration.js';
import { ensurePermission, isBluetooth, listDevices } from '../../engine/devices.js';
import { fmtBytes } from '../../engine/util.js';
import { fill, h, numberField, openDialog, select, toast } from '../dom.js';
import { renderInspector } from './inspector.js';

const OUTPUT_HELP = [
  ['Windows', 'Configurações › Sistema › Som › Saída: escolha a sua interface (ex.: “Fones (Focusrite USB)”).'],
  ['macOS', 'Ajustes do Sistema › Som › Saída: escolha a interface. Em Configuração de Áudio e MIDI, deixe a taxa em 48 kHz.'],
  ['Linux', 'Configurações de som (ou pavucontrol) › Saída: escolha a interface como padrão.'],
];

/** Qualidade da câmera e da gravação (vale para todos os projetos neste navegador). */
function videoQualitySection(app, render) {
  const S = app.S;
  const vp = loadVideoPrefs();
  const set = async (k, v) => {
    vp[k] = v;
    saveVideoPrefs(vp);
    // Câmera ligada: reabre para valer já (exceto gravando)
    if (S.armed && S.transport === 'stopped' && (k === 'recRes' || k === 'recFps')) await app.arm();
    render();
  };
  const r = REC_RES[vp.recRes];
  const vs = S.inputInfo?.videoSettings;
  const br = recordBitrate(vs?.width || r.w, vs?.height || r.h, vs?.frameRate || vp.recFps, vp.recQuality);
  return h('section', null,
    h('h3', null, 'Qualidade da câmera (gravação)'),
    h('div', { class: 'row' },
      select({ label: 'Resolução', value: vp.recRes, options: Object.entries(REC_RES).map(([k, x]) => [k, x.label]), onChange: (v) => set('recRes', +v) }),
      select({ label: 'Quadros por segundo', value: vp.recFps, options: [[30, '30'], [60, '60 (movimento mais suave)']], onChange: (v) => set('recFps', +v) }),
      select({ label: 'Qualidade', value: vp.recQuality, options: Object.entries(QUALITY).map(([k, x]) => [k, x.label]), onChange: (v) => set('recQuality', v) })),
    vs
      ? h('p', null, `Câmera agora: ${vs.width}×${vs.height} a ${Math.round(vs.frameRate || 0)} quadros/s`,
        vs.height < r.h || (vs.frameRate || 0) < vp.recFps - 1 ? h('span', { class: 'warn' }, ' — a câmera não oferece o que foi pedido; ela usa o melhor que tem.') : null)
      : h('p', { class: 'muted small' }, 'Ligue a câmera de um canal para ver o que ela entrega de verdade.'),
    h('p', { class: 'muted small' },
      `Gravação a ~${(br / 1e6).toFixed(0)} Mbps ≈ ${Math.round(mbPerMin(br))} MB por minuto por canal. `,
      'Mais qualidade ocupa mais espaço e exige mais do computador; se a gravação engasgar, baixe a resolução ou os quadros. ',
      'Luz boa na cena melhora mais a imagem do que qualquer ajuste aqui.'));
}

export function openSettings(app, focus) {
  const S = app.S;
  const c = app.caps;
  const body = h('div', { class: 'settings' });
  let calibResult = null;
  let calibrating = false;

  const render = async () => {
    const lat = app.latency();
    const l = app.engine.latency();
    let est = null;
    let persisted = false;
    try { est = await app.store.estimate(); persisted = await app.store.persisted(); } catch { /* ok */ }

    const yes = (v, t = 'sim') => h('span', { class: v ? 'ok' : 'bad' }, v ? `✓ ${t}` : '✗ não');
    const outLabel = S.inputInfo?.label;

    fill(body,
      h('section', { id: 'sec-latency' },
        h('h3', null, 'Latência e sincronia'),
        h('p', null, h('strong', null, `${lat.ms.toFixed(1)} ms`), lat.calibrated ? ` — ${lat.method === 'manual' ? 'valor manual' : 'calibrada por loopback'}` : ' — estimada (calibre para chegar a ≤ 5 ms entre canais)'),
        h('p', { class: 'muted small' },
          'Como calibrar: com o fone encostado no microfone (ou um cabo da saída da interface para a entrada 1), clique em Calibrar. ',
          'O app toca 8 cliques e mede quanto tempo cada um leva para voltar. Leva cerca de 5 segundos. Refaça ao trocar de interface, fone ou taxa.'),
        h('div', { class: 'row' },
          h('button', {
            class: 'primary', disabled: calibrating || S.transport !== 'stopped', onClick: async () => {
              calibrating = true;
              calibResult = null;
              render();
              const monitor = S.monitor;
              try {
                if (!S.armed) await app.arm();
                if (!S.armed) throw new Error('A entrada não abriu.');
                app.setMonitor(false);
                const r = await calibrateLatency(app.engine);
                calibResult = r;
                app.setLatency(Math.round(r.latencyMs * 10) / 10, { spreadMs: r.spreadMs, method: 'loopback', input: S.inputInfo?.label });
              } catch (e) {
                calibResult = { error: e.message };
              } finally {
                app.setMonitor(monitor);
                calibrating = false;
                render();
              }
            },
          }, calibrating ? 'Calibrando…' : 'Calibrar (loopback)'),
          numberField({
            label: 'Valor manual (ms)', value: Math.round(lat.ms * 10) / 10, min: 0, max: 1000, step: 0.1, width: '6em',
            onChange: (v) => { app.setLatency(v, { method: 'manual' }); render(); },
          }),
          h('button', { class: 'ghost small', onClick: () => { app.clearLatency(); render(); } }, 'Usar estimativa')),
        calibResult?.error ? h('p', { class: 'warn' }, calibResult.error) : null,
        calibResult && !calibResult.error ? h('p', { class: calibResult.spreadMs > 4 ? 'warn' : 'ok' },
          `Resultado: ${calibResult.latencyMs.toFixed(1)} ms · variação ±${(calibResult.spreadMs / 2).toFixed(1)} ms · ${calibResult.detected}/${calibResult.total} cliques detectados.`,
          calibResult.spreadMs > 4 ? ' Variação alta: aumente o volume, reduza ruído e calibre de novo.' : '') : null,
        h('p', { class: 'muted small' },
          `Navegador informa: baseLatency ${l.baseMs.toFixed(1)} ms, outputLatency ${l.outputMs.toFixed(1)} ms. `,
          c.browser.name === 'Firefox' ? 'No Firefox o outputLatency costuma vir menor que o real; por isso a calibração é obrigatória.' : ''),
        h('p', { class: 'muted small' }, 'A latência vale para as próximas tomadas. Tomadas já gravadas podem ser ajustadas no campo “Sincronia (ms)” de cada canal (−500 a +500 ms; negativo adianta o canal, positivo atrasa).')),

      h('section', null,
        h('h3', null, 'Saída de áudio (fones)'),
        app.engine.canSetSink()
          ? [
            select({
              label: 'Saída', value: S.sinkId || '',
              options: [['', 'Padrão do sistema'], ...S.devices.audioOut.map((d) => [d.id, d.label])],
              onChange: async (v) => {
                try {
                  await app.engine.setSink(v);
                  S.sinkId = v;
                  S.sinkLabel = S.devices.audioOut.find((d) => d.id === v)?.label || 'padrão';
                  try { localStorage.setItem('mc.sink', v); } catch { /* ok */ }
                  if (isBluetooth(S.sinkLabel)) toast('Saída Bluetooth: a latência fica alta e instável. Prefira fone com fio.', 'warn', 10000);
                  render();
                } catch (e) { toast(`Não foi possível trocar a saída: ${e.message}`, 'error'); }
              },
            }),
            h('p', { class: 'muted small' }, 'Este navegador permite escolher a saída dentro do app (AudioContext.setSinkId).'),
          ]
          : [
            h('p', null, `O ${c.browser.name} ainda não permite escolher a saída do Web Audio dentro do app. O som sai pela saída padrão do sistema — defina a sua interface ou fone como padrão:`),
            h('ul', null, OUTPUT_HELP.map(([os, t]) => h('li', null, h('strong', null, `${os}: `), t))),
            h('p', { class: 'muted small' }, 'Depois de trocar a saída padrão, recarregue a página. Evite fones Bluetooth.'),
          ]),

      videoQualitySection(app, render),
      h('section', null,
        h('h3', null, 'Entrada e taxa de amostragem'),
        h('p', null, `Áudio interno do app: ${app.engine.sampleRate} Hz, ponto flutuante de 32 bits.`,
          S.rateFallback ? ' (O dispositivo não aceitou 48 kHz; o app passou a usar a taxa do sistema.)' : ''),
        S.inputInfo
          ? h('p', null, `Entrada aberta: ${outLabel || '—'} · ${S.inputInfo.settings.channelCount ?? '?'} canal(is) entregues · `,
            S.inputInfo.settings.sampleRate ? `${S.inputInfo.settings.sampleRate} Hz` : 'taxa não informada pelo navegador',
            S.inputInfo.settings.sampleRate && S.inputInfo.settings.sampleRate !== app.engine.sampleRate ? h('span', { class: 'warn' }, ' — diferente da taxa do app; ajuste a interface no sistema.') : null)
          : h('p', { class: 'muted' }, 'Nenhuma entrada aberta agora.'),
        h('p', { class: 'muted small' }, 'Os navegadores leem no máximo 2 entradas por dispositivo. Numa interface de 4+ entradas use as entradas 1 e 2 (cada uma pode ir para um canal do app).'),
        h('button', {
          class: 'ghost small', onClick: async () => {
            await ensurePermission();
            S.devices = await listDevices();
            if (S.ui) renderInspector(app, S.ui.inspector);
            render();
          },
        }, 'Atualizar lista de dispositivos'),
        S.devices.audioIn.length ? h('ul', { class: 'small' }, S.devices.audioIn.map((d) => h('li', null, d.label, isBluetooth(d.label) ? h('span', { class: 'warn' }, ' (Bluetooth — evite)') : null))) : null),

      h('section', null,
        h('h3', null, 'Navegador e recursos'),
        h('table', { class: 'caps' }, h('tbody', null,
          [
            ['Navegador', `${c.browser.name} ${c.browser.version}`],
            ['Gravação da câmera', c.recordMime ? h('span', { class: 'ok' }, `✓ ${c.recordMime}`) : yes(false)],
            ['AudioWorklet', yes(c.audioWorklet)],
            ['Armazenamento OPFS', yes(c.opfs)],
            ['WebCodecs', yes(c.webcodecs)],
            ['Exportar MP4', c.canExportMp4 ? h('span', { class: 'ok' }, `✓ ${c.mp4Video} + ${c.mp4Audio}`) : h('span', { class: 'bad' }, '✗ sem codificador H.264/AAC (cai para WebM)')],
            ['Exportar WebM', c.canExportWebm ? h('span', { class: 'ok' }, `✓ ${c.webmVideo} + ${c.webmAudio}`) : yes(false)],
            ['Escolher saída no app (setSinkId)', yes(c.sinkIdAudioContext)],
            ['outputLatency', yes(c.outputLatency)],
          ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))))),

      h('section', null,
        h('h3', null, 'Armazenamento'),
        est ? h('p', null, `Em uso: ${fmtBytes(est.usage)} de ${fmtBytes(est.quota)} disponíveis para o app (livre: ${fmtBytes(est.free)}).`) : h('p', { class: 'muted' }, 'Estimativa indisponível.'),
        h('p', null, persisted ? h('span', { class: 'ok' }, '✓ Armazenamento persistente concedido (o navegador não apaga os projetos sozinho).') : 'Armazenamento não persistente: o navegador pode limpar os dados se faltar espaço.'),
        !persisted ? h('button', { class: 'ghost small', onClick: async () => { const ok = await app.store.persist(); toast(ok ? 'Armazenamento persistente concedido.' : 'O navegador recusou o pedido.', ok ? 'info' : 'warn'); render(); } }, 'Pedir armazenamento persistente') : null,
        h('p', { class: 'muted small' }, 'Tudo fica só neste computador. Nada é enviado para fora sem você exportar.')),
    );
    if (focus === 'latency') body.querySelector('#sec-latency')?.scrollIntoView();
    focus = null;
  };
  openDialog('Áudio e configurações', body, { wide: true });
  render();
}
