/**
 * background.js — Service Worker (Manifest V3)
 *
 * Auto-polls the local server every 2s for pending queries.
 * When a query arrives, runs the full pipeline on the selected web chat.
 * Tracks the active chat tab so follow-up messages continue the same conversation.
 */

try {
  importScripts("webchat_shared.js");
} catch (_) {}

const shared = globalThis.SyncZoteroShared || {
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  hasMeaningfulAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length <= 1) return false;
    if (
      normalized === "thinking" ||
      normalized === "thinking..." ||
      normalized === "stopped thinking" ||
      normalized === "quick answer" ||
      normalized === "stopped thinking quick answer"
    ) return false;
    if (/^thought for .+$/.test(normalized)) return false;
    if (/^reading\s+documents?\.?$/i.test(normalized)) return false;
    if (/^searching(\s+the\s+web)?\.?$/i.test(normalized)) return false;
    if (/^analyzing\.?$/i.test(normalized)) return false;
    if (/^browsing\.?$/i.test(normalized)) return false;
    // Chinese equivalents (DeepSeek Chinese UI)
    const raw = String(text || "").trim().replace(/\s+/g, " ");
    if (raw === "思考中" || raw === "思考中..." || raw === "深度思考" || raw === "停止思考") return false;
    if (/^已深度思考/.test(raw) || /^已思考/.test(raw) || /^思考了/.test(raw)) return false;
    if (/^正在阅读/.test(raw) || /^正在搜索/.test(raw) ||
        /^正在分析/.test(raw) || /^正在浏览/.test(raw)) return false;
    return true;
  },
  canReuseReadyTranscriptForScrape: (siteId, ready) => {
    if (String(siteId || "").toLowerCase() !== "chatgpt") return false;
    const messages = Array.isArray(ready?.messages) ? ready.messages : [];
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      if (String(message.text || "").trim()) return true;
      if (String(message.thinking || "").trim()) return true;
      return Array.isArray(message.attachments) && message.attachments.length > 0;
    });
  },
};

let SERVER = "http://127.0.0.1:23119/llm-for-zotero/webchat";
const MAX_PRE_SUBMIT_RELEASES = 3;
const RELAY_POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const TAB_LOAD_TIMEOUT_MS = 120_000;
const PIPELINE_TIMEOUT_MS = 60 * 60_000;
const RELAY_HOSTS = ["127.0.0.1", "localhost"];
const WEBCHAT_DEBUG = false;

// ---------------------------------------------------------------------------
// Site configuration — maps target IDs to their site details
// ---------------------------------------------------------------------------

const SITE_CONFIGS = {
  chatgpt: {
    siteId: "chatgpt",
    label: "ChatGPT",
    homeUrl: "https://chatgpt.com/",
    urlPattern: "https://chatgpt.com/*",
    urlPrefix: "https://chatgpt.com",
    conversationUrlPattern: /\/c\//,
  },
  deepseek: {
    siteId: "deepseek",
    label: "DeepSeek",
    homeUrl: "https://chat.deepseek.com/",
    urlPattern: "https://chat.deepseek.com/*",
    urlPrefix: "https://chat.deepseek.com",
    conversationUrlPattern: /\/a\/chat\/s\//,
  },
    lucrezia: {
    siteId: "lucrezia",
    label: "LucrezIA",
    homeUrl: "https://web.lucrezia.unipd.it/",
    urlPattern: "https://web.lucrezia.unipd.it/*",
    urlPrefix: "https://web.lucrezia.unipd.it",
    conversationUrlPattern: /\/bot\/[0-9A-Za-z]{26}|\/conversation\/[0-9A-Za-z]{26}/i,
  },
};

const ALL_SITE_URL_PATTERNS = Object.values(SITE_CONFIGS).map(s => s.urlPattern);

/** Get site config from a target ID (e.g., "chatgpt", "deepseek"). Defaults to chatgpt. */
function getSiteConfig(target) {
  return SITE_CONFIGS[target] || SITE_CONFIGS.chatgpt;
}

/** Determine which site config a URL belongs to. */
function getSiteConfigByUrl(url) {
  for (const config of Object.values(SITE_CONFIGS)) {
    if (url?.startsWith(config.urlPrefix)) return config;
  }
  return null;
}

function isSiteHomeUrl(url, config) {
  try {
    const parsed = new URL(String(url || ""));
    const expected = new URL(config.homeUrl);
    const parsedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    const expectedPath = expected.pathname.replace(/\/+$/, "") || "/";
    return parsed.origin === expected.origin && parsedPath === expectedPath;
  } catch {
    return false;
  }
}

function findSiteHomeTab(tabs, config) {
  return tabs.find((tab) => isSiteHomeUrl(tab.url, config)) || null;
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return null;
  }
}

/** The currently active target — updated when a query specifies a target. */
let activeTarget = "chatgpt";

// Connection state tracking
let zoteroConnected = false;
let lastSuccessfulContact = 0;

function debugLog(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  console.log("[sync-zotero][webchat]", event, payload || "");
}

function withZoteroAllowedRequest(init = {}) {
  const next = { ...(init || {}) };
  const headers = new Headers(next.headers || {});
  headers.set("Zotero-Allowed-Request", "1");
  next.headers = headers;
  return next;
}

function relayFetch(url, init) {
  return fetch(url, withZoteroAllowedRequest(init));
}

// Zotero's HTTP server port can vary (23119-23128). Discover the actual port.
let _portDiscoveryInFlight = false;
async function discoverZoteroPort() {
  if (_portDiscoveryInFlight) return;
  _portDiscoveryInFlight = true;
  try {
    const previousServer = SERVER;
    for (const host of RELAY_HOSTS) {
      for (let port = 23119; port <= 23128; port++) {
        try {
          const candidateServer = `http://${host}:${port}/llm-for-zotero/webchat`;
          const res = await relayFetch(`${candidateServer}/debug`);
          if (!res.ok) continue;
          const data = await res.json();
          // Verify this is actually our relay, not Zotero returning generic text
          if (data && typeof data.status === "string") {
            SERVER = candidateServer;
            lastSuccessfulContact = Date.now();

            const wasConnected = zoteroConnected;
            zoteroConnected = true;

            if (SERVER !== previousServer) {
              console.log(`[sync-zotero] Found Zotero server at ${host}:${port} (relay changed)`);
              resetExtensionState();
            } else if (!wasConnected) {
              console.log(`[sync-zotero] Reconnected to Zotero server at ${host}:${port}`);
              resetExtensionState();
            } else {
              console.log(`[sync-zotero] Found Zotero server at ${host}:${port}`);
            }
            return;
          }
        } catch { /* try next host/port */ }
      }
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
    const res = await relayFetch(`${SERVER}/heartbeat`);
    if (res.ok) {
      lastSuccessfulContact = Date.now();
      // Update activeTarget from relay if provided
      try {
        const hb = await res.clone().json();
        if (hb.active_target && SITE_CONFIGS[hb.active_target]) {
          if (activeTarget !== hb.active_target) {
            // Target changed — clear stale tab reference so SCRAPE_HISTORY
            // and other commands discover the correct tab for the new target.
            activeChatTabId = null;
            console.log(`[sync-zotero] Target changed: ${activeTarget} → ${hb.active_target}, cleared activeChatTabId`);
          }
          activeTarget = hb.active_target;
        }
      } catch { /* non-critical */ }
      if (!zoteroConnected) {
        zoteroConnected = true;
        console.log("[sync-zotero] Heartbeat: reconnected to Zotero");
        resetExtensionState();
      }

      // Report extension status (chat tab alive, URL) to the relay
      // Only report alive if a tab matching the ACTIVE TARGET is open
      try {
        let chatTabAlive = false;
        let chatUrl = null;
        let health = null;
        const targetConfig = getSiteConfig(activeTarget);
        const tabs = await chrome.tabs.query({ url: targetConfig.urlPattern });
        if (tabs.length > 0) {
          chatTabAlive = true;
          const preferred = activeChatTabId !== null
            ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
            : tabs[0];
          chatUrl = preferred?.url || null;
          if (preferred?.id !== undefined && preferred?.id !== null) {
            try {
              health = await sendToContentScript(preferred.id, { type: "HEALTH_CHECK" });
            } catch (err) {
              health = {
                ok: false,
                contentScriptAlive: false,
                siteId: targetConfig.siteId,
                url: chatUrl,
                mainWorldInjected: false,
                composerFound: false,
                sendControlState: null,
                uploadControlFound: false,
                networkHookActive: false,
                lastRequestAt: null,
                lastStreamAt: null,
                lastDiagnostic: {
                  reasonCode: "health_check_failed",
                  phase: "health_check",
                  siteId: targetConfig.siteId,
                  message: err?.message || String(err),
                },
              };
            }
          }
        }
        relayFetch(`${SERVER}/extension_status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatTabAlive,
            chatUrl,
            siteId: health?.siteId || targetConfig.siteId,
            url: health?.url || chatUrl,
            contentScriptAlive: health?.contentScriptAlive === true,
            mainWorldInjected: health?.mainWorldInjected === true,
            composerFound: health?.composerFound === true,
            sendControlState: health?.sendControlState || null,
            uploadControlFound: health?.uploadControlFound === true,
            networkHookActive: health?.networkHookActive === true,
            lastRequestAt: health?.lastRequestAt || null,
            lastStreamAt: health?.lastStreamAt || null,
            lastDiagnostic: health?.lastDiagnostic || null,
          }),
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

// Auto-discover existing chat tabs on startup without opening new tabs.
(async () => {
  // Search all supported sites for an existing tab
  let foundTab = null;
  for (const config of Object.values(SITE_CONFIGS)) {
    const tabs = await chrome.tabs.query({ url: config.urlPattern });
    if (tabs.length > 0) {
      foundTab = tabs[0];
      activeTarget = config.siteId;
      break;
    }
  }
  if (foundTab && activeChatTabId === null) {
    activeChatTabId = foundTab.id;
    console.log(`[sync-zotero] Found existing chat tab: ${foundTab.id} (${activeTarget})`);
  }
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pipelineRunning  = false;
let activeChatTabId  = null;   // Chat tab used for the current conversation
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
    res = await relayFetch(`${SERVER}${path}`);
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
  if (!res.ok) {
    throw new Error(data.error || data.reason || `Server returned HTTP ${res.status}`);
  }
  if (data.error) throw new Error(data.error);
  if (data.ok === false && (data.reason || data.message)) {
    throw new Error(data.reason || data.message);
  }
  return data;
}

async function serverPost(path, body) {
  let res;
  try {
    res = await relayFetch(`${SERVER}${path}`, {
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
  if (!res.ok) {
    throw new Error(data.error || data.reason || `Server returned HTTP ${res.status}`);
  }
  if (data.error) throw new Error(data.error);
  if (data.ok === false && (data.reason || data.message)) {
    throw new Error(data.reason || data.message);
  }
  return data;
}

async function claimQuery(seq) {
  return serverPost("/claim_query", { seq });
}

async function ackQueryPhase(seq, attempt, phase, diagnostic = null) {
  return serverPost("/ack_query_phase", {
    seq,
    attempt,
    phase,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

async function releaseQuery(seq, attempt) {
  return serverPost("/release_query", { seq, attempt });
}

async function reportTurnState(body) {
  return serverPost("/update_turn_state", body);
}

function formatDiagnosticError(message, diagnostic) {
  const base = String(message || "WebChat bridge error");
  if (!diagnostic || typeof diagnostic !== "object") return base;
  const details = [];
  if (diagnostic.reasonCode) details.push(String(diagnostic.reasonCode));
  if (diagnostic.phase) details.push(`phase=${diagnostic.phase}`);
  if (diagnostic.sendControlState) details.push(`send=${diagnostic.sendControlState}`);
  if (Number.isFinite(Number(diagnostic.clickAttempts))) {
    details.push(`clicks=${Number(diagnostic.clickAttempts)}`);
  }
  if (diagnostic.requestObserved === true) details.push("request_observed");
  if (diagnostic.streamObserved === true) details.push("stream_observed");
  return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

async function waitForChatReadyInTab(tabId, expectedChatUrl = null, timeoutMs = 30_000) {
  const response = await sendToContentScript(tabId, {
    type: "WAIT_FOR_CHAT_READY",
    expectedChatUrl,
    timeoutMs,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Chat did not become ready.");
  }
  return response;
}

async function resetNetworkCacheInTab(tabId, scope = "all") {
  try {
    await sendToContentScript(tabId, {
      type: "RESET_NETWORK_CACHE",
      scope,
    });
  } catch (_) {}
}

async function publishReadyConversationState(
  tabId,
  expectedChatUrl = null,
  { submitScraped = false, expectedChatId = null, minCapturedAt = 0 } = {},
) {
  const expectedSiteConfig = expectedChatUrl
    ? getSiteConfigByUrl(expectedChatUrl)
    : getSiteConfig(activeTarget);
  const allowNetworkReadyFallback =
    submitScraped && expectedSiteConfig?.siteId === "deepseek";
  const readyTimeoutMs = allowNetworkReadyFallback ? 8_000 : 30_000;
  const fallbackReady = {
    ok: false,
    ready: false,
    chatUrl: expectedChatUrl || null,
    chatId: expectedChatId || null,
    transcriptCount: 0,
    transcriptHash: null,
    messages: [],
  };
  const readyPromise = (async () => {
    try {
      return await waitForChatReadyInTab(tabId, expectedChatUrl, readyTimeoutMs);
    } catch (err) {
      if (!allowNetworkReadyFallback) {
        throw err;
      }
      debugLog("ready_fallback_network", {
        expectedChatUrl,
        expectedChatId,
        reason: err?.message || String(err),
      });
      return fallbackReady;
    }
  })();
  let ready = allowNetworkReadyFallback ? fallbackReady : await readyPromise;
  if (!allowNetworkReadyFallback) {
    debugLog("ready_ack", ready);
  }

  // If we got empty messages on a conversation page, retry once after a delay
  const convSiteConfig = expectedChatUrl ? getSiteConfigByUrl(expectedChatUrl) : null;
  const isConversationPage = expectedChatUrl && convSiteConfig?.conversationUrlPattern?.test(expectedChatUrl);
  if (
    submitScraped &&
    ready?.ok !== false &&
    isConversationPage &&
    (!ready.messages || ready.messages.length === 0) &&
    expectedSiteConfig?.siteId !== "deepseek"
  ) {
    debugLog("ready_retry", "empty messages on conversation page, retrying…");
    await new Promise(r => setTimeout(r, 2000));
    ready = await waitForChatReadyInTab(tabId, expectedChatUrl);
    debugLog("ready_retry_ack", ready);
  }

  if (submitScraped) {
    const scrapeTimeoutMs =
      expectedSiteConfig?.siteId === "deepseek" ? 20_000 : 15_000;
    const canonicalChatUrl =
      expectedSiteConfig?.siteId === "deepseek" && expectedChatUrl
        ? expectedChatUrl
        : null;
    const canonicalChatId =
      expectedSiteConfig?.siteId === "deepseek" && expectedChatId
        ? expectedChatId
        : null;
    // Use SCRAPE_MESSAGES for full scroll-and-collect (captures all messages
    // from virtual-scrolling sites like DeepSeek, not just the visible ones).
    let scrapedSnapshot = {
      messages: ready.messages || [],
      chatUrl: canonicalChatUrl || ready.chatUrl || expectedChatUrl || null,
      chatId: canonicalChatId || ready.chatId || expectedChatId || null,
      siteHostname:
        hostnameFromUrl(canonicalChatUrl || ready.chatUrl || expectedChatUrl),
      capturedAt: Date.now(),
      source: "dom",
    };
    const reuseReadyTranscript = shared.canReuseReadyTranscriptForScrape(
      expectedSiteConfig?.siteId,
      ready,
    );
    if (reuseReadyTranscript) {
      debugLog("ready_transcript_reused", {
        siteId: expectedSiteConfig?.siteId || null,
        count: Array.isArray(ready.messages) ? ready.messages.length : 0,
      });
    } else {
      try {
        const scrapeResult = await sendToContentScript(tabId, {
          type: "SCRAPE_MESSAGES",
          expectedChatUrl,
          expectedChatId,
          minCapturedAt,
          timeoutMs: scrapeTimeoutMs,
        });
        if (scrapeResult?.ok && Array.isArray(scrapeResult.messages)) {
          scrapedSnapshot = {
            messages: scrapeResult.messages,
            chatUrl:
              canonicalChatUrl ||
              scrapeResult.chatUrl ||
              ready.chatUrl ||
              expectedChatUrl ||
              null,
            chatId:
              canonicalChatId ||
              scrapeResult.chatId ||
              ready.chatId ||
              expectedChatId ||
              null,
            siteHostname:
              hostnameFromUrl(
                canonicalChatUrl ||
                scrapeResult.chatUrl ||
                ready.chatUrl ||
                expectedChatUrl,
              ) || scrapeResult.siteHostname || hostnameFromUrl(ready.chatUrl),
            capturedAt: Number(scrapeResult.capturedAt) || Date.now(),
            source: scrapeResult.source || "dom",
          };
        }
      } catch (_) { /* fall back to ready.messages */ }
    }
    if (allowNetworkReadyFallback) {
      try {
        ready = await readyPromise;
      } catch (err) {
        debugLog("ready_post_scrape_error", {
          expectedChatUrl,
          expectedChatId,
          reason: err?.message || String(err),
        });
        ready = fallbackReady;
      }
      debugLog("ready_ack", ready);
    }
    await serverPost("/chat_history", {
      action: "submit_scraped",
      messages: scrapedSnapshot.messages,
      chatUrl: scrapedSnapshot.chatUrl,
      chatId: scrapedSnapshot.chatId,
      siteHostname: scrapedSnapshot.siteHostname,
      capturedAt: scrapedSnapshot.capturedAt,
      source: scrapedSnapshot.source,
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

// Backup: chrome.alarms wakes the service worker up even if it was killed.
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
  pollForStop();
  setTimeout(adaptivePoll, interval);
}
setTimeout(adaptivePoll, RELAY_POLL_INTERVAL_MS);

// Poll for stop signal — runs even during active pipeline (unlike pollForCommand)
async function pollForStop() {
  if (!pipelineRunning) return; // only needed during active generation
  if (!zoteroConnected) return;
  try {
    const data = await relayFetch(`${SERVER}/poll_stop`).then(r => r.json());
    if (data.stop && activeChatTabId !== null) {
      // Tell content script to click the stop button
      chrome.tabs.sendMessage(activeChatTabId, { type: "STOP" }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
}

/**
 * ChatGPT: DOM-based history scrape.
 * The sidebar is rendered by React and already present in the DOM.
 * Never reload — just scrape the existing page.
 */
async function scrapeChatGPTHistory(siteConfig, historyStartedAt) {
  const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
  let tabId = tabs.length > 0 ? tabs[0].id : null;

  if (!tabId) {
    // No ChatGPT tab — create one and wait for page load
    const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
    await waitForTabLoad(tab.id);
    tabId = tab.id;
  }

  await ensureContentScript(tabId);
  return sendToContentScript(tabId, {
    type: "SCRAPE_HISTORY_NOW",
    force: true,
    minCapturedAt: historyStartedAt,
    timeoutMs: 15_000,
  });
}

/**
 * DeepSeek: Network-capture-based history scrape.
 * History is extracted from intercepted fetch/XHR responses during page load.
 * Must reload (or navigate to home) so the network bootstrap captures fresh data.
 */
async function scrapeDeepSeekHistory(siteConfig, historyStartedAt) {
  const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
  let tabId = findSiteHomeTab(tabs, siteConfig)?.id || null;

  if (tabId) {
    // Home tab exists — reload to trigger fresh network capture
    await resetNetworkCacheInTab(tabId, "history");
    await reloadTab(tabId);
    await waitForTabLoad(tabId);
  } else if (tabs.length > 0) {
    // Site tab exists but not on home — navigate it to home
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { url: siteConfig.homeUrl });
    await waitForTabLoad(tabId);
  } else {
    // No tab — create one in background
    const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
    await waitForTabLoad(tab.id);
    tabId = tab.id;
  }

  await ensureContentScript(tabId);
  return sendToContentScript(tabId, {
    type: "SCRAPE_HISTORY_NOW",
    force: true,
    minCapturedAt: historyStartedAt,
    timeoutMs: 15_000,
  });
}

async function pollForCommand() {
  if (pipelineRunning) return;
  if (!zoteroConnected) return;
  try {
    const data = await relayFetch(`${SERVER}/poll_command`).then(r => r.json());
    // Update activeTarget from relay — clear stale tab if target changed
    if (data.active_target && SITE_CONFIGS[data.active_target]) {
      if (activeTarget !== data.active_target) {
        activeChatTabId = null;
        console.log(`[sync-zotero] poll_command: target changed ${activeTarget} → ${data.active_target}, cleared activeChatTabId`);
      }
      activeTarget = data.active_target;
    }
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

      // Navigate a chat tab to a fresh page
      const siteConfig = getSiteConfig(activeTarget);
      let tabId = activeChatTabId;

      // Find an existing chat tab if we don't have one tracked
      if (tabId === null) {
        const tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
        if (tabs.length > 0) tabId = tabs[0].id;
      }

      if (tabId !== null) {
        try {
          await chrome.tabs.update(tabId, { url: siteConfig.homeUrl });
          await waitForTabLoad(tabId);
        } catch (_) {}
      } else {
        const tab = await chrome.tabs.create({ url: siteConfig.homeUrl, active: false });
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
      const loadStartedAt = Date.now();
      await reportTurnState({
        remote_chat_url: cmd.chatUrl,
        remote_chat_id: cmd.chatId || null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: null,
        turn_status: "navigating",
      }).catch(() => {});

      // Navigate to a specific past chat URL
      let tabId = null;

      // Try to find an existing chat tab first
      const loadSiteConfig = getSiteConfigByUrl(cmd.chatUrl) || getSiteConfig(activeTarget);
      if (activeChatTabId !== null) {
        try {
          const existingTab = await chrome.tabs.get(activeChatTabId);
          if (existingTab?.url?.startsWith(loadSiteConfig.urlPrefix)) {
            tabId = activeChatTabId;
          }
        } catch (_) {
          activeChatTabId = null;
        }
      }
      if (!tabId) {
        const tabs = await chrome.tabs.query({ url: loadSiteConfig.urlPattern });
        if (tabs.length > 0) {
          tabId = tabs[0].id;
          activeChatTabId = tabId;
        }
      }

      if (tabId) {
        // SPA — navigating within it won't trigger a full page load.
        // Use the content script to navigate via window.location for a clean reload.
        try {
          await ensureContentScript(tabId);
          await resetNetworkCacheInTab(tabId, "all");
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
        // No existing chat tab — create a new one
        const tab = await chrome.tabs.create({ url: cmd.chatUrl, active: false });
        await waitForTabLoad(tab.id);
        activeChatTabId = tab.id;
        tabId = tab.id;
      }

      broadcastStatus("idle", "Loaded past chat — scraping messages…");

      try {
        await publishReadyConversationState(tabId, cmd.chatUrl, {
          submitScraped: true,
          expectedChatId: cmd.chatId || null,
          minCapturedAt: loadStartedAt,
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
          err.message || "Failed to load the selected conversation",
        );
        return;
      }

      broadcastStatus("idle", "Loaded past chat — ready for follow-up");
    } else if (cmd.type === "SCRAPE_HISTORY") {
      const historyStartedAt = Date.now();
      const scrapeSiteConfig = getSiteConfig(activeTarget);

      let scrapeResult = null;
      try {
        const scrape = (scrapeSiteConfig.siteId === "chatgpt" || scrapeSiteConfig.siteId === "lucrezia")
          ? scrapeChatGPTHistory
          : scrapeDeepSeekHistory;
		scrapeResult = await scrape(scrapeSiteConfig, historyStartedAt);
      } catch (_) {
        // Communication failure — content script never ran.
        // Post timeout metadata so the plugin's polling loop can exit.
        await serverPost("/update_chat_history", {
          sessions: [],
          siteHostname: hostnameFromUrl(scrapeSiteConfig.homeUrl),
          scrapedAt: Date.now(),
          source: null,
          status: "timeout",
        }).catch(() => {});
      }
      // If scrapeResult came back but !ok, the content script already posted
      // its own HISTORY_UPDATE — no duplicate post needed from here.
    } else if (cmd.type === "ENSURE_TAB") {
      // Open the target site tab if none is currently open (auto-open on preload)
      const ensureConfig = getSiteConfig(activeTarget);
      const existingTabs = await chrome.tabs.query({ url: ensureConfig.urlPattern });
      if (existingTabs.length === 0) {
        const tab = await chrome.tabs.create({ url: ensureConfig.homeUrl, active: false });
        await waitForTabLoad(tab.id);
        activeChatTabId = tab.id;
        console.log(`[sync-zotero] ENSURE_TAB: opened ${ensureConfig.homeUrl} (tab ${tab.id})`);
      } else {
        activeChatTabId = existingTabs[0].id;
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
    // Forward the scraped history to the relay server.
    // Include siteHostname so the relay can merge per-site (e.g. empty
    // DeepSeek scrape clears only DeepSeek entries, not ChatGPT's).
    const siteHostname = message.siteHostname || null;
    const scrapedAt = Number(message.scrapedAt) || Date.now();
    serverPost("/update_chat_history", {
      sessions: message.history,
      siteHostname,
      scrapedAt,
      source: message.source || null,
      status: message.status || null,
    })
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

  // Determine which site to use from the query target (defaults to active/chatgpt)
  const queryTarget = query.target || activeTarget || "chatgpt";
  activeTarget = queryTarget;
  const siteConfig = getSiteConfig(queryTarget);
  const siteLabel = getSiteConfig(queryTarget).label || "Chat";

  broadcastStatus("running", isFollowup
    ? (query.pdf_base64 ? `Attaching PDF to conversation…` : `Sending follow-up to ${siteLabel}…`)
    : (query.pdf_base64 ? `Starting fresh chat with PDF: ${query.pdf_filename}…` : `Starting fresh ${siteLabel} chat…`)
  );

  try {
    // ── Drain stale NEW_CHAT command ────────────────────────────────
    // If this query starts fresh, consume any pending NEW_CHAT command
    // so it doesn't fire after the pipeline and navigate away.
    if (startsFresh) {
      try {
        await relayFetch(`${SERVER}/poll_command`).then(r => r.json());
      } catch (_) { /* server not running — ignore */ }
    }

    // ── Get the right chat tab ─────────────────────────────────────
    let tab = null;

    if (activeChatTabId !== null) {
      try {
        const existing = await chrome.tabs.get(activeChatTabId);
        if (existing?.url?.startsWith(siteConfig.urlPrefix)) {
          tab = existing;
        }
      } catch (_) {
        activeChatTabId = null;
      }
    }

    if (!tab) {
      tab = await getChatTab(queryTarget);
      activeChatTabId = tab.id;
    }

    const shouldNavigateFresh = startsFresh;

    if (shouldNavigateFresh) {
      // Skip navigation if tab is already on the site's home/new-chat URL
      const currentUrl = tab.url || "";
      const isAlreadyHome = (
        currentUrl === siteConfig.homeUrl ||
        currentUrl === siteConfig.homeUrl.slice(0, -1) ||
        currentUrl === siteConfig.urlPrefix
      );
      if (!isAlreadyHome) {
        try {
          await chrome.tabs.update(tab.id, { url: siteConfig.homeUrl });
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
      shouldNavigateFresh ? null : (tab.url || null),
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
      diagnostic,
    } = await streamPipeline(tab.id, {
      pdfBase64:    query.pdf_base64 || null,
      pdfFilename:  query.pdf_base64 ? (query.pdf_filename || "document.pdf") : null,
      prompt:       query.prompt,
      images:       query.images || null,
      chatgptMode:  query.chatgpt_mode || null,
      seq,
      attempt,
    });

    let finalRunState = runState;
    let finalCompletionReason = completionReason || null;
    if (finalRunState === "done" && !shared.hasMeaningfulAssistantText(responseText)) {
      const hasPartialContext =
        Boolean((thinkingText || "").trim()) ||
        Number(answerRevision || 0) > 0 ||
        Number(thinkingRevision || 0) > 0;
      if (hasPartialContext) {
        finalRunState = "incomplete";
        finalCompletionReason = finalCompletionReason || "error";
      } else {
        throw new Error(`${siteLabel} did not produce a visible final answer.`);
      }
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
      run_state: finalRunState,
      completion_reason: finalCompletionReason,
      final_transcript_hash: finalTranscriptHash || null,
      verified_at: verifiedAt || null,
      remote_chat_url: remoteChatUrl || null,
      remote_chat_id: remoteChatId || null,
      user_turn_key: userTurnKey || null,
      assistant_turn_key: assistantTurnKey || null,
      baseline_transcript_count: baselineTranscriptCount || 0,
      baseline_transcript_hash: baselineTranscriptHash || null,
      turn_status:
        turnStatus ||
        (finalRunState === "incomplete" ? "incomplete" : "done"),
      diagnostic: diagnostic || null,
    });

    // Capture the conversation URL for history persistence (works for all sites)
    try {
      const currentTab = await chrome.tabs.get(activeChatTabId);
      const tabSiteConfig = currentTab.url ? getSiteConfigByUrl(currentTab.url) : null;
      if (tabSiteConfig && currentTab.url !== tabSiteConfig.homeUrl) {
        await serverPost("/update_chat_url", { chat_url: currentTab.url });
      }
    } catch (_) {}

    broadcastStatus(
      finalRunState === "incomplete" ? "error" : "done",
      finalRunState === "incomplete"
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

    await submitError(seq, err.message, attempt, err.diagnostic || null);

    const msg = err.message.includes("Failed to fetch")
      ? "Cannot reach local server. Is gui.py running?"
      : err.message;
    broadcastStatus("error", msg);

  } finally {
    pipelineRunning = false;
  }
}

async function submitError(seq, errorMsg, attempt, diagnostic = null) {
  try {
    await serverPost("/submit_response", {
      seq,
      attempt,
      response: null,
      error: errorMsg,
      diagnostic,
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function getChatTab(target) {
  const config = getSiteConfig(target || activeTarget);
  const tabs = await chrome.tabs.query({ url: config.urlPattern });
  if (tabs.length > 0) return tabs[0];  // reuse silently, no focus change
  // Open a new tab in the background (active: false keeps user's focus)
  const tab = await chrome.tabs.create({ url: config.homeUrl, active: false });
  await waitForTabLoad(tab.id);
  return tab;
}

// Backward compat alias
async function getChatGPTTab() {
  return getChatTab(activeTarget);
}

function waitForTabLoad(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish();
        return;
      }
      if (tab && tab.status === "complete") {
        finish();
      }
    });
  });
}

// Clear activeChatTabId if the user closes the chat tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeChatTabId) {
    activeChatTabId = null;
    broadcastStatus("idle", "Chat tab closed — next query will open a new conversation");
  }
});

// ---------------------------------------------------------------------------
// Content script messaging (with retry)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Port-based streaming pipeline
// ---------------------------------------------------------------------------

function streamPipeline(tabId, payload) {
  // Disconnect any stale port from a previous pipeline
  if (activePort) {
    try { activePort.disconnect(); } catch (_) {}
    activePort = null;
  }

  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "sync-zotero" });
    activePort = port;
    let resolved = false;
    let submitted = false;
    let streamingAcked = false;
    let relayPostFailureCount = 0;
    let timeoutId = null;

    const disconnectPort = () => {
      if (activePort === port) activePort = null;
      try { port.disconnect(); } catch (_) {}
    };

    const finish = (callback, value) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      disconnectPort();
      callback(value);
    };

    const handleRelayUpdateError = (err, context, diagnostic = null) => {
      const reason = err?.message || String(err);
      relayPostFailureCount += 1;
      const isContractMismatch = /(?:^|\b)(seq_mismatch|attempt_mismatch)(?:\b|$)/i.test(reason);
      if (isContractMismatch || relayPostFailureCount >= 3) {
        const error = new Error(`Relay update failed during ${context}: ${reason}`);
        error.diagnostic = diagnostic || null;
        finish(reject, error);
        return false;
      }
      console.warn(`[sync-zotero] Relay update failed during ${context}: ${reason}`);
      return true;
    };

    const postRelayUpdate = async (context, diagnostic, fn) => {
      if (resolved) return false;
      try {
        await fn();
        relayPostFailureCount = 0;
        return true;
      } catch (err) {
        return handleRelayUpdateError(err, context, diagnostic);
      }
    };

    timeoutId = setTimeout(() => {
      finish(reject, new Error("Pipeline timed out after 60 minutes"));
    }, PIPELINE_TIMEOUT_MS);

    port.onMessage.addListener(async (msg) => {
      if (msg.seq !== undefined && msg.seq !== payload.seq) return;
      if (msg.attempt !== undefined && msg.attempt !== payload.attempt) return;

      if (msg.type === "phase") {
        if (msg.phase === "submitted" || msg.phase === "streaming") {
          submitted = true;
        }
        if (!(await postRelayUpdate(
          `phase:${msg.phase}`,
          msg.diagnostic || null,
          () => ackQueryPhase(payload.seq, payload.attempt, msg.phase, msg.diagnostic || null),
        ))) return;
      } else if (msg.type === "turn_state") {
        if (!(await postRelayUpdate(
          `turn_state:${msg.turnStatus || "unknown"}`,
          msg.diagnostic || null,
          () => reportTurnState({
            seq: payload.seq,
            attempt: payload.attempt,
            remote_chat_url: msg.remoteChatUrl ?? null,
            remote_chat_id: msg.remoteChatId ?? null,
            user_turn_key: msg.userTurnKey ?? null,
            assistant_turn_key: msg.assistantTurnKey ?? null,
            baseline_transcript_count: msg.baselineTranscriptCount ?? 0,
            baseline_transcript_hash: msg.baselineTranscriptHash ?? null,
            turn_status: msg.turnStatus ?? null,
            diagnostic: msg.diagnostic ?? null,
          }),
        ))) return;
      } else if (msg.type === "snapshot") {
        if (!streamingAcked) {
          streamingAcked = true;
          submitted = true;
          if (!(await postRelayUpdate(
            "phase:streaming",
            msg.diagnostic || null,
            () => ackQueryPhase(payload.seq, payload.attempt, "streaming", msg.diagnostic || null),
          ))) return;
        }
        broadcastStatus(
          "running",
          msg.runState === "settling"
            ? "Settling visible response…"
            : (msg.thinking ? "Thinking…" : "Streaming response…"),
        );
        if (!(await postRelayUpdate(
          "snapshot",
          msg.diagnostic || null,
          () => serverPost("/update_partial", {
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
            diagnostic: msg.diagnostic ?? null,
          }),
        ))) return;
      } else if (msg.type === "mode_report") {
        // Forward ChatGPT's actual mode back to the plugin relay
        serverPost("/update_mode", { seq: payload.seq, mode: msg.mode }).catch(() => {});
      } else if (msg.type === "terminal") {
        finish(resolve, {
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
          diagnostic: msg.diagnostic ?? null,
        });
      } else if (msg.type === "error") {
        const error = new Error(formatDiagnosticError(msg.error, msg.diagnostic || null));
        error.diagnostic = msg.diagnostic || null;
        finish(reject, error);
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
      if (!resolved) {
        if (timeoutId !== null) clearTimeout(timeoutId);
        resolved = true;
        const err = chrome.runtime.lastError;
        const error = new Error("Port disconnected unexpectedly" + (err ? ": " + err.message : ""));
        error.name = submitted ? "PipelineDisconnect" : "PreSubmitDisconnect";
        reject(error);
      }
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

async function reloadTab(tabId) {
  await new Promise((resolve) => {
    chrome.tabs.reload(tabId, () => {
      void chrome.runtime.lastError;
      resolve();
    });
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

  // Poll briefly instead of always paying a fixed 1s delay after injection.
  for (let attempt = 0; attempt < 10; attempt++) {
    const ready = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        resolve(!chrome.runtime.lastError && res?.pong === true);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
        const res = await relayFetch(`${SERVER}/poll_response?since=0`);
        relayAlive = res.ok;
      } catch { /* offline */ }

      // Check chat tabs — look for ANY open supported chat tab
      let chatTabAlive = false;
      let chatUrl = null;
      let activeSiteLabel = "Chat Site";
      try {
        const siteConfig = getSiteConfig(activeTarget);
        activeSiteLabel = getSiteConfig(activeTarget).label || "Chat";

        // Check the active target's site first
        let tabs = await chrome.tabs.query({ url: siteConfig.urlPattern });
        // Fall back to checking all supported sites
        if (tabs.length === 0) {
          for (const pattern of ALL_SITE_URL_PATTERNS) {
            tabs = await chrome.tabs.query({ url: pattern });
            if (tabs.length > 0) {
              const foundConfig = getSiteConfigByUrl(tabs[0].url);
              if (foundConfig) activeSiteLabel = foundConfig.label || "Chat";
              break;
            }
          }
        }
        if (tabs.length > 0) {
          chatTabAlive = true;
          const preferred = activeChatTabId !== null
            ? tabs.find(t => t.id === activeChatTabId) || tabs[0]
            : tabs[0];
          chatUrl = preferred.url || null;
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
        activeSiteLabel,
        pipelineState: ps.state,
        pipelineMessage: ps.message,
      });
    })();
    return true; // async sendResponse
  }
});
