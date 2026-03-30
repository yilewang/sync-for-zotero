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
  TURN_COMPLETION_QUIET_WINDOW_MS: 7000,
  TURN_COMPLETION_REBOUND_WINDOW_MS: 1500,
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  composerTextMatchesPrompt: (promptText, composerText) => String(promptText || "").trim() === String(composerText || "").trim(),
  createTurnCompletionTracker: (nowMs) => {
    const ts = Number.isFinite(nowMs) ? Number(nowMs) : 0;
    return {
      phase: "active",
      activeRunSeen: false,
      lastAnswerRevision: 0,
      lastThinkingRevision: 0,
      lastTranscriptRevision: 0,
      lastAnswerChangeAt: ts,
      lastThinkingChangeAt: ts,
      lastTranscriptChangeAt: ts,
      lastActiveRunAt: ts,
      quietWindowStartedAt: ts,
      candidateSince: null,
      verificationStartedAt: null,
    };
  },
  advanceTurnCompletionTracker: (currentTracker, sample) => {
    const nowMs = Number.isFinite(sample?.nowMs) ? Number(sample.nowMs) : Date.now();
    const quietWindowMs = Number.isFinite(sample?.quietWindowMs) && Number(sample.quietWindowMs) > 0
      ? Number(sample.quietWindowMs)
      : 7000;
    const reboundWindowMs = Number.isFinite(sample?.reboundWindowMs) && Number(sample.reboundWindowMs) > 0
      ? Number(sample.reboundWindowMs)
      : 1500;
    const tracker = currentTracker
      ? { ...currentTracker }
      : {
        phase: "active",
        activeRunSeen: false,
        lastAnswerRevision: 0,
        lastThinkingRevision: 0,
        lastTranscriptRevision: 0,
        lastAnswerChangeAt: nowMs,
        lastThinkingChangeAt: nowMs,
        lastTranscriptChangeAt: nowMs,
        lastActiveRunAt: nowMs,
        quietWindowStartedAt: nowMs,
        candidateSince: null,
        verificationStartedAt: null,
      };
    const previousPhase = tracker.phase || "active";
    const answerRevision = Number.isFinite(sample?.answerRevision)
      ? Math.max(0, Math.floor(Number(sample.answerRevision)))
      : tracker.lastAnswerRevision;
    const thinkingRevision = Number.isFinite(sample?.thinkingRevision)
      ? Math.max(0, Math.floor(Number(sample.thinkingRevision)))
      : tracker.lastThinkingRevision;
    const transcriptRevision = Number.isFinite(sample?.transcriptRevision)
      ? Math.max(0, Math.floor(Number(sample.transcriptRevision)))
      : tracker.lastTranscriptRevision;
    const answerVisible = sample?.answerVisible === true;
    const thinkingVisible = sample?.thinkingVisible === true;
    const activeRun = sample?.activeRun === true;
    const hasUserTurn = sample?.hasUserTurn === true;
    const hasAssistantTurn = sample?.hasAssistantTurn === true;
    const forceIncomplete = sample?.forceIncomplete === true;

    if (answerRevision !== tracker.lastAnswerRevision) {
      tracker.lastAnswerRevision = answerRevision;
      tracker.lastAnswerChangeAt = nowMs;
    }
    if (thinkingRevision !== tracker.lastThinkingRevision) {
      tracker.lastThinkingRevision = thinkingRevision;
      tracker.lastThinkingChangeAt = nowMs;
    }
    if (transcriptRevision !== tracker.lastTranscriptRevision) {
      tracker.lastTranscriptRevision = transcriptRevision;
      tracker.lastTranscriptChangeAt = nowMs;
    }
    if (activeRun) {
      tracker.lastActiveRunAt = nowMs;
      tracker.activeRunSeen = true;
    }

    const quietWindowStartedAt = Math.max(
      tracker.lastAnswerChangeAt,
      tracker.lastThinkingChangeAt,
      tracker.lastTranscriptChangeAt,
      tracker.lastActiveRunAt,
    );
    tracker.quietWindowStartedAt = quietWindowStartedAt;
    const quietForMs = Math.max(0, nowMs - quietWindowStartedAt);

    if (forceIncomplete) {
      tracker.phase = "incomplete";
      tracker.candidateSince = null;
      tracker.verificationStartedAt = null;
    } else if (answerVisible && !activeRun) {
      tracker.phase = "candidate_done";
      if (previousPhase !== "candidate_done") {
        tracker.candidateSince = nowMs;
      } else if (!Number.isFinite(tracker.candidateSince)) {
        tracker.candidateSince = nowMs;
      }
      if (quietForMs >= quietWindowMs) {
        if (!Number.isFinite(tracker.verificationStartedAt)) {
          tracker.verificationStartedAt = nowMs;
        }
        if (nowMs - tracker.verificationStartedAt >= reboundWindowMs) {
          tracker.phase = "verified_done";
        }
      } else {
        tracker.verificationStartedAt = null;
      }
    } else {
      tracker.phase = "active";
      tracker.candidateSince = null;
      tracker.verificationStartedAt = null;
    }

    let turnStatus = "submitted";
    if (tracker.phase === "verified_done") {
      turnStatus = "done";
    } else if (tracker.phase === "incomplete") {
      turnStatus = "incomplete";
    } else if (tracker.phase === "candidate_done") {
      turnStatus = "assistant_settling";
    } else if (hasAssistantTurn || answerVisible || thinkingVisible) {
      turnStatus = "assistant_turn_matched";
    } else if (hasUserTurn) {
      turnStatus = "user_turn_matched";
    }

    let runState = "submitted";
    if (tracker.phase === "verified_done") {
      runState = "done";
    } else if (tracker.phase === "incomplete") {
      runState = "incomplete";
    } else if (tracker.phase === "candidate_done") {
      runState = "settling";
    } else if (
      answerVisible ||
      thinkingVisible ||
      activeRun ||
      tracker.activeRunSeen ||
      hasAssistantTurn
    ) {
      runState = "active";
    }

    return {
      tracker,
      phase: tracker.phase,
      previousPhase,
      phaseChanged: tracker.phase !== previousPhase,
      turnStatus,
      runState,
      quietForMs,
      verificationForMs: Number.isFinite(tracker.verificationStartedAt)
        ? Math.max(0, nowMs - tracker.verificationStartedAt)
        : 0,
      emitDone: tracker.phase === "verified_done" && previousPhase !== "verified_done",
      emitIncomplete: tracker.phase === "incomplete" && previousPhase !== "incomplete",
      activeRunSeen: tracker.activeRunSeen,
      quietWindowStartedAt,
      candidateSince: tracker.candidateSince,
      verificationStartedAt: tracker.verificationStartedAt,
    };
  },
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

const WEBCHAT_DEBUG = false;
const TURN_DEBUG_EVENT_LIMIT = 200;
let turnDebugEvents = [];
let activeTurnDebugToken = null;

function debugLog(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  console.log("[sync-zotero][webchat]", event, payload || "");
}

function resetTurnDebug(seq, attempt) {
  activeTurnDebugToken = `${Number(seq) || 0}:${Number(attempt) || 0}`;
  turnDebugEvents = [];
}

function recordTurnDebug(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  const entry = {
    at: Date.now(),
    token: activeTurnDebugToken,
    event,
    payload: payload || null,
  };
  turnDebugEvents.push(entry);
  if (turnDebugEvents.length > TURN_DEBUG_EVENT_LIMIT) {
    turnDebugEvents.splice(0, turnDebugEvents.length - TURN_DEBUG_EVENT_LIMIT);
  }
  console.log("[sync-zotero][webchat]", event, payload || "");
}

globalThis.__syncZoteroWebchatDebug = {
  getEvents: () => turnDebugEvents.slice(),
  getActiveToken: () => activeTurnDebugToken,
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

async function waitForSubmissionSignal(promptText, baselineOutboundRequestSerial, baselineUserMessageCount, timeoutMs = 5000) {
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
let activeConversationStreamCount = 0;
let lastTransportActivityAt = 0;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type === "SYNC_ZOTERO_SSE") {
    sseText = event.data.text || "";
    sseThinking = event.data.thinking || null;
    sseDone = event.data.done || false;
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_STREAM_START") {
    // A new SSE stream is starting (e.g., tool-use continuation).
    // Reset done flag so the previous stream's [DONE] doesn't
    // cause premature pipeline exit.
    sseDone = false;
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_REQUEST") {
    outboundRequestSerial += 1;
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_STREAM_STATE") {
    activeConversationStreamCount = Math.max(0, Number(event.data.activeCount) || 0);
    lastTransportActivityAt = Date.now();
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
  'button[aria-label="Cancel"]',
  'button[aria-label="Cancel response"]',
  'button[title="Cancel"]',
  'button[title="Stop"]',
  '[data-testid*="cancel"]',
];

function looksLikeRedCancelButton(el) {
  if (!(el instanceof HTMLButtonElement)) return false;
  const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`
    .trim()
    .toLowerCase();
  if (/\b(cancel|stop)\b/.test(label)) return true;
  if (!/^(x|×)$/.test(label)) return false;
  const style = window.getComputedStyle(el);
  const bg = style.backgroundColor || "";
  return /rgb(a)?\(\s*(1[6-9]\d|2[0-5]\d)\s*,\s*([0-9]|[1-9]\d|1[01]\d)\s*,\s*([0-9]|[1-9]\d|1[01]\d)/i.test(bg);
}

function findStopButton() {
  for (const sel of STOP_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isVisibleElement(el)) return el;
  }

  const composerRoot =
    findComposerNow()?.closest("form") ||
    document.querySelector("form") ||
    document.body;
  const buttons = composerRoot?.querySelectorAll?.("button") || [];
  for (const button of buttons) {
    if (isVisibleElement(button) && looksLikeRedCancelButton(button)) {
      return button;
    }
  }
  return null;
}

function hasBusyComposerHint() {
  const bodyText = document.body?.textContent || "";
  return (
    bodyText.includes("Wait for the current response to finish before starting a new chat") ||
    bodyText.includes("Wait for ChatGPT to finish responding")
  );
}

function isConversationStillRunning(stopBtn = findStopButton()) {
  return Boolean(stopBtn) || activeConversationStreamCount > 0 || hasBusyComposerHint();
}

function getAssistantMessageNodes() {
  const selectors = [
    "[data-message-author-role='assistant']",
    "article[data-testid*='assistant']",
  ];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length > 0) return nodes;
  }
  return [];
}

function buildAssistantAnchorId(node, index) {
  return (
    node.getAttribute?.("data-message-id") ||
    node.id ||
    `assistant-anchor-${index + 1}`
  );
}

function getAssistantMessageInfo() {
  return getAssistantMessageNodes().map((node, index) => {
    const id = buildAssistantAnchorId(node, index);
    const text = shared.normalizeComposerText(extractAssistantAnswerText(node));
    return {
      node,
      id,
      index,
      signature: `${id}::${text.slice(0, 500)}`,
    };
  });
}

function getLatestAssistantSignature() {
  const assistantMessages = getAssistantMessageInfo();
  if (assistantMessages.length === 0) {
    return { count: 0, signature: "" };
  }

  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  return {
    count: assistantMessages.length,
    signature: latestAssistant.signature,
  };
}

function resolveAnchoredAssistantInfo(baselineSnapshot, anchorId = null) {
  const assistants = getAssistantMessageInfo();
  if (!assistants.length) return null;

  if (anchorId) {
    const exact = assistants.find((entry) => entry.id === anchorId);
    if (exact) return exact;
    const fallbackByIndex = assistants[baselineSnapshot?.count || 0];
    if (fallbackByIndex) return fallbackByIndex;
    return assistants[assistants.length - 1] || null;
  }

  const baselineCount = baselineSnapshot?.count || 0;
  if (assistants.length > baselineCount) {
    return assistants[baselineCount] || assistants[assistants.length - 1] || null;
  }

  const latest = assistants[assistants.length - 1];
  if (latest && latest.signature && latest.signature !== (baselineSnapshot?.signature || "")) {
    return latest;
  }

  return null;
}

function getMeaningfulSseText() {
  return shared.hasMeaningfulAssistantText(sseText) ? sseText : "";
}

function getCurrentAnchoredSnapshot(baselineSnapshot, anchorId = null) {
  const anchor = resolveAnchoredAssistantInfo(baselineSnapshot, anchorId);
  const answerText = anchor ? extractAssistantAnswerText(anchor.node) : "";
  const domThinking = anchor ? extractAssistantThinkingText(anchor.node) : "";
  const thinkingText = shared.normalizeComposerText(domThinking || sseThinking || "");
  return {
    anchorId: anchor?.id || null,
    answerText,
    thinkingText,
    answerVisible: shared.hasMeaningfulAssistantText(answerText),
  };
}

async function waitForMeaningfulAssistantResponse(
  baselineSnapshot,
  anchorId = null,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = getCurrentAnchoredSnapshot(baselineSnapshot, anchorId);
    if (snapshot.answerVisible || snapshot.thinkingText) {
      return snapshot;
    }

    const sseAnswer = getMeaningfulSseText();
    if (sseAnswer) {
      return {
        anchorId: snapshot.anchorId,
        answerText: sseAnswer,
        thinkingText: snapshot.thinkingText,
        answerVisible: true,
      };
    }

    await workerSleep(400);
  }
  return {
    anchorId,
    answerText: "",
    thinkingText: shared.normalizeComposerText(sseThinking || ""),
    answerVisible: false,
  };
}

function postSnapshot(port, payload) {
  try {
    port.postMessage({ type: "snapshot", ...payload });
  } catch (_) {}
}

function postTurnState(port, payload) {
  try {
    port.postMessage({ type: "turn_state", ...payload });
  } catch (_) {}
}

function postTerminal(port, payload) {
  try {
    port.postMessage({ type: "terminal", ...payload });
  } catch (_) {}
}

async function streamResponseSnapshots(
  port,
  seq,
  attempt,
  baselineTranscript = null,
  promptText = "",
  attachmentFingerprint = "",
  timeoutMs = 180000,
) {
  sseText = "";
  sseThinking = null;
  sseDone = false;
  resetTurnDebug(seq, attempt);

  const baseline = baselineTranscript || extractConversationTranscript();
  const baselineTranscriptCount = baseline.count;
  const baselineTranscriptHash = baseline.hash;
  let remoteChatUrl = baseline.chatUrl;
  let remoteChatId = baseline.chatId;
  let userTurnKey = null;
  let assistantTurnKey = null;
  let answerRevision = 0;
  let thinkingRevision = 0;
  let transcriptRevision = 0;
  let lastTranscriptHash = baseline.hash;
  let lastAnswerText = "";
  let lastThinkingText = "";
  let lastRunState = "submitted";
  let lastCompletionReason = null;
  let lastTurnStatus = "submitted";
  let lastUserTurnKey = null;
  let lastAssistantTurnKey = null;
  let lastAnyProgressAt = Date.now();
  let cancelAttempted = false;
  let cancelRequestedAt = 0;
  const deadline = Date.now() + timeoutMs;
  const userTurnDeadline = Date.now() + 30_000;
  let reportedUserTurn = false;
  let reportedAssistantTurn = false;
  let lastActiveRun = null;
  let completionTracker = shared.createTurnCompletionTracker(Date.now());

  recordTurnDebug("baseline_transcript", {
    seq,
    attempt,
    baselineTranscriptCount,
    baselineTranscriptHash,
    attachmentFingerprint,
    remoteChatUrl,
    remoteChatId,
  });

  postTurnState(port, {
    seq,
    attempt,
    remoteChatUrl,
    remoteChatId,
    baselineTranscriptCount,
    baselineTranscriptHash,
    turnStatus: "submitted",
  });

  while (Date.now() < deadline) {
    const nowMs = Date.now();
    const stopBtn = findStopButton();
    const activeRun = isConversationStillRunning(stopBtn);
    const transcript = extractConversationTranscript();
    remoteChatUrl = transcript.chatUrl;
    remoteChatId = transcript.chatId;
    if (transcript.hash !== lastTranscriptHash) {
      lastTranscriptHash = transcript.hash;
      transcriptRevision += 1;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("transcript_revision", {
        seq,
        attempt,
        transcriptRevision,
        transcriptHash: transcript.hash,
      });
    }
    if (lastActiveRun === null || lastActiveRun !== activeRun) {
      lastActiveRun = activeRun;
      recordTurnDebug("active_run_transition", {
        seq,
        attempt,
        activeRun,
      });
    }

    if (!userTurnKey) {
      const matchedUserTurn = findMatchingUserTurn(
        transcript,
        baselineTranscriptCount,
        promptText,
      );
      if (matchedUserTurn) {
        userTurnKey = matchedUserTurn.messageKey;
        if (!reportedUserTurn) {
          reportedUserTurn = true;
          recordTurnDebug("user_turn_matched", {
            seq,
            attempt,
            userTurnKey,
            remoteChatUrl,
            remoteChatId,
          });
          postTurnState(port, {
            seq,
            attempt,
            remoteChatUrl,
            remoteChatId,
            baselineTranscriptCount,
            baselineTranscriptHash,
            userTurnKey,
            turnStatus: "user_turn_matched",
          });
        }
      } else if (!activeRun && Date.now() > userTurnDeadline) {
        throw new Error("ChatGPT never created the submitted user turn in the conversation transcript.");
      }
    }

    const assistantTurn = resolveBoundAssistantTurn(
      transcript,
      userTurnKey,
      assistantTurnKey,
    );
    if (assistantTurn?.messageKey) {
      assistantTurnKey = assistantTurn.messageKey;
      if (!reportedAssistantTurn) {
        reportedAssistantTurn = true;
        recordTurnDebug("assistant_turn_matched", {
          seq,
          attempt,
          userTurnKey,
          assistantTurnKey,
          remoteChatUrl,
          remoteChatId,
        });
        postTurnState(port, {
          seq,
          attempt,
          remoteChatUrl,
          remoteChatId,
          baselineTranscriptCount,
          baselineTranscriptHash,
          userTurnKey,
          assistantTurnKey,
          turnStatus: "assistant_turn_matched",
        });
      }
    }

    const answerText = assistantTurn?.text || "";
    const domThinking = assistantTurn?.thinking || "";
    const thinkingText = shared.normalizeComposerText(
      domThinking || sseThinking || "",
    );
    const answerChanged = answerText !== lastAnswerText;
    const thinkingChanged = thinkingText !== lastThinkingText;
    if (answerChanged) {
      answerRevision += 1;
      lastAnswerText = answerText;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("answer_revision", {
        seq,
        attempt,
        answerRevision,
        textLength: lastAnswerText.length,
      });
    }
    if (thinkingChanged) {
      thinkingRevision += 1;
      lastThinkingText = thinkingText;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("thinking_revision", {
        seq,
        attempt,
        thinkingRevision,
        textLength: lastThinkingText.length,
      });
    }

    const answerVisible = shared.hasMeaningfulAssistantText(answerText);
    const thinkingVisible = Boolean(thinkingText);
    const quietSinceMs = nowMs - Math.max(lastAnyProgressAt, lastTransportActivityAt || 0);
    const completion = shared.advanceTurnCompletionTracker(completionTracker, {
      nowMs,
      answerVisible,
      thinkingVisible,
      activeRun,
      answerRevision,
      thinkingRevision,
      transcriptRevision,
      hasUserTurn: Boolean(userTurnKey),
      hasAssistantTurn: Boolean(assistantTurnKey),
    });
    const previousPhase = completionTracker.phase;
    completionTracker = completion.tracker;
    const turnStatus = completion.turnStatus;
    const runState = completion.runState;
    if (completion.phaseChanged) {
      recordTurnDebug("completion_phase", {
        seq,
        attempt,
        previousPhase,
        phase: completion.phase,
        quietForMs: completion.quietForMs,
        verificationForMs: completion.verificationForMs,
      });
    }
    if (
      completion.phase === "candidate_done" &&
      !completion.phaseChanged &&
      completion.verificationStartedAt &&
      completion.verificationStartedAt === nowMs
    ) {
      recordTurnDebug("verification_window_start", {
        seq,
        attempt,
        quietForMs: completion.quietForMs,
      });
    }

    const shouldEmitSnapshot =
      answerChanged ||
      thinkingChanged ||
      runState !== lastRunState ||
      turnStatus !== lastTurnStatus ||
      userTurnKey !== lastUserTurnKey ||
      assistantTurnKey !== lastAssistantTurnKey ||
      lastCompletionReason !== null;
    if (shouldEmitSnapshot) {
      postSnapshot(port, {
        seq,
        attempt,
        answerSnapshot: lastAnswerText,
        thinkingSnapshot: lastThinkingText || null,
        text: lastAnswerText,
        thinking: lastThinkingText || null,
        answerAnchorId: assistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState,
        completionReason: null,
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus,
      });
      lastRunState = runState;
      lastCompletionReason = null;
      lastTurnStatus = turnStatus;
      lastUserTurnKey = userTurnKey;
      lastAssistantTurnKey = assistantTurnKey;
    }

    if (completion.emitDone) {
      recordTurnDebug("verified_done_emit", {
        seq,
        attempt,
        transcriptHash: transcript.hash,
        answerRevision,
        thinkingRevision,
      });
      postTerminal(port, {
        seq,
        attempt,
        text: lastAnswerText,
        thinking: lastThinkingText || null,
        answerAnchorId: assistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState: "done",
        completionReason: "settled",
        finalTranscriptHash: transcript.hash,
        verifiedAt: nowMs,
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus: "done",
      });
      return;
    }

    if (
      answerVisible &&
      activeRun &&
      !cancelAttempted &&
      quietSinceMs >= 12_000
    ) {
      cancelAttempted = true;
      cancelRequestedAt = Date.now();
      try {
        stopBtn?.click?.();
      } catch (_) {}
      recordTurnDebug("forced_cancel_attempt", {
        seq,
        attempt,
        quietSinceMs,
      });
      postTurnState(port, {
        seq,
        attempt,
        remoteChatUrl,
        remoteChatId,
        baselineTranscriptCount,
        baselineTranscriptHash,
        userTurnKey,
        assistantTurnKey,
        turnStatus: "assistant_settling",
      });
      await workerSleep(1500);
      continue;
    }

    if (
      cancelAttempted &&
      answerVisible &&
      activeRun &&
      nowMs - cancelRequestedAt >= 4_000
    ) {
      completionTracker = shared.advanceTurnCompletionTracker(completionTracker, {
        nowMs,
        answerVisible,
        thinkingVisible,
        activeRun,
        answerRevision,
        thinkingRevision,
        transcriptRevision,
        hasUserTurn: Boolean(userTurnKey),
        hasAssistantTurn: Boolean(assistantTurnKey),
        forceIncomplete: true,
      }).tracker;
      recordTurnDebug("forced_cancel_incomplete", {
        seq,
        attempt,
      });
      postTerminal(port, {
        seq,
        attempt,
        text: lastAnswerText,
        thinking: lastThinkingText || null,
        answerAnchorId: assistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState: "incomplete",
        completionReason: "forced_cancel",
        finalTranscriptHash: transcript.hash,
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus: "incomplete",
      });
      return;
    }

    await workerSleep(500);
  }

  if (shared.hasMeaningfulAssistantText(lastAnswerText)) {
    completionTracker = shared.advanceTurnCompletionTracker(completionTracker, {
      nowMs: Date.now(),
      answerVisible: true,
      thinkingVisible: Boolean(lastThinkingText),
      activeRun: false,
      answerRevision,
      thinkingRevision,
      transcriptRevision,
      hasUserTurn: Boolean(userTurnKey),
      hasAssistantTurn: Boolean(assistantTurnKey),
      forceIncomplete: true,
    }).tracker;
    recordTurnDebug("timeout_incomplete", {
      seq,
      attempt,
      answerRevision,
      thinkingRevision,
    });
    postTerminal(port, {
      seq,
      attempt,
      text: lastAnswerText,
      thinking: lastThinkingText || null,
      answerAnchorId: assistantTurnKey,
      answerRevision,
      thinkingRevision,
      runState: "incomplete",
      completionReason: cancelAttempted ? "forced_cancel" : "timeout",
      finalTranscriptHash: lastTranscriptHash,
      remoteChatUrl,
      remoteChatId,
      userTurnKey,
      assistantTurnKey,
      baselineTranscriptCount,
      baselineTranscriptHash,
      turnStatus: "incomplete",
    });
    return;
  }

  throw new Error("ChatGPT did not produce a visible assistant turn before timeout.");
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
function extractAssistantAnswerText(node) {
  if (!node) return "";
  const prunedAssistant = node.cloneNode(true);
  pruneAssistantStatusNodes(prunedAssistant);

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
  const candidateMap = new Map();
  for (const sel of contentSelectors) {
    const nodes = prunedAssistant.querySelectorAll(sel);
    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") continue;
      const className = String(el.className || "").toLowerCase();
      if (
        className.includes("sr-only") ||
        className.includes("screen-reader") ||
        className.includes("visually-hidden") ||
        className.includes("radix-visually-hidden") ||
        className.includes("thinking") ||
        className.includes("reasoning")
      ) {
        continue;
      }
      const text = shared.normalizeComposerText(el.textContent || "");
      if (!shared.hasMeaningfulAssistantText(text)) continue;
      const markdown = htmlToMarkdown(el.innerHTML).trim();
      const key = markdown || text;
      const prev = candidateMap.get(key);
      const score = text.length + (sel === ".markdown" || sel === ".prose" ? 1000 : 0);
      if (!prev || score > prev.score) {
        candidateMap.set(key, {
          score,
          markdown: markdown || text,
        });
      }
    }
  }

  const bestCandidate = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score)[0];
  if (bestCandidate?.markdown) {
    return bestCandidate.markdown;
  }

  // Ultimate fallback: use innerText on the entire container
  const text = shared.normalizeComposerText(
    prunedAssistant.innerText || prunedAssistant.textContent || "",
  );
  if (shared.hasMeaningfulAssistantText(text)) return text;

  return "";
}

function extractResponseAfter(baselineCount = 0) {
  const assistantMessages = getAssistantMessageInfo();
  if (assistantMessages.length <= baselineCount) return "";
  return extractAssistantAnswerText(
    assistantMessages[assistantMessages.length - 1].node,
  );
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
    "[role='status']",
    "[aria-live]",
    "progress",
  ];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((node) => node.remove());
  }
}

function extractAssistantThinkingText(node) {
  if (!node) return null;
  const root = node.cloneNode(true);
  root.querySelectorAll("button, [role='button']").forEach((el) => el.remove());

  const explicit = [
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking'] .markdown",
    "[class*='reasoning'] .markdown",
  ];
  for (const sel of explicit) {
    const nodes = root.querySelectorAll(sel);
    if (nodes.length > 0) {
      const text = shared.normalizeComposerText(
        nodes[nodes.length - 1].textContent || "",
      );
      if (text.length > 2) return text;
    }
  }

  const allDetails = root.querySelectorAll("details");
  for (let i = allDetails.length - 1; i >= 0; i--) {
    const el = allDetails[i];
    const summary = el.querySelector("summary");
    const summaryText = shared.normalizeComposerText(summary?.textContent || "");
    if (/thought|thinking|reason/i.test(summaryText)) {
      const full = shared.normalizeComposerText(el.textContent || "");
      const content = full.startsWith(summaryText)
        ? shared.normalizeComposerText(full.slice(summaryText.length))
        : full;
      if (content.length > 2) return content;
    }
  }

  return null;
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

function simpleHash(text) {
  let hash = 2166136261;
  const input = String(text || "");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getCurrentChatUrl() {
  return window.location.href;
}

function getCurrentChatId(url = getCurrentChatUrl()) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function removeTransientMessageNodes(root) {
  if (!root) return;
  const selectors = [
    "button",
    "[role='button']",
    "[role='status']",
    "[aria-live]",
    "[hidden]",
    "[aria-hidden='true']",
    ".sr-only",
    ".screen-reader-only",
    ".visually-hidden",
    "[class*='visually-hidden']",
    "[class*='screen-reader']",
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking']",
    "[class*='reasoning']",
    "progress",
  ];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }
}

function extractAttachmentNames(node) {
  if (!node) return [];
  const selectors = [
    "[data-testid*='file']",
    "[class*='attachment']",
    "[class*='file-pill']",
    "[aria-label*='PDF']",
    "[aria-label*='pdf']",
    "[class*='FileIcon']",
  ];
  const names = [];
  for (const selector of selectors) {
    node.querySelectorAll(selector).forEach((element) => {
      const text = shared.normalizeComposerText(
        element.getAttribute?.("aria-label") ||
          element.textContent ||
          "",
      );
      if (!text || text.length < 2) return;
      if (/^(pdf|papers?)$/i.test(text)) return;
      if (!names.includes(text)) {
        names.push(text);
      }
    });
  }
  return names;
}

function extractUserMessageText(node) {
  if (!node) return "";
  const root = node.cloneNode(true);
  removeTransientMessageNodes(root);
  const text = shared.normalizeComposerText(
    root.innerText || root.textContent || "",
  );
  return text;
}

function getConversationMessageNodes() {
  const nodes = Array.from(
    document.querySelectorAll("[data-message-author-role]"),
  );
  return nodes.filter((node) => {
    const role = node.getAttribute("data-message-author-role");
    return role === "user" || role === "assistant";
  });
}

function buildTranscriptMessageKey(node, role, index, text, attachments = []) {
  const explicit =
    node.getAttribute?.("data-message-id") ||
    node.id ||
    null;
  if (explicit) return explicit;

  const signature = [
    role,
    index,
    shared.normalizeComposerText(text).slice(0, 240),
    attachments.join("|"),
  ].join("::");
  return `${role}-${index}-${simpleHash(signature)}`;
}

function extractNormalizedMessage(node, index) {
  const role = node.getAttribute("data-message-author-role");
  if (role !== "user" && role !== "assistant") return null;

  const attachments = extractAttachmentNames(node);
  const thinking =
    role === "assistant"
      ? shared.normalizeComposerText(extractAssistantThinkingText(node) || "")
      : "";
  const text = role === "assistant"
    ? shared.normalizeComposerText(extractAssistantAnswerText(node))
    : extractUserMessageText(node);
  const cleanedText =
    role === "assistant" && shared.isPlaceholderAssistantText(text) ? "" : text;

  return {
    messageKey: buildTranscriptMessageKey(
      node,
      role,
      index,
      cleanedText || thinking,
      attachments,
    ),
    role,
    text: cleanedText,
    thinking: thinking || "",
    attachments,
  };
}

function extractConversationTranscript() {
  const nodes = getConversationMessageNodes();
  const messages = [];

  nodes.forEach((node, index) => {
    const message = extractNormalizedMessage(node, index);
    if (!message) return;
    if (
      !message.text &&
      !message.thinking &&
      (!Array.isArray(message.attachments) || message.attachments.length === 0)
    ) {
      return;
    }
    messages.push(message);
  });

  const hash = simpleHash(
    messages.map((message) => JSON.stringify(message)).join("\n"),
  );

  return {
    chatUrl: getCurrentChatUrl(),
    chatId: getCurrentChatId(),
    count: messages.length,
    hash,
    messages,
  };
}

function mapTranscriptToRelayMessages(transcript) {
  return transcript.messages.map((message) => ({
    messageKey: message.messageKey,
    role: message.role,
    text: message.text || "",
    thinking: message.thinking || undefined,
    attachments: message.attachments?.length ? message.attachments : undefined,
  }));
}

async function waitForChatReady(expectedChatUrl = null, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const normalizedExpected = normalizeUrl(expectedChatUrl);
  let lastSignature = "";
  let stableChecks = 0;

  while (Date.now() < deadline) {
    const transcript = extractConversationTranscript();
    const composerReady = Boolean(findComposerNow());
    const urlMatches =
      !normalizedExpected ||
      normalizeUrl(transcript.chatUrl) === normalizedExpected;
    const activeRun = isConversationStillRunning();
    const signature = `${transcript.hash}:${transcript.count}`;

    if (urlMatches && composerReady && !activeRun) {
      stableChecks = signature === lastSignature ? stableChecks + 1 : 1;
      lastSignature = signature;
      if (stableChecks >= 2) {
        debugLog("chat_ready", {
          chatUrl: transcript.chatUrl,
          chatId: transcript.chatId,
          count: transcript.count,
          hash: transcript.hash,
        });
        return {
          ok: true,
          ready: true,
          chatUrl: transcript.chatUrl,
          chatId: transcript.chatId,
          transcriptHash: transcript.hash,
          transcriptCount: transcript.count,
          messages: mapTranscriptToRelayMessages(transcript),
        };
      }
    } else {
      stableChecks = 0;
      lastSignature = signature;
    }

    await workerSleep(400);
  }

  const transcript = extractConversationTranscript();
  return {
    ok: false,
    ready: false,
    error: "Timed out waiting for the ChatGPT conversation to become ready.",
    chatUrl: transcript.chatUrl,
    chatId: transcript.chatId,
    transcriptHash: transcript.hash,
    transcriptCount: transcript.count,
    messages: mapTranscriptToRelayMessages(transcript),
  };
}

function findMatchingUserTurn(transcript, baselineCount, promptText) {
  const normalizedPrompt = shared.normalizeComposerText(promptText).toLowerCase();
  const candidates = transcript.messages
    .slice(Math.max(0, baselineCount))
    .filter((message) => message.role === "user");
  if (candidates.length === 0) return null;

  const exact = candidates.find(
    (message) =>
      shared.normalizeComposerText(message.text).toLowerCase() === normalizedPrompt,
  );
  if (exact) return exact;

  const contains = candidates.find((message) => {
    const normalized = shared.normalizeComposerText(message.text).toLowerCase();
    return normalized.includes(normalizedPrompt) || normalizedPrompt.includes(normalized);
  });
  if (contains) return contains;

  return candidates.length === 1 ? candidates[0] : null;
}

function resolveBoundAssistantTurn(transcript, userTurnKey, assistantTurnKey = null) {
  if (!userTurnKey) return null;
  const userIndex = transcript.messages.findIndex(
    (message) => message.messageKey === userTurnKey,
  );
  if (userIndex < 0) return null;

  if (assistantTurnKey) {
    const exact = transcript.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.messageKey === assistantTurnKey,
    );
    if (exact) return exact;
  }

  for (let index = userIndex + 1; index < transcript.messages.length; index++) {
    const message = transcript.messages[index];
    if (message.role === "assistant") {
      return message;
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
  const ready = await waitForChatReady(getCurrentChatUrl(), 15000);
  if (!ready.ok) {
    console.warn("[sync-zotero] scrapeAllMessages: page never became ready");
    return [];
  }

  const messages = ready.messages.filter(
    (message) => message.text || message.thinking,
  );
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

  if (msg.type === "WAIT_FOR_CHAT_READY") {
    waitForChatReady(msg.expectedChatUrl || null, msg.timeoutMs || 30000)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          ready: false,
          error: err?.message || "Failed to wait for ChatGPT readiness.",
        }),
      );
    return true;
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
        const baselineTranscript = extractConversationTranscript();
        const attachmentFingerprint = [
          msg.pdfFilename || "",
          Array.isArray(msg.images) ? msg.images.length : 0,
        ].join("|");

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

        await streamResponseSnapshots(
          port,
          seq,
          attempt,
          baselineTranscript,
          msg.prompt || "",
          attachmentFingerprint,
          180000,
        );

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
