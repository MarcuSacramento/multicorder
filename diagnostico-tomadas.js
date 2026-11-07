// Diagnóstico (só leitura): cole no Console (F12) com o MultiCorder aberto.
// Mostra, para cada canal do projeto mais recente, se a tomada tem som e onde ela começa.
(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('projects');
  const projs = [];
  for await (const [, h] of dir.entries()) {
    if (h.kind !== 'directory') continue;
    try { projs.push({ h, p: JSON.parse(await (await (await h.getFileHandle('project.json')).getFile()).text()) }); } catch {}
  }
  projs.sort((a, b) => b.p.updatedAt - a.p.updatedAt);
  const { h, p } = projs[0];
  const rows = [];
  for (const ch of p.channels) {
    const t = ch.takeId && p.takes[ch.takeId];
    const row = { canal: ch.name, entrada: ch.inputMode, mute: ch.mute, volumeDb: ch.volumeDb, tomada: ch.takeId || '—' };
    if (t) {
      let peakL = 0, peakR = 0, n = 0;
      try {
        const td = await (await h.getDirectoryHandle('takes')).getDirectoryHandle(t.id);
        for await (const [name, fh] of td.entries()) {
          if (!name.startsWith('a-')) continue;
          const f = await fh.getFile();
          const d = new Float32Array(await f.arrayBuffer(), 0, Math.floor(f.size / 4));
          for (let i = 0; i + 1 < d.length; i += 2) {
            const l = Math.abs(d[i]), r = Math.abs(d[i + 1]);
            if (l > peakL) peakL = l; if (r > peakR) peakR = r;
          }
          n += d.length >> 1;
        }
      } catch (e) { row.erro = e.message; }
      Object.assign(row, {
        segundos: +(n / t.sampleRate).toFixed(1),
        picoEntrada1_dB: peakL ? +(20 * Math.log10(peakL)).toFixed(1) : '-inf (zero)',
        picoEntrada2_dB: peakR ? +(20 * Math.log10(peakR)).toFixed(1) : '-inf (zero)',
        inicio_s: t.audioStart != null ? +t.audioStart.toFixed(3) : null,
        taxa: t.sampleRate, video: t.hasVideo,
      });
    }
    rows.push(row);
  }
  console.log('Projeto:', p.name);
  console.table(rows);
})();
