// RC-06: exportar/importar o projeto inteiro como um arquivo .mcproj (abre em qualquer navegador).
// Formato: "MCPROJ01" | u32 LE tamanho do cabeçalho | cabeçalho JSON | bytes dos arquivos em sequência.
import { normalizeProject } from './project.js';
import { uid } from './util.js';

const MAGIC = 'MCPROJ01';

export async function packProject(store, pid) {
  const files = await store.walk(pid);
  const header = { format: MAGIC, files: files.map((f) => ({ path: f.path, size: f.file.size })) };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const len = new DataView(new ArrayBuffer(4));
  len.setUint32(0, hb.length, true);
  return new Blob([new TextEncoder().encode(MAGIC), len.buffer, hb, ...files.map((f) => f.file)], {
    type: 'application/octet-stream',
  });
}

/** Importa como projeto novo (id novo), para nunca sobrescrever um existente. */
export async function unpackProject(store, blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) throw new Error('Arquivo não é um projeto do Multicorder (.mcproj).');
  const hlen = new DataView(head.buffer).getUint32(8, true);
  const header = JSON.parse(await blob.slice(12, 12 + hlen).text());
  let off = 12 + hlen;
  let projectJson = null;
  const id = uid('p');
  for (const f of header.files) {
    const part = blob.slice(off, off + f.size);
    off += f.size;
    if (f.path === 'project.json') projectJson = await part.text();
    else await store.writePath(id, f.path, part);
  }
  if (!projectJson) { await store.remove(id).catch(() => {}); throw new Error('Arquivo sem project.json.'); }
  const p = normalizeProject(JSON.parse(projectJson));
  p.id = id;
  await store.save(p);
  return p;
}
