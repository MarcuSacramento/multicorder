"""Servidor local do MultiCorder.

Uso:  python serve.py [porta] [--open]
Abre em http://localhost:8080 (localhost conta como contexto seguro, então
getUserMedia, OPFS e AudioWorklet funcionam sem HTTPS).

Portas: os projetos ficam guardados no navegador POR ENDEREÇO (porta incluída).
Por isso o servidor tenta sempre a mesma porta. Se ela já tem um MultiCorder
rodando, só abre o navegador; se outro programa a ocupa, usa a próxima livre e avisa.
"""
import http.server
import json
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OPEN = "--open" in sys.argv
PORT = int(ARGS[0]) if ARGS else 8080
MARK = "X-MultiCorder"

# ---------------------------------------------------------------- Faixa-guia do YouTube
#
# O app pede o áudio de um link; o servidor baixa com o yt-dlp (pip install -U yt-dlp), sem
# converter (Opus/WebM ou AAC/M4A, que o navegador já decodifica, então não precisa de ffmpeg).
# Cada pedido é um "job" com progresso; o arquivo fica numa pasta temporária até o app buscar.

YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
YT_MAX_SEC = 20 * 60
JOB_TTL = 15 * 60
JOBS = {}
JOBS_LOCK = threading.Lock()


def yt_status():
    try:
        import yt_dlp  # noqa: F401
        from yt_dlp.version import __version__
        return {"available": True, "version": __version__}
    except Exception:
        return {"available": False, "install": f'"{sys.executable}" -m pip install -U yt-dlp'}


def valid_youtube(url):
    try:
        u = urllib.parse.urlparse(url.strip())
    except ValueError:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "").lower() in YT_HOSTS


def clean_jobs():
    now = time.time()
    with JOBS_LOCK:
        for jid in [k for k, j in JOBS.items() if now - j["created"] > JOB_TTL]:
            shutil.rmtree(JOBS.pop(jid)["dir"], ignore_errors=True)


def run_job(jid, url):
    job = JOBS[jid]

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            job["progress"] = (d.get("downloaded_bytes", 0) / total) if total else None
            job["status"] = "downloading"

    def too_long(info, *, incomplete=False):
        dur = info.get("duration")
        if info.get("is_live"):
            return "Transmissões ao vivo não podem ser usadas."
        if dur and dur > YT_MAX_SEC:
            return f"O vídeo tem mais de {YT_MAX_SEC // 60} minutos."
        return None

    try:
        import yt_dlp

        opts = {
            # sem conversão: Opus (WebM) ou AAC (M4A) tocam direto no navegador
            "format": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio[acodec!=none]/best[acodec!=none]",
            "outtmpl": str(Path(job["dir"]) / "audio.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "match_filter": too_long,
            "progress_hooks": [hook],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        files = [p for p in Path(job["dir"]).iterdir() if p.is_file() and not p.name.endswith(".part")]
        if not files:
            raise RuntimeError("O vídeo foi recusado ou não tem áudio.")
        job.update(status="done", progress=1, file=str(files[0]), title=info.get("title") or "YouTube",
                   duration=info.get("duration"), ext=files[0].suffix.lstrip("."))
    except Exception as e:  # noqa: BLE001 — a mensagem vai para o app
        msg = str(e).replace("ERROR: ", "").strip()
        job.update(status="error", error=msg[:400] or "Falha no download.")
        shutil.rmtree(job["dir"], ignore_errors=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    # No Windows o registro às vezes mapeia .js como text/plain, o que quebra módulos ES.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json",
        ".wasm": "application/wasm",
        ".bin": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- API da faixa-guia do YouTube ----------

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _trusted(self):
        # Só o próprio app: protege contra outros sites chamando o servidor local (e DNS rebinding).
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if host not in ("localhost", "127.0.0.1"):
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            o = urllib.parse.urlparse(origin)
            if (o.hostname or "").lower() not in ("localhost", "127.0.0.1") or o.port != self.server.server_address[1]:
                return False
        return True

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        if not self._trusted():
            return self._json(403, {"error": "proibido"})
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/youtube/status":
            return self._json(200, yt_status())
        job = JOBS.get((q.get("id") or [""])[0])
        if not job:
            return self._json(404, {"error": "pedido não encontrado"})
        if u.path == "/api/youtube/job":
            return self._json(200, {k: job.get(k) for k in ("status", "progress", "title", "duration", "error", "ext")})
        if u.path == "/api/youtube/file" and job["status"] == "done":
            data = Path(job["file"]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/webm" if job["ext"] in ("webm", "opus") else "audio/mp4" if job["ext"] in ("m4a", "mp4") else "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            with JOBS_LOCK:
                JOBS.pop(job["id"], None)
            shutil.rmtree(job["dir"], ignore_errors=True)
            return None
        return self._json(404, {"error": "não encontrado"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/youtube":
            return self._json(404, {"error": "não encontrado"})
        if not self._trusted() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(403, {"error": "proibido"})
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 4096)
            url = str(json.loads(self.rfile.read(n) or b"{}").get("url", ""))
        except (ValueError, AttributeError):
            return self._json(400, {"error": "pedido inválido"})
        if not valid_youtube(url):
            return self._json(400, {"error": "Cole um link do YouTube (youtube.com ou youtu.be)."})
        st = yt_status()
        if not st["available"]:
            return self._json(503, {"error": "yt-dlp não instalado", **st})
        clean_jobs()
        jid = uuid.uuid4().hex
        job = {"id": jid, "status": "starting", "progress": None, "created": time.time(),
               "dir": tempfile.mkdtemp(prefix="multicorder-yt-")}
        with JOBS_LOCK:
            JOBS[jid] = job
        threading.Thread(target=run_job, args=(jid, url), daemon=True).start()
        return self._json(200, {"id": jid})

    def end_headers(self):
        # Kits de bateria (grandes e fixos): o navegador guarda e só confere se mudaram.
        self.send_header("Cache-Control", "no-cache" if self.path.startswith("/kits/") else "no-store")
        self.send_header(MARK, "1")
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # No Windows, SO_REUSEADDR deixa dois servidores na mesma porta; aqui a porta tem de ser exclusiva.
    allow_reuse_address = sys.platform != "win32"


def is_multicorder(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
            return r.headers.get(MARK) == "1"
    except Exception:
        return False


def open_browser(url):
    if not OPEN:
        return
    for name in ("firefox", "windows-default"):
        try:
            if webbrowser.get(name).open(url):
                return
        except webbrowser.Error:
            pass
    webbrowser.open(url)


def main():
    for port in range(PORT, PORT + 10):
        url = f"http://localhost:{port}"
        if is_multicorder(port):
            print(f"O MultiCorder já está rodando em {url} — abrindo o navegador.")
            open_browser(url)
            return
        try:
            httpd = Server(("127.0.0.1", port), Handler)
        except OSError:
            print(f"Porta {port} ocupada por outro programa.")
            continue
        with httpd:
            print(f"MultiCorder em {url}  (Ctrl+C ou feche esta janela para parar)")
            if port != PORT:
                print(f"ATENÇÃO: usando a porta {port} em vez de {PORT}. Os projetos salvos no navegador")
                print(f"ficam separados por porta; os de {PORT} só aparecem em http://localhost:{PORT}.")
            open_browser(url)
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                pass
        return
    print(f"Nenhuma porta livre entre {PORT} e {PORT + 9}.")
    sys.exit(1)


if __name__ == "__main__":
    main()
