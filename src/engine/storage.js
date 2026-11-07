// Armazenamento local em OPFS (RF-05, RNF-09, RNF-10).
// Estrutura: projects/<id>/project.json, projects/<id>/takes/<takeId>/a-000001.f32 | v-000001.webm, projects/<id>/guide.bin
import { referencedTakes } from './project.js';

const pad = (n) => String(n).padStart(6, '0');

export class ProjectStore {
  async init() {
    if (!navigator.storage?.getDirectory) {
      throw new Error('Este navegador não oferece OPFS (armazenamento local). Em janela privada do Firefox o OPFS fica desativado.');
    }
    this.root = await navigator.storage.getDirectory();
    this.dir = await this.root.getDirectoryHandle('projects', { create: true });
  }

  async _pdir(id, create = true) { return this.dir.getDirectoryHandle(id, { create }); }

  async _takesDir(pid, create = true) {
    const p = await this._pdir(pid, create);
    return p.getDirectoryHandle('takes', { create });
  }

  async _takeDir(pid, tid, create = true) {
    const t = await this._takesDir(pid, create);
    return t.getDirectoryHandle(tid, { create });
  }

  async _write(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close(); // gravação atômica: o arquivo só muda no close
  }

  async list() {
    const out = [];
    for await (const [, h] of this.dir.entries()) {
      if (h.kind !== 'directory') continue;
      try {
        const f = await (await h.getFileHandle('project.json')).getFile();
        const p = JSON.parse(await f.text());
        out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, channels: p.channels.length, aspect: p.aspect, bpm: p.bpm });
      } catch { /* pasta sem projeto válido */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id) {
    const d = await this._pdir(id, false);
    const f = await (await d.getFileHandle('project.json')).getFile();
    return JSON.parse(await f.text());
  }

  async save(p) {
    p.updatedAt = Date.now();
    const d = await this._pdir(p.id);
    await this._write(d, 'project.json', JSON.stringify(p));
  }

  async remove(id) {
    await this.dir.removeEntry(id, { recursive: true });
  }

  async _copyDir(src, dst) {
    for await (const [name, h] of src.entries()) {
      if (h.kind === 'directory') await this._copyDir(h, await dst.getDirectoryHandle(name, { create: true }));
      else await this._write(dst, name, await h.getFile());
    }
  }

  /** Duplica a pasta inteira e grava o project.json novo (com outro id). */
  async duplicate(srcId, newProject) {
    const src = await this._pdir(srcId, false);
    const dst = await this._pdir(newProject.id);
    await this._copyDir(src, dst);
    await this.save(newProject);
  }

  // ---------- Tomadas (blocos gravados durante a tomada) ----------

  async writeChunk(pid, tid, kind, index, data) {
    const d = await this._takeDir(pid, tid);
    await this._write(d, `${kind}-${pad(index)}.${kind === 'a' ? 'f32' : 'webm'}`, data);
  }

  async _chunks(pid, tid, kind) {
    let d;
    try { d = await this._takeDir(pid, tid, false); } catch { return []; }
    const files = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'file' && name.startsWith(kind + '-')) files.push([name, h]);
    }
    files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return Promise.all(files.map(([, h]) => h.getFile()));
  }

  /** Áudio da tomada: float32 estéreo intercalado. */
  async readTakeAudio(pid, tid) {
    const files = await this._chunks(pid, tid, 'a');
    const total = files.reduce((s, f) => s + Math.floor(f.size / 4), 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const f of files) {
      const b = new Float32Array(await f.arrayBuffer(), 0, Math.floor(f.size / 4));
      out.set(b, off);
      off += b.length;
    }
    return out;
  }

  async takeAudioFrames(pid, tid) {
    const files = await this._chunks(pid, tid, 'a');
    return Math.floor(files.reduce((s, f) => s + f.size, 0) / 8);
  }

  async readTakeVideo(pid, tid, mime = 'video/webm') {
    const files = await this._chunks(pid, tid, 'v');
    return files.length ? new Blob(files, { type: mime }) : null;
  }

  async deleteTake(pid, tid) {
    try { await (await this._takesDir(pid)).removeEntry(tid, { recursive: true }); } catch { /* ok */ }
  }

  /** Remove tomadas que nenhum canal usa mais (ex.: depois de regravar). */
  async gc(project) {
    const keep = referencedTakes(project);
    for (const id of Object.keys(project.takes)) if (!keep.has(id)) delete project.takes[id];
    let td;
    try { td = await this._takesDir(project.id); } catch { return; }
    const drop = [];
    for await (const [name] of td.entries()) if (!keep.has(name)) drop.push(name);
    for (const name of drop) { try { await td.removeEntry(name, { recursive: true }); } catch { /* ok */ } }
  }

  // ---------- Arquivos avulsos ----------

  async writeFile(pid, name, data) { await this._write(await this._pdir(pid), name, data); }

  async readFile(pid, name) {
    const d = await this._pdir(pid, false);
    return (await d.getFileHandle(name)).getFile();
  }

  async deleteFile(pid, name) {
    try { await (await this._pdir(pid, false)).removeEntry(name); } catch { /* ok */ }
  }

  /** Lista todos os arquivos do projeto com caminho relativo (para exportar o projeto). */
  async walk(pid) {
    const out = [];
    const rec = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') await rec(h, `${prefix}${name}/`);
        else out.push({ path: prefix + name, file: await h.getFile() });
      }
    };
    await rec(await this._pdir(pid, false), '');
    return out;
  }

  async writePath(pid, path, data) {
    const parts = path.split('/').filter((s) => s && s !== '..' && s !== '.');
    let d = await this._pdir(pid);
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    await this._write(d, parts[parts.length - 1], data);
  }

  // ---------- Cota (RNF-09) ----------

  async estimate() {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0, free: (e.quota || 0) - (e.usage || 0) };
  }

  async persist() { return navigator.storage.persist ? navigator.storage.persist() : false; }
  async persisted() { return navigator.storage.persisted ? navigator.storage.persisted() : false; }
}
