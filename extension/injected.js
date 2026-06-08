/**
 * injected.js — Runs in MAIN world (same JS context as the page).
 *
 * Patches network primitives so the extension can:
 *   1. stream live assistant output from SSE requests
 *   2. capture DeepSeek bootstrap JSON for sidebar history and full transcripts
 *
 * Network snapshots are cached in the page world and replayed to the content
 * script on request so background tabs remain readable even when the DOM is
 * virtualized or not fully painted.
 */

(function () {
  "use strict";

  const PATCH_VERSION = 4;
  if (window.__syncZoteroFetchPatched >= PATCH_VERSION) return;
  window.__syncZoteroFetchPatched = PATCH_VERSION;

  const originalFetch = window.__syncZoteroOriginalFetch || window.fetch;
  window.__syncZoteroOriginalFetch = originalFetch;

  const XHRProto = window.XMLHttpRequest?.prototype;
  const originalXHROpen =
    window.__syncZoteroOriginalXHROpen ||
    (XHRProto ? XHRProto.open : null);
  const originalXHRSend =
    window.__syncZoteroOriginalXHRSend ||
    (XHRProto ? XHRProto.send : null);
  if (originalXHROpen) window.__syncZoteroOriginalXHROpen = originalXHROpen;
  if (originalXHRSend) window.__syncZoteroOriginalXHRSend = originalXHRSend;

  let activeConversationStreamCount = 0;

  function postPageEvent(payload) {
    try {
      window.postMessage(payload, "*");
    } catch {
      /* keep page execution isolated from the extension */
    }
  }

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeAssistantText(text) {
    return normalizeWhitespace(text).replace(/\s+/g, " ").trim();
  }

  function fingerprintText(text) {
    const normalized = normalizeWhitespace(text)
      .normalize("NFC")
      .toLowerCase();
    if (!normalized) return "";
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${normalized.length}:${(hash >>> 0).toString(36)}`;
  }

  function hasMeaningfulAssistantText(text) {
    const normalized = normalizeAssistantText(text).toLowerCase();
    if (!normalized) return false;
    if (
      normalized === "thinking" ||
      normalized === "thinking..." ||
      normalized === "stopped thinking" ||
      normalized === "quick answer" ||
      normalized === "stopped thinking quick answer"
    ) {
      return false;
    }
    if (/^thought for .+$/.test(normalized)) return false;
    if (/^reading\s+documents?\.?$/i.test(normalized)) return false;
    if (/^searching(\s+the\s+web)?\.?$/i.test(normalized)) return false;
    if (/^analyzing\.?$/i.test(normalized)) return false;
    if (/^browsing\.?$/i.test(normalized)) return false;
    // Chinese equivalents (DeepSeek Chinese UI)
    const raw = normalizeAssistantText(text);
    if (raw === "思考中" || raw === "思考中..." || raw === "深度思考" || raw === "停止思考") return false;
    if (/^已深度思考/.test(raw) || /^已思考/.test(raw) || /^思考了/.test(raw)) return false;
    if (/^正在阅读/.test(raw) || /^正在搜索/.test(raw) ||
        /^正在分析/.test(raw) || /^正在浏览/.test(raw)) return false;
    return true;
  }

  function normalizeUrl(url) {
    return String(url || "").replace(/#.*$/, "").replace(/\/+$/, "");
  }

  function resolveUrl(url) {
    try {
      return new URL(String(url || ""), window.location.href).href;
    } catch {
      return String(url || "");
    }
  }

  function getCurrentChatUrl() {
    return normalizeUrl(window.location.href);
  }

  function getCurrentChatId(url = getCurrentChatUrl()) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/a\/chat\/s\/([^/?#]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function buildDeepSeekChatUrl(chatId) {
    if (!chatId) return null;
    return `https://chat.deepseek.com/a/chat/s/${chatId}`;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function safeJsonParse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function looksLikeJsonText(raw) {
    const trimmed = String(raw || "").trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }

  function extractTextValue(value, depth = 0) {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => extractTextValue(item, depth + 1))
        .filter(Boolean)
        .join("\n");
    }
    if (!isObject(value)) return "";

    const directKeys = [
      "text",
      "content",
      "value",
      "answer",
      "output_text",
      "message",
      "parts",
    ];
    const chunks = [];
    for (const key of directKeys) {
      if (!(key in value)) continue;
      const next = extractTextValue(value[key], depth + 1);
      if (next) chunks.push(next);
    }
    return chunks.join("\n");
  }

  function extractReasoningValue(value, depth = 0) {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((item) => extractReasoningValue(item, depth + 1))
        .filter(Boolean)
        .join("\n");
    }
    if (!isObject(value)) return "";

    const keys = [
      "reasoning_content",
      "reasoning",
      "thinking",
      "thinking_text",
      "reasoning_text",
    ];
    const chunks = [];
    for (const key of keys) {
      if (!(key in value)) continue;
      const next = extractReasoningValue(value[key], depth + 1);
      if (next) chunks.push(next);
    }
    return chunks.join("\n");
  }

  function extractAttachmentNames(value, depth = 0) {
    if (depth > 4 || value == null) return [];
    if (Array.isArray(value)) {
      return value.flatMap((item) => extractAttachmentNames(item, depth + 1));
    }
    if (!isObject(value)) return [];

    const names = [];
    for (const key of ["attachments", "files", "documents"]) {
      if (!(key in value)) continue;
      const raw = value[key];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === "string" && item.trim()) {
            names.push(item.trim());
            continue;
          }
          if (!isObject(item)) continue;
          const name =
            typeof item.name === "string" && item.name.trim()
              ? item.name.trim()
              : typeof item.filename === "string" && item.filename.trim()
                ? item.filename.trim()
                : typeof item.file_name === "string" && item.file_name.trim()
                  ? item.file_name.trim()
                  : "";
          if (name) names.push(name);
        }
      }
    }
    return names;
  }

  function normalizeTranscriptRole(raw) {
    const candidate =
      typeof raw === "string"
        ? raw
        : typeof raw?.role === "string"
          ? raw.role
          : typeof raw?.author?.role === "string"
            ? raw.author.role
            : typeof raw?.message?.role === "string"
              ? raw.message.role
              : "";
    const normalized = String(candidate || "").trim().toLowerCase();
    if (normalized === "human") return "user";
    if (normalized === "model") return "assistant";
    return normalized;
  }

  function normalizeDeepSeekTranscriptMessage(raw) {
    if (!isObject(raw)) return null;

    const role = normalizeTranscriptRole(raw);
    if (role !== "user" && role !== "assistant" && role !== "system") {
      return null;
    }

    const text = normalizeWhitespace(
      extractTextValue(
        raw.content ??
        raw.message?.content ??
        raw.text ??
        raw.output_text ??
        raw.answer ??
        "",
      ),
    );
    const thinking = normalizeWhitespace(
      extractReasoningValue(raw.reasoning_content != null ? raw : raw.message || raw),
    );
    const attachments = extractAttachmentNames(raw);

    if (!text && !thinking && attachments.length === 0) {
      return null;
    }

    return {
      role,
      text,
      thinking: thinking || undefined,
      attachments: attachments.length ? Array.from(new Set(attachments)) : undefined,
    };
  }

  function extractPromptTextFromRequestPayload(value, depth = 0) {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") {
      return normalizeWhitespace(value);
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        const normalized = normalizeDeepSeekTranscriptMessage(value[index]);
        if (normalized?.role === "user" && normalized.text) {
          return normalized.text;
        }
      }
      for (let index = value.length - 1; index >= 0; index--) {
        const next = extractPromptTextFromRequestPayload(value[index], depth + 1);
        if (next) return next;
      }
      return "";
    }
    if (!isObject(value)) return "";

    for (const key of ["messages", "message_list", "conversation", "turns"]) {
      if (Array.isArray(value[key])) {
        const next = extractPromptTextFromRequestPayload(value[key], depth + 1);
        if (next) return next;
      }
    }

    for (const key of ["prompt", "query", "input", "message", "content", "text"]) {
      if (!(key in value)) continue;
      const next = extractPromptTextFromRequestPayload(value[key], depth + 1);
      if (next) return next;
    }

    for (const child of Object.values(value)) {
      const next = extractPromptTextFromRequestPayload(child, depth + 1);
      if (next) return next;
    }

    return "";
  }

  function extractPromptFingerprintFromBody(body) {
    if (body == null) return null;
    let payload = body;
    if (typeof body === "string") {
      payload = safeJsonParse(body) ?? body;
    }
    const promptText = extractPromptTextFromRequestPayload(payload);
    return fingerprintText(promptText) || null;
  }

  function extractPromptFingerprintFromFetchArgs(args) {
    try {
      if (args[0] instanceof Request) {
        return null;
      }
      const body = args[1]?.body;
      if (typeof body === "string") {
        return extractPromptFingerprintFromBody(body);
      }
      if (body instanceof URLSearchParams) {
        return extractPromptFingerprintFromBody(body.toString());
      }
      if (body instanceof FormData) {
        const textFields = [];
        for (const [key, value] of body.entries()) {
          if (typeof value === "string") {
            textFields.push(`${key}=${value}`);
          }
        }
        return extractPromptFingerprintFromBody(textFields.join("&"));
      }
    } catch {
      return null;
    }
    return null;
  }

  let outboundRequestSerial = 0;

  function postConversationRequestEvent(url, method, promptFingerprint = null) {
    const chatUrl = getCurrentChatUrl();
    postPageEvent({
      type: "SYNC_ZOTERO_REQUEST",
      url,
      method,
      timestamp: Date.now(),
      requestSerial: ++outboundRequestSerial,
      chatUrl,
      chatId: getCurrentChatId(chatUrl),
      sentAt: Date.now(),
      promptFingerprint: promptFingerprint || null,
    });
  }

  const DEEPSEEK_HISTORY_PRIMARY_ARRAY_KEYS = new Set([
    "history",
    "histories",
    "conversations",
    "conversationlist",
    "sessions",
    "sessionlist",
    "threads",
    "threadlist",
    "chatlist",
    "chatsessions",
    "chatsessionlist",
  ]);
  const DEEPSEEK_HISTORY_SECONDARY_ARRAY_KEYS = new Set([
    "items",
    "list",
    "results",
  ]);
  const DEEPSEEK_TRANSCRIPT_PRIMARY_ARRAY_KEYS = new Set([
    "messages",
    "messagelist",
    "conversationmessages",
    "chatmessages",
    "turns",
    "turnlist",
  ]);
  const DEEPSEEK_TRANSCRIPT_SECONDARY_ARRAY_KEYS = new Set([
    "items",
    "list",
    "results",
  ]);
  const DEEPSEEK_CONTEXT_OBJECT_KEYS = ["chat", "session", "conversation", "thread"];
  const DEEPSEEK_HISTORY_TITLE_KEYS = new Set([
    "title",
    "conversationtitle",
    "chattitle",
    "sessiontitle",
    "threadtitle",
    "displaytitle",
  ]);

  function normalizeContainerKey(key) {
    return String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function pathHasContextToken(path, tokens) {
    return path.some(
      (segment) =>
        typeof segment === "string" &&
        tokens.some((token) => normalizeContainerKey(segment).includes(token)),
    );
  }

  function objectHasContextToken(value, tokens) {
    if (!isObject(value)) return false;
    return Object.keys(value).some((key) =>
      tokens.some((token) => normalizeContainerKey(key).includes(token)),
    );
  }

  function collectExplicitArrayCandidates(
    value,
    {
      primaryKeys,
      secondaryKeys,
      contextTokens,
      urlHint = false,
      allowRootArray = false,
    },
    depth = 0,
    path = [],
    out = [],
  ) {
    if (depth > 5 || value == null) return out;

    if (Array.isArray(value)) {
      if (allowRootArray && path.length === 0) {
        out.push({ array: value, parent: null, key: null, path: [] });
      }
      for (let index = 0; index < value.length; index++) {
        const child = value[index];
        if (Array.isArray(child) || isObject(child)) {
          collectExplicitArrayCandidates(
            child,
            { primaryKeys, secondaryKeys, contextTokens, urlHint, allowRootArray: false },
            depth + 1,
            path.concat(index),
            out,
          );
        }
      }
      return out;
    }

    if (!isObject(value)) return out;

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeContainerKey(key);
      if (Array.isArray(child)) {
        const hasContext =
          objectHasContextToken(value, contextTokens) ||
          pathHasContextToken(path, contextTokens);
        if (
          primaryKeys.has(normalizedKey) ||
          (secondaryKeys.has(normalizedKey) && (hasContext || urlHint))
        ) {
          out.push({
            array: child,
            parent: value,
            key,
            path: path.concat(key),
          });
        }
      }
      if (Array.isArray(child) || isObject(child)) {
        collectExplicitArrayCandidates(
          child,
          { primaryKeys, secondaryKeys, contextTokens, urlHint, allowRootArray: false },
          depth + 1,
          path.concat(key),
          out,
        );
      }
    }

    return out;
  }

  function getDirectContextObjects(raw) {
    if (!isObject(raw)) return [];
    const contexts = [raw];
    for (const key of DEEPSEEK_CONTEXT_OBJECT_KEYS) {
      if (isObject(raw[key])) {
        contexts.push(raw[key]);
      }
    }
    return contexts;
  }

  function extractDeepSeekChatReferenceFromString(value, { allowBareId = false } = {}) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return { chatId: null, chatUrl: null };

    const resolved = resolveUrl(trimmed);
    const absoluteMatch = resolved.match(
      /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/([^/?#]+)$/,
    );
    if (absoluteMatch) {
      return {
        chatId: absoluteMatch[1],
        chatUrl: normalizeUrl(resolved),
      };
    }

    const pathMatch = trimmed.match(/^\/a\/chat\/s\/([^/?#]+)$/);
    if (pathMatch) {
      return {
        chatId: pathMatch[1],
        chatUrl: buildDeepSeekChatUrl(pathMatch[1]),
      };
    }

    if (allowBareId && /^[0-9a-z-]{16,}$/i.test(trimmed)) {
      return {
        chatId: trimmed,
        chatUrl: buildDeepSeekChatUrl(trimmed),
      };
    }

    return { chatId: null, chatUrl: null };
  }

  function extractDeepSeekChatReferenceFromObject(raw, { allowBareId = false } = {}) {
    if (!isObject(raw)) return { chatId: null, chatUrl: null };
    const contexts = getDirectContextObjects(raw);
    const urlKeys = [
      "chat_url",
      "chatUrl",
      "session_url",
      "sessionUrl",
      "conversation_url",
      "conversationUrl",
      "url",
      "href",
      "path",
    ];
    const idKeys = [
      "chat_id",
      "chatId",
      "chat_session_id",
      "chatSessionId",
      "session_id",
      "sessionId",
      "conversation_id",
      "conversationId",
      "thread_id",
      "threadId",
      "id",
    ];

    for (const context of contexts) {
      for (const key of urlKeys) {
        const match = extractDeepSeekChatReferenceFromString(context[key], {
          allowBareId: false,
        });
        if (match.chatId || match.chatUrl) return match;
      }
      for (const key of idKeys) {
        const match = extractDeepSeekChatReferenceFromString(context[key], {
          allowBareId,
        });
        if (match.chatId || match.chatUrl) return match;
      }
    }

    return { chatId: null, chatUrl: null };
  }

  function extractDeepSeekEntryTitle(raw) {
    const contexts = getDirectContextObjects(raw);
    for (const context of contexts) {
      for (const [key, value] of Object.entries(context)) {
        if (typeof value !== "string") continue;
        if (!DEEPSEEK_HISTORY_TITLE_KEYS.has(normalizeContainerKey(key))) continue;
        const title = normalizeWhitespace(value);
        if (title) return title;
      }
    }
    return "";
  }

  function scoreTranscriptCandidate(candidate) {
    const assistantCount = candidate.messages.filter((message) => message.role === "assistant").length;
    const userCount = candidate.messages.filter((message) => message.role === "user").length;
    const meaningfulAssistantCount = candidate.messages.filter(
      (message) => message.role === "assistant" && hasMeaningfulAssistantText(message.text),
    ).length;
    const thinkingCount = candidate.messages.filter((message) => message.thinking).length;

    return (
      candidate.messages.length * 10 +
      assistantCount * 8 +
      userCount * 6 +
      meaningfulAssistantCount * 12 +
      thinkingCount * 2 +
      (candidate.chatId ? 10 : 0) +
      (candidate.chatUrl ? 10 : 0)
    );
  }

  function extractDeepSeekTranscriptSnapshot(payload, responseUrl) {
    const candidates = collectExplicitArrayCandidates(payload, {
      primaryKeys: DEEPSEEK_TRANSCRIPT_PRIMARY_ARRAY_KEYS,
      secondaryKeys: DEEPSEEK_TRANSCRIPT_SECONDARY_ARRAY_KEYS,
      contextTokens: ["message", "conversation", "chat", "turn"],
      urlHint: urlLooksLikeTranscriptResponse(responseUrl),
      allowRootArray: urlLooksLikeTranscriptResponse(responseUrl),
    });

    const currentChatUrl = normalizeUrl(getCurrentChatUrl());
    const currentChatId = getCurrentChatId(currentChatUrl);
    const currentConversationUrl = currentChatId ? currentChatUrl : "";
    let best = null;

    for (const candidate of candidates) {
      const normalizedMessages = candidate.array
        .map((item) => normalizeDeepSeekTranscriptMessage(item))
        .filter(Boolean);
      const assistantCount = normalizedMessages.filter(
        (message) => message.role === "assistant",
      ).length;
      const userCount = normalizedMessages.filter(
        (message) => message.role === "user",
      ).length;
      if (normalizedMessages.length < 2 || assistantCount === 0 || userCount === 0) {
        continue;
      }

      const candidateReference = extractDeepSeekChatReferenceFromObject(
        candidate.parent || {},
        { allowBareId: true },
      );
      const payloadReference = extractDeepSeekChatReferenceFromObject(payload, {
        allowBareId: true,
      });
      const responseReference = extractDeepSeekChatReferenceFromString(responseUrl, {
        allowBareId: false,
      });
      const chatId =
        currentChatId ||
        candidateReference.chatId ||
        payloadReference.chatId ||
        responseReference.chatId ||
        null;
      const chatUrl =
        normalizeUrl(
          currentConversationUrl ||
          candidateReference.chatUrl ||
          payloadReference.chatUrl ||
          responseReference.chatUrl ||
          (chatId ? buildDeepSeekChatUrl(chatId) : ""),
        ) || null;
      const snapshot = {
        messages: normalizedMessages,
        chatUrl,
        chatId,
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "network",
      };
      const score = scoreTranscriptCandidate(snapshot);
      if (!best || score > best.score) {
        best = { score, snapshot };
      }
    }

    return best?.snapshot || null;
  }

  function normalizeDeepSeekHistoryEntry(raw) {
    if (!isObject(raw)) return null;

    const reference = extractDeepSeekChatReferenceFromObject(raw, {
      allowBareId: true,
    });
    const id = reference.chatId || null;
    const chatUrl = normalizeUrl(reference.chatUrl || buildDeepSeekChatUrl(id) || "");
    const title = extractDeepSeekEntryTitle(raw);

    if (!id || !chatUrl || !title || title === id || title === chatUrl) {
      return null;
    }

    return { id, title, chatUrl };
  }

  function urlLooksLikeHistoryResponse(url) {
    try {
      const parsed = new URL(resolveUrl(url));
      const path = parsed.pathname.toLowerCase();
      return (
        path.includes("history") ||
        path.includes("conversation") ||
        path.includes("session") ||
        path.includes("thread") ||
        path.includes("list")
      ) && !path.includes("/completion");
    } catch {
      return false;
    }
  }

  function urlLooksLikeTranscriptResponse(url) {
    try {
      const parsed = new URL(resolveUrl(url));
      const path = parsed.pathname.toLowerCase();
      return (
        (path.includes("message") ||
          path.includes("conversation") ||
          path.includes("chat") ||
          path.includes("turn")) &&
        !path.includes("/completion")
      );
    } catch {
      return false;
    }
  }

  function scoreHistoryCandidate(candidate) {
    return candidate.history.length * 10 + (candidate.chatIds.size * 3);
  }

  function extractDeepSeekHistorySnapshot(payload, responseUrl) {
    const urlHint = urlLooksLikeHistoryResponse(responseUrl);
    const candidates = collectExplicitArrayCandidates(payload, {
      primaryKeys: DEEPSEEK_HISTORY_PRIMARY_ARRAY_KEYS,
      secondaryKeys: DEEPSEEK_HISTORY_SECONDARY_ARRAY_KEYS,
      contextTokens: ["history", "conversation", "session", "thread", "chat"],
      urlHint,
      allowRootArray: urlHint,
    });

    let best = null;
    let sawEmpty = false;
    let sawInvalid = false;

    for (const candidate of candidates) {
      if (!Array.isArray(candidate.array)) continue;
      if (candidate.array.length === 0) {
        sawEmpty = true;
        continue;
      }

      const deduped = [];
      const seenIds = new Set();
      for (const item of candidate.array) {
        const entry = normalizeDeepSeekHistoryEntry(item);
        if (!entry || seenIds.has(entry.id)) continue;
        deduped.push(entry);
        seenIds.add(entry.id);
      }

      if (!deduped.length) {
        sawInvalid = true;
        continue;
      }

      const chatIds = new Set(deduped.map((entry) => entry.id));
      const candidateSnapshot = {
        history: deduped,
        chatIds,
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "network",
        status: "ok",
      };
      const score = scoreHistoryCandidate(candidateSnapshot);
      if (!best || score > best.score) {
        best = { score, snapshot: candidateSnapshot };
      }
    }

    if (best?.snapshot) {
      return best.snapshot;
    }
    if (sawInvalid) {
      return {
        history: [],
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "network",
        status: "invalid_source",
      };
    }
    if (sawEmpty) {
      return {
        history: [],
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "network",
        status: "empty",
      };
    }
    if (urlHint) {
      return {
        history: [],
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "network",
        status: "invalid_source",
      };
    }

    return null;
  }

  function getDeepSeekCache() {
    if (!window.__syncZoteroDeepSeekCache) {
      window.__syncZoteroDeepSeekCache = {
        transcripts: {},
        latestTranscriptKey: null,
        history: null,
      };
    }
    return window.__syncZoteroDeepSeekCache;
  }

  function makeTranscriptCacheKey(chatUrl, chatId) {
    return `${normalizeUrl(chatUrl || "")}::${String(chatId || "").trim()}`;
  }

  function emitDeepSeekTranscriptSnapshot(snapshot) {
    postPageEvent({
      type: "SYNC_ZOTERO_DEEPSEEK_TRANSCRIPT_CACHE",
      snapshot,
    });
  }

  function emitDeepSeekHistorySnapshot(snapshot) {
    postPageEvent({
      type: "SYNC_ZOTERO_DEEPSEEK_HISTORY_CACHE",
      snapshot,
    });
  }

  function storeDeepSeekTranscriptSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
      return;
    }
    const cache = getDeepSeekCache();
    const key = makeTranscriptCacheKey(snapshot.chatUrl, snapshot.chatId);
    cache.transcripts[key] = snapshot;
    cache.latestTranscriptKey = key;

    const keys = Object.keys(cache.transcripts);
    if (keys.length > 6) {
      const keysToDrop = keys.filter((entryKey) => entryKey !== key).slice(0, keys.length - 6);
      for (const entryKey of keysToDrop) {
        delete cache.transcripts[entryKey];
      }
    }

    emitDeepSeekTranscriptSnapshot(snapshot);
  }

  function storeDeepSeekHistorySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.history)) return;
    const cache = getDeepSeekCache();
    cache.history = snapshot;
    emitDeepSeekHistorySnapshot(snapshot);
  }

  function replayDeepSeekNetworkCache() {
    const cache = getDeepSeekCache();
    const transcript =
      cache.latestTranscriptKey && cache.transcripts[cache.latestTranscriptKey]
        ? cache.transcripts[cache.latestTranscriptKey]
        : null;
    if (transcript) emitDeepSeekTranscriptSnapshot(transcript);
    if (cache.history) emitDeepSeekHistorySnapshot(cache.history);
  }

  function clearDeepSeekNetworkCache(scope) {
    const cache = getDeepSeekCache();
    if (scope === "transcript" || scope === "all" || !scope) {
      cache.transcripts = {};
      cache.latestTranscriptKey = null;
    }
    if (scope === "history" || scope === "all" || !scope) {
      cache.history = null;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "SYNC_ZOTERO_NETWORK_CACHE_REQUEST") {
      replayDeepSeekNetworkCache();
      return;
    }
    if (event.data?.type === "SYNC_ZOTERO_NETWORK_CACHE_CLEAR") {
      clearDeepSeekNetworkCache(event.data.scope || "all");
      return;
    }
    if (event.data?.type === "SYNC_ZOTERO_NETWORK_HEALTH_REQUEST") {
      postPageEvent({
        type: "SYNC_ZOTERO_NETWORK_HEALTH",
        nonce: event.data.nonce || null,
        patchVersion: PATCH_VERSION,
        networkHookActive: true,
        activeStreamCount: activeConversationStreamCount,
        timestamp: Date.now(),
      });
    }
  });

  const SITE_ADAPTERS = {
    "chatgpt.com": {
      isConversationRequest(url, method) {
        if (method !== "POST") return false;
        return (
          /\/backend-api\/(?:f\/)?conversation\b/.test(url) ||
          /\/backend-anon\/conversation\b/.test(url)
        );
      },
      parseSSEPayload(parsed, lastText, lastThinking) {
        const msg = parsed?.message;
        if (!msg || msg.author?.role !== "assistant") return null;

        const msgType = msg.content?.content_type;
        if (
          msgType === "system_error" ||
          msgType === "title_generation" ||
          msgType === "conversation_title"
        ) {
          return null;
        }

        let text = lastText;
        let thinking = lastThinking;

        const parts = msg.content?.parts;
        if (Array.isArray(parts)) {
          const partText = parts
            .filter((part) => typeof part === "string")
            .join("");
          if (hasMeaningfulAssistantText(partText) && partText !== lastText) {
            text = partText;
          }
        }

        const thinkingText =
          msg.metadata?.thinking_text ||
          msg.metadata?.reasoning_text ||
          msg.content?.thinking ||
          null;
        if (thinkingText && thinkingText !== lastThinking) {
          thinking = thinkingText;
        }

        if (text !== lastText || thinking !== lastThinking) {
          return { text, thinking };
        }
        return null;
      },
    },

    "chat.deepseek.com": {
      isConversationRequest(url, method) {
        if (method !== "POST") return false;
        return /\/api\/v0\/chat\/completion\b/.test(url);
      },
      parseSSEPayload(parsed, lastText, lastThinking) {
        const choices = parsed?.choices;
        if (!Array.isArray(choices) || choices.length === 0) return null;

        const choice = choices[0] || {};
        const delta = choice.delta || {};

        let text = lastText;
        let thinking = lastThinking;

        const nextText =
          typeof delta.content === "string" && delta.content
            ? delta.content
            : typeof choice.text === "string" && choice.text
              ? choice.text
              : typeof choice.message?.content === "string" && choice.message.content
                ? choice.message.content
                : typeof parsed.output_text === "string" && parsed.output_text
                  ? parsed.output_text
                  : "";
        if (nextText) {
          text =
            typeof delta.content === "string" && delta.content
              ? lastText + nextText
              : nextText;
        }

        const nextThinking =
          typeof delta.reasoning_content === "string" && delta.reasoning_content
            ? delta.reasoning_content
            : typeof choice.reasoning_content === "string" && choice.reasoning_content
              ? choice.reasoning_content
              : typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content
                ? choice.message.reasoning_content
                : "";
        if (nextThinking) {
          thinking =
            typeof delta.reasoning_content === "string" && delta.reasoning_content
              ? (lastThinking || "") + nextThinking
              : nextThinking;
        }

        if (text !== lastText || thinking !== lastThinking) {
          return { text, thinking };
        }
        return null;
      },
    },
  };

  const currentHost = window.location.hostname;
  const adapter = SITE_ADAPTERS[currentHost];
  if (!adapter) return;

  postPageEvent({
    type: "SYNC_ZOTERO_INJECTED_READY",
    host: currentHost,
    patchVersion: PATCH_VERSION,
    networkHookActive: true,
    timestamp: Date.now(),
  });

  function postActiveStreamCount() {
    postPageEvent({
      type: "SYNC_ZOTERO_STREAM_STATE",
      activeCount: activeConversationStreamCount,
      timestamp: Date.now(),
    });
  }

  function inspectDeepSeekJsonPayload(parsed, responseUrl) {
    if (currentHost !== "chat.deepseek.com") return;

    const transcriptSnapshot = extractDeepSeekTranscriptSnapshot(parsed, responseUrl);
    if (transcriptSnapshot) {
      storeDeepSeekTranscriptSnapshot(transcriptSnapshot);
    }

    const historySnapshot = extractDeepSeekHistorySnapshot(parsed, responseUrl);
    if (historySnapshot) {
      storeDeepSeekHistorySnapshot(historySnapshot);
    }
  }

  function shouldInspectFetchJsonResponse(url, method, response) {
    if (currentHost !== "chat.deepseek.com") return false;
    if (!response?.ok) return false;
    if (adapter.isConversationRequest(url, method)) return false;

    let parsedUrl = null;
    try {
      parsedUrl = new URL(resolveUrl(url));
      if (parsedUrl.origin !== window.location.origin) return false;
    } catch {
      return false;
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("json")) return true;
    if (!contentType) return parsedUrl.pathname.includes("/api/");
    return false;
  }

  function shouldInspectXHRResponse(xhr, url, method) {
    if (currentHost !== "chat.deepseek.com") return false;
    if ((xhr.status || 0) < 200 || (xhr.status || 0) >= 300) return false;
    if (adapter.isConversationRequest(url, method)) return false;

    let parsedUrl = null;
    try {
      parsedUrl = new URL(resolveUrl(url));
      if (parsedUrl.origin !== window.location.origin) return false;
    } catch {
      return false;
    }

    const contentType = String(xhr.getResponseHeader?.("content-type") || "").toLowerCase();
    if (contentType.includes("json")) return true;
    if (!contentType) return parsedUrl.pathname.includes("/api/");
    return false;
  }

  async function inspectFetchJsonResponse(response, url) {
    const raw = await response.text();
    if (!looksLikeJsonText(raw)) return;
    const parsed = safeJsonParse(raw);
    if (parsed == null) return;
    inspectDeepSeekJsonPayload(parsed, url);
  }

  function inspectXHRJsonResponse(xhr, url) {
    let parsed = null;
    if (xhr.responseType === "json" && xhr.response != null) {
      parsed = xhr.response;
    } else {
      const raw =
        typeof xhr.responseText === "string"
          ? xhr.responseText
          : typeof xhr.response === "string"
            ? xhr.response
            : "";
      if (!looksLikeJsonText(raw)) return;
      parsed = safeJsonParse(raw);
    }
    if (parsed == null) return;
    inspectDeepSeekJsonPayload(parsed, url);
  }

  window.fetch = async function (...args) {
    try {
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      if (adapter.isConversationRequest(url, method)) {
        postConversationRequestEvent(
          resolveUrl(url),
          method,
          extractPromptFingerprintFromFetchArgs(args),
        );
      }
    } catch {
      /* keep page fetch intact */
    }

    const response = await originalFetch.apply(this, args);

    try {
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      if (adapter.isConversationRequest(url, method)) {
        processSSEResponse(response.clone()).catch((err) => {
          console.debug("[sync-zotero] SSE processing error:", err);
        });
      } else if (shouldInspectFetchJsonResponse(url, method, response)) {
        inspectFetchJsonResponse(response.clone(), resolveUrl(url)).catch((err) => {
          console.debug("[sync-zotero] JSON bootstrap inspection error:", err);
        });
      }
    } catch {
      /* keep page fetch intact */
    }

    return response;
  };

  if (XHRProto && originalXHROpen && originalXHRSend && !XHRProto.__syncZoteroPatched) {
    XHRProto.__syncZoteroPatched = true;

    XHRProto.open = function (method, url, ...rest) {
      try {
        this.__syncZoteroUrl = resolveUrl(url);
        this.__syncZoteroMethod = String(method || "GET").toUpperCase();
      } catch {
        this.__syncZoteroUrl = String(url || "");
        this.__syncZoteroMethod = String(method || "GET").toUpperCase();
      }
      return originalXHROpen.call(this, method, url, ...rest);
    };

    XHRProto.send = function (...args) {
      try {
        const url = this.__syncZoteroUrl || "";
        const method = this.__syncZoteroMethod || "GET";
        if (adapter.isConversationRequest(url, method)) {
          const body = args[0];
          postConversationRequestEvent(
            url,
            method,
            typeof body === "string" ? extractPromptFingerprintFromBody(body) : null,
          );
        }
      } catch {
        /* keep XHR intact */
      }
      if (!this.__syncZoteroListenerAttached) {
        this.__syncZoteroListenerAttached = true;
        this.addEventListener("readystatechange", () => {
          if (this.readyState !== 4) return;
          try {
            const url = this.__syncZoteroUrl || "";
            const method = this.__syncZoteroMethod || "GET";
            if (shouldInspectXHRResponse(this, url, method)) {
              inspectXHRJsonResponse(this, url);
            }
          } catch (err) {
            console.debug("[sync-zotero] XHR bootstrap inspection error:", err);
          }
        });
      }
      return originalXHRSend.apply(this, args);
    };
  }

  async function processSSEResponse(response) {
    const body = response.body;
    if (!body) return;

    activeConversationStreamCount += 1;
    postActiveStreamCount();
    postPageEvent({ type: "SYNC_ZOTERO_STREAM_START" });

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastText = "";
    let lastThinking = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();

          if (data === "[DONE]") {
            postPageEvent({
              type: "SYNC_ZOTERO_SSE",
              text: lastText,
              thinking: lastThinking || null,
              done: true,
              activeStreamCount: activeConversationStreamCount,
            });
            return;
          }

          const parsed = safeJsonParse(data);
          if (parsed == null) continue;

          const result = adapter.parseSSEPayload(parsed, lastText, lastThinking);
          if (!result) continue;

          lastText = result.text;
          lastThinking = result.thinking;
          postPageEvent({
            type: "SYNC_ZOTERO_SSE",
            text: lastText,
            thinking: lastThinking || null,
            done: false,
          });
        }
      }

      if (hasMeaningfulAssistantText(lastText)) {
        postPageEvent({
          type: "SYNC_ZOTERO_SSE",
          text: lastText,
          thinking: lastThinking || null,
          done: true,
          activeStreamCount: activeConversationStreamCount,
        });
      }
    } finally {
      activeConversationStreamCount = Math.max(0, activeConversationStreamCount - 1);
      postActiveStreamCount();
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
})();
