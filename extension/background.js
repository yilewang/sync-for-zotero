/**
 * background.js — Service Worker (Manifest V3)
 *
 * Auto-polls the local server every 2s for pending queries.
 * When a query arrives, runs the full pipeline on ChatGPT automatically.
 * Tracks the active ChatGPT tab so follow-up messages continue the same conversation.
 */

const SERVER      = "http://localhost:7878";
const CHATGPT_URL = "https://chatgpt.com/";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pipelineRunning  = false;
let activeChatTabId  = null;   // ChatGPT tab used for the current conversation
let lastProcessedSeq = 0;      // prevents re-running the same query on SW restart

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function serverGet(path) {
  const res  = await fetch(`${SERVER}${path}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function serverPost(path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
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
      pdfBase64:   query.pdf_base64,
      pdfFilename: query.pdf_filename,
      prompt:      query.prompt,
      isFollowup,
      seq,
    });

    await serverPost("/submit_response", {
      seq,
      response: responseText,
      thinking: thinkingText ?? null,
      error:    null,
    });

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
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "sync-zotero" });

    port.onMessage.addListener(async (msg) => {
      if (msg.type === "partial") {
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
          // Clear any partial so the GUI shows the waiting state cleanly
          try { await serverPost("/update_partial", { seq: payload.seq, text: null }); } catch (_) {}
        } else {
          broadcastStatus("running", "Streaming response…");
        }
      } else if (msg.type === "done") {
        port.disconnect();
        resolve({ text: msg.text, thinking: msg.thinking ?? null });
      } else if (msg.type === "error") {
        port.disconnect();
        reject(new Error(msg.error));
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error("Port disconnected: " + err.message));
    });

    port.postMessage({ type: "START", ...payload });
  });
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

  // Content script not responsive — inject it
  await chrome.scripting.executeScript({
    target: { tabId },
    files:  ["content_script.js"],
  });

  // Wait for it to initialise
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
});
