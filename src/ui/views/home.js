// Tela inicial: criar, abrir, duplicar, excluir, exportar e importar projetos (RF-01, RF-05, RC-06).
import { packProject, unpackProject } from '../../engine/archive.js';
import { LAYOUTS } from '../../engine/layout.js';
import { createProject, normalizeProject, TIME_SIGNATURES } from '../../engine/project.js';
import { uid } from '../../engine/util.js';
import { download, h, numberField, safeName, select, toast } from '../dom.js';

export async function renderHome(app, root) {
  let list = [];
  try { list = await app.store.list(); } catch (e) { toast(e.message, 'error'); }
  const refresh = () => renderHome(app, root);

  const items = list.map((it) => h('li', { class: 'project-item' },
    h('button', { class: 'project-open', onClick: () => app.openProject(it.id) },
      h('strong', null, it.name),
      h('span', { class: 'muted' }, `${it.channels} canais · ${it.bpm} BPM · ${it.aspect} · ${new Date(it.updatedAt).toLocaleString('pt-BR')}`)),
    h('div', { class: 'row' },
      h('button', {
        class: 'ghost small', onClick: async () => {
          const p = normalizeProject(await app.store.load(it.id));
          const c = structuredClone(p);
          c.id = uid('p');
          c.name = `${p.name} (cópia)`;
          c.createdAt = Date.now();
          await app.store.duplicate(it.id, c);
          toast('Projeto duplicado.');
          refresh();
        },
      }, 'Duplicar'),
      h('button', {
        class: 'ghost small', title: 'Salvar o projeto como arquivo para abrir em outro navegador', onClick: async () => {
          try {
            const blob = await packProject(app.store, it.id);
            download(blob, `${safeName(it.name)}.mcproj`);
          } catch (e) { toast(`Falha ao exportar: ${e.message}`, 'error'); }
        },
      }, 'Salvar arquivo'),
      h('button', {
        class: 'ghost small danger', onClick: async () => {
          if (!confirm(`Excluir "${it.name}" e todas as tomadas? Isso não pode ser desfeito.`)) return;
          await app.store.remove(it.id);
          refresh();
        },
      }, 'Excluir'))));

  const fileInput = h('input', {
    type: 'file', accept: '.mcproj', hidden: true, onChange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const p = await unpackProject(app.store, f);
        toast(`Projeto "${p.name}" importado.`);
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    },
  });

  root.replaceChildren(h('div', { class: 'home' },
    h('header', { class: 'home-head' },
      h('h1', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 34, height: 34 }), 'MultiCorder'),
      h('p', { class: 'muted' }, 'Vídeos musicais em grade de 2 a 6 canais. Grave um canal de cada vez ouvindo os anteriores, mixe e exporte.')),
    browserNote(app.caps),
    h('div', { class: 'home-grid' },
      newProjectForm(app),
      h('section', { class: 'card' },
        h('div', { class: 'row between' },
          h('h2', null, 'Projetos'),
          h('button', { class: 'ghost small', onClick: () => fileInput.click() }, 'Importar arquivo .mcproj'),
          fileInput),
        items.length ? h('ul', { class: 'project-list' }, items) : h('p', { class: 'muted' }, 'Nenhum projeto ainda. Crie o primeiro ao lado.')))));
}

function browserNote(c) {
  const notes = [];
  if (c.browser.name === 'Firefox' && c.browser.version < 130) notes.push(`Firefox ${c.browser.version}: a exportação precisa do Firefox 130 ou superior (WebCodecs).`);
  if (!c.canExportMp4 && c.canExportWebm) notes.push('Neste navegador/sistema não há codificador H.264/AAC no WebCodecs: a exportação sairá em WebM.');
  if (!c.canExportMp4 && !c.canExportWebm) notes.push('Exportação de vídeo indisponível (sem WebCodecs). Ainda dá para gravar, mixar e exportar o áudio em WAV.');
  notes.push('Use fone de ouvido para gravar: as faixas anteriores não podem vazar no microfone.');
  return h('div', { class: 'notes' }, notes.map((n) => h('p', null, n)));
}

function newProjectForm(app) {
  const f = { name: '', bpm: 100, timeSig: '4/4', channelCount: 4, aspect: '9:16', layoutId: '2x2' };
  const layoutBox = h('div');
  const renderLayout = () => {
    const opts = LAYOUTS[f.channelCount];
    if (!opts.some((o) => o.id === f.layoutId)) f.layoutId = opts[0].id;
    layoutBox.replaceChildren(select({ label: 'Layout', options: opts.map((o) => [o.id, o.label]), value: f.layoutId, onChange: (v) => { f.layoutId = v; } }));
  };
  renderLayout();
  return h('form', {
    class: 'card new-project',
    onSubmit: async (e) => {
      e.preventDefault();
      const p = createProject({ ...f, name: f.name || `Projeto ${new Date().toLocaleDateString('pt-BR')}` });
      await app.store.save(p);
      app.openProject(p.id);
    },
  },
  h('h2', null, 'Novo projeto'),
  h('div', { class: 'field' },
    h('label', { for: 'np-name' }, 'Nome'),
    h('input', { id: 'np-name', placeholder: 'Minha música', onInput: (e) => { f.name = e.target.value; } })),
  h('div', { class: 'row' },
    numberField({ label: 'BPM', value: f.bpm, min: 40, max: 240, onChange: (v) => { f.bpm = Math.round(v); }, width: '5em' }),
    select({ label: 'Compasso', options: TIME_SIGNATURES.map((t) => [t, t]), value: f.timeSig, onChange: (v) => { f.timeSig = v; } })),
  h('div', { class: 'row' },
    select({ label: 'Canais', options: [2, 3, 4, 5, 6].map((n) => [n, n]), value: f.channelCount, onChange: (v) => { f.channelCount = +v; renderLayout(); } }),
    layoutBox),
  select({ label: 'Proporção do vídeo', options: [['9:16', '9:16 (vertical)'], ['1:1', '1:1 (quadrado)'], ['16:9', '16:9 (horizontal)']], value: f.aspect, onChange: (v) => { f.aspect = v; } }),
  h('button', { type: 'submit', class: 'primary' }, 'Criar projeto'));
}
