import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const shared = require("../extension/webchat_shared.js");
const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const contentSource = read("../extension/content_script.js");
const backgroundSource = read("../extension/background.js");
const chatUrl = "https://gemini.google.com/app/d11114e59cd9e350";

// Reduced observed Gemini HTML: source lives in data-math, not MathML.
const inlineMath = '<span class="math-inline" data-math="\\mu"><span class="katex"><span class="katex-html" aria-hidden="true">μ</span></span></span>';

function content(html = "", url = chatUrl) {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.location = new URL(url);
  window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  const listeners = [];
  const sentMessages = [];
  const context = vm.createContext({
    window, document, URL, console, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event, SyncZoteroShared: shared,
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } },
      onConnect: { addListener() {} }, sendMessage(message) { sentMessages.push(message); } } },
  });
  const adapterPath = new URL("../extension/gemini_adapter.js", import.meta.url);
  if (fs.existsSync(adapterPath)) vm.runInContext(fs.readFileSync(adapterPath, "utf8"), context);
  vm.runInContext(contentSource, context);
  const api = vm.runInContext(`({ adapter: SITE_ADAPTER, extractConversationTranscript,
    prepareRichOutput: typeof prepareRichOutput === "function" ? prepareRichOutput : null,
    extractFullConversationTranscript, findStopButton, collectHealthStatus, collectHistoryEntries, scrapeHistory,
    collectVisibleComposerPdfCardEvidence, resolveBoundAssistantTurn,
    findMatchingUserTurn, hasResponseActionBar, attachPDF, submitMessageAndVerify, streamResponseSnapshots, workerSleep,
    assertSubmissionConversation: typeof assertSubmissionConversation === "function" ? assertSubmissionConversation : null })`, context);
  return { ...api, document, context, listeners, sentMessages };
}

test("Gemini opens the usable sidebar control and waits for delayed history links", async () => {
  const page = content('<button aria-label="Open sidebar" disabled></button><button id="toggle" aria-label="Open sidebar"></button><bard-sidenav></bard-sidenav>');
  let clicks = 0;
  let elapsed = 0;
  page.document.querySelector('#toggle').addEventListener('click', () => { clicks++; });
  const ready = await page.adapter.prepareHistory({
    timeoutMs: 1000, now: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
      if (elapsed >= 400) page.document.querySelector('bard-sidenav').innerHTML = '<a href="/app/d11114e59cd9e350">Old chat</a>';
    },
  });
  assert.equal(ready, true);
  assert.equal(clicks, 1);
  assert.equal(page.collectHistoryEntries().length, 1);
  assert.ok(elapsed >= 400);
});

test("Gemini leaves an already populated sidebar untouched", async () => {
  const page = content('<button aria-label="Open sidebar"></button><bard-sidenav><a href="/app/d11114e59cd9e350">Old chat</a></bard-sidenav>');
  page.document.querySelector('button').addEventListener('click', () => assert.fail('must not toggle'));
  assert.equal(await page.adapter.prepareHistory({ wait: async () => assert.fail('must not wait') }), true);
});

test("Gemini history readiness times out when only answer-body links exist", async () => {
  const page = content('<model-response><a href="/app/d11114e59cd9e350">Not history</a></model-response>');
  let elapsed = 0;
  assert.equal(await page.adapter.prepareHistory({ timeoutMs: 400, now: () => elapsed, wait: async (ms) => { elapsed += ms; } }), false);
  assert.equal(elapsed, 400);
});

test("Gemini history scrape reports timeout rather than an empty account when the sidebar never loads", async () => {
  const page = content('<bard-sidenav></bard-sidenav>');
  const result = await page.scrapeHistory({ force: true, timeoutMs: 1 });
  assert.equal(result.status, "timeout");
  assert.equal(result.history.length, 0);
  const update = page.sentMessages.find((message) => message.type === "HISTORY_UPDATE");
  assert.equal(update.status, "timeout");
  assert.equal(update.history.length, 0);
});

test("Gemini history scrape opens the sidebar before collecting sessions", async () => {
  const page = content('<button aria-label="Open sidebar"></button><bard-sidenav></bard-sidenav>');
  page.document.querySelector('button').addEventListener('click', () => {
    page.document.querySelector('bard-sidenav').innerHTML = '<a href="/app/d11114e59cd9e350">Old chat</a>';
  });
  const result = await page.scrapeHistory({ force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].title, "Old chat");
});

test("Gemini preserves inline data-math in sentences and table cells without duplicate glyphs", () => {
  const page = content(`<model-response><message-content><div class="markdown"><p>The mean is ${inlineMath}.</p><table><tr><th>Symbol</th></tr><tr><td>${inlineMath}</td></tr></table></div></message-content></model-response>`);
  const answer = page.adapter.extractAssistantAnswerText(page.document.querySelector("model-response"));
  assert.match(answer, /The mean is \$\\mu\$\./);
  assert.match(answer, /\| \$\\mu\$ \|/);
  assert.ok(!answer.includes("μ"));
  assert.equal(page.document.querySelectorAll("[aria-hidden=true]").length, 2, "extraction must not mutate live DOM");
});

test("Gemini preserves display data-math as a single display equation", () => {
  const page = content('<model-response><message-content><div class="markdown"><div class="math-block" data-math="f(x)=x^2"><span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true">glyphs</span></span></span></div></div></message-content></model-response>');
  assert.equal(page.adapter.extractAssistantAnswerText(page.document.querySelector("model-response")), "$$f(x)=x^2$$");
});

for (const { name, badge } of [
  { name: "single PDF", badge: '<button aria-label="View source details for citation from PDF: proof.pdf. Press Enter to open sources dialog."><span>PDF</span></button>' },
  { name: "repeated PDFs", badge: '<button aria-label="View source details for citations from PDF: proof.pdf, PDF: proof.pdf, PDF: proof.pdf, and others. Press Enter to open sources dialog."><span>PDF + 3</span></button>' },
  { name: "localized document", badge: '<button aria-label="查看文档来源"><span>文档</span></button>' },
  { name: "image without an accessible label", badge: '<span>Image: figure.png</span>' },
  { name: "internal source link", badge: '<a href="#source-1">Uploaded document</a>' },
  { name: "file source link", badge: '<a href="file:///proof.pdf">PDF: proof.pdf</a>' },
  { name: "blob source link", badge: '<a href="blob:https://gemini.google.com/proof">PDF</a>' },
]) {
  test(`Gemini omits ${name} badges from answers and synced history`, () => {
    const page = content(`<div class="conversation-container" id="turn-1"><model-response><message-content><div class="markdown"><p>Value 952<source-inline-chip><div class="source-inline-chip-container">${badge}</div></source-inline-chip>.</p><p>The PDF proof.pdf reports this value [1].</p></div></message-content></model-response></div>`);
    const original = page.document.querySelector('model-response').innerHTML;
    const expected = 'Value 952.\n\nThe PDF proof.pdf reports this value [1].';
    assert.equal(page.adapter.extractAssistantAnswerText(page.document.querySelector('model-response')), expected);
    assert.equal(page.extractConversationTranscript().messages[0].text, expected);
    assert.equal(page.document.querySelector('model-response').innerHTML, original, 'capture must not change the Gemini page');
  });
}

test("Gemini retains only HTTP and HTTPS links from a mixed source badge", () => {
  const page = content('<model-response><message-content><div class="markdown"><p>Result<source-inline-chip><div class="source-inline-chip-container"><button aria-label="PDF: proof.pdf">PDF + 2</button><a href="https://example.com/paper">Paper</a><a href="file:///proof.pdf">Local PDF</a><a href="http://example.com/archive">Archive</a></div></source-inline-chip>.</p></div></message-content></model-response>');
  assert.equal(page.adapter.extractAssistantAnswerText(page.document.querySelector('model-response')), 'Result [[Paper](https://example.com/paper); [Archive](http://example.com/archive)].');
});

test("Gemini preserves web sources outside Markdown without including response controls", () => {
  const page = content('<model-response><message-content><div class="markdown"><p>Read the documentation.</p></div></message-content><div class="response-footer complete"><sources-list><a href="https://www.zotero.org/support/pdf_reader">Zotero PDF reader</a></sources-list><button>Copy response</button></div></model-response>');
  const answer = page.adapter.extractAssistantAnswerText(page.document.querySelector("model-response"));
  assert.match(answer, /\[Zotero PDF reader\]\(https:\/\/www\.zotero\.org\/support\/pdf_reader\)/);
  assert.ok(!answer.includes('Copy response'));
});

test("Gemini retains a source list inside the Markdown owner exactly once", () => {
  const page = content('<model-response><message-content><div class="markdown"><p>Result.</p><sources-list><a href="https://example.com/source">Source</a><button>More</button></sources-list></div></message-content></model-response>');
  const answer = page.adapter.extractAssistantAnswerText(page.document.querySelector("model-response"));
  assert.equal(answer.match(/https:\/\/example\.com\/source/g)?.length, 1);
  assert.ok(!answer.includes('More'));
});

test("Gemini retains ordinary web links and source-chip links only once", () => {
  const page = content('<model-response><message-content><div class="markdown"><p><a href="https://example.com/ordinary">Ordinary link</a><source-inline-chip><div class="source-inline-chip-container"><a href="https://example.com/paper">Paper</a></div></source-inline-chip></p></div></message-content></model-response>');
  const answer = page.adapter.extractAssistantAnswerText(page.document.querySelector("model-response"));
  assert.match(answer, /\[Ordinary link\]\(https:\/\/example\.com\/ordinary\)/);
  assert.equal(answer.match(/https:\/\/example\.com\/paper/g)?.length, 1);
});

test("Gemini history excludes matching response links and other page navigation", () => {
  const page = content('<bard-sidenav role="navigation"><a href="/app/d11114e59cd9e350">Real history</a></bard-sidenav><model-response><nav><a href="/app/2222222222222222">Example conversation</a></nav></model-response><nav><a href="/app/3333333333333333">Other navigation</a></nav>');
  assert.deepEqual(JSON.parse(JSON.stringify(page.collectHistoryEntries())), [{id:"d11114e59cd9e350", title:"Real history", chatUrl}]);
});

for (const { name, pdf, images, requestedImages, ok } of [
  { name: "missing image", pdf: false, images: 0, requestedImages: 1, ok: false },
  { name: "PDF without requested image", pdf: true, images: 0, requestedImages: 1, ok: false },
  { name: "image on prompt-only turn", pdf: false, images: 1, requestedImages: 0, ok: false },
  { name: "PDF and image", pdf: true, images: 1, requestedImages: 1, ok: true },
  { name: "image only", pdf: false, images: 1, requestedImages: 1, ok: true },
  { name: "prompt only", pdf: false, images: 0, requestedImages: 0, ok: true },
]) {
  test(`Gemini production tracker validates complete requested attachments: ${name}`, async () => {
    const page = content();
    const baseline = page.extractConversationTranscript();
    const file = pdf ? '<div data-test-id="uploaded-file"><span data-test-id="filename-label">proof</span><span class="extension-label">PDF</span></div>' : '';
    const image = '<img data-test-id="uploaded-img" src="data:image/png;base64,AA==">'.repeat(images);
    page.document.body.innerHTML = `<div class="conversation-container" id="receipt"><user-query><div class="query-text-line">Read this test.</div><user-query-file-preview>${file}${image}</user-query-file-preview></user-query><model-response><message-content><div class="markdown" aria-busy="false">Test result.</div></message-content><div class="response-footer complete"></div></model-response></div>`;
    let now = Date.now();
    page.context.Date = class extends Date { static now() { return now; } };
    page.context.advanceTimer = async (ms) => { now += ms; };
    vm.runInContext("workerSleep = advanceTimer", page.context);
    const events = [];
    const run = () => page.streamResponseSnapshots({ postMessage: event => events.push(event) }, 55, 1, baseline, "Read this test.", `${pdf ? 'proof.pdf' : ''}|${requestedImages}`, {}, 20000);
    if (ok) {
      await run();
      assert.equal(events.find(e => e.type === 'terminal')?.diagnostic.reasonCode, 'verified_done');
    } else {
      await assert.rejects(run, /attachment|image|PDF/i);
      assert.ok(!events.some(e => e.type === 'terminal' && e.diagnostic?.reasonCode === 'verified_done'));
    }
  });
}

test("Gemini URL normalization strips transient parameters only on exact HTTPS conversation routes", () => {
  assert.equal(shared.normalizeConversationUrl(`${chatUrl}?hl=en#reply`), chatUrl);
  assert.equal(typeof shared.resolveExpectedConversationBinding, "function");
  for (const url of ["http://gemini.google.com/app/d11114e59cd9e350",
    "https://gemini.google.com.evil.test/app/d11114e59cd9e350",
    "https://gemini.google.com/app/not-a-conversation", `${chatUrl}/other`]) {
    assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: url }, "gemini"), /conversation|binding/i);
  }
  assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: chatUrl, expected_chat_id: "aaaaaaaaaaaaaaaa" }, "gemini"), /binding|match/i);
  assert.deepEqual(shared.resolveExpectedConversationBinding({ expected_chat_url: chatUrl, expected_chat_id: "d11114e59cd9e350" }, "gemini"), { chatUrl, chatId: "d11114e59cd9e350" });
  assert.deepEqual(shared.resolveExpectedConversationBinding({ force_new_chat: true, expected_chat_url: chatUrl }, "gemini"), { chatUrl: null, chatId: null });
});

test("routing rejects unknown targets and lookalike hosts", () => {
  const start = backgroundSource.indexOf("const SITE_CONFIGS =");
  const end = backgroundSource.indexOf("let activeTarget =", start);
  const api = vm.runInNewContext(`${backgroundSource.slice(start, end)}; ({ getSiteConfig, getSiteConfigByUrl })`, { URL });
  assert.equal(api.getSiteConfig("gemini").homeUrl, "https://gemini.google.com/app");
  assert.throws(() => api.getSiteConfig("unknown"), /unsupported/i);
  assert.equal(api.getSiteConfigByUrl("https://chatgpt.com.evil.test/c/123"), null);
  assert.equal(api.getSiteConfigByUrl("http://gemini.google.com/app"), null);
  assert.equal(api.getSiteConfigByUrl(chatUrl).siteId, "gemini");
});

test("DOM readiness advertises Gemini honestly with no network hook", async () => {
  const page = content(read("fixtures/gemini-observed-dom.html"));
  assert.equal(page.adapter?.siteId, "gemini");
  const health = await page.collectHealthStatus();
  assert.equal(health.composerFound, true);
  assert.equal(health.contentScriptAlive, true);
  assert.equal(health.networkHookActive, false);
  assert.equal(health.mainWorldInjected, false);
  assert.equal(health.answerCapture, "dom");
  const status = shared.buildExtensionStatusReport({ chatTabAlive: true, chatUrl, targetSiteId: "gemini", health });
  assert.ok(status.supportedTargets.includes("gemini"));
  assert.equal(status.answerCapture, "dom");
  page.document.querySelector(".ql-editor").remove();
  assert.equal((await page.collectHealthStatus()).composerFound, false);
});

test("observed PDF turn extracts clean Markdown and stable role-specific keys during streaming", () => {
  const page = content(read("fixtures/gemini-pdf-turn.html"));
  const initial = page.extractConversationTranscript();
  assert.equal(initial.messages.length, 2);
  const [user, assistant] = initial.messages;
  assert.ok(!user.text.includes("You said"));
  assert.deepEqual(Array.from(user.attachments), ["gemini-proof.pdf"]);
  assert.match(assistant.text, /GEMINI-PDF-73B9/);
  assert.match(assistant.text, /Cedar/);
  assert.equal(assistant.text, 'Based on the "gemini-proof.pdf" file you provided, here is the extracted information:\n\n- **Secret marker:** GEMINI-PDF-73B9\n- **Fictional method name:** Cedar');
  assert.notEqual(user.messageKey, assistant.messageKey);
  page.document.querySelector("message-content .markdown").innerHTML = '<p>Growing <strong>answer</strong> <a href="https://example.com">link</a></p><ul><li>item</li></ul>';
  const next = page.extractConversationTranscript();
  assert.equal(next.messages[1].messageKey, assistant.messageKey);
  assert.match(next.messages[1].text, /\*\*answer\*\*/);
  assert.match(next.messages[1].text, /\[link\]\(https:\/\/example.com\)/);
});

test("previous footer never completes the submitted Gemini turn", () => {
  const page = content(read("fixtures/gemini-pdf-turn.html"));
  const old = page.extractConversationTranscript();
  page.document.body.insertAdjacentHTML("beforeend", '<div class="conversation-container" id="new-turn"><user-query><div class="query-text-line">new prompt</div></user-query><model-response><message-content><div class="markdown" aria-busy="true">New answer</div></message-content></model-response></div>');
  const transcript = page.extractConversationTranscript();
  const user = page.findMatchingUserTurn(transcript, old.count, "new prompt", old.messages);
  assert.ok(user);
  const assistant = page.resolveBoundAssistantTurn(transcript, user.messageKey);
  assert.equal(assistant.text, "New answer");
  assert.equal(page.hasResponseActionBar(assistant.messageKey), false);
  page.document.querySelector("#new-turn .markdown").setAttribute("aria-busy", "false");
  page.document.querySelector("#new-turn model-response").insertAdjacentHTML("beforeend", '<div class="response-footer complete"></div>');
  assert.equal(page.hasResponseActionBar(assistant.messageKey), true);
  assert.equal(page.hasResponseActionBar("missing-current-turn"), false);
});

test("composer PDF cards require settled readiness and never count historical or empty wrappers", () => {
  const page = content(read("fixtures/gemini-upload-ready.html") + read("fixtures/gemini-pdf-turn.html"));
  assert.equal(typeof page.adapter?.getComposerAttachments, "function");
  let cards = page.adapter.getComposerAttachments();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].filename, "gemini-proof.pdf");
  assert.equal(cards[0].ready, true);
  cards[0].node.insertAdjacentHTML("beforeend", '<mat-progress-spinner></mat-progress-spinner>');
  assert.equal(page.adapter.getComposerAttachments()[0].ready, false);
  assert.equal(page.collectVisibleComposerPdfCardEvidence().length, 1);
  cards[0].node.remove();
  assert.equal(page.collectVisibleComposerPdfCardEvidence().length, 0);
});

test("Gemini stop uses localized structural control and history rejects external links", () => {
  const page = content('<input-container><button aria-label="停止回答"><mat-icon fonticon="stop"></mat-icon></button></input-container><bard-sidenav role="navigation"><a href="/app/d11114e59cd9e350">Test chat</a><a href="https://gemini.google.com.evil.test/app/aaaaaaaaaaaaaaaa">Bad</a></bard-sidenav>');
  assert.ok(page.findStopButton());
  assert.equal(page.collectHistoryEntries().length, 1);
  assert.equal(page.collectHistoryEntries()[0].chatUrl, chatUrl);
});

test("pending unnamed upload blocks a prompt-only send", () => {
  const page = content('<input-container><uploader-file-preview><div class="gem-attachment-content loading"><mat-spinner role="progressbar" aria-label="Loading attachment"></mat-spinner><button aria-label="close gemini-proof"></button></div></uploader-file-preview></input-container>');
  assert.equal(page.collectVisibleComposerPdfCardEvidence().length, 1);
  assert.equal(page.adapter.getComposerAttachments()[0].ready, false);
});

test("observed image preview is a single attachment and cannot satisfy a PDF receipt", () => {
  const page = content(`<input-container>${read("fixtures/gemini-image-ready.html")}</input-container>`);
  const cards = page.adapter.getComposerAttachments();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "image");
  assert.equal(cards[0].ready, true);
  assert.equal(shared.classifySubmittedPdfContract([cards[0].filename], "test.pdf").contractVerified, false);
});

test("Gemini upload uses the opened file input and waits for a settled named PDF receipt", async () => {
  const page = content('<input-container><button><mat-icon fonticon="plus"></mat-icon></button></input-container><input type="file" id="unrelated">');
  assert.equal(typeof page.adapter.uploadFile, "function");
  let now = 0;
  const file = new File(["test pdf"], "gemini-proof.pdf", { type: "application/pdf" });
  page.context.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (value) => this.files.push(value) }; }
  };
  page.document.querySelector("button").addEventListener("click", () => {
    page.document.body.insertAdjacentHTML("beforeend", '<images-files-uploader><input type="file"></images-files-uploader>');
    page.document.querySelector("images-files-uploader input").addEventListener("change", (event) => {
      assert.equal(event.target.files[0], file);
      page.document.querySelector("input-container").insertAdjacentHTML("beforeend", '<uploader-file-preview><mat-spinner role="progressbar"></mat-spinner><button aria-label="close gemini-proof"></button></uploader-file-preview>');
    });
  });
  const receipt = await page.adapter.uploadFile(file, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
      if (now === 200) {
        const preview = page.document.querySelector("uploader-file-preview");
        preview.querySelector("mat-spinner").remove();
        preview.insertAdjacentHTML("afterbegin", '<span class="gem-attachment-text">gemini-proof</span><span class="gem-attachment-extension-label">PDF</span>');
      }
    },
  });
  assert.equal(receipt.method, "file_input");
  assert.equal(receipt.filenameConfirmed, true);
  assert.equal(receipt.readyConfirmed, true);
  assert.ok(receipt.totalElapsedMs >= 950);
  assert.equal(page.document.querySelector("#unrelated").files, undefined);
});

function pipelineHarness({ navigationFails = false, wrongReadyUrl = false, initialUrl = "https://gemini.google.com/app/aaaaaaaaaaaaaaaa" } = {}) {
  const errors = [];
  const sent = [];
  const navigations = [];
  let tab = { id: 1, active: true, url: initialUrl };
  const context = vm.createContext({
    shared, URL, console, pipelineRunning: false, activePipelineSeq: 0, activePipelineAttempt: 0,
    activeTarget: "gemini", activeChatTabId: 1, SUPPORTED_DELIVERY_CONTRACTS: [1], MAX_PRE_SUBMIT_RELEASES: 3,
    SERVER: "http://127.0.0.1:23128", broadcastStatus() {}, debugLog() {},
    submitError: async (...args) => errors.push(args), serverPost: async () => {},
    relayFetch: async () => ({ json: async () => ({}) }),
    ensureTabActive: async () => tab, ensureTabReady: async () => {}, ensureContentScript: async () => {},
    waitForTabLoad: async () => {},
    publishReadyConversationState: async () => ({ chatUrl: wrongReadyUrl ? "https://gemini.google.com/app/bbbbbbbbbbbbbbbb" : tab.url, chatId: tab.url.split("/").pop() }),
    streamPipeline: async (...args) => { sent.push(args); return { text: "Answer", runState: "done" }; },
    chrome: { tabs: { get: async () => tab, update: async (_id, changes) => {
      if (navigationFails) throw new Error("Navigation failed");
      navigations.push(changes.url); tab = { ...tab, ...changes }; return tab;
    } } },
  });
  const configStart = backgroundSource.indexOf("const SITE_CONFIGS =");
  const configEnd = backgroundSource.indexOf("let activeTarget =", configStart);
  const pipelineStart = backgroundSource.indexOf("async function runPipeline(");
  const pipelineEnd = backgroundSource.indexOf("async function submitError(", pipelineStart);
  vm.runInContext(backgroundSource.slice(configStart, configEnd) + backgroundSource.slice(pipelineStart, pipelineEnd), context);
  return { context, errors, sent, navigations, run: (query) => context.runPipeline({ seq: 4, attempt: 2, delivery_contract_version: 1, prompt: "hello", target: "gemini", ...query }) };
}

test("unknown target fails closed and clears pipeline state", async () => {
  const h = pipelineHarness();
  await h.run({ target: "unknown" });
  assert.equal(h.context.pipelineRunning, false);
  assert.equal(h.sent.length, 0);
  assert.match(h.errors[0][1], /unsupported/i);
});

test("follow-up navigates to the expected conversation and passes the binding to submission", async () => {
  const h = pipelineHarness();
  await h.run({ expected_chat_url: chatUrl });
  assert.deepEqual(h.navigations, [chatUrl]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].expectedChatUrl, chatUrl);
});

test("navigation errors and wrong ready URLs never submit a follow-up", async () => {
  for (const options of [{ navigationFails: true }, { wrongReadyUrl: true }]) {
    const h = pipelineHarness(options);
    await h.run({ expected_chat_url: chatUrl });
    assert.equal(h.sent.length, 0);
    assert.equal(h.context.pipelineRunning, false);
    assert.equal(h.errors.length, 1);
  }
});

test("fresh Gemini chat reloads even an existing home shell and confirms its empty transcript", async () => {
  const h = pipelineHarness({ wrongReadyUrl: true, initialUrl: "https://gemini.google.com/app" });
  await h.run({ force_new_chat: true });
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.navigations, ["https://gemini.google.com/app"]);
});

test("pre-submit Gemini URL check rejects navigation races and stale fresh-chat transcripts", () => {
  const page = content(read("fixtures/gemini-pdf-turn.html"));
  assert.equal(typeof page.assertSubmissionConversation, "function");
  assert.doesNotThrow(() => page.assertSubmissionConversation({ expectedChatUrl: chatUrl }));
  assert.throws(() => page.assertSubmissionConversation({ expectedChatUrl: "https://gemini.google.com/app/aaaaaaaaaaaaaaaa" }), /conversation/i);
  page.context.window.location = new URL("https://gemini.google.com/app");
  assert.throws(() => page.assertSubmissionConversation({ expectedChatUrl: "https://gemini.google.com/app", forceNewChat: true }), /fresh|empty/i);
});

test("Gemini submitted PDF contract rejects duplicate or differently named PDFs", () => {
  const page = content();
  assert.equal(typeof page.adapter.classifySubmittedAttachments, "function");
  assert.equal(page.adapter.classifySubmittedAttachments(["test.pdf", "image"], "test.pdf", 1).contractVerified, true);
  assert.equal(page.adapter.classifySubmittedAttachments(["test.pdf", "other.pdf"], "test.pdf").contractVerified, false);
  assert.equal(page.adapter.classifySubmittedAttachments(["other.pdf"], "test.pdf").contractVerified, false);
  assert.equal(page.adapter.classifySubmittedAttachments(["test.pdf"], "").contractVerified, false);
});

test("manifest loads a working Gemini adapter without loading a network interceptor", () => {
  const manifest = JSON.parse(read("../extension/manifest.json"));
  const scripts = manifest.content_scripts.filter((entry) => entry.matches.includes("https://gemini.google.com/*"));
  assert.ok(manifest.host_permissions.includes("https://gemini.google.com/*"));
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every((entry) => entry.world !== "MAIN"));
  const page = content();
  const globals = { ...page.context };
  delete globals.SyncZoteroGemini;
  const runtime = vm.createContext(globals);
  for (const script of scripts.flatMap((entry) => entry.js)) vm.runInContext(read(`../extension/${script}`), runtime);
  assert.equal(vm.runInContext("SITE_ADAPTER.siteId", runtime), "gemini");
});

test("manual injection loads Gemini DOM support without injecting the MAIN-world network hook", async () => {
  const injected = [];
  let loaded = false;
  const context = vm.createContext({ shared, URL, setTimeout, clearTimeout,
    chrome: { runtime: {}, tabs: {
      get: async () => ({ id: 1, url: chatUrl }),
      sendMessage: (_id, _message, callback) => callback(loaded ? { pong: true, supportedDeliveryContracts: [1], supportedTargets: ["gemini"], answerCapture: "dom" } : null),
    }, scripting: { executeScript: async (args) => { injected.push(args); if (args.files.includes("content_script.js")) loaded = true; } } },
  });
  const configStart = backgroundSource.indexOf("const SITE_CONFIGS =");
  const configEnd = backgroundSource.indexOf("let activeTarget =", configStart);
  const start = backgroundSource.indexOf("async function ensureContentScript(");
  const end = backgroundSource.indexOf("\n}", start) + 2;
  vm.runInContext(backgroundSource.slice(configStart, configEnd) + backgroundSource.slice(start, end), context);
  const health = await context.ensureContentScript(1, 1);
  assert.equal(health.answerCapture, "dom");
  assert.ok(injected.every((args) => args.world !== "MAIN"));
  assert.deepEqual(Array.from(injected[0].files), ["webchat_shared.js", "gemini_adapter.js", "content_script.js"]);
});

test("Gemini performs one Send click and never retries an ambiguous submission", async () => {
  const page = content('<input-container><div class="ql-editor" role="textbox" contenteditable="true">hello</div><button><mat-icon fonticon="arrow_upward"></mat-icon></button></input-container>');
  let clicks = 0;
  page.document.querySelector("button").addEventListener("click", () => clicks++);
  let now = Date.now();
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => { now += ms; };
  page.context.window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  page.document.createRange = () => ({ selectNodeContents() {} });
  page.document.execCommand = () => true;
  page.context.KeyboardEvent = page.context.Event;
  vm.runInContext("workerSleep = advanceTimer", page.context);
  await assert.rejects(() => page.submitMessageAndVerify("hello"), /Gemini.*delivery.*verified/i);
  assert.equal(clicks, 1);
});

test("Gemini heartbeat uses canonical chat URLs even when the tab has query parameters", async () => {
  const page = content(read("fixtures/gemini-observed-dom.html"), `${chatUrl}?hl=en#reply`);
  const health = await page.collectHealthStatus();
  const status = shared.buildExtensionStatusReport({ chatTabAlive: true, chatUrl: `${chatUrl}?hl=en`, targetSiteId: "gemini", health });
  assert.equal(status.chatUrl, chatUrl);
  assert.equal(status.url, chatUrl);
});

test("fresh Send validates binding before the click and accepts the newly allocated conversation URL", async () => {
  const page = content('<input-container><div class="ql-editor" role="textbox" contenteditable="true">hello</div><button><mat-icon fonticon="arrow_upward"></mat-icon></button></input-container>', "https://gemini.google.com/app");
  let checks = 0;
  page.document.querySelector("button").addEventListener("click", () => {
    page.context.window.location = new URL(chatUrl);
    page.document.querySelector(".ql-editor").textContent = "";
  });
  const result = await page.submitMessageAndVerify("hello", () => true, () => {
    checks++;
    page.assertSubmissionConversation({ expectedChatUrl: "https://gemini.google.com/app", forceNewChat: true });
  });
  assert.equal(checks, 1);
  assert.equal(result.clickAttempts, 1);
});

test("fast completed Gemini PDF turn emits the bound seq/attempt receipt through the production stream tracker", async () => {
  const page = content(read("fixtures/gemini-pdf-turn.html"));
  const transcript = page.extractConversationTranscript();
  let now = Date.now();
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => { now += ms; };
  vm.runInContext("workerSleep = advanceTimer", page.context);
  const events = [];
  await page.streamResponseSnapshots({ postMessage: (event) => events.push(event) }, 42, 3,
    { ...transcript, count: 0, hash: "empty", messages: [] }, transcript.messages[0].text,
    "gemini-proof.pdf|0", { pdfAttachmentReceipt: { method: "file_input", filenameConfirmed: true, readyConfirmed: true, totalElapsedMs: 1000 } }, 20000);
  const terminal = events.find((event) => event.type === "terminal");
  assert.ok(terminal);
  assert.equal(terminal.seq, 42);
  assert.equal(terminal.attempt, 3);
  assert.equal(terminal.assistantTurnKey, transcript.messages[1].messageKey);
  assert.equal(terminal.remoteChatUrl, chatUrl);
  assert.equal(terminal.diagnostic.submittedPdfCount, 1);
  assert.equal(terminal.diagnostic.submittedAttachmentVerified, true);
  assert.equal(terminal.diagnostic.attachmentReadyVerified, true);
  assert.match(terminal.text, /GEMINI-PDF-73B9/);
});

test("Gemini production timer resolves when browser CSP forbids blob Workers", async () => {
  const page = content();
  let workerAttempts = 0;
  page.context.Blob = Blob;
  page.context.URL = { createObjectURL: () => "blob:blocked", revokeObjectURL() {} };
  page.context.Worker = class { constructor() { workerAttempts++; throw new Error("CSP blocks blob worker"); } };
  await page.workerSleep(5);
  assert.equal(workerAttempts, 0);
});

function workerTimerHarness(mode, hostname) {
  const page = content("", `https://${hostname}/`);
  const state = { terminated: 0, worker: null };
  const revoked = [];
  const activeTimers = new Set();
  const clearedTimers = [];
  page.context.setTimeout = (callback, ms) => {
    const id = setTimeout(() => { activeTimers.delete(id); callback(); }, ms);
    activeTimers.add(id);
    return id;
  };
  page.context.clearTimeout = (id) => {
    clearedTimers.push(id);
    activeTimers.delete(id);
    clearTimeout(id);
  };
  page.context.Blob = Blob;
  page.context.URL = { createObjectURL: () => "blob:failed", revokeObjectURL: (url) => revoked.push(url) };
  page.context.Worker = class {
    constructor() {
      if (mode === "constructor-error") throw new Error("Worker startup blocked");
      state.worker = this;
      queueMicrotask(() => {
        if (mode === "success") this.onmessage?.({ data: "done" });
        else this.onerror?.({ preventDefault() {} });
      });
    }
    terminate() { state.terminated++; }
  };
  return { page, state, revoked, activeTimers, clearedTimers };
}

for (const hostname of ["chatgpt.com", "chat.deepseek.com"]) {
  for (const [mode, label] of [
    ["success", "normal Worker completion"],
    ["constructor-error", "Worker construction throws"],
    ["async-error", "asynchronous Worker failure"],
  ]) {
    test(`${hostname} production worker timer resolves and cleans resources after ${label}`, { timeout: 500 }, async () => {
      const h = workerTimerHarness(mode, hostname);
      // Successful workers must cancel the still-pending native fallback; failed
      // workers let it fire. Both leave no timer, handler, worker, or object URL.
      await h.page.workerSleep(mode === "success" ? 200 : 5);
      assert.equal(h.activeTimers.size, 0);
      assert.equal(h.clearedTimers.length, 1);
      assert.equal(h.state.terminated, mode === "constructor-error" ? 0 : 1);
      assert.deepEqual(h.revoked, ["blob:failed"]);
      if (h.state.worker) {
        assert.equal(h.state.worker.onmessage, null);
        assert.equal(h.state.worker.onerror, null);
      }
    });
  }
}

test("Gemini submitted PDF filenames must match completely without legacy suffix or duplicate-name matching", () => {
  const page = content();
  for (const name of ["wrong-test.pdf", "test (2).pdf", "test.pdf.backup", "test….pdf"]) {
    const receipt = page.adapter.classifySubmittedAttachments([name], "test.pdf");
    assert.equal(receipt.filenameMatched, false, name);
    assert.equal(receipt.contractVerified, false, name);
  }
  assert.equal(page.adapter.classifySubmittedAttachments(["  Cafe\u0301.pdf  "], "Café.pdf").contractVerified, true);
});

test("Gemini readiness completes using production timers under blocked-worker CSP", { timeout: 2500 }, async () => {
  const page = content(read("fixtures/gemini-observed-dom.html"));
  page.context.MutationObserver = page.context.window.MutationObserver;
  page.context.Worker = class { constructor() { throw new Error("CSP blocks blob worker"); } };
  const ready = await vm.runInContext("waitForChatReady(null, 2000)", page.context);
  assert.equal(ready.ok, true);
  assert.equal(ready.ready, true);
});

test("Gemini PDF receipts normalize only the extension case and retain complete basename equality", () => {
  const page = content();
  assert.equal(page.adapter.classifySubmittedAttachments(["test.pdf"], "test.PDF").contractVerified, true);
  assert.equal(page.adapter.classifySubmittedAttachments(["test.PDF"], "test.pdf").contractVerified, true);
  for (const name of ["wrong-test.pdf", "test (2).pdf", "Test.pdf"]) {
    assert.equal(page.adapter.classifySubmittedAttachments([name], "test.PDF").contractVerified, false, name);
  }
});

test("Gemini upload readiness accepts an uppercase PDF extension", async () => {
  const page = content('<input-container></input-container><images-files-uploader><input type="file"></images-files-uploader>');
  let now = 0;
  page.context.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  };
  page.document.querySelector("input[type=file]").addEventListener("change", () => {
    const observed = parseHTML(read("fixtures/gemini-upload-ready.html")).document.querySelector("input-container");
    page.document.querySelector("input-container").innerHTML = observed.innerHTML;
  });
  const receipt = await page.adapter.uploadFile(new File(["PDF"], "gemini-proof.PDF", { type: "application/pdf" }), {
    now: () => now, wait: async (ms) => { now += ms; }, timeoutMs: 1500,
  });
  assert.equal(receipt.filenameConfirmed, true);
  assert.equal(receipt.readyConfirmed, true);
});

test("observed mixed Gemini user turn identifies the actual PDF and uploaded image", () => {
  const page = content(`<div class="conversation-container" id="mixed">${read("fixtures/gemini-mixed-turn.html")}</div>`);
  const [message] = page.extractConversationTranscript().messages;
  assert.deepEqual(Array.from(message.attachments), ["gemini-live-proof.pdf", "image"]);
  assert.ok(page.document.querySelector('user-query-file-preview img[data-test-id="uploaded-img"]'));
});

for (const [followup, directReplacement] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`Gemini production tracker preserves ${followup ? "follow-up" : "fresh"} user binding across ${directReplacement ? "direct container replacement" : "late ID allocation"}`, async () => {
    const allocatedChatUrl = followup ? chatUrl : "https://gemini.google.com/app/44353066e9854a0f";
    const oldTurn = '<div class="conversation-container" id="prior"><user-query><div class="query-text-line">Read the attached test PDF. Reply with its marker and method name only.</div></user-query><model-response><message-content><div class="markdown" aria-busy="false">Prior unrelated answer</div></message-content><div class="response-footer complete"></div></model-response></div>';
    const page = content(followup ? oldTurn : "", followup ? chatUrl : "https://gemini.google.com/app");
    const baseline = page.extractConversationTranscript();
    page.document.body.insertAdjacentHTML("beforeend", `<div class="conversation-container">${read("fixtures/gemini-mixed-turn.html")}</div>`);
    let current = page.document.querySelector(".conversation-container:not([id])");
    const initial = page.extractConversationTranscript().messages.at(-1);
    let now = Date.now();
    let allocated = false;
    page.context.Date = class extends Date { static now() { return now; } };
    page.context.advanceTimer = async (ms) => {
      now += ms;
      if (!allocated) {
        allocated = true;
        page.context.window.location = new URL(allocatedChatUrl);
        if (!directReplacement) {
          current.id = "b0b0816f2d3b7530";
          page.extractConversationTranscript();
        }
        // Direct replacement models live Gemini: no permanent ID was ever
        // observable on the provisional node before it disappeared.
        const replacement = current.cloneNode(true);
        replacement.id = "b0b0816f2d3b7530";
        current.replaceWith(replacement);
        current = replacement;
        current.insertAdjacentHTML("beforeend", '<model-response><message-content><div class="markdown" aria-busy="false">Current marker: LATE-ID-42; Cedar</div></message-content><div class="response-footer complete"></div></model-response>');
      }
    };
    vm.runInContext("workerSleep = advanceTimer", page.context);
    const events = [];
    await page.streamResponseSnapshots({ postMessage: (event) => events.push(event) }, 43, 2,
      baseline, initial.text, "gemini-live-proof.pdf|1",
      { pdfAttachmentReceipt: { method: "file_input", filenameConfirmed: true, readyConfirmed: true } }, 20000);
    const terminal = events.find((event) => event.type === "terminal");
    assert.ok(terminal);
    assert.equal(terminal.userTurnKey, directReplacement
      ? "b0b0816f2d3b7530:user" : initial.messageKey);
    assert.equal(terminal.assistantTurnKey, page.adapter.getMessageId(current.querySelector("model-response")));
    assert.equal(terminal.text, "Current marker: LATE-ID-42; Cedar");
    assert.equal(terminal.remoteChatUrl, allocatedChatUrl);
    assert.equal(terminal.remoteChatId, followup ? "d11114e59cd9e350" : "44353066e9854a0f");
    assert.equal(terminal.seq, 43);
    assert.equal(terminal.attempt, 2);
    assert.equal(terminal.diagnostic.submittedAttachmentCount, 2);
    assert.equal(terminal.diagnostic.submittedPdfCount, 1);
    assert.equal(terminal.diagnostic.submittedAttachmentVerified, true);
    assert.ok(events.every((event) => !event.text?.includes("Prior unrelated answer")));
  });
}

for (const destination of [
  "https://gemini.google.com/app/2222222222222222",
  "https://gemini.google.com/app",
  "https://gemini.google.com/",
  "https://example.com/app/1111111111111111",
  "https://gemini.google.com/app/thread-1",
]) {
  for (const timing of ["before matching", "after binding", "terminal confirmation"]) {
    test(`Gemini tracker rejects navigation ${timing} to ${destination}`, async () => {
      const origin = "https://gemini.google.com/app/1111111111111111";
      const page = content("", origin);
      const baseline = page.extractConversationTranscript();
      page.document.body.innerHTML = '<div class="conversation-container"><user-query><div class="query-text-line">same prompt</div></user-query></div>';
      const answer = '<model-response><message-content><div class="markdown" aria-busy="false">OLD ANSWER FROM A DIFFERENT CONVERSATION</div></message-content><div class="response-footer complete"></div></model-response>';
      if (timing === "terminal confirmation") page.document.querySelector(".conversation-container").insertAdjacentHTML("beforeend", answer);
      const navigate = () => {
        page.context.window.location = new URL(destination);
        if (timing !== "terminal confirmation") {
          page.document.body.innerHTML = `<div class="conversation-container" id="historical"><user-query><div class="query-text-line">same prompt</div></user-query>${answer}</div>`;
        }
      };
      if (timing === "before matching") navigate();
      let now = Date.now();
      let navigated = timing === "before matching";
      page.context.Date = class extends Date { static now() { return now; } };
      page.context.advanceTimer = async (ms) => {
        now += ms;
        if (!navigated && (timing !== "terminal confirmation" || ms === 750)) {
          navigated = true;
          navigate();
        }
      };
      vm.runInContext("workerSleep = advanceTimer", page.context);
      const events = [];
      await assert.rejects(page.streamResponseSnapshots({ postMessage: (event) => events.push(event) },
        44, 1, baseline, "same prompt", "|0", null, 20000), /Gemini.*conversation/i);
      assert.ok(events.every((event) => event.type !== "terminal"));
      assert.ok(events.every((event) => event.remoteChatUrl === origin));
      if (timing !== "terminal confirmation") assert.ok(events.every((event) => !event.text?.includes("OLD ANSWER")));
    });
  }
}

test("Gemini tracker reports a conversation allocated during terminal confirmation", async () => {
  const page = content("", "https://gemini.google.com/app");
  const baseline = page.extractConversationTranscript();
  page.document.body.innerHTML = '<div class="conversation-container" id="current"><user-query><div class="query-text-line">same prompt</div></user-query><model-response><message-content><div class="markdown" aria-busy="false">Current answer</div></message-content><div class="response-footer complete"></div></model-response></div>';
  let now = Date.now();
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => {
    now += ms;
    if (ms === 750) page.context.window.location = new URL(chatUrl);
  };
  vm.runInContext("workerSleep = advanceTimer", page.context);
  const events = [];
  await page.streamResponseSnapshots({ postMessage: (event) => events.push(event) },
    45, 1, baseline, "same prompt", "|0", null, 20000);
  const terminal = events.find((event) => event.type === "terminal");
  assert.equal(terminal?.completionReason, "settled");
  assert.equal(terminal?.remoteChatUrl, chatUrl);
  assert.equal(terminal?.remoteChatId, "d11114e59cd9e350");
});

test("Gemini tracker pins the first allocated conversation before a second navigation", async () => {
  const page = content("", "https://gemini.google.com/app");
  const baseline = page.extractConversationTranscript();
  page.document.body.innerHTML = '<div class="conversation-container"><user-query><div class="query-text-line">same prompt</div></user-query></div>';
  let now = Date.now();
  let polls = 0;
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => {
    now += ms;
    page.context.window.location = new URL(++polls === 1
      ? "https://gemini.google.com/app/1111111111111111"
      : "https://gemini.google.com/app/2222222222222222");
  };
  vm.runInContext("workerSleep = advanceTimer", page.context);
  const events = [];
  await assert.rejects(page.streamResponseSnapshots({ postMessage: (event) => events.push(event) },
    45, 1, baseline, "same prompt", "|0", null, 3000), /Gemini.*conversation/i);
  assert.equal(polls, 2);
  assert.ok(events.every((event) => event.type !== "terminal"));
});

test("Gemini replacement binding requires the baseline and one exact user with the requested attachments", () => {
  const page = content();
  assert.equal(typeof page.adapter.resolveReplacementUserTurn, "function");
  const prior = { messageKey: "prior:user", role: "user", text: "same prompt", attachments: ["test.pdf", "image"] };
  const priorAnswer = { messageKey: "prior:assistant", role: "assistant", text: "Wrong old answer" };
  const current = { messageKey: "current:user", role: "user", text: "same prompt", attachments: ["test.pdf", "image"] };
  const baseline = { chatUrl, messages: [prior, priorAnswer] };
  const resolve = (messages, overrides = {}) => page.adapter.resolveReplacementUserTurn({
    transcript: { chatUrl, messages }, baseline, expectedChatUrl: chatUrl, promptText: "same prompt", expectedPdfFilename: "test.pdf", expectedImageCount: 1, ...overrides,
  });
  assert.equal(resolve([prior, priorAnswer, current])?.messageKey, "current:user");
  assert.equal(resolve([prior, priorAnswer]), null);
  assert.equal(resolve([current]), null);
  assert.equal(resolve([prior, priorAnswer, current, { ...current, messageKey: "duplicate:user" }]), null);
  assert.equal(resolve([prior, priorAnswer, { ...current, attachments: ["wrong-test.pdf", "image"] }]), null);
  assert.equal(resolve([prior, priorAnswer, { ...current, attachments: ["test.pdf"] }]), null);
  assert.equal(resolve([prior, priorAnswer, { ...current, text: "same prompt plus something" }]), null);
  assert.equal(resolve([prior, priorAnswer, current], { transcript: { chatUrl: "https://gemini.google.com/app/2222222222222222", messages: [prior, priorAnswer, current] } }), null);
  assert.equal(resolve([{ ...current, attachments: [] }], { baseline: { messages: [] }, expectedPdfFilename: "", expectedImageCount: 0 })?.messageKey, "current:user");
});

for (const label of ["Si and Qin...onal drift", "Si and Qin…onal drift"]) {
  test(`Gemini upload accepts a ready middle-elided long filename: ${label}`, async () => {
    const page = content('<input-container></input-container><images-files-uploader><input type="file"></images-files-uploader>');
    let now = 0;
    page.context.DataTransfer = class {
      constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
    };
    page.document.querySelector('input[type=file]').addEventListener('change', () => {
      const observed = parseHTML(read('fixtures/gemini-upload-ready.html').replaceAll('gemini-proof', label)).document.querySelector('input-container');
      page.document.querySelector('input-container').innerHTML = observed.innerHTML;
    });
    const receipt = await page.adapter.uploadFile(new File(['PDF'], 'Si and Qin - Representational drift.pdf', { type: 'application/pdf' }), {
      now: () => now, wait: async (ms) => { now += ms; }, timeoutMs: 1500,
    });
    assert.equal(receipt.readyConfirmed, true);
    assert.equal(receipt.filenameConfirmed, true);
    assert.ok(now >= 750);
    // Submitted-turn identity remains exact even when the composer elides it.
    assert.equal(page.adapter.classifySubmittedAttachments([label + '.pdf'], 'Si and Qin - Representational drift.pdf').contractVerified, false);
  });
}

for (const scenario of [
  { name: 'wrong prefix', label: 'Xu and Qin...onal drift' },
  { name: 'wrong suffix', label: 'Si and Qin...onal draft' },
  { name: 'short ambiguous label', label: 'Si...drift' },
  { name: 'extra elision', label: 'Si and...Qin...onal drift' },
  { name: 'duplicate cards', label: 'Si and Qin...onal drift', duplicate: true },
  { name: 'busy card', label: 'Si and Qin...onal drift', busy: true },
  { name: 'failed upload', label: 'Si and Qin...onal drift', failed: true },
  { name: 'stale card', label: 'Si and Qin...onal drift', stale: true },
]) {
  test(`Gemini long-name upload rejects ${scenario.name}`, async () => {
    const observed = parseHTML(read('fixtures/gemini-upload-ready.html').replaceAll('gemini-proof', scenario.label)).document.querySelector('input-container');
    const card = observed.querySelector('uploader-file-preview');
    if (scenario.busy) card.insertAdjacentHTML('beforeend', '<mat-spinner role="progressbar"></mat-spinner>');
    if (scenario.failed) card.insertAdjacentHTML('beforeend', '<div role="alert">Upload failed</div>');
    const markup = card.outerHTML + (scenario.duplicate ? card.outerHTML : '');
    const page = content(`<input-container>${scenario.stale ? markup : ''}</input-container><images-files-uploader><input type="file"></images-files-uploader>`);
    page.context.DataTransfer = class {
      constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
    };
    page.document.querySelector('input[type=file]').addEventListener('change', () => {
      if (!scenario.stale) page.document.querySelector('input-container').innerHTML = markup;
    });
    let now = 0;
    await assert.rejects(page.adapter.uploadFile(new File(['PDF'], 'Si and Qin - Representational drift.pdf', { type: 'application/pdf' }), {
      now: () => now, wait: async (ms) => { now += ms; }, timeoutMs: 1000,
    }), /did not confirm a ready attachment/);
  });
}

// Reduced from live Gemini (2026-10-27): code language is a header, images
// live inside a button, and rendered SVG source arrives in a sandbox frame.
const richTurn = (body) => `<div class="conversation-container" id="rich"><user-query><div class="query-text-line">draw a circle</div></user-query><model-response><message-content><div class="markdown" aria-busy="false">${body}</div></message-content><div class="response-footer complete"></div></model-response></div>`;
const codeBlock = (language, source) => `<code-block><div class="code-block-decoration header-formatted"><span>${language}</span><button>Copy code</button></div><pre><code class="code-container formatted">${source}</code></pre></code-block>`;

test("Gemini preserves HTML and Python code languages in answers and history", () => {
  const page = content(richTurn(codeBlock("HTML", "&lt;h1&gt;Green Square&lt;/h1&gt;") + codeBlock("Python", "print(42)")));
  assert.equal(page.extractConversationTranscript().messages.at(-1).text,
    "```html\n<h1>Green Square</h1>\n```\n\n```python\nprint(42)\n```");
});

test("Gemini image-only response survives control pruning and materializes browser blobs", async () => {
  const page = content(richTurn('<generated-image><button class="image-button"><img src="blob:https://gemini.google.com/circle" alt="Blue circle"></button><button>Download</button></generated-image>'));
  page.context.fetch = async (url) => {
    assert.equal(url, "blob:https://gemini.google.com/circle");
    return { ok: true, blob: async () => new Blob(["circle"], { type: "image/png" }) };
  };
  page.context.btoa = btoa;
  page.context.AbortSignal = AbortSignal;
  await page.prepareRichOutput();
  const result = page.extractConversationTranscript().messages.at(-1);
  assert.equal(result.role, "assistant");
  assert.equal(result.text, "![Blue circle](data:image/png;base64,Y2lyY2xl)");
  assert.ok(page.adapter.isResponseComplete("rich:assistant"));
  assert.match(page.document.querySelector("img").src, /^blob:/, "capture must not alter the page");
});

test("Gemini recovers source only from the matching artifact frame and waits for it", async () => {
  const page = content(richTurn('<p>Diagram</p><svg-code-block><div class="svg-toolbar">SVG<button>Copy SVG</button></div><iframe srcdoc="provider bootstrap"></iframe></svg-code-block>'));
  const frame = page.document.querySelector('iframe');
  const frameWindow = { postMessage() {} };
  Object.defineProperty(frame, "contentWindow", { value: frameWindow });
  const deliver = (source, html) => {
    const event = new page.context.window.Event('message');
    Object.defineProperties(event, { source: { value: source }, data: { value: { type: 'SYNC_ZOTERO_GEMINI_ARTIFACT', html } } });
    page.context.window.dispatchEvent(event);
  };
  assert.equal(page.adapter.isResponseComplete("rich:assistant"), false);
  deliver({}, '<svg><text>WRONG TURN</text></svg>');
  assert.ok(!page.adapter.extractAssistantAnswerText(page.document.querySelector('model-response')).includes('WRONG TURN'));
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="30" fill="blue"/></svg>';
  deliver(frameWindow, source);
  assert.equal(page.extractConversationTranscript().messages.at(-1).text, `Diagram\n\n\`\`\`svg\n${source}\n\`\`\``);
  assert.equal(page.adapter.isResponseComplete("rich:assistant"), true);
  assert.equal(frame.getAttribute('srcdoc'), 'provider bootstrap');
});


test("Gemini history waits for late SVG source and preserves generated images", async () => {
  const page = content(richTurn('<svg-code-block><iframe srcdoc="bootstrap"></iframe></svg-code-block><generated-image><button><img src="data:image/png;base64,YQ==" alt="Figure"></button></generated-image>'));
  const frame = page.document.querySelector('iframe');
  const frameWindow = { postMessage() {
    queueMicrotask(() => {
      const event = new page.context.window.Event('message');
      Object.defineProperties(event, { source: { value: frameWindow }, data: { value: { type: 'SYNC_ZOTERO_GEMINI_ARTIFACT', html: '<svg><circle r="2"/></svg>' } } });
      page.context.window.dispatchEvent(event);
    });
  } };
  Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
  const result = await page.extractFullConversationTranscript();
  assert.match(result.messages.at(-1).text, /```svg\n<svg><circle/);
  assert.match(result.messages.at(-1).text, /!\[Figure\]\(data:image\/png;base64,YQ==\)/);
  assert.ok(!result.messages.at(-1).text.includes('being transferred'));
});

for (const kind of ['failed', 'foreign', 'oversized', 'nonimage']) {
  test(`Gemini reports ${kind} blob image transfer without losing the answer`, async () => {
    const url = kind === 'foreign' ? 'blob:https://example.com/image' : 'blob:https://gemini.google.com/image';
    const page = content(richTurn(`<p>Answer</p><button><img src="${url}" alt="Figure"></button>`));
    page.context.AbortSignal = AbortSignal;
    page.context.fetch = async () => {
      if (kind === 'failed') throw new Error('unavailable');
      if (kind === 'foreign') assert.fail('foreign blobs must not be fetched');
      return { ok: true, blob: async () => ({ type: kind === 'nonimage' ? 'text/html' : 'image/png', size: kind === 'oversized' ? 6 * 1024 * 1024 : 1 }) };
    };
    await page.prepareRichOutput();
    const text = page.extractConversationTranscript().messages.at(-1).text;
    assert.match(text, /^Answer/);
    assert.match(text, /Image could not be transferred/);
    assert.ok(!text.includes('blob:'));
  });
}

test("Gemini live tracker transfers an image-only reply before terminal acknowledgement", async () => {
  const page = content();
  const baseline = page.extractConversationTranscript();
  page.document.body.innerHTML = richTurn('<generated-image><button><img src="blob:https://gemini.google.com/generated" alt="Circle"></button></generated-image>');
  page.context.fetch = async () => ({ ok: true, blob: async () => new Blob(['circle'], { type: 'image/png' }) });
  page.context.btoa = btoa;
  page.context.AbortSignal = AbortSignal;
  let now = Date.now();
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => { now += ms; };
  vm.runInContext('workerSleep = advanceTimer', page.context);
  const events = [];
  await page.streamResponseSnapshots({ postMessage: (event) => events.push(event) }, 44, 1, baseline, 'draw a circle', '', { composerTextMatched: true }, 20000);
  const terminal = events.find(event => event.type === 'terminal');
  assert.equal(terminal?.text, '![Circle](data:image/png;base64,Y2lyY2xl)');
  assert.equal(terminal?.assistantTurnKey, 'rich:assistant');
  assert.equal(terminal?.diagnostic.attachmentContractVerified, true);
});

test('Gemini keeps source attached to its own SVG block while an earlier block is mounting', () => {
  const page = content(richTurn('<svg-code-block></svg-code-block><p>Second drawing</p><svg-code-block><iframe></iframe></svg-code-block>'));
  const frame = page.document.querySelector('iframe');
  const frameWindow = { postMessage() {} };
  Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
  const event = new page.context.window.Event('message');
  Object.defineProperties(event, { source: { value: frameWindow }, data: { value: {type:'SYNC_ZOTERO_GEMINI_ARTIFACT',html:'<svg><circle/></svg>'} } });
  page.context.window.dispatchEvent(event);
  assert.equal(page.extractConversationTranscript().messages.at(-1).text, 'Second drawing\n\n```svg\n<svg><circle/></svg>\n```');
});
