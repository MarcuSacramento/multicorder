// Dispositivos de entrada/saída (RU-01, RU-02, RF-16, RNF-08).

const BT = /bluetooth|hands[- ]?free|airpods|buds|\bbt\b|headset \(/i;
export const isBluetooth = (label) => BT.test(label || '');

/** Pede permissão uma vez para que enumerateDevices traga os nomes. */
export async function ensurePermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch { return false; }
  }
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind) => all.filter((d) => d.kind === kind && d.deviceId)
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind} ${i + 1}` }));
  return { audioIn: pick('audioinput'), videoIn: pick('videoinput'), audioOut: pick('audiooutput') };
}

/** RU-02: processamento do navegador desligado, pedindo 2 canais e 48 kHz. */
export async function openAudioInput(deviceId) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    if (e.name === 'OverconstrainedError' && deviceId) {
      delete audio.deviceId; // dispositivo lembrado não existe mais
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } else throw e;
  }
  const track = stream.getAudioTracks()[0];
  return { stream, track, settings: track.getSettings(), label: track.label };
}

/** RNF-08: tenta a resolução/quadros escolhidos (padrão 1080p30) e cai para 1080p30, 720p30 e o que houver. */
export async function openVideoInput(deviceId, { w = 1920, h = 1080, fps = 30 } = {}) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const tries = [
    { ...base, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
    { ...base, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    { ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    { ...base },
  ];
  let lastErr;
  for (const video of tries) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video });
      const track = stream.getVideoTracks()[0];
      return { stream, track, settings: track.getSettings(), label: track.label };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function stopStream(s) {
  s?.getTracks().forEach((t) => t.stop());
}
