/**
 * background.js — Service Worker (Manifest V3)
 *
 * Auto-polls the local server every 2s for pending queries.
 * When a query arrives, runs the full pipeline on ChatGPT automatically.
 * Tracks the active ChatGPT tab so follow-up messages continue the same conversation.
 */

try {
  importScripts("webchat_shared.js");
} catch (_) {}

const shared = globalThis.SyncZoteroShared || {
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  hasMeaningfulAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    return normalized.length > 1 &&
      normalized !== "thinking" &&
      normalized !== "thinking..." &&
      normalized !== "stopped thinking" &&
      normalized !== "quick answer" &&
      normalized !== "stopped thinking quick answer" &&
      !/^thought for .+$/.test(normalized) &&
      !/^reading\s+documents?\.?$/i.test(normalized) &&
      !/^searching(\s+the\s+web)?\.?$/i.test(normalized) &&
      !/^analyzing\.?$/i.test(normalized) &&
      !/^browsing\.?$/i.test(normalized);
  },
};

let SERVER = "http://127.0.0.1:23119/llm-for-zotero/webchat";
const CHATGPT_URL = "https://chatgpt.com/";
const MAX_PRE_SUBMIT_RELEASES = 3;
const RELAY_POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const WEBCHAT_DEBUG = false;

// Connection state tracking
let zoteroConnected = false;
let lastSuccessfulContact = 0;

function debugLog(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  console.log("[sync-zotero][webchat]", event, payload || "");
}

// Zotero's HTTP server port can vary (23119-23128). Discover the actual port.
let _portDiscoveryInFlight = false;
async function discoverZoteroPort() {
  if (_portDiscoveryInFlight) return;
  _portDiscoveryInFlight = true;
  try {
    const previousServer = SERVER;
    for (let port = 23119; port <= 23128; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/llm-for-zotero/webchat/debug`);
        if (!res.ok) continue;
        const data = await res.json();
        // Verify this is actually our relay, not Zotero returning generic text
        if (data && typeof data.status === "string") {
          SERVER = `http://127.0.0.1:${port}/llm-for-zotero/webchat`;
          lastSuccessfulContact = Date.now();

          const wasConnected = zoteroConnected;
          zoteroConnected = true;

          if (SERVER !== previousServer) {
            console.log(`[sync-zotero] Found Zotero server on port ${port} (port changed)`);
            resetExtensionState();
          } else if (!wasConnected) {
            console.log(`[sync-zotero] Reconnected to Zotero server on port ${port}`);
            resetExtensionState();
          } else {
            console.log(`[sync-zotero] Found Zotero server on port ${port}`);
          }
          return;
        }
      } catch { /* try next port */ }
    }
    if (zoteroConnected) {
      zoteroConnected = false;
      console.warn("[sync-zotero] Lost connection to Zotero server");
      broadcastStatus("disconnected", "Lost connection to Zotero — will retry automatically");
    }
  } finally {
    _portDiscoveryInFlight = false;
  }
}

/** Reset stale extension state after Zotero reconnection. */
function resetExtensionState() {
  pipelineRunning = false;
  lastProcessedSeq = 0;
  lastProcessedAttempt = 0;
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }
  broadcastStatus("idle", "Reconnected to Zotero — ready for queries");
  // Immediately pick up any pending query
  pollForQuery();
}

// Heartbeat: checks connectivity and triggers port rediscovery when needed
async function heartbeat() {
  try {
    const res = await fetch(`${SERVER}/heartbeat`);
    if (res.ok) {
      lastSuccessfulContact = Date.now();
      if (!zoteroConnected) {
        zoteroConnected = true;
        console.log("[sync-zotero] Heartbeat: reconnected to Zotero");
        resetExtensionState();
      }

      // Report extension status (ChatGPT tab alive, URL) to the relay
      try {
        const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        const chatTabAlive = tabs.length > 0;
        const preferred = activeChatTabId !== null
          ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
          : tabs[0];
        const chatUrl = preferred?.url || null;
        fetch(`${SERVER}/extension_status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatTabAlive, chatUrl }),
        }).catch(() => {});
      } catch { /* non-critical */ }

      return;
    }
  } catch { /* server unreachable — fall through to rediscovery */ }

  // Current SERVER URL is stale — try to find the new port
  await discoverZoteroPort();
}

// Discover port on startup and run heartbeat periodically
discoverZoteroPort();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

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
let lastProcessedSeq = 0;
let lastProcessedAttempt = 0;
let activePort       = null;   // current port connection to content script

// Persist critical state to chrome.storage.session so it survives SW restarts
function persistState() {
  chrome.storage.session.set({
    _syncState: {
      lastProcessedSeq,
      lastProcessedAttempt,
      activeChatTabId,
      server: SERVER,
    },
  });
}

// Restore state from storage on SW restart
async function loadPersistedState() {
  try {
    const data = await chrome.storage.session.get("_syncState");
    if (data._syncState) {
      lastProcessedSeq = data._syncState.lastProcessedSeq || 0;
      lastProcessedAttempt = data._syncState.lastProcessedAttempt || 0;
      activeChatTabId = data._syncState.activeChatTabId || null;
      if (data._syncState.server) SERVER = data._syncState.server;
      // Never restore pipelineRunning = true — relay's stale claim expiration handles it
      console.log("[sync-zotero] Restored persisted state", data._syncState);
    }
  } catch (_) {}
}

// Load persisted state on startup
loadPersistedState();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function serverGet(path) {
  let res;
  try {
    res = await fetch(`${SERVER}${path}`);
  } catch (err) {
    zoteroConnected = false;
    discoverZoteroPort();
    throw err;
  }
  lastSuccessfulContact = Date.now();
  zoteroConnected = true;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function serverPost(path, body) {
  let res;
  try {
    res = await fetch(`${SERVER}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    zoteroConnected = false;
    discoverZoteroPort();
    throw err;
  }
  lastSuccessfulContact = Date.now();
  zoteroConnected = true;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function claimQuery(seq) {
  return serverPost("/claim_query", { seq });
}

async function ackQueryPhase(seq, attempt, phase) {
  return serverPost("/ack_query_phase", { seq, attempt, phase });
}

async function releaseQuery(seq, attempt) {
  return serverPost("/release_query", { seq, attempt });
}

async function reportTurnState(body) {
  return serverPost("/update_turn_state", body);
}

async function waitForChatReadyInTab(tabId, expectedChatUrl = null, timeoutMs = 30_000) {
  const response = await sendToContentScript(tabId, {
    type: "WAIT_FOR_CHAT_READY",
    expectedChatUrl,
    timeoutMs,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "ChatGPT did not become ready.");
  }
  return response;
}

async function publishReadyConversationState(
  tabId,
  expectedChatUrl = null,
  { submitScraped = false } = {},
) {
  let ready = await waitForChatReadyInTab(tabId, expectedChatUrl);
  debugLog("ready_ack", ready);

  // If we got empty messages on a conversation page, retry once after a delay
  const isConversationPage = expectedChatUrl && expectedChatUrl.includes("/c/");
  if (submitScraped && isConversationPage && (!ready.messages || ready.messages.length === 0)) {
    debugLog("ready_retry", "empty messages on conversation page, retrying…");
    await new Promise(r => setTimeout(r, 2000));
    ready = await waitForChatReadyInTab(tabId, expectedChatUrl);
    debugLog("ready_retry_ack", ready);
  }

  if (submitScraped) {
    await serverPost("/chat_history", {
      action: "submit_scraped",
      messages: ready.messages || [],
    });
  }

  await reportTurnState({
    remote_chat_url: ready.chatUrl || null,
    remote_chat_id: ready.chatId || null,
    baseline_transcript_count: ready.transcriptCount || 0,
    baseline_transcript_hash: ready.transcriptHash || null,
    turn_status: "ready",
  });

  return ready;
}

// ---------------------------------------------------------------------------
// Keep the service worker alive + auto-poll for pending queries
// ---------------------------------------------------------------------------

// MV3 service workers are killed after ~30s of inactivity.
// A Chrome API call every 25s prevents the idle timeout from triggering.
// Also persist state on each keepalive tick to survive SW restarts.
setInterval(() => {
  chrome.storage.session.set({ _keepalive: Date.now() });
  persistState();
}, 25_000);

// Backup: chrome.alarms wakes the SW up even if it was killed.
// The SW module re-executes on restart, so setInterval below auto-resumes.
chrome.alarms.create("pollAlarm", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollAlarm") {
    pollForQuery();
    pollForCommand();
  }
});

// Clean initialization after browser restart
chrome.runtime.onStartup.addListener(() => {
  loadPersistedState().then(() => discoverZoteroPort());
});

// Adaptive polling: 500ms when active, 2000ms when idle (saves CPU/network)
let lastQueryActivity = 0;
const IDLE_POLL_INTERVAL_MS = 2000;

function adaptivePoll() {
  const isActive = pipelineRunning || (Date.now() - lastQueryActivity < 30_000);
  const interval = isActive ? RELAY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
  pollForQuery();
  pollForCommand();
  setTimeout(adaptivePoll, interval);
}
setTimeout(adaptivePoll, RELAY_POLL_INTERVAL_MS);

async function pollForCommand() {
  if (pipelineRunning) return;
  if (!zoteroConnected) return;
  try {
    const data = await fetch(`${SERVER}/poll_command`).then(r => r.json());
    if (!data.command) return;

    const cmd = data.command;
    if (cmd.type === "NEW_CHAT") {
      await reportTurnState({
        remote_chat_url: null,
        remote_chat_id: null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: null,
        turn_status: "navigating",
      }).catch(() => {});

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
        } catch (_) {}
      } else {
        const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
        await waitForTabLoad(tab.id);
        tabId = tab.id;
      }

      if (tabId !== null) {
        activeChatTabId = tabId;
        try {
          await publishReadyConversationState(tabId, null, { submitScraped: false });
        } catch (err) {
          broadcastStatus("error", err.message || "New chat did not become ready");
          return;
        }
      }
      broadcastStatus("idle", "New chat — ready for next query");
    } else if (cmd.type === "LOAD_CHAT" && cmd.chatUrl) {
      await reportTurnState({
        remote_chat_url: cmd.chatUrl,
        remote_chat_id: cmd.chatId || null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: null,
        turn_status: "navigating",
      }).catch(() => {});

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

      try {
        await publishReadyConversationState(tabId, cmd.chatUrl, {
          submitScraped: true,
        });
      } catch (err) {
        console.warn("[sync-zotero] Scraping error:", err);
        await reportTurnState({
          remote_chat_url: cmd.chatUrl,
          remote_chat_id: cmd.chatId || null,
          turn_status: "error",
        }).catch(() => {});
        broadcastStatus(
          "error",
          err.message || "Failed to load the selected ChatGPT conversation",
        );
        return;
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
  if (!zoteroConnected) return;

  try {
    const data = await serverGet("/poll_query");

    if (data.status !== "pending") return;
    if (!data.query?.seq) return;

    const claimed = await claimQuery(data.query.seq);
    if (!claimed?.ok || !claimed.query) return;

    const token = shared.attemptToken(claimed.query.seq, claimed.query.attempt);
    const lastToken = shared.attemptToken(lastProcessedSeq, lastProcessedAttempt);
    if (token === lastToken) return;

    lastProcessedSeq = claimed.query.seq;
    lastProcessedAttempt = claimed.query.attempt || 0;
    lastQueryActivity = Date.now();
    await ackQueryPhase(claimed.query.seq, claimed.query.attempt || 0, "claimed").catch(() => {});
    await runPipeline(claimed.query);
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
  const attempt    = query.attempt || 0;
  const startsFresh = query.force_new_chat === true;
  const isFollowup = !startsFresh;

  broadcastStatus("running", isFollowup
    ? (query.pdf_base64 ? `Attaching PDF to conversation…` : "Sending follow-up to ChatGPT…")
    : (query.pdf_base64 ? `Starting fresh chat with PDF: ${query.pdf_filename}…` : "Starting fresh ChatGPT chat…")
  );

  try {
    // ── Drain stale NEW_CHAT command ────────────────────────────────
    // If this query starts fresh, consume any pending NEW_CHAT command
    // so it doesn't fire after the pipeline and navigate away.
    if (startsFresh) {
      try {
        await fetch(`${SERVER}/poll_command`).then(r => r.json());
      } catch (_) { /* server not running — ignore */ }
    }

    // ── Get the right ChatGPT tab ──────────────────────────────────
    let tab = null;

    if (activeChatTabId !== null) {
      try {
        const existing = await chrome.tabs.get(activeChatTabId);
        if (existing?.url?.startsWith("https://chatgpt.com")) {
          tab = existing;
        }
      } catch (_) {
        activeChatTabId = null;
      }
    }

    if (!tab) {
      tab = await getChatGPTTab();
      activeChatTabId = tab.id;
    }

    const shouldNavigateFresh = startsFresh;

    if (shouldNavigateFresh) {
      // Skip navigation if tab is already on the ChatGPT home/new-chat URL
      // (e.g., a NEW_CHAT command already navigated us there)
      const currentUrl = tab.url || "";
      const isAlreadyHome = (
        currentUrl === CHATGPT_URL ||
        currentUrl === CHATGPT_URL.slice(0, -1) ||
        currentUrl === "https://chatgpt.com"
      );
      if (!isAlreadyHome) {
        try {
          await chrome.tabs.update(tab.id, { url: CHATGPT_URL });
          await waitForTabLoad(tab.id);
        } catch (_) {}
      }
    }

    // ── Ensure content script is ready ────────────────────────────
    await ensureTabReady(tab.id);
    await ensureContentScript(tab.id);
    activeChatTabId = tab.id;

    const readyState = await publishReadyConversationState(
      tab.id,
      shouldNavigateFresh ? null : null,
      { submitScraped: false },
    );

    broadcastStatus(
      "running",
      isFollowup
        ? "Sending follow-up…"
        : "Preparing fresh chat and prompt…",
    );
    debugLog("pipeline_ready", {
      seq,
      attempt,
      startsFresh,
      readyState,
    });

    // ── Stream via port connection ─────────────────────────────────
    const {
      text: responseText,
      thinking: thinkingText,
      answerAnchorId,
      answerRevision,
      thinkingRevision,
      runState,
      completionReason,
      finalTranscriptHash,
      verifiedAt,
      remoteChatUrl,
      remoteChatId,
      userTurnKey,
      assistantTurnKey,
      baselineTranscriptCount,
      baselineTranscriptHash,
      turnStatus,
    } = await streamPipeline(tab.id, {
      pdfBase64:    query.pdf_base64 || null,
      pdfFilename:  query.pdf_base64 ? (query.pdf_filename || "document.pdf") : null,
      prompt:       query.prompt,
      images:       query.images || null,
      chatgptMode:  query.chatgpt_mode || null,
      seq,
      attempt,
    });

    if (runState === "done" && !shared.hasMeaningfulAssistantText(responseText)) {
      throw new Error("ChatGPT did not produce a visible final answer.");
    }

    await serverPost("/submit_response", {
      seq,
      attempt,
      response: responseText || null,
      thinking: thinkingText ?? null,
      error:    null,
      answer_anchor_id: answerAnchorId || null,
      answer_revision: answerRevision || 0,
      thinking_revision: thinkingRevision || 0,
      run_state: runState,
      completion_reason: completionReason || null,
      final_transcript_hash: finalTranscriptHash || null,
      verified_at: verifiedAt || null,
      remote_chat_url: remoteChatUrl || null,
      remote_chat_id: remoteChatId || null,
      user_turn_key: userTurnKey || null,
      assistant_turn_key: assistantTurnKey || null,
      baseline_transcript_count: baselineTranscriptCount || 0,
      baseline_transcript_hash: baselineTranscriptHash || null,
      turn_status: turnStatus || (runState === "incomplete" ? "incomplete" : "done"),
    });

    // Capture the ChatGPT URL for history persistence
    try {
      const currentTab = await chrome.tabs.get(activeChatTabId);
      if (currentTab.url && currentTab.url.startsWith("https://chatgpt.com/c/")) {
        await serverPost("/update_chat_url", { chat_url: currentTab.url });
      }
    } catch (_) {}

    broadcastStatus(
      runState === "incomplete" ? "error" : "done",
      runState === "incomplete"
        ? "Captured partial response — final answer not verified"
        : "Response sent to GUI",
    );

  } catch (err) {
    if (err?.name === "PreSubmitDisconnect" && attempt < MAX_PRE_SUBMIT_RELEASES) {
      try {
        await releaseQuery(seq, attempt);
        broadcastStatus("running", "Retrying prompt delivery after a pre-submit disconnect…");
        return;
      } catch (_) {
        // Fall through to surfacing a real error if the release itself failed.
      }
    }

    await submitError(seq, err.message, attempt);

    const msg = err.message.includes("Failed to fetch")
      ? "Cannot reach local server. Is gui.py running?"
      : err.message;
    broadcastStatus("error", msg);

  } finally {
    pipelineRunning = false;
  }
}

async function submitError(seq, errorMsg, attempt) {
  try {
    await serverPost("/submit_response", { seq, attempt, response: null, error: errorMsg });
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
    let submitted = false;
    let streamingAcked = false;

    port.onMessage.addListener(async (msg) => {
      if (msg.seq !== undefined && msg.seq !== payload.seq) return;
      if (msg.attempt !== undefined && msg.attempt !== payload.attempt) return;

      if (msg.type === "phase") {
        if (msg.phase === "submitted" || msg.phase === "streaming") {
          submitted = true;
        }
        try {
          await ackQueryPhase(payload.seq, payload.attempt, msg.phase);
        } catch (_) {}
      } else if (msg.type === "turn_state") {
        try {
          await reportTurnState({
            seq: payload.seq,
            attempt: payload.attempt,
            remote_chat_url: msg.remoteChatUrl ?? null,
            remote_chat_id: msg.remoteChatId ?? null,
            user_turn_key: msg.userTurnKey ?? null,
            assistant_turn_key: msg.assistantTurnKey ?? null,
            baseline_transcript_count: msg.baselineTranscriptCount ?? 0,
            baseline_transcript_hash: msg.baselineTranscriptHash ?? null,
            turn_status: msg.turnStatus ?? null,
          });
        } catch (_) {}
      } else if (msg.type === "snapshot") {
        if (!streamingAcked) {
          streamingAcked = true;
          submitted = true;
          try {
            await ackQueryPhase(payload.seq, payload.attempt, "streaming");
          } catch (_) {}
        }
        broadcastStatus(
          "running",
          msg.runState === "settling"
            ? "Settling visible response…"
            : (msg.thinking ? "Thinking…" : "Streaming response…"),
        );
        try {
          await serverPost("/update_partial", {
            seq:     payload.seq,
            attempt: payload.attempt,
            answer_snapshot: msg.answerSnapshot ?? msg.text ?? null,
            thinking_snapshot: msg.thinkingSnapshot ?? msg.thinking ?? null,
            text:    msg.text    ?? null,
            thinking: msg.thinking ?? null,
            answer_anchor_id: msg.answerAnchorId ?? null,
            answer_revision: msg.answerRevision ?? 0,
            thinking_revision: msg.thinkingRevision ?? 0,
            run_state: msg.runState ?? null,
            completion_reason: msg.completionReason ?? null,
            remote_chat_url: msg.remoteChatUrl ?? null,
            remote_chat_id: msg.remoteChatId ?? null,
            user_turn_key: msg.userTurnKey ?? null,
            assistant_turn_key: msg.assistantTurnKey ?? null,
            baseline_transcript_count: msg.baselineTranscriptCount ?? 0,
            baseline_transcript_hash: msg.baselineTranscriptHash ?? null,
            turn_status: msg.turnStatus ?? null,
          });
        } catch (_) {}
      } else if (msg.type === "mode_report") {
        // Forward ChatGPT's actual mode back to the plugin relay
        serverPost("/update_mode", { seq: payload.seq, mode: msg.mode }).catch(() => {});
      } else if (msg.type === "terminal") {
        resolved = true;
        if (activePort === port) activePort = null;
        port.disconnect();
        resolve({
          text: msg.text || "",
          thinking: msg.thinking ?? null,
          answerAnchorId: msg.answerAnchorId ?? null,
          answerRevision: msg.answerRevision ?? 0,
          thinkingRevision: msg.thinkingRevision ?? 0,
          runState: msg.runState || "done",
          completionReason: msg.completionReason ?? null,
          finalTranscriptHash: msg.finalTranscriptHash ?? null,
          verifiedAt: msg.verifiedAt ?? null,
          remoteChatUrl: msg.remoteChatUrl ?? null,
          remoteChatId: msg.remoteChatId ?? null,
          userTurnKey: msg.userTurnKey ?? null,
          assistantTurnKey: msg.assistantTurnKey ?? null,
          baselineTranscriptCount: msg.baselineTranscriptCount ?? 0,
          baselineTranscriptHash: msg.baselineTranscriptHash ?? null,
          turnStatus: msg.turnStatus ?? null,
        });
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
        const error = new Error("Port disconnected unexpectedly" + (err ? ": " + err.message : ""));
        error.name = submitted ? "PipelineDisconnect" : "PreSubmitDisconnect";
        reject(error);
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
  // Always inject the MAIN world script (SSE interceptor).
  // It has its own __syncZoteroFetchPatched guard to avoid double-patching,
  // but after full page reloads the guard resets and re-injection is needed.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ["injected.js"],
      world:  "MAIN",
    });
  } catch (_) {}

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

  if (msg.type === "GET_FULL_STATUS") {
    (async () => {
      // Check embedded relay
      let relayAlive = false;
      try {
        const res = await fetch(`${SERVER}/poll_response?since=0`);
        relayAlive = res.ok;
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
        relayAlive,
        zoteroConnected,
        chatTabAlive,
        chatUrl,
        pipelineState: ps.state,
        pipelineMessage: ps.message,
      });
    })();
    return true; // async sendResponse
  }
});
