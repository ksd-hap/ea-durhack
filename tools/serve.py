"""Dev server that never lets the browser cache: always serves the JS you just saved.

Plain `python -m http.server` sends no cache headers, so browsers reuse stale modules and
workers after an edit. Use this while developing; the demo can use either.

    python tools/serve.py              serves web/ on :8000   -> http://localhost:8000
    python tools/serve.py --root .     serves the repo root   -> http://localhost:8000/web/dev/selftest.html
    python tools/serve.py --port 8001
"""

import argparse
import functools
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="web", help="directory to serve, relative to the repo root")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    directory = os.path.join(ROOT, a.root)
    handler = functools.partial(NoCacheHandler, directory=directory)
    with http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler) as srv:
        print(f"serving {directory} at http://localhost:{a.port} (no-cache)")
        srv.serve_forever()


if __name__ == "__main__":
    main()
