#!/usr/bin/env node
/**
 * Standalone relay server for sync-for-zotero.
 *
 * Implements all API routes using only Node.js built-ins (no npm install needed).
 * Can be started with:  node server.mjs [--port 7878]
 *
 * This replaces the Next.js dev server for headless / auto-start use.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "7878", 10);

const HISTORY_DIR = path.join(os.homedir(), "Documents", "sync");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");

const DEFAULT_CONFIG = {
  pdf_folder: path.join(os.homedir(), "Documents", "sync", "pdf"),
  prompt_file: path.join(os.homedir(), "Documents", "sync", "prompt.txt"),
  output_folder: path.join(os.homedir(), "Documents", "sync"),
};

// ---------------------------------------------------------------------------
// State (in-memory, same as the Next.js version)
// ---------------------------------------------------------------------------

const state = {
  status: "idle",        // idle | pending | running | done | error
  query: { prompt: null, pdf_base64: null, pdf_filename: null, seq: 0 },
  active_seq: 0,
  running_since: 0,
  partial_text: null,
  partial_thinking: null,
  responses: [],
  activeSessionId: null,
  pendingCommand: null,
};

let mirroredHistory = [];

function resetState() {
  state.status = "idle";
  state.query = { prompt: null, pdf_base64: null, pdf_filename: null, seq: 0 };
  state.active_seq = 0;
  state.running_since = 0;
  state.partial_text = null;
  state.partial_thinking = null;
  state.responses = [];
  state.activeSessionId = null;
  state.pendingCommand = null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
        if (!cfg[k]) cfg[k] = v;
      }
      return cfg;
    } catch { /* fall through */ }
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadHistory() {
  ensureDir(HISTORY_DIR);
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); }
    catch { /* fall through */ }
  }
  return { sessions: [] };
}

function saveHistory(data) {
  ensureDir(HISTORY_DIR);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function getSession(id) {
  return loadHistory().sessions.find((s) => s.id === id);
}

function createSession(pdfFilename) {
  const history = loadHistory();
  const now = new Date().toISOString();
  const session = {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: pdfFilename ? `\u{1F4C4} ${pdfFilename}` : "New Chat",
    chatUrl: null,
    pdfFilename,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  history.sessions.unshift(session);
  saveHistory(history);
  return session;
}

function addMessageToSession(sessionId, message) {
  const history = loadHistory();
  const session = history.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.messages.push({ ...message, timestamp: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
  if (session.title === "New Chat" && message.kind === "user") {
    session.title = message.text.slice(0, 50) + (message.text.length > 50 ? "\u2026" : "");
  }
  saveHistory(history);
}

function updateSessionChatUrl(sessionId, chatUrl) {
  const history = loadHistory();
  const session = history.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.chatUrl = chatUrl;
  session.updatedAt = new Date().toISOString();
  saveHistory(history);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const routes = {};

// POST /submit_query
routes["POST /submit_query"] = async (req, res) => {
  const body = await readBody(req);

  if (state.status === "pending" || state.status === "running") {
    if (state.status === "running" && Date.now() - state.running_since > 120000) {
      state.status = "error";
    } else {
      return json(res, { error: "pipeline_busy", status: state.status });
    }
  }

  const isNewConversation = !!body.pdf_base64;
  if (isNewConversation || !state.activeSessionId) {
    const session = createSession(body.pdf_filename || null);
    state.activeSessionId = session.id;
  }

  if (state.activeSessionId) {
    addMessageToSession(state.activeSessionId, { speaker: "You", text: body.prompt || "", kind: "user" });
  }

  // Clear stale state from previous query
  state.responses = [];
  state.active_seq = 0;
  state.partial_text = null;
  state.partial_thinking = null;

  state.query.seq += 1;
  state.query.prompt = body.prompt || "";
  state.query.pdf_base64 = body.pdf_base64 || null;
  state.query.pdf_filename = body.pdf_filename || null;
  state.query.images = body.images || null;
  state.query.chatgpt_mode = body.chatgpt_mode || null;
  state.status = "pending";

  json(res, { ok: true, seq: state.query.seq, sessionId: state.activeSessionId });
};

// GET /poll_query
routes["GET /poll_query"] = (_req, res) => {
  if (state.status === "pending") {
    state.status = "running";
    state.active_seq = state.query.seq;
    state.running_since = Date.now();
    return json(res, { status: "pending", query: { ...state.query } });
  }
  json(res, { status: state.status, query: null });
};

// GET /poll_response
routes["GET /poll_response"] = (req, res) => {
  // Passive timeout: if pipeline running > 180s, auto-error
  if (state.status === "running" && state.running_since > 0 && Date.now() - state.running_since > 180000) {
    state.status = "error";
    state.responses.push({
      seq: state.active_seq,
      error: "Server-side timeout: pipeline running for > 180s",
      timestamp: new Date().toISOString(),
    });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const since = parseInt(url.searchParams.get("since") || "0", 10);
  const newResponses = state.responses.filter((r) => r.seq > since);

  json(res, {
    status: state.status,
    responses: newResponses,
    partial_text: state.partial_text,
    partial_thinking: state.partial_thinking,
    current_seq: state.query.seq,
  });
};

// POST /update_partial
routes["POST /update_partial"] = async (req, res) => {
  const body = await readBody(req);
  if (body.seq !== state.active_seq) return json(res, { ok: false, reason: "seq_mismatch" });
  if ("text" in body) state.partial_text = body.text;
  if ("thinking" in body) state.partial_thinking = body.thinking;
  json(res, { ok: true });
};

// POST /submit_response
routes["POST /submit_response"] = async (req, res) => {
  const body = await readBody(req);
  if (body.seq !== state.active_seq) return json(res, { ok: false, reason: "seq_mismatch" });

  const entry = {
    seq: body.seq,
    text: body.response,
    error: body.error,
    timestamp: new Date().toISOString(),
    thinking: body.thinking,
  };
  state.responses.push(entry);
  state.partial_text = null;
  state.partial_thinking = null;
  state.status = entry.error ? "error" : "done";

  if (state.activeSessionId) {
    if (entry.error) {
      addMessageToSession(state.activeSessionId, { speaker: "Error", text: entry.error, kind: "error" });
    } else {
      addMessageToSession(state.activeSessionId, {
        speaker: "ChatGPT", text: entry.text || "", kind: "bot", thinking: entry.thinking,
      });
    }
  }
  json(res, { ok: true });
};

// GET /poll_command
routes["GET /poll_command"] = (_req, res) => {
  const cmd = state.pendingCommand;
  if (cmd) { state.pendingCommand = null; return json(res, { command: cmd }); }
  json(res, { command: null });
};

// POST /new_chat
routes["POST /new_chat"] = async (_req, res) => {
  resetState();
  state.pendingCommand = { type: "NEW_CHAT" };
  json(res, { ok: true });
};

// POST /update_chat_url
routes["POST /update_chat_url"] = async (req, res) => {
  const body = await readBody(req);
  if (state.activeSessionId && body.chat_url) {
    updateSessionChatUrl(state.activeSessionId, body.chat_url);
  }
  json(res, { ok: true });
};

// GET /chat_history
routes["GET /chat_history"] = (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const action = reqUrl.searchParams.get("action");
  if (action === "get_scraped") {
    const messages = scrapedMessages;
    scrapedMessages = null;
    return json(res, { messages });
  }
  json(res, {
    sessions: mirroredHistory.map((s) => ({ id: s.id, title: s.title, chatUrl: s.chatUrl })),
  });
};

// POST /chat_history (submit scraped messages)
routes["POST /chat_history"] = async (req, res) => {
  const body = await readBody(req);
  if (body.action === "submit_scraped") {
    scrapedMessages = body.messages || [];
    return json(res, { ok: true });
  }
  json(res, { error: "Unknown action" }, 400);
};

// POST /update_chat_history
routes["POST /update_chat_history"] = async (req, res) => {
  const body = await readBody(req);
  if (Array.isArray(body.sessions)) mirroredHistory = body.sessions;
  json(res, { success: true });
};

// POST /load_chat
routes["POST /load_chat"] = async (req, res) => {
  const body = await readBody(req);
  let session = getSession(body.sessionId);
  if (!session) {
    const mirrored = mirroredHistory.find((s) => s.id === body.sessionId);
    if (mirrored) {
      session = { id: mirrored.id, title: mirrored.title, chatUrl: mirrored.chatUrl, messages: [] };
    } else {
      return json(res, { error: "Session not found" }, 404);
    }
  }
  resetState();
  state.activeSessionId = body.sessionId;
  if (session.chatUrl) state.pendingCommand = { type: "LOAD_CHAT", chatUrl: session.chatUrl };
  json(res, {
    ok: true,
    session: {
      id: session.id, title: session.title,
      pdfFilename: session.pdfFilename, chatUrl: session.chatUrl,
      messages: session.messages || [],
    },
  });
};

// POST /delete_chat
routes["POST /delete_chat"] = async (req, res) => {
  const body = await readBody(req);
  if (!body.chatId) return json(res, { error: "Missing chatId" }, 400);
  if (state.pendingCommand) return json(res, { error: "Another command is pending" }, 409);
  state.pendingCommand = { type: "DELETE_CHAT", chatId: body.chatId };
  json(res, { success: true });
};

// GET /get_config
routes["GET /get_config"] = (_req, res) => json(res, { config: loadConfig() });

// POST /set_config
routes["POST /set_config"] = async (req, res) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  Object.assign(cfg, body.values || {});
  saveConfig(cfg);
  json(res, { config: cfg });
};

// POST /save_response
routes["POST /save_response"] = async (req, res) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  ensureDir(cfg.output_folder);
  const stem = path.basename(body.source_filename || "output", path.extname(body.source_filename || "")).replace(/[^\w\-]/g, "_");
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const outPath = path.join(cfg.output_folder, `${stem}_${ts}.md`);
  fs.writeFileSync(outPath, body.content || "", "utf-8");
  json(res, { saved_to: outPath });
};

// POST /submit_scraped_messages
let scrapedMessages = null;
routes["POST /submit_scraped_messages"] = async (req, res) => {
  const body = await readBody(req);
  scrapedMessages = body.messages || [];
  json(res, { ok: true });
};

// GET /get_scraped_messages
routes["GET /get_scraped_messages"] = (_req, res) => {
  const messages = scrapedMessages;
  scrapedMessages = null; // one-shot: clear after reading
  json(res, { messages });
};

// GET /get_files
routes["GET /get_files"] = (_req, res) => {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.pdf_folder)) return json(res, { error: `No PDF files found in: ${cfg.pdf_folder}` });
  const pdfs = fs.readdirSync(cfg.pdf_folder)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => ({ name: f, full: path.join(cfg.pdf_folder, f), mtime: fs.statSync(path.join(cfg.pdf_folder, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!pdfs.length) return json(res, { error: `No PDF files found in: ${cfg.pdf_folder}` });
  if (!fs.existsSync(cfg.prompt_file)) return json(res, { error: `prompt.txt not found at: ${cfg.prompt_file}` });
  const promptText = fs.readFileSync(cfg.prompt_file, "utf-8").trim();
  if (!promptText) return json(res, { error: "prompt.txt is empty" });
  const pdfBase64 = fs.readFileSync(pdfs[0].full).toString("base64");
  json(res, { pdf_base64: pdfBase64, pdf_filename: pdfs[0].name, prompt: promptText });
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const routeKey = `${req.method} ${url.pathname}`;

  const handler = routes[routeKey];
  if (handler) {
    try { await handler(req, res); }
    catch (err) { json(res, { error: err.message }, 500); }
  } else {
    json(res, { error: "Not found" }, 404);
  }
});

server.listen(PORT, () => {
  console.log(`[sync-for-zotero] relay server running on http://localhost:${PORT}`);
});
