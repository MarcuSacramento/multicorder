// Helpers de DOM minúsculos (sem framework).

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (['value', 'checked', 'muted', 'disabled', 'selected', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Troca o conteúdo do elemento ignorando null/false (o replaceChildren nativo escreveria "null"). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

let uidN = 0;
const nextId = () => `f${++uidN}`;

/** Slider com rótulo e leitura de valor (acessível por teclado — RNF-13). */
export function slider({ label, min, max, step = 1, value, onInput, format = (v) => v, vertical = false, title }) {
  const id = nextId();
  const out = h('output', { for: id, class: 'readout' }, format(value));
  const input = h('input', {
    id, type: 'range', min, max, step, value, class: vertical ? 'vertical' : '',
    'aria-label': label, title: title || label,
    'aria-valuetext': String(format(value)),
    onInput: (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = format(v);
      input.setAttribute('aria-valuetext', String(format(v)));
      onInput(v);
    },
  });
  return h('div', { class: `field slider${vertical ? ' v' : ''}` },
    label ? h('label', { for: id }, label) : null, input, out);
}

export function select({ label, options, value, onChange, disabled }) {
  const id = nextId();
  const sel = h('select', { id, disabled, onChange: (e) => onChange(e.target.value), 'aria-label': label },
    options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  return h('div', { class: 'field' }, label ? h('label', { for: id }, label) : null, sel);
}

export function checkbox({ label, checked, onChange, disabled, title }) {
  const id = nextId();
  return h('div', { class: 'field check' },
    h('input', { id, type: 'checkbox', checked, disabled, title, onChange: (e) => onChange(e.target.checked) }),
    h('label', { for: id, title }, label));
}

export function numberField({ label, value, min, max, step = 1, onChange, suffix, width }) {
  const id = nextId();
  return h('div', { class: 'field num' },
    label ? h('label', { for: id }, label) : null,
    h('input', {
      id, type: 'number', value, min, max, step, style: width ? { width } : null,
      onChange: (e) => {
        let v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) v = 0;
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
        e.target.value = v;
        onChange(v);
      },
    }),
    suffix ? h('span', { class: 'suffix' }, suffix) : null);
}

export function openDialog(title, content, { wide = false, onClose } = {}) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-label': title },
    h('header', null,
      h('h2', null, title),
      h('button', { class: 'icon', 'aria-label': 'Fechar', onClick: () => dlg.close() }, '✕')),
    h('div', { class: 'body' }, content));
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dialog: dlg, body: dlg.querySelector('.body'), close: () => dlg.close() };
}

export function toast(msg, kind = 'info', ms = 6000) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

/**
 * Aviso de carregamento em tela cheia com barra de progresso.
 * `set(fração, texto)` atualiza (fração null = indeterminado); `close()` remove.
 */
export function busy(title) {
  const bar = h('progress', { max: 1 });
  const pct = h('span', { class: 'busy-pct' }, '');
  const detail = h('p', { class: 'muted busy-detail' }, '');
  const el = h('div', { class: 'busy-overlay', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'busy-card' },
      h('strong', null, title),
      h('div', { class: 'progress-row' }, bar, pct),
      detail));
  document.body.append(el);
  return {
    set(frac, text) {
      if (frac == null) { bar.removeAttribute('value'); pct.textContent = ''; }
      else { const f = Math.max(0, Math.min(1, frac)); bar.value = f; pct.textContent = `${Math.round(f * 100)}%`; }
      if (text != null) detail.textContent = text;
    },
    close() { el.remove(); },
  };
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const safeName = (s) => (s || 'projeto').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'projeto';

/** Medidor vertical/horizontal em canvas: escala de -60 a +6 dB, pico, RMS e clip. */
export function drawMeter(canvas, peak, rms, held, clip) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const vertical = H > W;
  const pos = (lin) => {
    const db = lin > 0 ? 20 * Math.log10(lin) : -100;
    return Math.max(0, Math.min(1, (db + 60) / 66));
  };
  g.fillStyle = '#0c0f16';
  g.fillRect(0, 0, W, H);
  const r = pos(rms), p = pos(peak), hp = pos(held);
  const zero = pos(1);
  const grad = vertical ? g.createLinearGradient(0, H, 0, 0) : g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#2fbf71');
  grad.addColorStop(0.75, '#d6c43c');
  grad.addColorStop(zero, '#e8833a');
  grad.addColorStop(1, '#ff3b4a');
  g.fillStyle = grad;
  g.globalAlpha = 0.45;
  if (vertical) g.fillRect(0, H - p * H, W, p * H); else g.fillRect(0, 0, p * W, H);
  g.globalAlpha = 1;
  if (vertical) g.fillRect(0, H - r * H, W, r * H); else g.fillRect(0, 0, r * W, H);
  g.fillStyle = '#fff';
  if (vertical) g.fillRect(0, H - hp * H, W, 1.5); else g.fillRect(hp * W, 0, 1.5, H);
  g.fillStyle = 'rgba(255,255,255,.35)';
  if (vertical) g.fillRect(0, H - zero * H, W, 1); else g.fillRect(zero * W, 0, 1, H);
  if (clip) {
    g.fillStyle = '#ff3b4a';
    if (vertical) g.fillRect(0, 0, W, 4); else g.fillRect(W - 4, 0, 4, H);
  }
}

/**
 * Seções recolhíveis: cada <fieldset> com <legend> dentro de `root` ganha uma seta ▾/▸ no título.
 * O app lembra quais ficaram fechadas (por `prefix` + título), também depois de redesenhar.
 */
export function collapsible(root, prefix) {
  for (const fs of root.querySelectorAll('fieldset')) {
    const lg = fs.querySelector(':scope > legend');
    if (!lg || lg.querySelector('.fold')) continue;
    const name = lg.textContent.trim().slice(0, 40);
    const key = `mc.fold.${prefix}.${name}`;
    const set = (closed) => {
      fs.classList.toggle('folded', closed);
      btn.textContent = closed ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!closed));
    };
    const btn = h('button', {
      class: 'fold', type: 'button', title: 'Recolher / abrir esta seção', 'aria-label': `Recolher ou abrir: ${name}`,
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const closed = !fs.classList.contains('folded');
        try { localStorage.setItem(key, closed ? '1' : '0'); } catch { /* ok */ }
        set(closed);
      },
    });
    lg.prepend(btn);
    set(localStorage.getItem(key) === '1');
  }
}
