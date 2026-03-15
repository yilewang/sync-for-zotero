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
// Step 1: Attach PDF
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
  for (let i = 0; i < 30; i++) {
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

async function streamResponse(onPartial, onVisibilityChange, timeoutMs = 180000) {
  const STOP_SELECTOR = '[data-testid="stop-button"]';

  // Wait up to 15s for streaming to START
  const startDeadline = Date.now() + 15000;
  while (Date.now() < startDeadline) {
    if (document.querySelector(STOP_SELECTOR)) break;
    await workerSleep(300);
  }

  // Stream partials while ChatGPT is generating
  const endDeadline = Date.now() + timeoutMs;
  while (Date.now() < endDeadline) {
    if (!document.querySelector(STOP_SELECTOR)) break;

    if (document.hidden) {
      onVisibilityChange(false);
    } else {
      onVisibilityChange(true);
      const text     = extractResponse();
      const thinking = extractThinking();
      if (text || thinking) onPartial(text, thinking);
    }

    await workerSleep(500);
  }

  // Final settle — always wait for DOM to flush after stop button disappears
  await workerSleep(1000);
}

// ---------------------------------------------------------------------------
// Step 5: Extract response as markdown
// ---------------------------------------------------------------------------

function extractResponse() {
  // Try selectors from most to least specific, covering both
  // the final rendered state and the in-progress streaming state.
  const selectors = [
    "[data-message-author-role='assistant'] .markdown",
    "[data-testid^='conversation-turn'] .markdown",
    "[data-message-author-role='assistant'] .prose",
    "[data-message-author-role='assistant'] [class*='prose']",
    ".markdown",
    // During streaming, ChatGPT may only have a plain text container
    "[data-message-author-role='assistant'] p",
    "[data-message-author-role='assistant']",
  ];

  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      const el = nodes[nodes.length - 1];
      // Skip if the element only contains the cursor/spinner
      const text = el.textContent.trim();
      if (text && text.length > 1) {
        return htmlToMarkdown(el.innerHTML);
      }
    }
  }

  return "";
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
// Main message listener
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PING handler (used by background to check if content script is alive)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") { sendResponse({ pong: true }); }
  return false;
});

// ---------------------------------------------------------------------------
// Port-based pipeline handler (streaming)
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sync-zotero") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "START") return;

    try {
      if (!msg.isFollowup) {
        await attachPDF(msg.pdfBase64, msg.pdfFilename);
      }
      await typePrompt(msg.prompt);
      await submitMessage();

      await streamResponse(
        (partialText, thinkingText) => {
          try { port.postMessage({ type: "partial", text: partialText, thinking: thinkingText ?? null }); } catch (_) {}
        },
        (isVisible) => {
          try { port.postMessage({ type: "visibility", visible: isVisible }); } catch (_) {}
        }
      );

      const finalText    = extractResponse();
      const finalThinking = extractThinking();
      port.postMessage({ type: "done", text: finalText, thinking: finalThinking ?? null });

    } catch (err) {
      try { port.postMessage({ type: "error", error: err.message }); } catch (_) {}
    }
  });
});
