"""Servidor local do MultiCorder.

Uso:  python serve.py [porta] [--open]
Abre em http://localhost:8080 (localhost conta como contexto seguro, então
getUserMedia, OPFS e AudioWorklet funcionam sem HTTPS).

Portas: os projetos ficam guardados no navegador POR ENDEREÇO (porta incluída).
Por isso o servidor tenta sempre a mesma porta. Se ela já tem um MultiCorder
rodando, só abre o navegador; se outro programa a ocupa, usa a próxima livre e avisa.

É só um servidor de arquivos: todo o trabalho (gravar, mixar, exportar) acontece no
navegador. Os tipos de arquivo e o cache seguem as mesmas regras da publicação na nuvem
(deploy/publicar-aws.ps1), para o navegador não baixar de novo o que não mudou.
"""
import http.server
import socketserver
import sys
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OPEN = "--open" in sys.argv
PORT = int(ARGS[0]) if ARGS else 8080
MARK = "X-MultiCorder"

# Tipos de arquivo. No Windows o registro às vezes mapeia .js como text/plain, o que quebra
# módulos ES; por isso a lista é fixa aqui.
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".bin": "application/octet-stream",
}

# Cache:
# - código e página: o navegador guarda e só confere se mudou (resposta curta 304, sem baixar);
# - kits de bateria (48 MB) e ícones: guardados por 1 dia sem nem conferir.
REVALIDATE = "public, max-age=0, must-revalidate"
ONE_DAY = "public, max-age=86400"


def cache_control(path):
    p = path.split("?", 1)[0]
    if p.startswith("/kits/") or p.startswith("/icons/"):
        return ONE_DAY
    return REVALIDATE


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", cache_control(self.path))
        self.send_header("X-Content-Type-Options", "nosniff")
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
            print(f"O Multicorder já está rodando em {url} — abrindo o navegador.")
            open_browser(url)
            return
        try:
            httpd = Server(("127.0.0.1", port), Handler)
        except OSError:
            print(f"Porta {port} ocupada por outro programa.")
            continue
        with httpd:
            print(f"Multicorder - VideoMusic Maker em {url}  (Ctrl+C ou feche esta janela para parar)")
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
