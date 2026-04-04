/**
 * injected.js — Runs in MAIN world (same JS context as the page).
 *
 * Patches window.fetch to intercept streaming responses from the site's
 * conversation API. Extracts assistant message text from the SSE stream
 * and relays it to the content script via window.postMessage.
 *
 * Supports multiple sites via hostname-based adapter selection:
 *   - chatgpt.com  — ChatGPT's /backend-api/conversation SSE format
 *   - chat.deepseek.com — DeepSeek's /api/v0/chat/completion SSE format
 *
 * This approach is immune to DOM changes — it reads the raw
 * API response data at the network level.
 */

(function () {
  "use strict";

  // Version guard: re-patch when the extension updates (new version).
  const PATCH_VERSION = 3;
  if (window.__syncZoteroFetchPatched >= PATCH_VERSION) return;
  window.__syncZoteroFetchPatched = PATCH_VERSION;

  // Use the ORIGINAL fetch (before any prior patch), or current if first time
  const originalFetch = window.__syncZoteroOriginalFetch || window.fetch;
  window.__syncZoteroOriginalFetch = originalFetch;
  let activeConversationStreamCount = 0;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function postActiveStreamCount() {
    window.postMessage(
      {
        type: "SYNC_ZOTERO_STREAM_STATE",
        activeCount: activeConversationStreamCount,
        timestamp: Date.now(),
      },
      "*"
    );
  }

  function normalizeAssistantText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
    if (/^thought for .+$/.test(normalized)) {
      return false;
    }
    // Tool-use status messages (not actual responses)
    if (/^reading\s+documents?\.?$/i.test(normalized)) return false;
    if (/^searching(\s+the\s+web)?\.?$/i.test(normalized)) return false;
    if (/^analyzing\.?$/i.test(normalized)) return false;
    if (/^browsing\.?$/i.test(normalized)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Site adapters — each defines how to detect and parse SSE for that site
  // ---------------------------------------------------------------------------

  const SITE_ADAPTERS = {
    "chatgpt.com": {
      /** Detect ChatGPT's streaming conversation API requests. */
      isConversationRequest(url, method) {
        if (method !== "POST") return false;
        return (
          /\/backend-api\/(?:f\/)?conversation\b/.test(url) ||
          /\/backend-anon\/conversation\b/.test(url)
        );
      },

      /**
       * Parse a single SSE JSON payload from ChatGPT's format.
       * ChatGPT wraps content in message.content.parts[] and thinking in message.metadata.
       * Returns { text, thinking } or null if this event should be skipped.
       */
      parseSSEPayload(parsed, lastText, lastThinking) {
        const msg = parsed?.message;
        if (!msg) return null;
        if (msg.author?.role !== "assistant") return null;

        // Skip known non-content message types
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

        // Extract main text content
        const parts = msg.content?.parts;
        if (Array.isArray(parts)) {
          const partText = parts
            .filter((p) => typeof p === "string")
            .join("");
          if (hasMeaningfulAssistantText(partText) && partText !== lastText) {
            text = partText;
          }
        }

        // Extract thinking/reasoning text (o1, o3, o4-mini models)
        const thinkingText =
          msg.metadata?.thinking_text ||
          msg.metadata?.reasoning_text ||
          msg.content?.thinking ||
          null;
        if (thinkingText && thinkingText !== lastThinking) {
          thinking = thinkingText;
        }

        // Only return if something changed
        if (text !== lastText || thinking !== lastThinking) {
          return { text, thinking };
        }
        return null;
      },
    },

    "chat.deepseek.com": {
      /** Detect DeepSeek's streaming chat completion API requests. */
      isConversationRequest(url, method) {
        if (method !== "POST") return false;
        return /\/api\/v0\/chat\/completion\b/.test(url);
      },

      /**
       * Parse a single SSE JSON payload from DeepSeek's format.
       * DeepSeek uses OpenAI-compatible format: choices[0].delta.content
       * and choices[0].delta.reasoning_content for thinking.
       * Returns { text, thinking } or null if this event should be skipped.
       */
      parseSSEPayload(parsed, lastText, lastThinking) {
        const choices = parsed?.choices;
        if (!Array.isArray(choices) || choices.length === 0) return null;

        const delta = choices[0]?.delta;
        if (!delta) return null;

        let text = lastText;
        let thinking = lastThinking;

        // Extract main content (accumulate deltas)
        if (typeof delta.content === "string" && delta.content) {
          text = lastText + delta.content;
        }

        // Extract reasoning/thinking content (DeepThink mode)
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          thinking = (lastThinking || "") + delta.reasoning_content;
        }

        // Only return if something changed
        if (text !== lastText || thinking !== lastThinking) {
          return { text, thinking };
        }
        return null;
      },
    },

  };

  // Select adapter based on current hostname
  const currentHost = window.location.hostname;
  const adapter = SITE_ADAPTERS[currentHost];
  if (!adapter) {
    // Unknown site — don't patch fetch
    return;
  }

  // ---------------------------------------------------------------------------
  // Fetch patching
  // ---------------------------------------------------------------------------

  window.fetch = async function (...args) {
    try {
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      if (adapter.isConversationRequest(url, method)) {
        window.postMessage(
          {
            type: "SYNC_ZOTERO_REQUEST",
            url,
            method,
            timestamp: Date.now(),
          },
          "*"
        );
      }
    } catch {
      // Never break the page's fetch
    }

    const response = await originalFetch.apply(this, args);

    try {
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      if (adapter.isConversationRequest(url, method)) {
        const clone = response.clone();
        processSSEResponse(clone).catch((err) => {
          console.debug("[sync-zotero] SSE processing error:", err);
        });
      }
    } catch {
      // Never break the page's fetch
    }

    return response;
  };

  // ---------------------------------------------------------------------------
  // SSE stream processing (shared across all sites)
  // ---------------------------------------------------------------------------

  async function processSSEResponse(response) {
    const body = response.body;
    if (!body) return;

    activeConversationStreamCount += 1;
    postActiveStreamCount();

    window.postMessage({ type: "SYNC_ZOTERO_STREAM_START" }, "*");

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

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6).trim();

          // SSE termination
          if (data === "[DONE]") {
            window.postMessage(
              {
                type: "SYNC_ZOTERO_SSE",
                text: lastText,
                thinking: lastThinking || null,
                done: true,
                activeStreamCount: activeConversationStreamCount,
              },
              "*"
            );
            return;
          }

          // Parse JSON payload
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          // Delegate to site adapter for extraction
          const result = adapter.parseSSEPayload(parsed, lastText, lastThinking);
          if (result) {
            lastText = result.text;
            lastThinking = result.thinking;
            window.postMessage(
              {
                type: "SYNC_ZOTERO_SSE",
                text: lastText,
                thinking: lastThinking || null,
                done: false,
              },
              "*"
            );
          }
        }
      }

      // Stream ended without [DONE] — still emit final state
      if (hasMeaningfulAssistantText(lastText)) {
        window.postMessage(
          {
            type: "SYNC_ZOTERO_SSE",
            text: lastText,
            thinking: lastThinking || null,
            done: true,
            activeStreamCount: activeConversationStreamCount,
          },
          "*"
        );
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
