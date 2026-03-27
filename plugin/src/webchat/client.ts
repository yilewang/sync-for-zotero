/**
 * [webchat] Client for the embedded relay server.
 *
 * Uses direct in-memory state access (not HTTP) to avoid deadlock — Zotero's
 * single-threaded server cannot serve requests from its own fetch().
 *
 * The Chrome extension communicates via HTTP; the plugin communicates directly.
 */

import type { ReasoningEvent } from "../utils/llmClient";
import {
  relaySubmitQuery,
  relayPollResponse,
  relayNewChat,
  relayLoadChat,
  relayGetChatHistory,
  relayGetScrapedMessages,
  relayGetReportedMode,
  getRelayBaseUrl,
} from "./relayServer";

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Submit query (direct state access)
// ---------------------------------------------------------------------------

export type SubmitQueryResult = { seq: number; sessionId?: string };

export async function submitQuery(
  _host: string,
  prompt: string,
  pdfBase64: string | null,
  pdfFilename: string | null,
  signal?: AbortSignal,
  images?: string[],
  chatgptMode?: string,
): Promise<SubmitQueryResult> {
  if (signal?.aborted) throw createAbortError();

  const result = relaySubmitQuery({
    prompt,
    pdf_base64: pdfBase64,
    pdf_filename: pdfFilename,
    images: images || null,
    chatgpt_mode: chatgptMode || null,
  });

  if (!result.ok) {
    if (result.error === "pipeline_busy") {
      throw new Error(
        "ChatGPT pipeline is busy. Please wait for the current query to finish.",
      );
    }
    throw new Error(result.error || "submit_query failed");
  }

  return { seq: result.seq };
}

// ---------------------------------------------------------------------------
// Poll for response (direct state access)
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
  _host: string,
  seq: number,
  onDelta: (delta: string) => void,
  onReasoning: ((event: ReasoningEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  let lastPartialText = "";
  let lastPartialThinking = "";
  let staleSince = 0;
  const STALE_THRESHOLD_MS = 3_000;
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {
    if (signal?.aborted) throw createAbortError();

    const data: PollResponseData = relayPollResponse();

    // Skip partials from a different query
    if (data.current_seq !== seq) {
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

    // Track staleness
    if (textChanged) {
      staleSince = 0;
    } else if (lastPartialText.length > 0 && staleSince === 0) {
      staleSince = Date.now();
    }

    // Check for final response
    const match = (data.responses || []).find((r) => r.seq === seq);
    if (match) {
      if (match.error) throw new Error(match.error);
      const finalText = match.text || "";
      if (finalText.length > lastPartialText.length) {
        onDelta(finalText.slice(lastPartialText.length));
      }
      if (onReasoning && match.thinking) {
        const rem = match.thinking.slice(lastPartialThinking.length);
        if (rem) onReasoning({ details: rem });
      }
      return finalText;
    }

    // Status done/idle fallback
    if (data.status === "done" || data.status === "idle") {
      if (lastPartialText.length > 0) return lastPartialText;
      if (data.status === "done") return "";
    }

    // Stale detection
    if (
      staleSince > 0 &&
      lastPartialText.length > 0 &&
      Date.now() - staleSince >= STALE_THRESHOLD_MS
    ) {
      return lastPartialText;
    }

    // Error
    if (data.status === "error") {
      if (lastPartialText.length > 0) return lastPartialText;
      throw new Error("ChatGPT pipeline encountered an error.");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (lastPartialText.length > 0) return lastPartialText;
  throw new Error("Timed out waiting for ChatGPT response (5 min).");
}

// ---------------------------------------------------------------------------
// New chat command (direct state access)
// ---------------------------------------------------------------------------

export async function sendNewChat(_host: string): Promise<void> {
  relayNewChat();
}

// ---------------------------------------------------------------------------
// Chat history (direct state access)
// ---------------------------------------------------------------------------

export type WebChatHistorySession = {
  id: string;
  title: string;
  chatUrl: string | null;
};

export async function fetchChatHistory(
  _host: string,
): Promise<WebChatHistorySession[]> {
  return relayGetChatHistory();
}

export async function loadChatSession(
  _host: string,
  sessionId: string,
): Promise<{
  messages: Array<{
    speaker: string;
    text: string;
    kind: string;
    thinking?: string;
    timestamp?: string;
  }>;
} | null> {
  const result = relayLoadChat(sessionId);
  return result.ok ? { messages: result.session.messages as any } : null;
}

// ---------------------------------------------------------------------------
// Scraped messages (direct state access)
// ---------------------------------------------------------------------------

export async function fetchScrapedMessages(
  _host: string,
  timeoutMs = 10_000,
): Promise<Array<{ role: string; text: string }>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = relayGetScrapedMessages();
    if (messages && messages.length > 0) {
      return messages;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Reported mode (direct state access)
// ---------------------------------------------------------------------------

/** Get the ChatGPT mode reported back by the extension. */
export function getReportedMode(): string | null {
  return relayGetReportedMode();
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/** Returns true if the relay is registered (always true when plugin is loaded). */
export async function testConnection(_host: string): Promise<boolean> {
  // The relay is embedded — if this code is running, the relay is registered.
  // But check if the extension can reach us by verifying Zotero.Server exists.
  try {
    return !!Zotero.Server?.Endpoints;
  } catch {
    return false;
  }
}
