"""Tiny dependency-free web server for the dashboard.

    python run.py dashboard            # http://localhost:8765

Routes
    GET  /                 the UI
    GET  /api/state        latest output/state.json
    POST /api/run          {"cmd": "screen"|"backtest"|"paper", "source": "...", "top": 10, ...}
    GET  /api/job          status/log of the last run
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, "output", "state.json")

_job = {"running": False, "cmd": None, "started": None, "finished": None, "returncode": None, "log": ""}
_lock = threading.Lock()

ALLOWED = {"screen", "backtest", "paper"}


def _run_job(args):
    global _job
    with _lock:
        _job = {"running": True, "cmd": " ".join(args), "started": time.time(), "finished": None,
                "returncode": None, "log": ""}
    try:
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "run.py"), *args], cwd=ROOT,
                              capture_output=True, text=True, timeout=1800)
        log, rc = (proc.stdout + proc.stderr)[-20000:], proc.returncode
    except Exception as exc:  # timeout etc.
        log, rc = f"{type(exc).__name__}: {exc}", 1
    with _lock:
        _job.update(running=False, finished=time.time(), returncode=rc, log=log)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):  # quieter
        if "/api/" not in (args[0] if args else ""):
            return

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/state"):
            if not os.path.exists(STATE):
                return self._json({"empty": True, "hint": "Run a screen or backtest first."})
            with open(STATE, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if self.path.startswith("/api/job"):
            with _lock:
                return self._json(_job)
        if self.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/run"):
            return self._json({"error": "not found"}, 404)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        cmd = req.get("cmd", "screen")
        if cmd not in ALLOWED:
            return self._json({"error": f"cmd must be one of {sorted(ALLOWED)}"}, 400)
        with _lock:
            if _job["running"]:
                return self._json({"error": "a run is already in progress"}, 409)
        args = [cmd, "--source", str(req.get("source", "yfinance"))]
        if req.get("top"):
            args += ["--top", str(int(req["top"]))]
        if req.get("weighting") in ("equal", "inverse_vol"):
            args += ["--weighting", req["weighting"]]
        if req.get("years"):
            args += ["--years", str(float(req["years"]))]
        if cmd == "backtest":
            if req.get("rebalance"):
                args += ["--rebalance", str(int(req["rebalance"]))]
            if req.get("stop") is not None:
                args += ["--stop", str(float(req["stop"]))]
        if cmd == "paper" and req.get("live_orders") is True:
            args += ["--live-orders"]
        if req.get("no_trend_filter"):
            args += ["--no-trend-filter"]
        threading.Thread(target=_run_job, args=(args,), daemon=True).start()
        return self._json({"started": True, "args": args})


def serve(port: int = 8765, open_browser: bool = True):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"dashboard -> {url}   (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    serve()
