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
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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
// Step 1c: Select ChatGPT model / thinking mode
// ---------------------------------------------------------------------------

/**
 * Switch ChatGPT's model and thinking effort before sending a message.
 *
 * Supported modes:
 *   "instant"           → Select "Instant" (fast, no thinking)
 *   "thinking_standard"  → Select "Thinking" + "Standard" effort
 *   "thinking_extended"  → Select "Thinking" + "Extended" effort
 *
 * Skips if mode is null/undefined (leave whatever the user already has).
 */
async function selectChatGPTMode(mode) {
  if (!mode) return;

  // --- Step 1: Open the model selector dropdown ---
  // The model selector is typically a button containing the model name ("ChatGPT")
  // near the top-left of the page, or inside the composer area.
  const modelBtnSelectors = [
    'button[data-testid="model-selector"]',
    'button[aria-haspopup="menu"][class*="model"]',
    // Fallback: look for a button containing "ChatGPT" or "GPT" text near top
    ...Array.from(document.querySelectorAll('main button[aria-haspopup]'))
      .filter(b => /chatgpt|gpt-|model/i.test(b.textContent + " " + (b.getAttribute("aria-label") || "")))
      .map(() => null), // just for iteration, we'll handle below
  ];

  let modelBtn = null;
  for (const sel of modelBtnSelectors) {
    if (!sel) continue;
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
    console.warn("[sync-zotero] Could not find ChatGPT model selector button");
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
    // Close menu by pressing Escape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    return;
  }

  // --- Step 3: If thinking mode, set the effort level ---
  if (wantThinking) {
    const effort = mode === "thinking_extended" ? "extended" : "standard";

    // The thinking effort selector may appear as a pill/chip near the composer
    // ("Extended thinking ▾") or as part of the model menu
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

      // Select the effort level from the sub-menu
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

  // Close any remaining open menus
  await sleep(200);
}

// ---------------------------------------------------------------------------
// Step 2: Type prompt
// ---------------------------------------------------------------------------

async function typePrompt(promptText) {
  // ChatGPT's composer is a <div contenteditable> or <textarea>
  // Try contenteditable first (current ChatGPT), fall back to textarea
  let composer = document.querySelector("#prompt-textarea");
  if (!composer) {
    composer = await waitForElement("[data-testid='text-input']", 8000).catch(() => null);
  }
  if (!composer) {
    composer = await waitForElement("textarea", 5000);
  }

  composer.focus();

  if (composer.tagName === "TEXTAREA") {
    setNativeValue(composer, promptText);
  } else {
    // contenteditable div — use execCommand for React compat
    composer.innerHTML = "";
    document.execCommand("insertText", false, promptText);
  }

  await sleep(500);
}

// ---------------------------------------------------------------------------
// Step 3: Submit
// ---------------------------------------------------------------------------

function findSendButton() {
  return (
    document.querySelector("button[data-testid='send-button']") ||
    document.querySelector("button[aria-label='Send message']") ||
    document.querySelector("button[aria-label='Send prompt']") ||
    document.querySelector("button[type='submit']") ||
    [...document.querySelectorAll("form button")].at(-1) ||
    null
  );
}

async function submitMessage() {
  // Wait for the send button to exist AND not be disabled
  // (ChatGPT disables it while the uploaded file is being processed)
  let sendBtn = null;
  // Wait up to 120 seconds — PDF uploads to ChatGPT can take a while
  for (let i = 0; i < 240; i++) {
    const btn = findSendButton();
    if (btn && !btn.disabled && !btn.hasAttribute("disabled")) {
      sendBtn = btn;
      break;
    }
    await sleep(500);
  }

  if (!sendBtn) throw new Error("Send button never became enabled");

  sendBtn.click();
  await sleep(500);
}

// ---------------------------------------------------------------------------
// SSE interception listener (receives data from injected.js in MAIN world)
// ---------------------------------------------------------------------------

let sseText = "";
let sseThinking = null;
let sseDone = false;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "SYNC_ZOTERO_SSE") return;
  sseText = event.data.text || "";
  sseThinking = event.data.thinking || null;
  sseDone = event.data.done || false;
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

async function streamResponse(onPartial, onVisibilityChange, timeoutMs = 180000) {
  // Reset SSE state for this new response
  sseText = "";
  sseThinking = null;
  sseDone = false;

  // Snapshot: count existing assistant messages BEFORE the new response arrives.
  const baselineCount = document.querySelectorAll(
    "[data-message-author-role='assistant']"
  ).length;

  // --- Phase 1: Wait for streaming to START ---
  // Signals: stop button appears, SSE data arrives, or new assistant DOM message
  const startDeadline = Date.now() + 15000;
  let streamStarted = false;
  while (Date.now() < startDeadline) {
    if (findStopButton()) { streamStarted = true; break; }
    if (sseText.length > 0) { streamStarted = true; break; }
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

  // --- Phase 2: Stream partials while ChatGPT is generating ---
  const endDeadline = Date.now() + timeoutMs;
  let lastSentText = "";
  let stableChecks = 0;
  const STABLE_WITH_BUTTON_GONE = 2;   // 2 × 500ms = 1s
  const STABLE_WITHOUT_BUTTON   = 6;   // 6 × 500ms = 3s

  while (Date.now() < endDeadline) {
    const stopBtn = findStopButton();

    // --- Get text: prefer SSE (network-level), fall back to DOM ---
    // SSE works even when tab is hidden!
    let text = sseText;
    let thinking = sseThinking;

    if (!text && !document.hidden) {
      // DOM fallback only when SSE not providing data
      text = extractResponseAfter(baselineCount);
      if (!thinking) thinking = extractThinking();
    }

    // Emit partial if text changed
    if (text && text !== lastSentText) {
      onPartial(text, thinking);
      lastSentText = text;
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
    // Primary: SSE stream sent [DONE] — emit final text before breaking
    if (sseDone) {
      // Ensure we emit the very last SSE text (it may have arrived with the done flag)
      if (sseText && sseText !== lastSentText) {
        onPartial(sseText, sseThinking);
        lastSentText = sseText;
      }
      if (lastSentText.length > 0) break;
    }
    // Secondary: stop button gone + content stable for 1s
    if (streamStarted && !stopBtn && stableChecks >= STABLE_WITH_BUTTON_GONE && lastSentText.length > 0) break;
    // Tertiary: no stop button + content stable for 3s
    if (!stopBtn && stableChecks >= STABLE_WITHOUT_BUTTON && lastSentText.length > 0) break;

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
    "div[data-message-id]",
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
    const el = latestAssistant.querySelector(sel);
    if (el) {
      const text = el.textContent.trim();
      if (text && text.length > 1) {
        return htmlToMarkdown(el.innerHTML);
      }
    }
  }

  // Ultimate fallback: use innerText on the entire container
  const text = latestAssistant.innerText?.trim() || latestAssistant.textContent?.trim();
  if (text && text.length > 1) return text;

  return "";
}

/** Extract the last assistant response (used for final extraction after streaming). */
function extractResponse() {
  return extractResponseAfter(0);
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
  // Wait a moment for the page to fully render
  await sleep(1000);

  const messages = [];

  // Try multiple selectors for message containers
  const MSG_SELECTORS = [
    "[data-message-author-role]",
    "article[data-testid]",
    "div[data-message-id]",
  ];

  let msgElements = [];
  for (const sel of MSG_SELECTORS) {
    msgElements = Array.from(document.querySelectorAll(sel));
    if (msgElements.length > 0) break;
  }

  for (const el of msgElements) {
    const role = el.getAttribute("data-message-author-role") || "";

    // Skip system/tool messages
    if (role !== "user" && role !== "assistant") continue;

    // Extract text content
    let text = "";
    if (role === "assistant") {
      // Try structured content selectors
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
      // Fallback
      if (!text) {
        text = el.innerText?.trim() || el.textContent?.trim() || "";
      }
    } else {
      // User messages: just get text content
      text = el.innerText?.trim() || el.textContent?.trim() || "";
    }

    if (text) {
      messages.push({
        role: role === "assistant" ? "bot" : "user",
        text,
      });
    }
  }

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

  // [webchat] Scrape all messages from the current ChatGPT conversation
  if (msg.type === "SCRAPE_MESSAGES") {
    scrapeAllMessages()
      .then((messages) => sendResponse({ ok: true, messages }))
      .catch((err) => sendResponse({ ok: false, error: err.message, messages: [] }));
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

      try {
        // Snapshot existing assistant messages before we start, so we only
        // extract the NEW response (not previous ones in a follow-up).
        const baselineCount = document.querySelectorAll(
          "[data-message-author-role='assistant']"
        ).length;

        if (!msg.isFollowup) {
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
        // Switch ChatGPT model/thinking mode if requested
        if (msg.chatgptMode) {
          await selectChatGPTMode(msg.chatgptMode);
        }
        await typePrompt(msg.prompt);
        await submitMessage();

        await streamResponse(
          (partialText, thinkingText) => {
            try { port.postMessage({ type: "partial", seq, text: partialText, thinking: thinkingText ?? null }); } catch (_) {}
          },
          (isVisible) => {
            try { port.postMessage({ type: "visibility", visible: isVisible }); } catch (_) {}
          }
        );

        // Final response: prefer SSE text (most reliable), fall back to DOM
        const finalText = sseText || extractResponseAfter(baselineCount);
        const finalThinking = sseThinking || extractThinking();
        port.postMessage({ type: "done", seq, text: finalText, thinking: finalThinking ?? null });

      } catch (err) {
        try { port.postMessage({ type: "error", seq, error: err.message }); } catch (_) {}
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
