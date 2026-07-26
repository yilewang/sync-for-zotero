import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const injectedSource = fs.readFileSync(
  path.resolve(testDir, "../extension/injected.js"),
  "utf8",
);

function createBridgeHarness() {
  const listeners = new Map();
  const postedMessages = [];
  let sendEnabled = false;

  class FakeHTMLElement {
    innerText = "";
    textContent = "";

    focus() {}

    dispatchEvent(event) {
      if (event.type !== "paste") return true;
      const nextText = event.clipboardData.getData("text/plain");
      this.innerText = nextText;
      this.textContent = nextText;
      sendEnabled = nextText.length > 0;
      event.defaultPrevented = true;
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
      listeners.set(type, listener);
    },
    getSelection() {
      return selection;
    },
    postMessage(payload) {
      postedMessages.push(payload);
    },
  };

  vm.runInNewContext(injectedSource, {
    ClipboardEvent: FakeClipboardEvent,
    DataTransfer: FakeDataTransfer,
    HTMLElement: FakeHTMLElement,
    document,
    window,
  });

  return {
    composer,
    get sendEnabled() {
      return sendEnabled;
    },
    messageListener: listeners.get("message"),
    postedMessages,
  };
}

function dispatchComposerRequest(harness, requestId, text) {
  harness.messageListener({
    data: {
      source: "sync-zotero-content",
      type: "SYNC_ZOTERO_SET_COMPOSER_TEXT",
      requestId,
      text,
    },
  });
}

test("main-world bridge applies prompt text through the editor paste transaction", () => {
  const harness = createBridgeHarness();

  dispatchComposerRequest(harness, "prompt-1", "Prompt-only message");

  assert.equal(harness.composer.innerText, "Prompt-only message");
  assert.equal(harness.sendEnabled, true);
  const result = harness.postedMessages.at(-1);
  assert.equal(result.source, "sync-zotero-page");
  assert.equal(result.type, "SYNC_ZOTERO_SET_COMPOSER_TEXT_RESULT");
  assert.equal(result.requestId, "prompt-1");
  assert.equal(result.ok, true);
  assert.equal(result.actualText, "Prompt-only message");
  assert.equal(result.error, null);
});

test("main-world bridge can clear a prior ProseMirror prompt", () => {
  const harness = createBridgeHarness();

  dispatchComposerRequest(harness, "prompt-1", "Prior prompt");
  dispatchComposerRequest(harness, "prompt-2", "");

  assert.equal(harness.composer.innerText, "");
  assert.equal(harness.sendEnabled, false);
  assert.equal(harness.postedMessages.at(-1).requestId, "prompt-2");
  assert.equal(harness.postedMessages.at(-1).ok, true);
});
