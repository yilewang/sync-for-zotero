import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const shared = require("../../extension/webchat_shared.js");
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const contentSource = read("../../extension/content_script.js");
const backgroundSource = read("../../extension/background.js");
const geminiSource = read("../../extension/gemini_adapter.js");
const markup = {
  chatgpt: read("../fixtures/chatgpt-observed-dom.html") +
    '<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>',
  deepseek: '<textarea placeholder="Message DeepSeek"></textarea>',
  gemini: read("../fixtures/gemini-observed-dom.html") +
    '<input-container><div class="ql-editor" role="textbox" contenteditable="true"></div></input-container>',
};

// Exercise the worker, actual DOM readiness, and pre-submit guard together.
// Only browser navigation, relay I/O, and the send itself are mocked.
export function conversationFollowup({ target, expectedUrl, initialUrl, redirectUrl = initialUrl, beforeSend }) {
  const { window, document } = parseHTML(`<html><body>${markup[target]}</body></html>`);
  window.location = new URL(initialUrl);
  window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  let now = Date.now();
  const pageContext = vm.createContext({
    window, document, URL, console, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, Event: window.Event,
    SyncZoteroShared: shared, Date: class extends Date { static now() { return now; } },
    advanceTimer: async (ms) => { now += ms; },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {} } },
  });
  vm.runInContext(geminiSource + contentSource + "\nworkerSleep = advanceTimer;", pageContext);
  const page = { window, ...vm.runInContext(
    "({ adapter: SITE_ADAPTER, waitForChatReady, assertSubmissionConversation, extractConversationTranscript })", pageContext,
  ) };
  const errors = [], sent = [], navigations = [], reports = [];
  const tab = () => ({ id: 1, active: true, url: window.location.href });
  const context = vm.createContext({
    shared, URL, console, pipelineRunning: false, activePipelineSeq: 0, activePipelineAttempt: 0,
    activeTarget: target, activeChatTabId: 1, SUPPORTED_DELIVERY_CONTRACTS: [1], MAX_PRE_SUBMIT_RELEASES: 3,
    broadcastStatus() {}, debugLog() {},
    submitError: async (_seq, message) => errors.push(message),
    serverPost: async () => {}, reportTurnState: async (state) => reports.push(state),
    ensureTabActive: async () => tab(), ensureTabReady: async () => {}, ensureContentScript: async () => {},
    waitForTabLoad: async () => {},
    sendToContentScript: async (_id, message) => {
      assert.equal(message.type, "WAIT_FOR_CHAT_READY");
      return page.waitForChatReady(message.expectedChatUrl, message.timeoutMs);
    },
    streamPipeline: async (_id, message) => {
      beforeSend?.(page);
      page.assertSubmissionConversation(message);
      sent.push(message);
      const transcript = page.extractConversationTranscript();
      return { text: "Verified answer", runState: "done", remoteChatUrl: transcript.chatUrl, remoteChatId: transcript.chatId };
    },
    chrome: { tabs: { get: async () => tab(), update: async (_id, { url }) => {
      navigations.push(url);
      window.location = new URL(redirectUrl);
      return tab();
    } } },
  });
  const configStart = backgroundSource.indexOf("const SITE_CONFIGS =");
  const configEnd = backgroundSource.indexOf("let activeTarget =", configStart);
  const readyStart = backgroundSource.indexOf("async function waitForChatReadyInTab(");
  const readyEnd = backgroundSource.indexOf("// Keep the service worker alive", readyStart);
  const pipelineStart = backgroundSource.indexOf("async function runPipeline(");
  const pipelineEnd = backgroundSource.indexOf("async function submitError(", pipelineStart);
  vm.runInContext(backgroundSource.slice(configStart, configEnd) +
    backgroundSource.slice(readyStart, readyEnd) + backgroundSource.slice(pipelineStart, pipelineEnd), context);
  return { page, errors, sent, navigations, reports, run: (query = {}) => context.runPipeline({
    seq: 13, attempt: 1, target, delivery_contract_version: 1, prompt: "Follow up",
    expected_chat_url: expectedUrl, expected_chat_id: new URL(expectedUrl).pathname.replace(/\/$/, "").split("/").pop(), ...query,
  }) };
}
