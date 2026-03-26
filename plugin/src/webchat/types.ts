/**
 * [webchat] Type definitions for the WebChat integration.
 *
 * Each WebChatTarget represents a web-based LLM chat service that can be
 * automated via a browser extension (e.g., ChatGPT via the sync-for-zotero
 * Chrome extension).
 */

export type WebChatTarget = "chatgpt"; // future: "gemini" | "qwen" | ...

export type WebChatTargetEntry = {
  id: WebChatTarget;
  label: string;
  defaultHost: string;
};

export const WEBCHAT_TARGETS: WebChatTargetEntry[] = [
  { id: "chatgpt", label: "ChatGPT", defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat" }, // port is dynamic — use getRelayBaseUrl() at runtime
];

export function getWebChatTarget(id: string): WebChatTargetEntry | undefined {
  return WEBCHAT_TARGETS.find((t) => t.id === id);
}

export function getDefaultWebChatTarget(): WebChatTargetEntry {
  return WEBCHAT_TARGETS[0];
}
