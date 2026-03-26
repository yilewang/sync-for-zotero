/**
 * [webchat] HTTP client for the sync-for-zotero web host.
 *
 * Handles all communication with the Next.js relay server:
 *   - submitQuery: POST /submit_query  (prompt + optional PDF base64)
 *   - pollForResponse: GET /poll_response  (streaming partial + final)
 *   - sendNewChat: POST /new_chat  (navigate ChatGPT to fresh conversation)
 *   - testConnection: GET /poll_response  (health check)
 */

import type { ReasoningEvent } from "../utils/llmClient";

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Convert a Uint8Array to base64, safe for large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binaryStr = "";
  const chunkSize = 0x8000; // 32 KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binaryStr += String.fromCharCode(
      ...bytes.subarray(i, Math.min(bytes.length, i + chunkSize)),
    );
  }
  return btoa(binaryStr);
}

// ---------------------------------------------------------------------------
// Submit query
// ---------------------------------------------------------------------------

export type SubmitQueryResult = { seq: number; sessionId?: string };

export async function submitQuery(
  host: string,
  prompt: string,
  pdfBase64: string | null,
  pdfFilename: string | null,
  signal?: AbortSignal,
  images?: string[],
  chatgptMode?: string,
): Promise<SubmitQueryResult> {
  const fetchFn = getFetch();
  const url = `${trimSlash(host)}/submit_query`;

  const body: Record<string, unknown> = { prompt };
  if (pdfBase64) {
    body.pdf_base64 = pdfBase64;
    body.pdf_filename = pdfFilename || "document.pdf";
  }
  if (images && images.length > 0) {
    body.images = images;
  }
  if (chatgptMode) {
    body.chatgpt_mode = chatgptMode;
  }

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`submit_query failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as unknown as Record<string, unknown>;
  if (data.error === "pipeline_busy") {
    throw new Error(
      "ChatGPT pipeline is busy. Please wait for the current query to finish.",
    );
  }
  if (data.error) {
    throw new Error(String(data.error));
  }
  return { seq: data.seq as number, sessionId: data.sessionId as string };
}

// ---------------------------------------------------------------------------
// Poll for response
// ---------------------------------------------------------------------------

type PollResponseData = {
  status: string;
  responses: Array<{
    seq: number;
    text?: string;
    error?: string;
    thinking?: string;
  }>;
  partial_text: string | null;
  partial_thinking: string | null;
  current_seq: number;
};

export async function pollForResponse(
  host: string,
  seq: number,
  onDelta: (delta: string) => void,
  onReasoning: ((event: ReasoningEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const fetchFn = getFetch();
  const base = trimSlash(host);
  let lastPartialText = "";
  let lastPartialThinking = "";
  let staleSince = 0; // timestamp when partial_text last stopped changing
  const STALE_THRESHOLD_MS = 3_000; // 3 seconds of no change → consider done
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {
    if (signal?.aborted) throw createAbortError();

    const res = await fetchFn(`${base}/poll_response?since=0`, { signal });
    const data = (await res.json()) as unknown as PollResponseData;

    // Skip partials from a different query (prevents cross-query contamination)
    if (data.current_seq !== seq) {
      // Check for final response matching our seq even if current_seq moved on
      const match = (data.responses || []).find((r) => r.seq === seq);
      if (match) {
        if (match.error) throw new Error(match.error);
        const finalText = match.text || "";
        if (finalText.length > lastPartialText.length) {
          onDelta(finalText.slice(lastPartialText.length));
        }
        return finalText;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Stream partial text deltas
    let textChanged = false;
    if (data.partial_text && data.partial_text !== lastPartialText) {
      const newText = data.partial_text.slice(lastPartialText.length);
      if (newText) onDelta(newText);
      lastPartialText = data.partial_text;
      textChanged = true;
    }

    // Stream partial thinking deltas
    if (
      onReasoning &&
      data.partial_thinking &&
      data.partial_thinking !== lastPartialThinking
    ) {
      const newThinking = data.partial_thinking.slice(
        lastPartialThinking.length,
      );
      if (newThinking) onReasoning({ details: newThinking });
      lastPartialThinking = data.partial_thinking;
      textChanged = true;
    }

    // Track how long partial_text has been unchanged
    if (textChanged) {
      staleSince = 0;
    } else if (lastPartialText.length > 0 && staleSince === 0) {
      staleSince = Date.now();
    }

    // Check for final response matching our sequence number
    const match = (data.responses || []).find((r) => r.seq === seq);
    if (match) {
      if (match.error) throw new Error(match.error);

      const finalText = match.text || "";
      // Fire remaining delta
      if (finalText.length > lastPartialText.length) {
        onDelta(finalText.slice(lastPartialText.length));
      }
      // Fire remaining thinking
      if (onReasoning && match.thinking) {
        const rem = match.thinking.slice(lastPartialThinking.length);
        if (rem) onReasoning({ details: rem });
      }
      return finalText;
    }

    // Fallback: status is "done" or "idle" (pipeline finished) but no matching
    // response entry — use whatever partial_text we've accumulated, or return
    // empty string rather than polling forever.
    if (data.status === "done" || data.status === "idle") {
      if (lastPartialText.length > 0) return lastPartialText;
      // Pipeline finished but no partial text — still resolve to avoid hanging
      if (data.status === "done") return "";
    }

    // Stale detection: if we have text and it hasn't changed for STALE_THRESHOLD_MS,
    // the extension likely finished but never called submit_response.
    // Treat the accumulated partial_text as the final answer.
    if (
      staleSince > 0 &&
      lastPartialText.length > 0 &&
      Date.now() - staleSince >= STALE_THRESHOLD_MS
    ) {
      return lastPartialText;
    }

    // Error without matching response
    if (data.status === "error") {
      if (lastPartialText.length > 0) return lastPartialText;
      throw new Error("ChatGPT pipeline encountered an error.");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout — return whatever we have if any
  if (lastPartialText.length > 0) return lastPartialText;
  throw new Error("Timed out waiting for ChatGPT response (5 min).");
}

// ---------------------------------------------------------------------------
// New chat command
// ---------------------------------------------------------------------------

/** Tell the web host to navigate ChatGPT to a fresh conversation. */
export async function sendNewChat(host: string): Promise<void> {
  const fetchFn = getFetch();
  const url = `${trimSlash(host)}/new_chat`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text();
    ztoolkit.log("[webchat] sendNewChat failed:", res.status, text);
  }
}

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------

export type WebChatHistorySession = {
  id: string;
  title: string;
  chatUrl: string | null;
};

/** Fetch all ChatGPT conversations (scraped from sidebar by the extension). */
export async function fetchChatHistory(
  host: string,
): Promise<WebChatHistorySession[]> {
  try {
    const fetchFn = getFetch();
    const res = await fetchFn(`${trimSlash(host)}/chat_history`);
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: WebChatHistorySession[] };
    return data.sessions || [];
  } catch {
    return [];
  }
}

/** Load a specific chat session and tell extension to navigate to it. */
export async function loadChatSession(
  host: string,
  sessionId: string,
): Promise<{ messages: Array<{ speaker: string; text: string; kind: string; thinking?: string; timestamp?: string }> } | null> {
  try {
    const fetchFn = getFetch();
    const res = await fetchFn(`${trimSlash(host)}/load_chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.session || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scraped messages (from DOM scraping of past ChatGPT conversations)
// ---------------------------------------------------------------------------

/**
 * Poll for scraped messages after a LOAD_CHAT command.
 * The extension scrapes the ChatGPT page and posts messages to the web host.
 * This function polls until messages arrive or timeout.
 */
export async function fetchScrapedMessages(
  host: string,
  timeoutMs = 10_000,
): Promise<Array<{ role: string; text: string }>> {
  const fetchFn = getFetch();
  const base = trimSlash(host);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${base}/get_scraped_messages`);
      if (res.ok) {
        const data = (await res.json()) as unknown as { messages: Array<{ role: string; text: string }> | null };
        if (data.messages && data.messages.length > 0) {
          return data.messages;
        }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Connection test (for preferences UI)
// ---------------------------------------------------------------------------

/** Returns true if the web host is reachable. */
export async function testConnection(host: string): Promise<boolean> {
  try {
    const fetchFn = getFetch();
    const res = await fetchFn(`${trimSlash(host)}/poll_response?since=0`);
    return res.ok;
  } catch {
    return false;
  }
}
