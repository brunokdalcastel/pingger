"""Pingger — diagnóstico de rede por traceroute contínuo.

Uso:
  python -m pingger                      abre a interface
  python -m pingger --trace host1 host2  já começa a tracear esses alvos
  python -m pingger --port 8080 --bind 0.0.0.0 --no-browser
"""
import argparse
import os
import shutil
import subprocess
import sys
import threading
import webbrowser

from .app import App
from .server import serve


def open_window(url):
    # Janela "de aplicativo" (sem barra de endereço) se Edge/Chrome existir.
    for exe in ("msedge", "chrome"):
        path = shutil.which(exe) or next((p for p in (
            rf"C:\Program Files (x86)\Microsoft\Edge\Application\{exe}.exe",
            rf"C:\Program Files\Microsoft\Edge\Application\{exe}.exe",
            rf"C:\Program Files\Google\Chrome\Application\{exe}.exe") if os.path.exists(p)), None)
        if path:
            subprocess.Popen([path, f"--app={url}", "--window-size=1400,900"])
            return
    webbrowser.open(url)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pingger")
    ap.add_argument("--trace", nargs="+", metavar="ALVO", help="alvos para começar a tracear")
    ap.add_argument("--port", type=int)
    ap.add_argument("--bind")
    ap.add_argument("--data", default=os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Pingger"))
    ap.add_argument("--no-browser", action="store_true", help="não abrir a janela (modo serviço/agente)")
    a = ap.parse_args(argv)

    app = App(a.data)
    port = a.port or int(app.settings["port"])
    bind = a.bind or app.settings["bind"]
    for host in a.trace or []:
        app.new_session(host)
    try:
        httpd = serve(app, port, bind)
    except OSError as e:
        print(f"Porta {port} ocupada ({e}); o Pingger já está aberto? Abrindo a janela existente.")
        if not a.no_browser:
            open_window(f"http://127.0.0.1:{port}/")
        return 1
    url = f"http://127.0.0.1:{port}/"
    print(f"Pingger rodando em {url} (dados em {a.data}). Ctrl+C para sair.")
    if not a.no_browser:
        threading.Timer(0.5, open_window, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
