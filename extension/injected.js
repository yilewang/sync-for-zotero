/**
 * injected.js — Runs in ChatGPT's MAIN world (same JS context as the page).
 *
 * Patches window.fetch to intercept streaming responses from ChatGPT's
 * conversation API. Extracts assistant message text from the SSE stream
 * and relays it to the content script via window.postMessage.
 *
 * This approach is immune to ChatGPT DOM changes — it reads the raw
 * API response data at the network level.
 */

(function () {
  "use strict";

  // Guard: only patch once per page load
  if (window.__syncZoteroFetchPatched) return;
  window.__syncZoteroFetchPatched = true;

  const originalFetch = window.fetch;
  let activeConversationStreamCount = 0;

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

  function isConversationRequest(url, method) {
    if (method !== "POST") return false;
    return (
      /\/backend-api\/(?:f\/)?conversation\b/.test(url) ||
      /\/backend-anon\/conversation\b/.test(url)
    );
  }

  window.fetch = async function (...args) {
    try {
      // Determine the request URL
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      // Intercept POST to the conversation endpoint (ChatGPT's streaming API)
      if (isConversationRequest(url, method)) {
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
      // Determine the request URL
      const url =
        args[0] instanceof Request ? args[0].url : String(args[0] || "");
      const method = (
        (args[0] instanceof Request ? args[0].method : args[1]?.method) || "GET"
      ).toUpperCase();

      if (isConversationRequest(url, method)) {
        // Clone so we can read without consuming the original
        const clone = response.clone();
        processSSEResponse(clone).catch((err) => {
          // Silent failure — don't break ChatGPT
          console.debug("[sync-zotero] SSE processing error:", err);
        });
      }
    } catch {
      // Never break the page's fetch
    }

    return response;
  };

  /**
   * Read the SSE stream from a cloned Response, extract assistant text,
   * and post updates to the content script.
   */
  async function processSSEResponse(response) {
    const body = response.body;
    if (!body) return;

    activeConversationStreamCount += 1;
    postActiveStreamCount();

    // Notify content script that a new SSE stream is starting.
    // This resets sseDone so the previous stream's [DONE] doesn't
    // prematurely end the pipeline (e.g., tool-use multi-stream flows
    // where "Reading documents" completes before the actual response).
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
        buffer = lines.pop() || ""; // keep the last (possibly incomplete) line

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
            continue; // malformed JSON — skip
          }

          // Filter: only process assistant messages
          const msg = parsed?.message;
          if (!msg) continue;
          if (msg.author?.role !== "assistant") continue;

          // Skip non-content message types (e.g., title generation, status)
          const msgType = msg.content?.content_type;
          if (msgType && msgType !== "text" && msgType !== "code") continue;

          // Extract main text content
          const parts = msg.content?.parts;
          if (Array.isArray(parts)) {
            const text = parts
              .filter((p) => typeof p === "string")
              .join("");
            if (hasMeaningfulAssistantText(text) && text !== lastText) {
              lastText = text;
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

          // Extract thinking/reasoning text (o1, o3, o4-mini models)
          const thinking =
            msg.metadata?.thinking_text ||
            msg.metadata?.reasoning_text ||
            msg.content?.thinking ||
            null;
          if (thinking && thinking !== lastThinking) {
            lastThinking = thinking;
            window.postMessage(
              {
                type: "SYNC_ZOTERO_SSE",
                text: lastText,
                thinking: lastThinking,
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
