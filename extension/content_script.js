/**
 * content_script.js — Runs on https://chatgpt.com/*
 *
 * Handles the RUN_PIPELINE message:
 *   1. Attach the PDF to ChatGPT's file input
 *   2. Type the prompt into the composer
 *   3. Submit the message
 *   4. Wait for the response to finish streaming
 *   5. Extract the response as markdown text
 *   6. Return it to the background script
 *
 * Also continuously scrapes the sidebar history and handles DELETE_CHAT commands.
 */

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const shared = globalThis.SyncZoteroShared || {
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  composerTextMatchesPrompt: (promptText, composerText) => String(promptText || "").trim() === String(composerText || "").trim(),
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
  hasDeliverySignal: (snapshot) => {
    if ((snapshot.outboundRequestSerial || 0) > (snapshot.baselineOutboundRequestSerial || 0)) return true;
    if (snapshot.stopButtonVisible) return true;
    if ((snapshot.userMessageCount || 0) > (snapshot.baselineUserMessageCount || 0)) return true;
    return false;
  },
  isPlaceholderAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase();
    return !normalized || normalized === "thinking" || normalized === "quick answer";
  },
  normalizeComposerText: (text) => String(text || "").trim(),
};

/** Wait until a selector matches, polling every 200 ms up to `timeout` ms. */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const interval = setInterval(() => {
      const found = document.querySelector(selector);
      if (found) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(found);
      }
    }, 200);

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for selector: ${selector}`));
    }, timeout);
  });
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dispatch synthetic React-compatible input events on an element. */
function setNativeValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  try {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: value ?? "",
      inputType: value ? "insertText" : "deleteContentBackward",
    }));
  } catch (_) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (typeof el.setSelectionRange === "function") {
    const caret = String(value || "").length;
    el.setSelectionRange(caret, caret);
  }
}

function isVisibleElement(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isUsableComposer(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (!isVisibleElement(el)) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  const contentEditable = el.getAttribute("contenteditable");
  if (contentEditable && contentEditable !== "true" && contentEditable !== "plaintext-only") {
    return false;
  }
  return true;
}

function getComposerCandidates() {
  const selectors = [
    "#prompt-textarea",
    "[data-testid='text-input']",
    "[role='textbox'][contenteditable='true']",
    "div[contenteditable='true']",
    "textarea",
  ];
  const candidates = [];
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (isUsableComposer(node)) {
        candidates.push(node);
      }
    }
  }
  return candidates;
}

async function getComposerElement(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = findComposerNow();
    if (composer) return composer;
    await sleep(100);
  }
  throw new Error("ChatGPT composer was not ready in time.");
}

function findComposerNow() {
  return getComposerCandidates()[0] || null;
}

function readComposerText(composer) {
  if (!composer) return "";
  if (composer.tagName === "TEXTAREA") {
    return composer.value || "";
  }
  return composer.innerText || composer.textContent || "";
}

function dispatchComposerInput(composer, inputType, data) {
  try {
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: data ?? null,
      inputType,
    }));
  } catch (_) {
    composer.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  }
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

function setContentEditableText(composer, promptText) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.deleteContents();
  range.collapse(true);

  if (!promptText) {
    composer.textContent = "";
    selection?.removeAllRanges();
    selection?.addRange(range);
    dispatchComposerInput(composer, "deleteContentBackward", "");
    return;
  }

  const textNode = document.createTextNode(promptText);
  range.insertNode(textNode);

  range.setStartAfter(textNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);

  dispatchComposerInput(composer, "insertText", promptText);
}

// ---------------------------------------------------------------------------
// Step 1a: Attach images (screenshots) to ChatGPT
// ---------------------------------------------------------------------------

async function attachImages(imageDataUrls) {
  if (!imageDataUrls || !imageDataUrls.length) return;

  for (const dataUrl of imageDataUrls) {
    // Convert data URL to File
    const [header, base64] = dataUrl.split(",");
    const mimeMatch = header.match(/data:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "image/png";
    const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], `screenshot.${ext}`, { type: mime });

    const dt = new DataTransfer();
    dt.items.add(file);

    const dropTarget =
      document.querySelector("#prompt-textarea") ||
      document.querySelector("[data-testid='text-input']") ||
      document.querySelector("form") ||
      document.body;

    dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(100);
    dropTarget.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(100);
    dropTarget.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));

    // Wait briefly for the upload to be accepted
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Step 1b: Attach PDF
// ---------------------------------------------------------------------------

async function attachPDF(pdfBase64, pdfFilename) {
  // Decode base64 → Uint8Array → File
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], pdfFilename, { type: "application/pdf" });

  const dt = new DataTransfer();
  dt.items.add(file);

  // Find the composer / drop target
  const dropTarget =
    document.querySelector("#prompt-textarea") ||
    document.querySelector("[data-testid='text-input']") ||
    document.querySelector("form") ||
    document.body;

  // Simulate drag-and-drop (same as manually dragging a file into the window)
  dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(100);
  dropTarget.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(100);
  dropTarget.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));

  // Wait for the attachment pill to appear (confirms upload was accepted)
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const pill = document.querySelector(
      '[data-testid*="file"], [class*="attachment"], [class*="file-pill"], ' +
      '[aria-label*="pdf"], [aria-label*="PDF"], [class*="FileIcon"]'
    );
    if (pill) return; // success
  }

  // Fallback: try the file input directly if drag-and-drop wasn't picked up
  const fileInput = document.querySelector("input[type='file']");
  if (fileInput) {
    Object.defineProperty(fileInput, "files", { value: dt.files, configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(1500);
  }
}

// ---------------------------------------------------------------------------
// Step 1c: Detect and select ChatGPT model / thinking mode
// ---------------------------------------------------------------------------

// Track the last mode we successfully set, so we can skip the dropdown
// when the mode hasn't changed (avoids disrupting the composer on follow-ups).
let _lastSetChatGPTMode = null;

/**
 * Switch ChatGPT's model and thinking effort before sending a message.
 *
 * Supported modes:
 *   "instant"           → Select "Instant" (fast, no thinking)
 *   "thinking_standard"  → Select "Thinking" + "Standard" effort
 *   "thinking_extended"  → Select "Thinking" + "Extended" effort
 *
 * Skips if mode matches the last successfully set mode.
 * Skips if mode is null/undefined (leave whatever the user already has).
 */
async function selectChatGPTMode(mode) {
  if (!mode) return;
  if (mode === _lastSetChatGPTMode) {
    console.log(`[sync-zotero] Mode already ${mode} — skipping switch`);
    return;
  }

  try {
    // --- Step 1: Open the model selector dropdown ---
    const modelBtnSelectors = [
      'button[data-testid="model-selector"]',
      'button[aria-haspopup="menu"][class*="model"]',
    ];

    let modelBtn = null;
    for (const sel of modelBtnSelectors) {
      modelBtn = document.querySelector(sel);
      if (modelBtn) break;
    }

    // Broader fallback: find button with "ChatGPT" text
    if (!modelBtn) {
      const buttons = document.querySelectorAll('button[aria-haspopup]');
      for (const btn of buttons) {
        if (/chatgpt/i.test(btn.textContent)) {
          modelBtn = btn;
          break;
        }
      }
    }

    if (!modelBtn) {
      console.warn("[sync-zotero] Could not find ChatGPT model selector button — skipping mode switch");
      return;
    }

    modelBtn.click();
    await sleep(400);

    // --- Step 2: Select the model type (Instant vs Thinking) ---
    const wantThinking = mode.startsWith("thinking");
    const targetLabel = wantThinking ? "thinking" : "instant";

    // Find menu items in the dropdown
    const menuItems = document.querySelectorAll(
      '[role="menuitem"], [role="option"], [data-testid*="model-option"], [class*="menu"] button'
    );

    let targetItem = null;
    for (const item of menuItems) {
      const text = item.textContent.toLowerCase().trim();
      if (text.includes(targetLabel)) {
        targetItem = item;
        break;
      }
    }

    // Also try generic menu items
    if (!targetItem) {
      const allClickables = document.querySelectorAll('[role="dialog"] button, [role="menu"] button, [role="listbox"] [role="option"]');
      for (const el of allClickables) {
        if (el.textContent.toLowerCase().includes(targetLabel)) {
          targetItem = el;
          break;
        }
      }
    }

    if (targetItem) {
      targetItem.click();
      await sleep(400);
    } else {
      console.warn(`[sync-zotero] Could not find "${targetLabel}" option in model menu`);
    }

    // --- Step 3: If thinking mode, set the effort level ---
    if (wantThinking && targetItem) {
      const effort = mode === "thinking_extended" ? "extended" : "standard";
      await sleep(300);

      // Look for the thinking effort dropdown/chip
      const effortSelectors = [
        'button[aria-label*="thinking"]',
        'button[class*="thinking"]',
        '[data-testid*="thinking"]',
      ];

      let effortBtn = null;
      for (const sel of effortSelectors) {
        effortBtn = document.querySelector(sel);
        if (effortBtn) break;
      }

      // Fallback: find button containing "thinking" text near the composer
      if (!effortBtn) {
        const composerArea = document.querySelector('form') || document.querySelector('[class*="composer"]') || document.body;
        const btns = composerArea.querySelectorAll('button');
        for (const btn of btns) {
          if (/thinking/i.test(btn.textContent) && btn.textContent.length < 50) {
            effortBtn = btn;
            break;
          }
        }
      }

      if (effortBtn) {
        effortBtn.click();
        await sleep(300);

        const effortItems = document.querySelectorAll(
          '[role="menuitem"], [role="option"], [role="dialog"] button, [role="menu"] button'
        );
        for (const item of effortItems) {
          if (item.textContent.toLowerCase().includes(effort)) {
            item.click();
            await sleep(200);
            break;
          }
        }
      }
    }
  } finally {
    // Always close any remaining open menus/dropdowns to unblock the composer
    await sleep(100);
    const openMenus = document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]');
    for (const menu of openMenus) {
      // Only close if it looks like a floating/overlay menu (not the main page)
      if (menu.closest('[data-radix-popper-content-wrapper]') || menu.closest('[class*="popover"]')) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(200);
        break;
      }
    }
    // Final Escape to be safe — clicking outside won't work if composer is covered
    document.body.click();
    await sleep(100);
  }
  // Record the mode we just set so we can skip next time if unchanged
  _lastSetChatGPTMode = mode;
}

// ---------------------------------------------------------------------------
// Step 2: Type prompt
// ---------------------------------------------------------------------------

async function typePromptAndVerify(promptText) {
  const expectedText = shared.normalizeComposerText(promptText);

  for (let attempt = 0; attempt < 2; attempt++) {
    const composer = await getComposerElement();
    composer.focus();

    if (composer.tagName === "TEXTAREA") {
      setNativeValue(composer, "");
      setNativeValue(composer, promptText);
    } else {
      setContentEditableText(composer, "");
      setContentEditableText(composer, promptText);
    }

    await sleep(300);

    const actualText = shared.normalizeComposerText(readComposerText(composer));
    if (shared.composerTextMatchesPrompt(expectedText, actualText)) {
      return composer;
    }
  }

  throw new Error("Prompt verification failed: ChatGPT composer text did not match the requested prompt.");
}

// ---------------------------------------------------------------------------
// Step 3: Submit
// ---------------------------------------------------------------------------

function isEnabledButton(btn) {
  return Boolean(btn) && !btn.disabled && !btn.hasAttribute("disabled") && isVisibleElement(btn);
}

async function waitForSendButton(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = findSendButton();
    if (button) return button;
    await sleep(100);
  }
  return null;
}

function findSendButton(composer = findComposerNow()) {
  const roots = [
    composer?.closest("form") || null,
    composer?.closest("[class*='composer']") || null,
    composer?.closest("[data-testid*='composer']") || null,
    composer?.parentElement || null,
    document,
  ];

  for (const root of roots) {
    if (!root) continue;
    const match =
      root.querySelector?.("button[data-testid='send-button']") ||
      root.querySelector?.("button[aria-label='Send message']") ||
      root.querySelector?.("button[aria-label='Send prompt']") ||
      root.querySelector?.("button[aria-label='Send']") ||
      root.querySelector?.("button[type='submit']");
    if (match && isVisibleElement(match)) return match;
  }

  return null;
}

async function waitForSendButtonEnabled(timeoutMs = 8000) {
  // Wait for the send button to exist AND not be disabled
  // (ChatGPT disables it while the uploaded file is being processed)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = findSendButton();
    if (isEnabledButton(btn)) {
      return btn;
    }
    await sleep(100);
  }
  return null;
}

function dispatchSubmitViaEnter(composer) {
  if (!composer) return;
  composer.focus();
  const eventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  composer.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  composer.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  composer.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}

function dispatchSubmitViaForm(composer) {
  const form = composer?.closest?.("form");
  if (!form) return;
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function waitForSubmissionSignal(promptText, baselineOutboundRequestSerial, baselineUserMessageCount, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const composer = findComposerNow();
    const signal = shared.hasDeliverySignal({
      baselineOutboundRequestSerial,
      outboundRequestSerial,
      baselineUserMessageCount,
      userMessageCount: document.querySelectorAll("[data-message-author-role='user']").length,
      stopButtonVisible: !!findStopButton(),
      composerTextAfter: readComposerText(composer),
      promptText,
    });
    if (signal) return true;
    await workerSleep(200);
  }
  return false;
}

async function submitMessageAndVerify(promptText) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const submitStrategies = [
      async (composer) => {
        const sendBtn = await waitForSendButtonEnabled(1200);
        if (!isEnabledButton(sendBtn)) return false;
        sendBtn.click();
        return true;
      },
      (composer) => dispatchSubmitViaEnter(composer),
      (composer) => dispatchSubmitViaForm(composer),
    ];

    for (const submit of submitStrategies) {
      const composer = await getComposerElement();
      const sendBtn = await waitForSendButton(4000);
      if (!sendBtn && attempt === 0) {
        await sleep(150);
      }

      const baselineUserMessageCount = document.querySelectorAll(
        "[data-message-author-role='user']"
      ).length;
      const baselineOutboundRequestSerial = outboundRequestSerial;

      const submitStarted = await submit(composer, sendBtn);
      if (submitStarted === false) {
        continue;
      }

      const delivered = await waitForSubmissionSignal(
        promptText,
        baselineOutboundRequestSerial,
        baselineUserMessageCount,
      );
      if (delivered) return true;

      await typePromptAndVerify(promptText);
    }
  }

  throw new Error("Prompt delivery failed: ChatGPT did not accept the prompt after 2 attempts.");
}

// ---------------------------------------------------------------------------
// SSE interception listener (receives data from injected.js in MAIN world)
// ---------------------------------------------------------------------------

let sseText = "";
let sseThinking = null;
let sseDone = false;
let outboundRequestSerial = 0;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type === "SYNC_ZOTERO_SSE") {
    sseText = event.data.text || "";
    sseThinking = event.data.thinking || null;
    sseDone = event.data.done || false;
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_STREAM_START") {
    // A new SSE stream is starting (e.g., tool-use continuation).
    // Reset done flag so the previous stream's [DONE] doesn't
    // cause premature pipeline exit.
    sseDone = false;
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_REQUEST") {
    outboundRequestSerial += 1;
  }
});

// ---------------------------------------------------------------------------
// Step 4: Stream response — emit partials every 500ms, resolve when done
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves after `ms` milliseconds using a Web Worker
 * timer — immune to Chrome's background-tab throttling of setTimeout.
 */
function workerSleep(ms) {
  return new Promise((resolve) => {
    const blob = new Blob(
      [`setTimeout(() => postMessage('done'), ${ms})`],
      { type: "application/javascript" }
    );
    const url = URL.createObjectURL(blob);
    const w   = new Worker(url);
    w.onmessage = () => { w.terminate(); URL.revokeObjectURL(url); resolve(); };
  });
}

const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
];

function findStopButton() {
  for (const sel of STOP_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getMeaningfulSseText() {
  return shared.hasMeaningfulAssistantText(sseText) ? sseText : "";
}

async function waitForMeaningfulAssistantResponse(baselineCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sseAnswer = getMeaningfulSseText();
    if (sseAnswer) return sseAnswer;

    const baselineText = extractResponseAfter(baselineCount);
    if (shared.hasMeaningfulAssistantText(baselineText)) {
      return baselineText;
    }

    const fallbackText = extractResponse();
    if (shared.hasMeaningfulAssistantText(fallbackText)) {
      return fallbackText;
    }

    await workerSleep(500);
  }
  return "";
}

async function streamResponse(onPartial, onVisibilityChange, onStreamStart, timeoutMs = 180000, preSubmitBaseline = -1) {
  // Reset SSE state for this new response
  sseText = "";
  sseThinking = null;
  sseDone = false;

  // Use pre-submit baseline if provided (more accurate — counted before ChatGPT
  // adds the response element to DOM). Fall back to counting now.
  const baselineCount = preSubmitBaseline >= 0
    ? preSubmitBaseline
    : document.querySelectorAll("[data-message-author-role='assistant']").length;

  // --- Phase 1: Wait for streaming to START ---
  // Signals: stop button appears, SSE data arrives, or new assistant DOM message
  const startDeadline = Date.now() + 15000;
  let streamStarted = false;
  while (Date.now() < startDeadline) {
    if (findStopButton()) { streamStarted = true; break; }
    if (getMeaningfulSseText().length > 0) { streamStarted = true; break; }
    // DOM fallback: new assistant message appeared with content
    const currentCount = document.querySelectorAll(
      "[data-message-author-role='assistant']"
    ).length;
    if (currentCount > baselineCount) {
      const text = extractResponseAfter(baselineCount);
      if (text && text.length > 0) { streamStarted = true; break; }
    }
    await workerSleep(300);
  }

  if (!streamStarted) {
    const delayedText = await waitForMeaningfulAssistantResponse(baselineCount, 2000);
    if (delayedText) {
      onPartial(delayedText, extractThinking());
      onStreamStart?.();
      await workerSleep(1000);
      return;
    }
    throw new Error("ChatGPT did not start responding after the prompt was submitted.");
  }

  if (streamStarted) {
    onStreamStart?.();
  }

  // --- Phase 2: Stream partials while ChatGPT is generating ---
  const endDeadline = Date.now() + timeoutMs;
  let lastSentText = "";
  let lastSentThinking = "";
  let stableChecks = 0;
  let answerlessDoneSince = 0;
  const STABLE_WITH_BUTTON_GONE = 2;   // 2 × 500ms = 1s
  const STABLE_WITHOUT_BUTTON   = 6;   // 6 × 500ms = 3s
  const ANSWERLESS_DONE_GRACE_MS = 30_000;

  while (Date.now() < endDeadline) {
    const stopBtn = findStopButton();

    // --- Get text: prefer SSE (network-level), fall back to DOM ---
    // SSE works even when tab is hidden!
    let text = getMeaningfulSseText();
    let thinking = sseThinking;

    if (!text && !document.hidden) {
      // DOM fallback only when SSE not providing data
      text = extractResponseAfter(baselineCount);
      if (!thinking) thinking = extractThinking();
    }

    const textChanged = Boolean(text && text !== lastSentText);
    const thinkingChanged = Boolean(thinking && thinking !== lastSentThinking);

    // Emit partial if either the answer text or reasoning text changed.
    if (textChanged || thinkingChanged) {
      onPartial(textChanged ? text : null, thinkingChanged ? thinking : null);
      if (textChanged) lastSentText = text;
      if (thinkingChanged) lastSentThinking = thinking;
      stableChecks = 0;
    } else if (text && !stopBtn) {
      stableChecks++;
    }

    // Reset stability while stop button is showing (still generating)
    if (stopBtn) stableChecks = 0;

    // Visibility notification
    if (document.hidden) {
      onVisibilityChange(false);
    } else {
      onVisibilityChange(true);
    }

    // --- Completion detection ---
    // Primary: SSE stream sent [DONE] — emit final text before breaking.
    // BUT: ChatGPT tool-use flows (reading documents, web search, etc.)
    // create multiple sequential API calls. The first stream's [DONE] fires
    // before the actual response stream starts. We must wait briefly to
    // detect follow-up streams before accepting the result as final.
    if (sseDone) {
      // Ensure we emit the very last SSE text (it may have arrived with the done flag)
      const finalSseText = getMeaningfulSseText();
      if (finalSseText && finalSseText !== lastSentText) {
        onPartial(finalSseText, sseThinking);
        lastSentText = finalSseText;
      }
      if (lastSentText.length > 0) {
        // Wait briefly for a potential follow-up stream (tool-use continuation).
        // If sseDone gets reset (SYNC_ZOTERO_STREAM_START from a new fetch)
        // or the stop button reappears, ChatGPT is still working.
        await workerSleep(2000);
        if (!sseDone || findStopButton()) {
          // New stream started or ChatGPT still generating — keep waiting
          stableChecks = 0;
        } else {
          break;
        }
      }
    }
    if (sseDone && lastSentText.length === 0) {
      if (!answerlessDoneSince) answerlessDoneSince = Date.now();
      const delayedText = await waitForMeaningfulAssistantResponse(baselineCount, 1500);
      if (delayedText) {
        onPartial(delayedText, extractThinking());
        lastSentText = delayedText;
        break;
      }
      if (Date.now() - answerlessDoneSince >= ANSWERLESS_DONE_GRACE_MS) {
        throw new Error("ChatGPT finished thinking without producing a visible answer.");
      }
    } else {
      answerlessDoneSince = 0;
    }
    // Secondary: stop button gone + content stable for 1s
    if (streamStarted && !stopBtn && stableChecks >= STABLE_WITH_BUTTON_GONE && lastSentText.length > 0) break;
    // Tertiary: no stop button + content stable for 3s
    if (!stopBtn && stableChecks >= STABLE_WITHOUT_BUTTON && lastSentText.length > 0) break;
    // Fallback: if no text found after 30s and no stop button, try extractResponse() (ignores baseline)
    if (!stopBtn && !lastSentText && stableChecks >= 60) {
      const fallbackText = extractResponse();
      if (fallbackText && shared.hasMeaningfulAssistantText(fallbackText)) {
        onPartial(fallbackText, extractThinking());
        lastSentText = fallbackText;
        break;
      }
    }

    await workerSleep(500);
  }

  // Final settle — wait for DOM to flush
  await workerSleep(1000);
}

// ---------------------------------------------------------------------------
// Step 5: Extract response as markdown
// ---------------------------------------------------------------------------

/**
 * Extract the response from the newest assistant message only.
 * @param {number} baselineCount — number of assistant messages that existed
 *   BEFORE the current query was submitted. Only messages after this count
 *   are considered, preventing old responses from leaking into follow-ups.
 */
function extractResponseAfter(baselineCount = 0) {
  // Try multiple selectors for assistant message containers (ChatGPT changes these)
  const MSG_SELECTORS = [
    "[data-message-author-role='assistant']",
    "article[data-testid*='assistant']",
    "[class*='agent-turn']",
  ];

  let assistantMessages = [];
  for (const sel of MSG_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > baselineCount) {
      assistantMessages = nodes;
      break;
    }
  }

  if (assistantMessages.length <= baselineCount) return "";

  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  const prunedAssistant = latestAssistant.cloneNode(true);
  pruneAssistantStatusNodes(prunedAssistant);

  // Try multiple content selectors within the message (resilient to UI changes)
  const contentSelectors = [
    ".markdown",
    "[class*='markdown']",
    ".prose",
    "[class*='prose']",
    "article",
    ".text-message",
    "div[data-message-content]",
    "p",
  ];
  for (const sel of contentSelectors) {
    const el = prunedAssistant.querySelector(sel);
    if (el) {
      const text = shared.normalizeComposerText(el.textContent || "");
      if (shared.hasMeaningfulAssistantText(text)) {
        return htmlToMarkdown(el.innerHTML);
      }
    }
  }

  // Ultimate fallback: use innerText on the entire container
  const text = shared.normalizeComposerText(
    prunedAssistant.innerText || prunedAssistant.textContent || "",
  );
  if (shared.hasMeaningfulAssistantText(text)) return text;

  return "";
}

/** Extract the last assistant response (used for final extraction after streaming). */
function extractResponse() {
  return extractResponseAfter(0);
}

function pruneAssistantStatusNodes(root) {
  const selectors = [
    "details",
    "summary",
    "button",
    "[role='button']",
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking']",
    "[class*='reasoning']",
  ];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((node) => node.remove());
  }
}

function extractThinking() {
  // ChatGPT renders the thinking/reasoning block in a <details> element
  // ("Thought for X seconds") for o1/o3/o4 models.
  // During streaming it may appear as an open/expanding block before collapsing.

  // Try explicit data-testid selectors first
  const explicit = [
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking'] .markdown",
    "[class*='reasoning'] .markdown",
  ];
  for (const sel of explicit) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      const text = nodes[nodes.length - 1].textContent.trim();
      if (text.length > 2) return text;
    }
  }

  // Fallback: look for a <details> block that contains thinking text.
  // ChatGPT wraps "Thought for X seconds" in <details><summary>…</summary>…</details>
  const allDetails = document.querySelectorAll("details");
  for (let i = allDetails.length - 1; i >= 0; i--) {
    const el      = allDetails[i];
    const summary = el.querySelector("summary");
    const summaryText = summary?.textContent?.trim() ?? "";
    // Only grab details blocks that look like thinking (contain "Thought" or "Thinking")
    if (/thought|thinking|reason/i.test(summaryText)) {
      // Get text content excluding the summary label
      const full    = el.textContent.trim();
      const content = full.startsWith(summaryText)
        ? full.slice(summaryText.length).trim()
        : full;
      if (content.length > 2) return content;
    }
  }

  return null;
}

/** Very lightweight HTML → Markdown converter for ChatGPT's response format. */
function htmlToMarkdown(html) {
  // Use a temporary DOM element
  const div = document.createElement("div");
  div.innerHTML = html;

  function nodeToMd(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;

    const tag = node.tagName?.toLowerCase();
    const children = () => Array.from(node.childNodes).map(nodeToMd).join("");

    switch (tag) {
      case "h1": return `\n# ${children()}\n`;
      case "h2": return `\n## ${children()}\n`;
      case "h3": return `\n### ${children()}\n`;
      case "h4": return `\n#### ${children()}\n`;
      case "h5": return `\n##### ${children()}\n`;
      case "h6": return `\n###### ${children()}\n`;
      case "p": return `\n${children()}\n`;
      case "br": return "\n";
      case "strong":
      case "b": return `**${children()}**`;
      case "em":
      case "i": return `*${children()}*`;
      case "code": {
        const parent = node.parentElement?.tagName?.toLowerCase();
        if (parent === "pre") return children(); // handled by pre
        return `\`${children()}\``;
      }
      case "pre": {
        const codeEl = node.querySelector("code");
        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] ?? "";
        const content = codeEl ? codeEl.textContent : node.textContent;
        return `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
      }
      case "ul": {
        return "\n" + Array.from(node.children).map(li => `- ${li.textContent.trim()}`).join("\n") + "\n";
      }
      case "ol": {
        return "\n" + Array.from(node.children).map((li, i) => `${i + 1}. ${li.textContent.trim()}`).join("\n") + "\n";
      }
      case "li": return `\n- ${children()}`;
      case "a": return `[${children()}](${node.getAttribute("href") ?? ""})`;
      case "blockquote": return `\n> ${children().trim().replace(/\n/g, "\n> ")}\n`;
      case "hr": return "\n---\n";
      case "table": return `\n${tableToMd(node)}\n`;
      default: return children();
    }
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const lines = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td, th")).map(
        (c) => c.textContent.trim().replace(/\|/g, "\\|")
      );
      return `| ${cells.join(" | ")} |`;
    });
    const header = lines[0];
    const sep = header.replace(/[^|]/g, "-").replace(/--/g, "--");
    return [header, sep, ...lines.slice(1)].join("\n");
  }

  return nodeToMd(div).replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Scrape all messages from the current ChatGPT conversation page
// ---------------------------------------------------------------------------

/**
 * Extract all user and assistant messages from the current ChatGPT page.
 * Returns them in chronological order as { role, text } objects.
 */
async function scrapeAllMessages() {
  const MSG_SELECTORS = [
    "[data-message-author-role]",
    "div[data-message-id]",
  ];

  // --- Phase 1: Wait for at least one message to appear in the DOM ---
  // ChatGPT loads conversation messages asynchronously after page load.
  // Poll up to 15 seconds for any message element to appear.
  let foundSelector = null;
  for (let i = 0; i < 30; i++) { // 30 × 500ms = 15s
    for (const sel of MSG_SELECTORS) {
      if (document.querySelectorAll(sel).length > 0) {
        foundSelector = sel;
        break;
      }
    }
    if (foundSelector) break;
    await sleep(500);
  }

  if (!foundSelector) {
    console.warn("[sync-zotero] scrapeAllMessages: no messages found after 15s");
    return [];
  }

  // --- Phase 2: Wait for messages to stabilize ---
  // ChatGPT may still be rendering. Wait until message count stops changing.
  let lastCount = 0;
  let stableChecks = 0;
  for (let i = 0; i < 10; i++) { // up to 5 more seconds
    const count = document.querySelectorAll(foundSelector).length;
    if (count === lastCount && count > 0) {
      stableChecks++;
      if (stableChecks >= 3) break; // stable for 1.5s
    } else {
      stableChecks = 0;
      lastCount = count;
    }
    await sleep(500);
  }

  // --- Phase 3: Extract all messages ---
  const msgElements = Array.from(document.querySelectorAll(foundSelector));
  const messages = [];

  for (const el of msgElements) {
    const role = el.getAttribute("data-message-author-role") || "";

    // Skip system/tool messages
    if (role !== "user" && role !== "assistant") continue;

    let text = "";
    if (role === "assistant") {
      const CONTENT_SELECTORS = [
        ".markdown",
        "[class*='markdown']",
        ".prose",
        "[class*='prose']",
        "article",
        "p",
      ];
      for (const sel of CONTENT_SELECTORS) {
        const contentEl = el.querySelector(sel);
        if (contentEl && contentEl.textContent.trim().length > 1) {
          text = htmlToMarkdown(contentEl.innerHTML);
          break;
        }
      }
      if (!text) {
        text = el.innerText?.trim() || el.textContent?.trim() || "";
      }
    } else {
      text = el.innerText?.trim() || el.textContent?.trim() || "";
    }

    if (text) {
      messages.push({
        role: role === "assistant" ? "bot" : "user",
        text,
      });
    }
  }

  console.log(`[sync-zotero] scrapeAllMessages: found ${messages.length} messages`);
  return messages;
}

// ---------------------------------------------------------------------------
// Main message listener
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PING handler (used by background to check if content script is alive)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ pong: true }); return false; }

  // [webchat] Trigger immediate sidebar history scrape (force re-send)
  if (msg.type === "SCRAPE_HISTORY_NOW") {
    lastHistoryJson = "";  // Reset cache to force re-send
    scrapeHistory();
    sendResponse({ ok: true });
    return false;
  }

  // [webchat] Navigate to a URL (forces full page reload for SPA)
  if (msg.type === "NAVIGATE") {
    _lastSetChatGPTMode = null; // Reset mode tracking for new page
    window.location.href = msg.url;
    sendResponse({ ok: true });
    return false;
  }

  // [webchat] Scrape all messages from the current ChatGPT conversation
  if (msg.type === "SCRAPE_MESSAGES") {
    console.log("[sync-zotero] SCRAPE_MESSAGES received, starting scrape…");
    scrapeAllMessages()
      .then((messages) => {
        console.log(`[sync-zotero] SCRAPE_MESSAGES done: ${messages.length} messages`);
        sendResponse({ ok: true, messages });
      })
      .catch((err) => {
        console.warn("[sync-zotero] SCRAPE_MESSAGES error:", err);
        sendResponse({ ok: false, error: err.message, messages: [] });
      });
    return true; // async sendResponse
  }

  return false;
});

// ---------------------------------------------------------------------------
// Port-based pipeline handler (streaming)
// ---------------------------------------------------------------------------

// Guard: only register the port listener once per execution context.
// If the content script is re-injected, the old context's listener is orphaned
// and cannot receive new connections, but this prevents same-context duplication.
let _syncZoteroPort = null;

if (!window.__syncZoteroListenerRegistered) {
  window.__syncZoteroListenerRegistered = true;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "sync-zotero") return;

    // Disconnect any previous port to prevent parallel pipelines
    if (_syncZoteroPort) {
      try { _syncZoteroPort.disconnect(); } catch (_) {}
    }
    _syncZoteroPort = port;

    port.onDisconnect.addListener(() => {
      if (_syncZoteroPort === port) _syncZoteroPort = null;
    });

    port.onMessage.addListener(async (msg) => {
      if (msg.type !== "START") return;

      const seq = msg.seq; // track seq for end-to-end validation
      const attempt = msg.attempt || 0;

      try {
        // Snapshot existing assistant messages before we start, so we only
        // extract the NEW response (not previous ones in a follow-up).
        const baselineCount = document.querySelectorAll(
          "[data-message-author-role='assistant']"
        ).length;

        // Attach PDF whenever provided — the plugin controls when to send via chip state
        if (msg.pdfBase64) {
          await attachPDF(msg.pdfBase64, msg.pdfFilename);
        }
        if (msg.images && msg.images.length > 0) {
          console.log(`[sync-zotero] Attaching ${msg.images.length} image(s)…`);
          try {
            await attachImages(msg.images);
          } catch (imgErr) {
            console.warn("[sync-zotero] Image attachment failed:", imgErr);
          }
        }
        // Mode switching disabled — users control thinking mode directly on chatgpt.com
        await typePromptAndVerify(msg.prompt);
        port.postMessage({ type: "phase", seq, attempt, phase: "prompt_applied" });

        await submitMessageAndVerify(msg.prompt);
        port.postMessage({ type: "phase", seq, attempt, phase: "submitted" });

        await streamResponse(
          (partialText, thinkingText) => {
            try { port.postMessage({ type: "partial", seq, attempt, text: partialText, thinking: thinkingText ?? null }); } catch (_) {}
          },
          (isVisible) => {
            try { port.postMessage({ type: "visibility", visible: isVisible }); } catch (_) {}
          },
          () => {
            try { port.postMessage({ type: "phase", seq, attempt, phase: "streaming" }); } catch (_) {}
          },
          180000,
          baselineCount  // pre-submit count for accurate DOM fallback
        );

        // Final response: try multiple extraction methods
        let finalText = getMeaningfulSseText() || extractResponseAfter(baselineCount);
        // If both SSE and baseline-aware extraction failed, try extracting the
        // very last assistant message regardless of baseline (handles cases where
        // the baseline count was wrong due to page state changes)
        if (!shared.hasMeaningfulAssistantText(finalText)) {
          finalText = extractResponse();
        }
        if (!shared.hasMeaningfulAssistantText(finalText)) {
          finalText = await waitForMeaningfulAssistantResponse(baselineCount, 15_000);
        }
        if (!shared.hasMeaningfulAssistantText(finalText)) {
          throw new Error("ChatGPT finished thinking without producing a visible answer.");
        }
        const finalThinking = sseThinking || extractThinking();
        port.postMessage({ type: "done", seq, attempt, text: finalText, thinking: finalThinking ?? null });

      } catch (err) {
        try { port.postMessage({ type: "error", seq, attempt, error: err.message }); } catch (_) {}
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 3: History Mirroring & Deletion
// ---------------------------------------------------------------------------

let lastHistoryJson = "";

async function scrapeHistory() {
  const items = Array.from(document.querySelectorAll('nav a[href^="/c/"]'));
  const history = items.map(a => {
    const href = a.getAttribute('href');
    const chatId = href.replace('/c/', '');
    // The title is usually in a nested div, but textContent works well enough
    // to get the visible text, stripped of extra whitespace.
    const title = a.textContent.trim();
    return { id: chatId, title, chatUrl: `https://chatgpt.com${href}` };
  });

  const historyJson = JSON.stringify(history);
  if (historyJson !== lastHistoryJson && history.length > 0) {
    lastHistoryJson = historyJson;
    chrome.runtime.sendMessage({ type: "HISTORY_UPDATE", history }, () => {
      // Suppress "Receiving end does not exist" when service worker is inactive
      void chrome.runtime.lastError;
    });
  }
}

// Scrape every 2 seconds
setInterval(scrapeHistory, 2000);

async function handleDeleteChat(chatId) {
  // Find the exact link in the sidebar
  const chatLink = document.querySelector(`nav a[href="/c/${chatId}"]`);
  if (!chatLink) return { success: false, error: "Chat not found in sidebar" };

  // Hover or focus to ensure the options button appears
  chatLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(300);

  // The options button is usually a sibling or child button with aria-haspopup="menu"
  // Let's look for a button inside the link or immediately next to it.
  const optionsBtn = chatLink.querySelector('button[aria-haspopup="menu"]') || 
                     chatLink.parentElement.querySelector('button[aria-haspopup="menu"]');
                     
  if (!optionsBtn) return { success: false, error: "Options button not found" };
  
  optionsBtn.click();
  await sleep(300);

  // Radix menu opens at the end of the body
  // Find the Delete menu item
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const deleteItem = menuItems.find(item => item.textContent.toLowerCase().includes('delete'));
  
  if (!deleteItem) return { success: false, error: "Delete menu item not found" };
  
  deleteItem.click();
  await sleep(500);

  // Find the red confirmation button in the modal
  const modalButtons = Array.from(document.querySelectorAll('[role="dialog"] button'));
  // Usually the destructive action button has specific styling, or it's the last button containing "Delete"
  const confirmBtn = modalButtons.find(btn => btn.textContent.toLowerCase().includes('delete'));
  
  if (!confirmBtn) return { success: false, error: "Confirmation button not found" };
  
  confirmBtn.click();
  await sleep(1000); // Wait for deletion to process

  // Scrape history immediately to reflect deletion
  scrapeHistory();
  return { success: true };
}

// Message listener for the DELETE command
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "DELETE_CHAT") {
    handleDeleteChat(request.chatId)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});
