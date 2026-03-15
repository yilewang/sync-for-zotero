#!/usr/bin/env python3
"""
sync-for-zotero HTTP server.

Can be started two ways:
  1. Directly:      python3 host.py       (no GUI, terminal only)
  2. Via gui.py:    python3 gui.py        (starts server internally + opens GUI)

Listens on http://localhost:7878
"""

import base64
import json
import os
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

PORT = 7878
SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "config.json"

DEFAULT_CONFIG = {
    "pdf_folder":    str(Path.home() / "Documents" / "sync" / "pdf"),
    "prompt_file":   str(Path.home() / "Documents" / "sync" / "prompt.txt"),
    "output_folder": str(Path.home() / "Documents" / "sync"),
}

# ---------------------------------------------------------------------------
# Threading HTTP server
# ---------------------------------------------------------------------------

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ---------------------------------------------------------------------------
# In-memory pipeline state  (guarded by _lock)
# ---------------------------------------------------------------------------

_lock = threading.Lock()

_state = {
    "status":       "idle",   # idle | pending | running | done | error
    "query": {
        "prompt":       None,
        "pdf_base64":   None,
        "pdf_filename": None,
        "seq":          0,
    },
    "active_seq":    0,
    "running_since": 0.0,
    "partial_text":    None,  # live streaming response text
    "partial_thinking": None, # live streaming thinking text
    "responses":     [],      # list of {seq, text, error, timestamp}
}

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            if not cfg.get(k):
                cfg[k] = v
        return cfg
    return dict(DEFAULT_CONFIG)


def save_config(cfg: dict):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)

# ---------------------------------------------------------------------------
# Legacy file-based helpers (kept for backward compat)
# ---------------------------------------------------------------------------

def handle_get_files(cfg: dict) -> dict:
    pdf_folder  = Path(cfg["pdf_folder"])
    prompt_file = Path(cfg["prompt_file"])
    all_files   = list(pdf_folder.iterdir())
    pdfs        = sorted(
        [p for p in all_files if p.suffix.lower() == ".pdf"],
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    if not pdfs:
        return {"error": f"No PDF files found in: {pdf_folder}"}
    if not prompt_file.exists():
        return {"error": f"prompt.txt not found at: {prompt_file}"}
    prompt_text = prompt_file.read_text(encoding="utf-8").strip()
    if not prompt_text:
        return {"error": "prompt.txt is empty"}
    pdf_b64 = base64.b64encode(pdfs[0].read_bytes()).decode("ascii")
    return {"pdf_base64": pdf_b64, "pdf_filename": pdfs[0].name, "prompt": prompt_text}


def handle_save_response(cfg: dict, content: str, source_filename: str) -> dict:
    output_folder = Path(cfg["output_folder"])
    output_folder.mkdir(parents=True, exist_ok=True)
    stem      = re.sub(r"[^\w\-]", "_", Path(source_filename).stem)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path  = output_folder / f"{stem}_{timestamp}.md"
    out_path.write_text(content, encoding="utf-8")
    return {"saved_to": str(out_path)}

# ---------------------------------------------------------------------------
# New pipeline state endpoints
# ---------------------------------------------------------------------------

def handle_submit_query(body: dict) -> dict:
    """GUI → host: submit a new query."""
    with _lock:
        if _state["status"] in ("pending", "running"):
            if _state["status"] == "running" and time.time() - _state["running_since"] > 120:
                _state["status"] = "error"
            else:
                return {"error": "pipeline_busy", "status": _state["status"]}

        _state["query"]["seq"]          += 1
        _state["query"]["prompt"]        = body.get("prompt", "")
        _state["query"]["pdf_base64"]    = body.get("pdf_base64")
        _state["query"]["pdf_filename"]  = body.get("pdf_filename")
        _state["status"]           = "pending"
        _state["partial_text"]     = None
        _state["partial_thinking"] = None
        return {"ok": True, "seq": _state["query"]["seq"]}


def handle_update_partial(body: dict) -> dict:
    """Extension → host: push a partial (streaming) response + thinking chunk."""
    seq = body.get("seq")
    with _lock:
        if seq != _state["active_seq"]:
            return {"ok": False, "reason": "seq_mismatch"}
        if "text" in body:
            _state["partial_text"] = body["text"]
        if "thinking" in body:
            _state["partial_thinking"] = body["thinking"]
        return {"ok": True}


def handle_poll_query() -> dict:
    """Extension → host: check for a pending query (atomically transitions to running)."""
    with _lock:
        if _state["status"] == "pending":
            _state["status"]       = "running"
            _state["active_seq"]   = _state["query"]["seq"]
            _state["running_since"] = time.time()
            return {"status": "pending", "query": dict(_state["query"])}
        return {"status": _state["status"], "query": None}


def handle_submit_response(body: dict) -> dict:
    """Extension → host: store the final response from ChatGPT."""
    seq = body.get("seq")
    with _lock:
        if seq != _state["active_seq"]:
            return {"ok": False, "reason": "seq_mismatch"}
        entry = {
            "seq":       seq,
            "text":      body.get("response"),
            "error":     body.get("error"),
            "timestamp": datetime.now().isoformat(),
        }
        entry["thinking"]        = body.get("thinking")
        _state["responses"].append(entry)
        _state["partial_text"]     = None
        _state["partial_thinking"] = None
        _state["status"] = "error" if entry["error"] else "done"
        return {"ok": True}


def handle_poll_response(since: int) -> dict:
    """GUI → host: get responses + current streaming partial."""
    with _lock:
        new_responses = [r for r in _state["responses"] if r["seq"] > since]
        return {
            "status":           _state["status"],
            "responses":        new_responses,
            "partial_text":     _state["partial_text"],
            "partial_thinking": _state["partial_thinking"],
            "current_seq":      _state["query"]["seq"],
        }

# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  [{self.address_string()}] {fmt % args}")

    def send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        params = parse_qs(parsed.query)
        cfg    = load_config()

        if path == "/get_files":
            self.send_json(handle_get_files(cfg))

        elif path == "/get_config":
            self.send_json({"config": cfg})

        elif path == "/poll_query":
            self.send_json(handle_poll_query())

        elif path == "/poll_response":
            since = int(params.get("since", ["0"])[0])
            self.send_json(handle_poll_response(since))

        else:
            self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        cfg  = load_config()

        if path == "/save_response":
            self.send_json(handle_save_response(
                cfg,
                content=body.get("content", ""),
                source_filename=body.get("source_filename", "output"),
            ))

        elif path == "/set_config":
            cfg.update(body.get("values", {}))
            save_config(cfg)
            self.send_json({"config": cfg})

        elif path == "/submit_query":
            self.send_json(handle_submit_query(body))

        elif path == "/update_partial":
            self.send_json(handle_update_partial(body))

        elif path == "/submit_response":
            self.send_json(handle_submit_response(body))

        else:
            self.send_json({"error": "Not found"}, 404)

# ---------------------------------------------------------------------------
# Entry point (direct run — no GUI)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cfg = load_config()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"sync-for-zotero server running on http://localhost:{PORT}")
    print(f"PDF folder:    {cfg['pdf_folder']}")
    print(f"Prompt file:   {cfg['prompt_file']}")
    print(f"Output folder: {cfg['output_folder']}")
    print("Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
