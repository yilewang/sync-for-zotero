import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");
const injectedSource = fs.readFileSync(
  path.resolve(testDir, "../extension/injected.js"),
  "utf8",
);
const contentScriptSource = fs.readFileSync(
  path.resolve(testDir, "../extension/content_script.js"),
  "utf8",
);

const setComposerRequestType = "SYNC_ZOTERO_SET_COMPOSER_TEXT_V2";
const setComposerResultType = "SYNC_ZOTERO_SET_COMPOSER_TEXT_RESULT_V2";

function createBridgeHarness({
  bridgeSettleTimeoutMs = null,
  existingV1Listener = false,
  pasteDelayMs = 0,
  pasteTransform = (text) => text,
} = {}) {
  const listeners = new Map();
  const postedMessages = [];
  let sendEnabled = false;
  let pasteDispatchCount = 0;

  class FakeHTMLElement {
    innerText = "";
    textContent = "";

    focus() {}

    dispatchEvent(event) {
      if (event.type !== "paste") return true;
      pasteDispatchCount += 1;
      const nextText = pasteTransform(
        event.clipboardData.getData("text/plain"),
      );
      event.defaultPrevented = true;
      const applyPaste = () => {
        this.innerText = nextText;
        this.textContent = nextText;
        sendEnabled = nextText.length > 0;
      };
      if (pasteDelayMs > 0) {
        setTimeout(applyPaste, pasteDelayMs);
      } else {
        applyPaste();
      }
      return false;
    }
  }

  class FakeDataTransfer {
    values = new Map();

    setData(type, value) {
      this.values.set(type, String(value));
    }

    getData(type) {
      return this.values.get(type) || "";
    }
  }

  class FakeClipboardEvent {
    constructor(type, init) {
      this.type = type;
      this.clipboardData = init.clipboardData;
      this.defaultPrevented = false;
    }
  }

  const composer = new FakeHTMLElement();
  const selection = {
    removeAllRanges() {},
    addRange() {},
  };
  const document = {
    querySelector(selector) {
      return selector === "#prompt-textarea" ? composer : null;
    },
    createRange() {
      return {
        selectNodeContents() {},
      };
    },
  };
  const window = {
    __syncZoteroFetchPatched: 4,
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    getSelection() {
      return selection;
    },
    postMessage(payload) {
      postedMessages.push(payload);
    },
  };

  if (existingV1Listener) {
    window.__syncZoteroComposerBridgeVersion = 1;
    window.addEventListener("message", (event) => {
      const payload = event.data;
      if (payload?.type !== "SYNC_ZOTERO_SET_COMPOSER_TEXT") return;
      window.postMessage({
        source: "sync-zotero-page",
        type: "SYNC_ZOTERO_SET_COMPOSER_TEXT_RESULT",
        requestId: payload.requestId,
        ok: false,
      });
    });
  }

  const harnessSource = bridgeSettleTimeoutMs == null
    ? injectedSource
    : injectedSource.replace(
      "const COMPOSER_BRIDGE_SETTLE_TIMEOUT_MS = 750;",
      `const COMPOSER_BRIDGE_SETTLE_TIMEOUT_MS = ${bridgeSettleTimeoutMs};`,
    );

  vm.runInNewContext(harnessSource, {
    ClipboardEvent: FakeClipboardEvent,
    DataTransfer: FakeDataTransfer,
    HTMLElement: FakeHTMLElement,
    clearTimeout,
    document,
    setTimeout,
    window,
  });

  return {
    composer,
    get sendEnabled() {
      return sendEnabled;
    },
    get pasteDispatchCount() {
      return pasteDispatchCount;
    },
    messageListeners: listeners.get("message") || [],
    postedMessages,
  };
}

async function dispatchComposerRequest(harness, requestId, text) {
  const event = {
    data: {
      source: "sync-zotero-content",
      type: setComposerRequestType,
      requestId,
      text,
    },
  };
  await Promise.all(
    harness.messageListeners.map((listener) => listener(event)),
  );
}

async function applyThroughContentPolicy(harness, requestId, text) {
  await dispatchComposerRequest(harness, requestId, text);
  const pageResult = harness.postedMessages.findLast(
    (message) =>
      message.type === setComposerResultType &&
      message.requestId === requestId,
  );
  const bridgeResult = {
    handled: Boolean(pageResult),
    applied: pageResult?.ok === true,
    pasteAccepted: pageResult?.pasteAccepted === true,
  };
  const transition = shared.composerBridgeWriteTransition(bridgeResult);
  const verificationPolicy = shared.composerPromptVerificationPolicy(
    transition.pendingBridgeCommit,
  );
  let fallbackCount = 0;
  let retryCount = 0;
  if (transition.allowSynchronousFallback) {
    fallbackCount += 1;
    harness.composer.innerText += text;
    harness.composer.textContent += text;
  }

  const deadline = Date.now() + 250;
  while (
    !shared.composerTextMatchesPrompt(text, harness.composer.innerText) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (
    !shared.composerTextMatchesPrompt(text, harness.composer.innerText) &&
    verificationPolicy.allowRetry
  ) {
    retryCount += 1;
  }
  return {
    bridgeResult,
    transition,
    verificationPolicy,
    fallbackCount,
    retryCount,
  };
}

test("main-world bridge applies prompt text through the editor paste transaction", async () => {
  const harness = createBridgeHarness();

  await dispatchComposerRequest(harness, "prompt-1", "Prompt-only message");

  assert.equal(harness.composer.innerText, "Prompt-only message");
  assert.equal(harness.sendEnabled, true);
  const result = harness.postedMessages.at(-1);
  assert.equal(result.source, "sync-zotero-page");
  assert.equal(result.type, setComposerResultType);
  assert.equal(result.requestId, "prompt-1");
  assert.equal(result.ok, true);
  assert.equal(result.pasteAccepted, true);
  assert.equal(result.actualText, "Prompt-only message");
  assert.equal(result.error, null);
});

test("main-world bridge can clear a prior ProseMirror prompt", async () => {
  const harness = createBridgeHarness();

  await dispatchComposerRequest(harness, "prompt-1", "Prior prompt");
  await dispatchComposerRequest(harness, "prompt-2", "");

  assert.equal(harness.composer.innerText, "");
  assert.equal(harness.sendEnabled, false);
  assert.equal(harness.postedMessages.at(-1).requestId, "prompt-2");
  assert.equal(harness.postedMessages.at(-1).ok, true);
});

test("main-world bridge waits for an asynchronous ProseMirror paste transaction", async () => {
  const harness = createBridgeHarness({ pasteDelayMs: 40 });

  await dispatchComposerRequest(harness, "prompt-async", "Delayed prompt");

  assert.equal(harness.composer.innerText, "Delayed prompt");
  assert.equal(harness.pasteDispatchCount, 1);
  assert.equal(harness.postedMessages.at(-1).ok, true);
  assert.equal(harness.postedMessages.at(-1).actualText, "Delayed prompt");
});

test("main-world bridge accepts ProseMirror paragraph whitespace changes", async () => {
  const harness = createBridgeHarness({
    pasteTransform: (text) => text.replace(/\n+/g, "\n"),
  });

  await dispatchComposerRequest(
    harness,
    "prompt-paragraphs",
    "First paragraph\n\nSecond paragraph",
  );

  assert.equal(
    harness.composer.innerText,
    "First paragraph\nSecond paragraph",
  );
  assert.equal(harness.postedMessages.at(-1).ok, true);
});

test("content script replaces a contenteditable prompt in one transaction", () => {
  assert.doesNotMatch(
    contentScriptSource,
    /await setContentEditableText\(composer, ""\);/,
  );
  assert.match(
    contentScriptSource,
    /await setContentEditableText\(composer, promptText\);/,
  );
  assert.match(
    contentScriptSource,
    /composerBridgeWriteTransition\(bridgeResult\)/,
  );
  assert.match(
    contentScriptSource,
    /composerPromptVerificationPolicy\(\s*pendingBridgeCommit/,
  );
});

test("late accepted paste neither falls back nor retries with a stale V1 listener", async () => {
  const harness = createBridgeHarness({
    bridgeSettleTimeoutMs: 30,
    existingV1Listener: true,
    pasteDelayMs: 60,
  });

  const result = await applyThroughContentPolicy(
    harness,
    "prompt-late-v2",
    "Late prompt",
  );

  assert.equal(result.bridgeResult.applied, false);
  assert.equal(result.bridgeResult.pasteAccepted, true);
  assert.deepEqual(result.transition, {
    allowSynchronousFallback: false,
    pendingBridgeCommit: true,
  });
  assert.deepEqual(result.verificationPolicy, {
    matchTimeoutMs: 10000,
    allowRetry: false,
  });
  assert.equal(result.fallbackCount, 0);
  assert.equal(result.retryCount, 0);
  assert.equal(harness.pasteDispatchCount, 1);
  assert.equal(harness.composer.innerText, "Late prompt");
  assert.deepEqual(
    harness.postedMessages.map((message) => message.type),
    [setComposerResultType],
  );
});

test("unknown bridge timeout cannot fall back or retry", () => {
  const transition = shared.composerBridgeWriteTransition({
    handled: false,
    applied: false,
    pasteAccepted: false,
    timedOut: true,
  });
  const verificationPolicy = shared.composerPromptVerificationPolicy(
    transition.pendingBridgeCommit,
  );

  assert.deepEqual(transition, {
    allowSynchronousFallback: false,
    pendingBridgeCommit: true,
  });
  assert.deepEqual(verificationPolicy, {
    matchTimeoutMs: 10000,
    allowRetry: false,
  });
});

test("explicitly unhandled paste keeps synchronous fallback and retry", () => {
  const transition = shared.composerBridgeWriteTransition({
    handled: true,
    applied: false,
    pasteAccepted: false,
  });
  const verificationPolicy = shared.composerPromptVerificationPolicy(
    transition.pendingBridgeCommit,
  );

  assert.deepEqual(transition, {
    allowSynchronousFallback: true,
    pendingBridgeCommit: false,
  });
  assert.deepEqual(verificationPolicy, {
    matchTimeoutMs: 300,
    allowRetry: true,
  });
});
