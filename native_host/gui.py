#!/usr/bin/env python3
"""
gui.py — Python GUI for sync-for-zotero.

Usage:
    python3 gui.py

Starts the HTTP server internally and opens the GUI window.
"""

import base64
import json
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
from pathlib import Path
import urllib.request
import urllib.error

SERVER = "http://localhost:7878"

# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only, no requests dependency)
# ---------------------------------------------------------------------------

def http_get(path: str) -> dict:
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=5) as r:
        return json.loads(r.read())


def http_post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        f"{SERVER}{path}", data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

# ---------------------------------------------------------------------------
# Start the HTTP server internally
# ---------------------------------------------------------------------------

def start_server():
    """Import host.py and start ThreadingHTTPServer on a daemon thread."""
    # Add native_host dir to path so we can import host
    native_dir = Path(__file__).parent
    if str(native_dir) not in sys.path:
        sys.path.insert(0, str(native_dir))

    from host import ThreadingHTTPServer, Handler, PORT

    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        # Port already in use — another host.py is running, that's fine
        print(f"Port {PORT} already in use — connecting to existing server.")
        return None

    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"Server started on http://localhost:{PORT}")
    return server

# ---------------------------------------------------------------------------
# GUI Application
# ---------------------------------------------------------------------------

BG        = "#1a1a2e"
BG_PANEL  = "#16213e"
BG_INPUT  = "#0f3460"
FG        = "#e0e0e0"
FG_DIM    = "#9ca3af"
FG_ACCENT = "#a78bfa"
FG_USER   = "#60a5fa"
FG_BOT    = "#e0e0e0"
FG_ERR    = "#f87171"
BTN_BG    = "#7c3aed"
FONT_BODY = ("Helvetica", 12)
FONT_MONO = ("Menlo", 11)
FONT_BOLD = ("Helvetica", 12, "bold")
FONT_SM   = ("Helvetica", 10)


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Sync for Zotero")
        self.root.geometry("680x700")
        self.root.configure(bg=BG)
        self.root.resizable(True, True)

        self.selected_pdf_path: str | None = None
        self.pdf_is_new: bool = False
        self.last_seen_seq: int = 0
        self.current_submit_seq: int | None = None
        self.waiting_for_response: bool = False
        self.streaming: bool = False
        self._stream_start_idx: str | None = None
        self._think_start_idx:  str | None = None
        self._thinking_shown:   bool       = False
        self._dot_count:        int        = 0          # for "thinking..." animation

        self._build_ui()
        self._poll_tick()
        self._animate_tick()  # start thinking animation loop

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        # ── Header ──────────────────────────────────────────────────
        header = tk.Frame(self.root, bg=BG_PANEL, pady=10)
        header.pack(fill=tk.X)
        tk.Label(header, text="📚  Sync for Zotero",
                 bg=BG_PANEL, fg=FG_ACCENT,
                 font=("Helvetica", 14, "bold"), padx=16).pack(side=tk.LEFT)

        # ── PDF picker ──────────────────────────────────────────────
        pdf_row = tk.Frame(self.root, bg=BG, padx=16, pady=8)
        pdf_row.pack(fill=tk.X)

        tk.Label(pdf_row, text="PDF:", bg=BG, fg=FG_DIM,
                 font=FONT_SM, width=4, anchor="w").pack(side=tk.LEFT)

        self.pdf_label = tk.Label(pdf_row, text="No file selected",
                                   bg=BG, fg=FG_DIM, font=FONT_SM,
                                   anchor="w")
        self.pdf_label.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(4, 8))

        tk.Button(pdf_row, text="Browse…", command=self._on_browse,
                  bg=BTN_BG, fg="white", relief=tk.FLAT,
                  font=FONT_SM, padx=10, pady=3,
                  activebackground="#6d28d9", activeforeground="white",
                  cursor="hand2").pack(side=tk.RIGHT)

        ttk.Separator(self.root, orient="horizontal").pack(fill=tk.X, padx=16)

        # ── Conversation history ─────────────────────────────────────
        conv_frame = tk.Frame(self.root, bg=BG)
        conv_frame.pack(fill=tk.BOTH, expand=True, padx=16, pady=(8, 4))

        self.conv = tk.Text(
            conv_frame,
            bg="#0a0f1e", fg=FG, font=FONT_MONO,
            relief=tk.FLAT, state=tk.DISABLED,
            wrap=tk.WORD, padx=12, pady=12,
            spacing3=4, insertbackground=FG,
        )
        scrollbar = ttk.Scrollbar(conv_frame, command=self.conv.yview)
        self.conv.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.conv.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Text tags for styling
        self.conv.tag_configure("user_label",   foreground=FG_USER,   font=FONT_BOLD)
        self.conv.tag_configure("user_text",   foreground=FG_USER,   font=FONT_MONO)
        self.conv.tag_configure("bot_label",   foreground=FG_ACCENT, font=FONT_BOLD)
        self.conv.tag_configure("bot_text",    foreground=FG_BOT,    font=FONT_MONO)
        self.conv.tag_configure("think_label", foreground="#6b7280",  font=("Helvetica", 10, "italic"))
        self.conv.tag_configure("think_text",  foreground="#6b7280",  font=("Menlo", 10, "italic"))
        self.conv.tag_configure("error_label", foreground=FG_ERR,    font=FONT_BOLD)
        self.conv.tag_configure("error_text",  foreground=FG_ERR,    font=FONT_MONO)
        self.conv.tag_configure("divider",     foreground="#2d3748",  font=FONT_SM)

        # ── Prompt input ─────────────────────────────────────────────
        prompt_frame = tk.Frame(self.root, bg=BG, padx=16, pady=6)
        prompt_frame.pack(fill=tk.X)

        self.prompt = tk.Text(
            prompt_frame,
            height=4, bg=BG_INPUT, fg=FG,
            font=FONT_BODY, relief=tk.FLAT,
            padx=10, pady=8, wrap=tk.WORD,
            insertbackground=FG,
        )
        self.prompt.pack(fill=tk.X)
        self.prompt.bind("<Command-Return>", self._on_send)
        self.prompt.bind("<Control-Return>", self._on_send)

        # ── Bottom bar ───────────────────────────────────────────────
        bottom = tk.Frame(self.root, bg=BG, padx=16, pady=8)
        bottom.pack(fill=tk.X)

        self.status_var = tk.StringVar(value="Ready — select a PDF and type a prompt")
        tk.Label(bottom, textvariable=self.status_var, bg=BG, fg=FG_DIM,
                 font=FONT_SM, anchor="w").pack(side=tk.LEFT, fill=tk.X, expand=True)

        self.send_btn = tk.Button(
            bottom, text="▶  Send", command=self._on_send,
            bg=BTN_BG, fg="white", relief=tk.FLAT,
            font=("Helvetica", 12, "bold"), padx=16, pady=5,
            activebackground="#6d28d9", activeforeground="white",
            cursor="hand2",
        )
        self.send_btn.pack(side=tk.RIGHT)

        hint = tk.Label(bottom, text="⌘↵ to send",
                        bg=BG, fg="#4b5563", font=FONT_SM)
        hint.pack(side=tk.RIGHT, padx=(0, 12))

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def _on_browse(self):
        path = filedialog.askopenfilename(
            title="Select PDF",
            filetypes=[("PDF files", "*.pdf"), ("All files", "*.*")],
        )
        if path:
            self.selected_pdf_path = path
            self.pdf_is_new = True
            self.pdf_label.config(text=Path(path).name, fg=FG)
            self.status_var.set("PDF selected — next Send will start a new conversation")

    def _on_send(self, event=None):
        prompt = self.prompt.get("1.0", tk.END).strip()
        if not prompt:
            return "break"

        is_new_conversation = self.pdf_is_new and self.selected_pdf_path is not None

        # Validate: first message must have a PDF
        if self.last_seen_seq == 0 and not is_new_conversation:
            messagebox.showwarning(
                "No PDF selected",
                "Please select a PDF file before sending the first message.",
                parent=self.root,
            )
            return "break"

        # Build payload
        body: dict = {"prompt": prompt}
        if is_new_conversation:
            try:
                pdf_bytes = Path(self.selected_pdf_path).read_bytes()
                body["pdf_base64"]   = base64.b64encode(pdf_bytes).decode("ascii")
                body["pdf_filename"] = Path(self.selected_pdf_path).name
            except Exception as e:
                messagebox.showerror("Cannot read PDF", str(e), parent=self.root)
                return "break"
            self.pdf_is_new = False
        else:
            body["pdf_base64"]   = None
            body["pdf_filename"] = None

        # Optimistic UI update
        self._stream_start_idx = None
        self._think_start_idx  = None
        self._thinking_shown   = False
        self.streaming = False
        self._append("You", prompt, "user")
        self.prompt.delete("1.0", tk.END)
        self.send_btn.config(state=tk.DISABLED)
        self.status_var.set("Sending…")

        threading.Thread(target=self._do_submit, args=(body,), daemon=True).start()
        return "break"

    # ------------------------------------------------------------------
    # Background threads
    # ------------------------------------------------------------------

    def _do_submit(self, body: dict):
        try:
            data = http_post("/submit_query", body)
            if data.get("error"):
                self.root.after(0, self._on_submit_error, data["error"])
            else:
                self.current_submit_seq = data["seq"]
                self.waiting_for_response = True
                self.root.after(0, self.status_var.set, "Waiting for extension to pick up query…")
        except urllib.error.URLError:
            self.root.after(0, self._on_submit_error,
                            "Cannot reach server. Is gui.py / host.py running?")
        except Exception as e:
            self.root.after(0, self._on_submit_error, str(e))

    def _on_submit_error(self, msg: str):
        self.status_var.set(f"Error: {msg}")
        self.send_btn.config(state=tk.NORMAL)
        self._append("Error", msg, "error")

    # ------------------------------------------------------------------
    # Poll loop (runs on main thread via after())
    # ------------------------------------------------------------------

    def _animate_tick(self):
        if self.waiting_for_response and not self.streaming:
            self._dot_count = (self._dot_count + 1) % 4
            dots = "·" * self._dot_count or " "   # cycles: " ", "·", "··", "···"
            self.status_var.set(f"Model is thinking{dots}")
        self.root.after(400, self._animate_tick)

    def _poll_tick(self):
        if self.waiting_for_response:
            threading.Thread(target=self._do_poll, daemon=True).start()
        # Poll faster while streaming (500ms), slower otherwise (1500ms)
        interval = 500 if self.streaming else 1500
        self.root.after(interval, self._poll_tick)

    def _do_poll(self):
        try:
            data = http_get(f"/poll_response?since={self.last_seen_seq}")
            self.root.after(0, self._apply_poll, data)
        except Exception:
            pass

    def _apply_poll(self, data: dict):
        status       = data.get("status", "idle")
        partial_text = data.get("partial_text")

        # ── Streaming partial update ───────────────────────────────
        partial_thinking = data.get("partial_thinking")

        if status == "running":
            if partial_thinking and partial_thinking.strip():
                self._update_thinking(partial_thinking)
                self.status_var.set("Thinking…")
            if partial_text and partial_text.strip():
                self.streaming = True
                self._update_stream(partial_text)
                self.status_var.set("Streaming response…")
            elif partial_text is None and self.streaming:
                self._clear_stream()
                self.status_var.set("Chrome is hidden — full response will appear when done…")

        # ── Final response ─────────────────────────────────────────
        for resp in data.get("responses", []):
            seq = resp["seq"]
            if seq <= self.last_seen_seq:
                continue
            self.last_seen_seq       = seq
            self.waiting_for_response = False
            self.streaming            = False

            # Replace the streaming placeholder with the final text
            self._finalise_stream()

            if resp.get("error"):
                self._append("Error", resp["error"], "error")
                self.status_var.set(f"Error: {resp['error']}")
            else:
                if resp.get("thinking"):
                    self._append_thinking(resp["thinking"])
                self._append("ChatGPT", resp["text"], "bot")
                self.status_var.set("Response received — type a follow-up or pick a new PDF")

            self.send_btn.config(state=tk.NORMAL)

        if self.waiting_for_response and not self.streaming:
            status_map = {
                "pending": "Waiting for extension to pick up query…",
                "running": "Sending to ChatGPT…",
            }
            if status in status_map:
                self.status_var.set(status_map[status])

    # ------------------------------------------------------------------
    # Conversation display
    # ------------------------------------------------------------------

    def _update_stream(self, partial_text: str):
        """Replace the in-progress streaming text in the conversation widget."""
        self.conv.config(state=tk.NORMAL)

        if self._stream_start_idx is None:
            # First partial: insert the label, record the index right after it
            self.conv.insert(tk.END, "ChatGPT:\n", "bot_label")
            self._stream_start_idx = self.conv.index(tk.END)  # e.g. "42.0"

        # Delete from the stored start index to END, then insert fresh text
        self.conv.delete(self._stream_start_idx, tk.END)
        self.conv.insert(self._stream_start_idx, partial_text.strip() + " ▌", "bot_text")
        self.conv.see(tk.END)
        self.conv.config(state=tk.DISABLED)

    def _update_thinking(self, thinking_text: str):
        """Stream the thinking text in-place (grey italic, above the response)."""
        self.conv.config(state=tk.NORMAL)
        if not self._thinking_shown:
            self.conv.insert(tk.END, "🤔 Thinking:\n", "think_label")
            self._think_start_idx = self.conv.index(tk.END)
            self._thinking_shown  = True
        self.conv.delete(self._think_start_idx, tk.END)
        self.conv.insert(self._think_start_idx, thinking_text.strip() + " ▌", "think_text")
        self.conv.see(tk.END)
        self.conv.config(state=tk.DISABLED)

    def _append_thinking(self, thinking_text: str):
        """Append the final (collapsed) thinking block."""
        if not thinking_text or not thinking_text.strip():
            return
        self.conv.config(state=tk.NORMAL)
        self.conv.insert(tk.END, "🤔 Thinking:\n", "think_label")
        self.conv.insert(tk.END, thinking_text.strip() + "\n\n", "think_text")
        self.conv.config(state=tk.DISABLED)

    def _clear_stream(self):
        """Wipe the in-progress streaming text (e.g. when tab goes hidden)."""
        if self._stream_start_idx is None:
            return
        self.conv.config(state=tk.NORMAL)
        self.conv.delete(self._stream_start_idx, tk.END)
        self.conv.config(state=tk.DISABLED)
        self.streaming = False
        # Keep _stream_start_idx so we can resume streaming if tab becomes visible again

    def _finalise_stream(self):
        """Remove the streaming block so _append can write the clean final version."""
        if self._stream_start_idx is None:
            return
        self.conv.config(state=tk.NORMAL)
        try:
            # Delete label line + streaming text (one line back from _stream_start_idx)
            label_start = self.conv.index(f"{self._stream_start_idx} - 1 lines linestart")
            self.conv.delete(label_start, tk.END)
        except Exception:
            pass
        self._stream_start_idx = None
        self._think_start_idx  = None
        self._thinking_shown   = False
        self.conv.config(state=tk.DISABLED)

    def _append(self, speaker: str, text: str, kind: str):
        """Append a completed message to the conversation display."""
        self.conv.config(state=tk.NORMAL)

        self.conv.insert(tk.END, f"{speaker}:\n", f"{kind}_label")
        self.conv.insert(tk.END, text.strip() + "\n", f"{kind}_text")
        self.conv.insert(tk.END, "\n" + "─" * 56 + "\n\n", "divider")
        self.conv.see(tk.END)
        self.conv.config(state=tk.DISABLED)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    start_server()

    root = tk.Tk()
    app  = App(root)
    root.mainloop()
