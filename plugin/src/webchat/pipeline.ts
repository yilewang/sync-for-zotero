/**
 * [webchat] Dedicated send pipeline for WebChat providers.
 *
 * Unlike the normal LLM pipeline, this:
 *   - Attaches the current paper's PDF when `sendPdf` is true (controlled by chip state)
 *   - Sends only the raw question text (no system messages, no history)
 *   - Submits via the web host relay → Chrome extension → ChatGPT.com
 */

import type { ReasoningEvent } from "../utils/llmClient";
import { readLocalFileBytes } from "../utils/llmClient";
import { submitQuery, pollForResponse, bytesToBase64 } from "./client";

// ---------------------------------------------------------------------------
// PDF resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the file path of the PDF attachment for the given Zotero item.
 * Handles both the item-is-attachment case and the item-has-child-attachment case.
 */
async function resolveItemPdfPath(
  item: Zotero.Item,
): Promise<{ path: string; filename: string } | null> {
  // If the item itself is a PDF attachment
  if (item.isAttachment?.() && item.attachmentContentType === "application/pdf") {
    const path = await getFilePath(item);
    if (path) return { path, filename: extractFilename(path) };
  }

  // Otherwise look through child attachments
  const attachmentIds = item.getAttachments?.() || [];
  for (const attId of attachmentIds) {
    const att = Zotero.Items.get(attId);
    if (!att?.isAttachment?.() || att.attachmentContentType !== "application/pdf") continue;
    const path = await getFilePath(att);
    if (path) return { path, filename: extractFilename(path) };
  }

  // Check parentItem if item is something like a note
  if (item.parentID) {
    const parent = Zotero.Items.get(item.parentID);
    if (parent) return resolveItemPdfPath(parent);
  }

  return null;
}

async function getFilePath(att: Zotero.Item): Promise<string | null> {
  // Zotero 7+: getFilePathAsync
  const asyncPath = await (
    att as unknown as { getFilePathAsync?: () => Promise<string | false> }
  ).getFilePathAsync?.();
  if (asyncPath) return asyncPath as string;

  // Fallback: getFilePath (sync)
  if (typeof (att as unknown as { getFilePath?: () => string | undefined }).getFilePath === "function") {
    const syncPath = (att as unknown as { getFilePath: () => string | undefined }).getFilePath();
    if (syncPath) return syncPath;
  }

  // Fallback: attachmentPath property
  const rawPath = (att as unknown as { attachmentPath?: string }).attachmentPath;
  return rawPath || null;
}

function extractFilename(path: string): string {
  return path.split(/[\\/]/).pop() || "document.pdf";
}

// ---------------------------------------------------------------------------
// Main send function
// ---------------------------------------------------------------------------

export type WebChatSendOptions = {
  item: Zotero.Item;
  question: string;
  host: string;
  /** When true, attach the paper PDF to the ChatGPT query. */
  sendPdf?: boolean;
  /** Screenshot images as base64 data URLs to attach to ChatGPT. */
  images?: string[];
  /** ChatGPT mode: "instant", "thinking_standard", or "thinking_extended". */
  chatgptMode?: string;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
};

/**
 * Send a question to ChatGPT via the web host relay.
 * Attaches the current paper's PDF only when `sendPdf` is true.
 * The caller determines whether to send PDF based on the paper chip state.
 *
 * Returns the final response text.
 */
export async function sendWebChatQuestion(
  opts: WebChatSendOptions,
): Promise<string> {
  const { item, question, host, sendPdf, images, chatgptMode, signal, onDelta, onReasoning } = opts;

  ztoolkit.log(`[webchat] sendWebChatQuestion: sendPdf=${sendPdf}`);

  // --- Resolve and read the current paper's PDF (only when explicitly requested) ---
  let pdfBase64: string | null = null;
  let pdfFilename: string | null = null;

  if (sendPdf) {
    const pdf = await resolveItemPdfPath(item);
    if (pdf) {
      try {
        const bytes = await readLocalFileBytes(pdf.path);
        pdfBase64 = bytesToBase64(bytes);
        pdfFilename = pdf.filename;
      } catch (err) {
        ztoolkit.log("[webchat] Failed to read PDF:", err);
        // Continue without PDF — send text-only query
      }
    }
  }

  // --- Submit to web host ---
  const { seq } = await submitQuery(host, question, pdfBase64, pdfFilename, signal, images, chatgptMode);

  // --- Poll for streaming response ---
  return pollForResponse(host, seq, onDelta, onReasoning, signal);
}
