/**
 * background.js — Service Worker (Manifest V3)
 *
 * Auto-polls the local server every 2s for pending queries.
 * When a query arrives, runs the full pipeline on ChatGPT automatically.
 * Tracks the active ChatGPT tab so follow-up messages continue the same conversation.
 */

let SERVER = "http://127.0.0.1:23119/llm-for-zotero/webchat";
const CHATGPT_URL = "https://chatgpt.com/";

// Zotero's HTTP server port can vary (23119-23128). Discover the actual port.
async function discoverZoteroPort() {
  for (let port = 23119; port <= 23128; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/llm-for-zotero/webchat/debug`);
      if (!res.ok) continue;
      const data = await res.json();
      // Verify this is actually our relay, not Zotero returning generic text
      if (data && typeof data.status === "string") {
        SERVER = `http://127.0.0.1:${port}/llm-for-zotero/webchat`;
        console.log(`[sync-zotero] Found Zotero server on port ${port}`);
        return;
      }
    } catch { /* try next port */ }
  }
  console.warn("[sync-zotero] Could not find Zotero server on ports 23119-23128");
}

// Discover port on startup and periodically
discoverZoteroPort();
setInterval(discoverZoteroPort, 30_000);

// Auto-discover existing ChatGPT tabs on startup and trigger initial history scrape
(async () => {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (tabs.length > 0 && activeChatTabId === null) {
    activeChatTabId = tabs[0].id;
    console.log(`[sync-zotero] Found existing ChatGPT tab: ${tabs[0].id}`);

    // Wait for Zotero port discovery, then trigger a history scrape
    await discoverZoteroPort();
    try {
      await ensureContentScript(activeChatTabId);
      // Ping the content script to trigger an immediate scrapeHistory()
      chrome.tabs.sendMessage(activeChatTabId, { type: "SCRAPE_HISTORY_NOW" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pipelineRunning  = false;
let activeChatTabId  = null;   // ChatGPT tab used for the current conversation
let lastProcessedSeq = 0;      // prevents re-running the same query on SW restart
let activePort       = null;   // current port connection to content script

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function serverGet(path) {
  const res  = await fetch(`${SERVER}${path}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function serverPost(path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------------------
// Keep the service worker alive + auto-poll for pending queries
// ---------------------------------------------------------------------------

// MV3 service workers are killed after ~30s of inactivity.
// A Chrome API call every 25s prevents the idle timeout from triggering.
setInterval(() => chrome.storage.session.set({ _keepalive: Date.now() }), 25_000);

// Backup: chrome.alarms wakes the SW up even if it was killed.
// The SW module re-executes on restart, so setInterval below auto-resumes.
chrome.alarms.create("pollAlarm", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollAlarm") pollForQuery();
});

// Main poll loop (runs while SW is alive)
setInterval(pollForQuery, 2000);

// Poll for navigation commands from the Next.js server
setInterval(pollForCommand, 2000);

async function pollForCommand() {
  if (pipelineRunning) return;
  try {
    const data = await fetch(`${SERVER}/poll_command`).then(r => r.json());
    if (!data.command) return;

    const cmd = data.command;
    if (cmd.type === "NEW_CHAT") {
      // Navigate a ChatGPT tab to a fresh page
      let tabId = activeChatTabId;

      // Find an existing ChatGPT tab if we don't have one tracked
      if (tabId === null) {
        const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        if (tabs.length > 0) tabId = tabs[0].id;
      }

      if (tabId !== null) {
        try {
          await chrome.tabs.update(tabId, { url: CHATGPT_URL });
          await waitForTabLoad(tabId);
          activeChatTabId = tabId;
        } catch (_) {
          activeChatTabId = null;
        }
      }
      broadcastStatus("idle", "New chat — ready for next query");
    } else if (cmd.type === "LOAD_CHAT" && cmd.chatUrl) {
      // Navigate to a specific past chat URL
      let tabId = null;

      // Try to find an existing ChatGPT tab first
      if (activeChatTabId !== null) {
        try {
          const existingTab = await chrome.tabs.get(activeChatTabId);
          if (existingTab?.url?.startsWith("https://chatgpt.com")) {
            tabId = activeChatTabId;
          }
        } catch (_) {
          activeChatTabId = null;
        }
      }
      if (!tabId) {
        const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        if (tabs.length > 0) {
          tabId = tabs[0].id;
          activeChatTabId = tabId;
        }
      }

      if (tabId) {
        // ChatGPT is an SPA — navigating within it won't trigger a full page load.
        // Use the content script to navigate via window.location for a clean reload.
        try {
          await ensureContentScript(tabId);
          await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: "NAVIGATE", url: cmd.chatUrl }, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          });
        } catch (_) {
          // Fallback: direct tab update
          await chrome.tabs.update(tabId, { url: cmd.chatUrl });
        }
        await waitForTabLoad(tabId);
      } else {
        // No existing ChatGPT tab — create a new one
        const tab = await chrome.tabs.create({ url: cmd.chatUrl, active: false });
        await waitForTabLoad(tab.id);
        activeChatTabId = tab.id;
        tabId = tab.id;
      }

      broadcastStatus("idle", "Loaded past chat — scraping messages…");

      // Scrape all messages from the loaded conversation.
      // The content script waits for messages to appear in DOM (up to 15s).
      try {
        // Wait for page to fully reload and content script to initialize
        await new Promise(r => setTimeout(r, 3000));
        await ensureContentScript(tabId);

        const response = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: "SCRAPE_MESSAGES" }, (res) => {
            if (chrome.runtime.lastError) {
              console.warn("[sync-zotero] SCRAPE_MESSAGES failed:", chrome.runtime.lastError.message);
              resolve({ ok: false, messages: [] });
            } else {
              resolve(res || { ok: false, messages: [] });
            }
          });
        });

        if (response.ok && response.messages?.length > 0) {
          console.log(`[sync-zotero] Scraped ${response.messages.length} messages, posting to server`);
          await serverPost("/chat_history", { action: "submit_scraped", messages: response.messages });
        } else {
          console.warn("[sync-zotero] No messages scraped from ChatGPT page");
        }
      } catch (err) {
        console.warn("[sync-zotero] Scraping error:", err);
      }

      broadcastStatus("idle", "Loaded past chat — ready for follow-up");
    } else if (cmd.type === "SCRAPE_HISTORY") {
      // Plugin is requesting a fresh history scrape
      let tabId = activeChatTabId;
      if (!tabId) {
        const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        if (tabs.length > 0) { tabId = tabs[0].id; activeChatTabId = tabId; }
      }
      if (tabId) {
        try {
          chrome.tabs.sendMessage(tabId, { type: "SCRAPE_HISTORY_NOW" }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) {}
      }
    } else if (cmd.type === "DELETE_CHAT" && cmd.chatId) {
      if (activeChatTabId !== null) {
        chrome.tabs.sendMessage(activeChatTabId, { type: "DELETE_CHAT", chatId: cmd.chatId }, (response) => {
          if (response && !response.success) {
            broadcastStatus("error", `Failed to delete chat: ${response.error}`);
          }
        });
      }
    }
  } catch (_) {
    // Server not running — ignore
  }
}

// ---------------------------------------------------------------------------
// History Mirroring Logic
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HISTORY_UPDATE") {
    // Forward the scraped history to the relay server
    serverPost("/update_chat_history", { sessions: message.history })
      .then(() => console.log(`[sync-zotero] History updated: ${message.history?.length} sessions`))
      .catch((err) => console.warn("[sync-zotero] History update failed:", err.message));
  }
});
async function pollForQuery() {
  if (pipelineRunning) return;

  try {
    const data = await serverGet("/poll_query");

    if (data.status !== "pending") return;
    if (data.query.seq <= lastProcessedSeq) return;

    lastProcessedSeq = data.query.seq;
    await runPipeline(data.query);
  } catch (err) {
    // Server not running — silently skip (expected when server is off)
    if (!err.message.includes("Failed to fetch") && !err.message.includes("NetworkError")) {
      broadcastStatus("error", err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(query) {
  pipelineRunning  = true;
  const seq        = query.seq;
  const isFollowup = !query.pdf_base64;

  broadcastStatus("running", isFollowup
    ? "Sending follow-up to ChatGPT…"
    : `Attaching PDF: ${query.pdf_filename}…`
  );

  try {
    // ── Get the right ChatGPT tab ──────────────────────────────────
    let tab;

    if (isFollowup && activeChatTabId !== null) {
      try {
        tab = await chrome.tabs.get(activeChatTabId);
        if (!tab.url || !tab.url.startsWith("https://chatgpt.com")) {
          throw new Error("Tab navigated away from ChatGPT");
        }
        // No focus change — stay in background
      } catch (_) {
        await submitError(seq, "ChatGPT tab was closed. Please start a new conversation by selecting a new PDF in the GUI.");
        return;
      }
    } else {
      tab = await getChatGPTTab();
      activeChatTabId = tab.id;
    }

    // ── Ensure content script is ready ────────────────────────────
    await ensureTabReady(tab.id);
    await ensureContentScript(tab.id);

    broadcastStatus("running", isFollowup ? "Sending follow-up…" : "Attaching PDF and sending prompt…");

    // ── Stream via port connection ─────────────────────────────────
    const { text: responseText, thinking: thinkingText } = await streamPipeline(tab.id, {
      pdfBase64:    query.pdf_base64,
      pdfFilename:  query.pdf_filename,
      prompt:       query.prompt,
      images:       query.images || null,
      chatgptMode:  query.chatgpt_mode || null,
      isFollowup,
      seq,
    });

    await serverPost("/submit_response", {
      seq,
      response: responseText,
      thinking: thinkingText ?? null,
      error:    null,
    });

    // Capture the ChatGPT URL for history persistence
    try {
      const currentTab = await chrome.tabs.get(activeChatTabId);
      if (currentTab.url && currentTab.url.startsWith("https://chatgpt.com/c/")) {
        await serverPost("/update_chat_url", { chat_url: currentTab.url });
      }
    } catch (_) {}

    broadcastStatus("done", "Response sent to GUI");

  } catch (err) {
    await submitError(seq, err.message);

    const msg = err.message.includes("Failed to fetch")
      ? "Cannot reach local server. Is gui.py running?"
      : err.message;
    broadcastStatus("error", msg);

  } finally {
    pipelineRunning = false;
  }
}

async function submitError(seq, errorMsg) {
  try {
    await serverPost("/submit_response", { seq, response: null, error: errorMsg });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function getChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (tabs.length > 0) return tabs[0];  // reuse silently, no focus change
  // Open a new tab in the background (active: false keeps user's focus)
  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
  await waitForTabLoad(tab.id);
  return tab;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Clear activeChatTabId if the user closes the ChatGPT tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeChatTabId) {
    activeChatTabId = null;
    broadcastStatus("idle", "ChatGPT tab closed — next query will open a new conversation");
  }
});

// ---------------------------------------------------------------------------
// Content script messaging (with retry)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Port-based streaming pipeline
// ---------------------------------------------------------------------------

function streamPipeline(tabId, payload) {
  const PIPELINE_TIMEOUT_MS = 180_000;

  // Disconnect any stale port from a previous pipeline
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }

  const pipelinePromise = new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "sync-zotero" });
    activePort = port;
    let resolved = false;

    port.onMessage.addListener(async (msg) => {
      if (msg.type === "partial") {
        // Ignore partials from a stale seq (Bug 2 guard)
        if (msg.seq !== undefined && msg.seq !== payload.seq) return;
        broadcastStatus("running", msg.thinking ? "Thinking…" : "Streaming response…");
        try {
          await serverPost("/update_partial", {
            seq:     payload.seq,
            text:    msg.text    ?? null,
            thinking: msg.thinking ?? null,
          });
        } catch (_) {}
      } else if (msg.type === "visibility") {
        if (!msg.visible) {
          broadcastStatus("running", "Chrome is hidden — waiting for full response…");
          try { await serverPost("/update_partial", { seq: payload.seq, text: null }); } catch (_) {}
        } else {
          broadcastStatus("running", "Streaming response…");
        }
      } else if (msg.type === "done") {
        resolved = true;
        if (activePort === port) activePort = null;
        port.disconnect();
        resolve({ text: msg.text, thinking: msg.thinking ?? null });
      } else if (msg.type === "error") {
        resolved = true;
        if (activePort === port) activePort = null;
        port.disconnect();
        reject(new Error(msg.error));
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
      if (!resolved) {
        const err = chrome.runtime.lastError;
        reject(new Error("Port disconnected unexpectedly" + (err ? ": " + err.message : "")));
      }
    });

    port.postMessage({ type: "START", ...payload });
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Pipeline timed out after 180s")), PIPELINE_TIMEOUT_MS);
  });

  return Promise.race([pipelinePromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Simple one-shot message (used for PING only)
// ---------------------------------------------------------------------------

async function sendToContentScript(tabId, message) {
  // Ensure the tab is fully loaded before attempting
  await ensureTabReady(tabId);

  // Ensure the content script is injected and responsive
  await ensureContentScript(tabId);

  // Send the actual message
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function ensureTabReady(tabId) {
  // Wait for the tab to reach "complete" status
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;

  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000); // max wait 10s
  });
}

async function ensureContentScript(tabId) {
  // Try pinging the content script
  const alive = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
      resolve(!chrome.runtime.lastError && res?.pong === true);
    });
  });

  if (alive) return;

  // Content script not responsive — inject both scripts
  // 1. MAIN world script (fetch interceptor) — must run first
  await chrome.scripting.executeScript({
    target: { tabId },
    files:  ["injected.js"],
    world:  "MAIN",
  });

  // 2. ISOLATED world script (pipeline handler)
  await chrome.scripting.executeScript({
    target: { tabId },
    files:  ["content_script.js"],
  });

  // Wait for them to initialise
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

// ---------------------------------------------------------------------------
// Status broadcasting
// ---------------------------------------------------------------------------

function broadcastStatus(state, message) {
  chrome.storage.session.set({ pipelineStatus: { state, message } });
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", state, message }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Message listener (popup status requests only)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    chrome.storage.session.get("pipelineStatus", (data) => {
      sendResponse(data.pipelineStatus || { state: "idle", message: "Ready" });
    });
    return true;
  }

  if (msg.type === "GET_FULL_STATUS") {
    (async () => {
      // Check web host
      let webHostAlive = false;
      try {
        const res = await fetch(`${SERVER}/poll_response?since=0`);
        webHostAlive = res.ok;
      } catch { /* offline */ }

      // Check ChatGPT tab — look for ANY open ChatGPT tab, not just activeChatTabId
      let chatTabAlive = false;
      let chatUrl = null;
      try {
        const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        if (tabs.length > 0) {
          chatTabAlive = true;
          // Prefer the active pipeline tab, otherwise use the first found
          const preferred = activeChatTabId !== null
            ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
            : tabs[0];
          if (preferred.url && preferred.url.startsWith("https://chatgpt.com/c/")) {
            chatUrl = preferred.url;
          }
        }
      } catch { /* no tabs */ }

      // Pipeline status
      const stored = await chrome.storage.session.get("pipelineStatus");
      const ps = stored.pipelineStatus || { state: "idle", message: "Ready" };

      sendResponse({
        webHostAlive,
        chatTabAlive,
        chatUrl,
        pipelineState: ps.state,
        pipelineMessage: ps.message,
      });
    })();
    return true; // async sendResponse
  }
});
