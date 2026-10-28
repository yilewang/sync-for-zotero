import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";
import { conversationFollowup } from "./helpers/conversation_workflow.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const shared = require("../extension/webchat_shared.js");
const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const contentSource = read("../extension/content_script.js");
const backgroundSource = read("../extension/background.js");
const homeUrl = "https://chatgpt.com/";
const tempChatUrl = "https://chatgpt.com/c/WEB:6a1f0c3e-0000-4000-8000-000000000001";
const realChatUrl = "https://chatgpt.com/c/6a1f0c3e-7d2b-4e11-9a55-0c1d2e3f4a5b";
const prompt = "Please summarize the selected text above in one short paragraph.";
const answer = "The selected text argues that grid cells provide a metric for path integration.";
const fixture = read("fixtures/chatgpt-observed-dom.html");
const composer = '<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div></form>';
const originalError = /Chat never exposed a user turn matching the submitted prompt, so delivery could not be verified\./;

function content(html = "", url = homeUrl) {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.location = new URL(url);
  window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  const context = vm.createContext({
    window, document, URL, console, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event, SyncZoteroShared: shared,
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} },
      onConnect: { addListener() {} }, sendMessage() {} } },
  });
  vm.runInContext(contentSource, context);
  const api = vm.runInContext(`({ adapter: SITE_ADAPTER, extractConversationTranscript,
    findStopButton, resolveBoundAssistantTurn, findMatchingUserTurn, hasResponseActionBar,
    streamResponseSnapshots, buildDiagnostic, ensureChatGPTChatMode })`, context);
  return { ...api, window, document, context };
}

// Posts the same page events the MAIN-world fetch hook sends (injected.js).
function transport(page, data) {
  const event = new page.window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: page.window });
  page.window.dispatchEvent(event);
}

// Fake clock: workerSleep advances `now`, and each step runs once its time is reached.
function installClock(page, steps) {
  const start = Date.now();
  let now = start;
  const pending = steps.slice().sort((a, b) => a.at - b.at);
  page.context.Date = class extends Date { static now() { return now; } };
  page.context.advanceTimer = async (ms) => {
    now += ms;
    while (pending.length && now - start >= pending[0].at) pending.shift().run();
  };
  vm.runInContext("workerSleep = advanceTimer", page.context);
  return { elapsed: () => now - start };
}

const debugEvents = (page) => page.context.__syncZoteroWebchatDebug.getEvents().map((entry) => entry.event);

function recorder(clock) {
  const events = [];
  return { events, port: { postMessage: (event) => events.push({ ...event, at: clock ? clock.elapsed() : 0 }) } };
}

const projectChatUrl = realChatUrl.replace("/c/", "/g/g-p-issue13/c/");
const projectFollowup = (options = {}) => conversationFollowup({
  target: "chatgpt", expectedUrl: realChatUrl,
  initialUrl: projectChatUrl, redirectUrl: projectChatUrl, ...options,
});

test("moved ChatGPT conversation passes follow-up readiness and submission without renavigating", async () => {
  const h = projectFollowup();
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.navigations, []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.reports[0].remote_chat_url, projectChatUrl);
  assert.equal(h.reports[0].remote_chat_id, realChatUrl.split("/").pop());
});

test("saved ChatGPT URL can redirect into a Project before a PDF follow-up", async () => {
  const h = projectFollowup({ initialUrl: homeUrl });
  await h.run({ pdf_base64: "synthetic-pdf", pdf_filename: "test.pdf" });
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.navigations, [realChatUrl]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].pdfFilename, "test.pdf");
});

test("subsequent follow-up accepts the saved Project URL and conversation ID", async () => {
  const h = projectFollowup({ initialUrl: homeUrl });
  await h.run({ expected_chat_url: projectChatUrl });
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.navigations, [projectChatUrl]);
  assert.equal(h.sent.length, 1);
});

test("Project support still blocks the wrong conversation before readiness or submission", async () => {
  const wrongUrl = projectChatUrl.replace(realChatUrl.split("/").pop(), "other-chat");
  for (const options of [
    { initialUrl: wrongUrl, redirectUrl: wrongUrl },
    { beforeSend: (page) => { page.window.location = new URL(wrongUrl); } },
  ]) {
    const h = projectFollowup(options);
    await h.run({ pdf_base64: "synthetic-pdf", pdf_filename: "test.pdf" });
    assert.equal(h.sent.length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /conversation/);
  }
});

test("ChatGPT observed DOM yields the bound user and assistant turns", () => {
  const page = content(fixture, realChatUrl);
  const transcript = page.extractConversationTranscript();
  assert.deepEqual(Array.from(transcript.messages, (m) => m.role), ["user", "assistant"]);
  assert.deepEqual(Array.from(transcript.messages, (m) => m.messageKey), ["a3f0c2d4-user-0001", "b7d91e35-assistant-0002"]);
  assert.equal(transcript.messages[0].text, prompt);
  assert.equal(transcript.messages[1].text, answer);
  assert.equal(page.findMatchingUserTurn(transcript, 0, prompt, [])?.messageKey, "a3f0c2d4-user-0001");
  // Markdown-escaped variant of the same prompt (Tier 4 would also accept a
  // single candidate, so this mainly pins normalization does not throw).
  assert.equal(page.findMatchingUserTurn(transcript, 0, prompt.replace(/\.$/, "\\."), [])?.messageKey, "a3f0c2d4-user-0001");
  assert.equal(page.resolveBoundAssistantTurn(transcript, "a3f0c2d4-user-0001")?.messageKey, "b7d91e35-assistant-0002");
  assert.equal(page.hasResponseActionBar(), true);
  assert.equal(page.findStopButton(), null);
});

test("ChatGPT late transcript mount (Flow A) waits past 30 s and then verifies the turn", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  assert.equal(baseline.count, 0);
  let pendingSeenBeforeMount = false;
  const clock = installClock(page, [
    { at: 0, run: () => transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 1 }) },
    { at: 4_000, run: () => { page.window.location = new URL(tempChatUrl); } },
    { at: 7_000, run: () => {
      transport(page, { type: "SYNC_ZOTERO_SSE", text: "", done: true, activeStreamCount: 1 });
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 0 });
    } },
    { at: 11_000, run: () => { page.window.location = new URL(realChatUrl); } },
    { at: 45_000, run: () => {
      pendingSeenBeforeMount = debugEvents(page).includes("user_turn_pending_transcript");
      page.document.body.innerHTML = fixture;
    } },
  ]);
  const { events, port } = recorder(clock);
  await page.streamResponseSnapshots(port, 7, 1, baseline, prompt, "|0", { clickAttempts: 1, baselineOutboundRequestSerial: 0 }, 120_000);
  assert.equal(pendingSeenBeforeMount, true);
  assert.equal(debugEvents(page).filter((e) => e === "user_turn_pending_transcript").length, 1);
  const pendingStates = events.filter((e) => e.type === "turn_state" && e.diagnostic?.reasonCode === "transcript_not_mounted");
  assert.equal(pendingStates.length, 1);
  assert.equal(pendingStates[0].turnStatus, "submitted");
  const terminals = events.filter((e) => e.type === "terminal");
  assert.equal(terminals.length, 1);
  const [terminal] = terminals;
  assert.ok(terminal.at >= 45_000);
  assert.equal(terminal.runState, "done");
  assert.equal(terminal.text, answer);
  assert.equal(terminal.userTurnKey, "a3f0c2d4-user-0001");
  assert.equal(terminal.assistantTurnKey, "b7d91e35-assistant-0002");
  assert.equal(terminal.diagnostic.userTurnMatched, true);
  assert.equal(terminal.diagnostic.assistantTurnMatched, true);
  assert.equal(terminal.remoteChatUrl, realChatUrl);
});

test("ChatGPT late assistant text (Flow B) waits for the markdown instead of emitting an empty terminal", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const doc = page.document;
  const [, userTurn, assistantTurn] = (() => {
    const tmp = doc.createElement("div");
    tmp.innerHTML = fixture;
    return [null, tmp.querySelector('[data-testid="conversation-turn-1"]'), tmp.querySelector('[data-testid="conversation-turn-2"]')];
  })();
  const actionBar = assistantTurn.querySelector('[aria-label="Response actions"]');
  actionBar.remove();
  assistantTurn.querySelector(".markdown").innerHTML = "";
  const thread = doc.createElement("div");
  thread.id = "thread";
  const clock = installClock(page, [
    { at: 0, run: () => {
      doc.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button" aria-label="Stop generating"></button>');
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 1 });
    } },
    { at: 3_000, run: () => {
      doc.body.prepend(thread);
      thread.append(userTurn, assistantTurn);
    } },
    { at: 8_000, run: () => {
      doc.querySelector('[data-testid="stop-button"]').remove();
      transport(page, { type: "SYNC_ZOTERO_SSE", text: "", done: true, activeStreamCount: 1 });
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 0 });
      assistantTurn.querySelector(".agent-turn").append(actionBar);
    } },
    { at: 14_000, run: () => {
      assistantTurn.querySelector(".markdown").innerHTML = `<p>${answer}</p>`;
    } },
  ]);
  const { events, port } = recorder(clock);
  await page.streamResponseSnapshots(port, 8, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 120_000);
  const terminals = events.filter((e) => e.type === "terminal");
  assert.equal(terminals.length, 1);
  const [terminal] = terminals;
  assert.ok(terminal.at >= 14_000, `terminal emitted at ${terminal.at} ms, before the markdown landed`);
  assert.equal(terminal.runState, "done");
  assert.equal(terminal.text, answer);
  assert.equal(terminal.diagnostic.reasonCode, "verified_done");
  assert.equal(terminal.diagnostic.userTurnMatched, true);
  assert.equal(terminal.diagnostic.assistantTurnMatched, true);
  const userMatched = events.find((e) => e.type === "turn_state" && e.turnStatus === "user_turn_matched");
  assert.ok(userMatched && userMatched.at >= 3_000 && userMatched.at < 8_000);
});

test("ChatGPT new user turns that do not match the prompt fail with user_turn_not_found", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const turn = (id, text) => `<section data-testid="conversation-turn-${id}" data-turn="user"><div data-message-author-role="user" data-message-id="other-user-${id}"><div class="whitespace-pre-wrap">${text}</div></div></section>`;
  const clock = installClock(page, [
    { at: 0, run: () => transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 1 }) },
    { at: 3_000, run: () => {
      page.document.body.insertAdjacentHTML("afterbegin", turn(1, "Translate this recipe into French for me") + turn(2, "What is the capital of Mongolia today"));
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 0 });
    } },
  ]);
  const { events, port } = recorder(clock);
  let thrown = null;
  await assert.rejects(
    page.streamResponseSnapshots(port, 9, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 120_000).catch((error) => { thrown = error; throw error; }),
    /Chat exposed 2 new user turn\(s\) after the baseline but none matched the submitted prompt, so delivery could not be verified\./,
  );
  assert.ok(clock.elapsed() > 30_000);
  assert.equal(thrown.reasonCode, "user_turn_not_found");
  assert.equal(thrown.diagnosticDetails.newMessages, 2);
  assert.equal(thrown.diagnosticDetails.userCandidates, 2);
  assert.equal(thrown.diagnosticDetails.roleNodesVisible, 2);
  assert.equal(thrown.diagnosticDetails.roleNodesTotal, 2);
  assert.ok(events.every((e) => e.type !== "terminal"));

  // The error port payload is built from the thrown error's reason and details.
  const diagnostic = page.buildDiagnostic({ phase: "error", reasonCode: thrown.reasonCode, message: thrown.message, clickAttempts: 1, ...thrown.diagnosticDetails });
  assert.equal(diagnostic.reasonCode, "user_turn_not_found");
  assert.equal(diagnostic.newMessages, 2);
  assert.equal(diagnostic.userCandidates, 2);
  assert.equal(diagnostic.roleNodesVisible, 2);
  assert.equal(diagnostic.roleNodesTotal, 2);
  assert.match(contentSource, /reasonCode: err\?\.reasonCode \|\| "pipeline_error"/);
  const start = backgroundSource.indexOf("function formatDiagnosticError(");
  const end = backgroundSource.indexOf("\n}", start) + 2;
  const bg = vm.createContext({});
  vm.runInContext(backgroundSource.slice(start, end), bg);
  const formatted = bg.formatDiagnosticError(thrown.message, { ...diagnostic, sendControlState: "not_found" });
  assert.match(formatted, /\(user_turn_not_found, phase=error, send=not_found, clicks=1, new=2, user_candidates=2, role_nodes=2\/2\)$/);
});

test("ChatGPT submit with no observed signal still fails at the 30 s user-turn deadline", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const clock = installClock(page, []);
  const { events, port } = recorder(clock);
  let thrown = null;
  await assert.rejects(
    page.streamResponseSnapshots(port, 10, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 120_000).catch((error) => { thrown = error; throw error; }),
    originalError,
  );
  assert.ok(clock.elapsed() > 30_000 && clock.elapsed() < 32_000);
  assert.equal(thrown.reasonCode, undefined);
  assert.ok(!debugEvents(page).includes("user_turn_pending_transcript"));
  assert.ok(events.every((e) => e.type !== "terminal"));
});

test("ChatGPT pending transcript that never mounts fails at the response deadline without an unverified terminal", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const clock = installClock(page, [
    { at: 0, run: () => transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 1 }) },
    { at: 5_000, run: () => {
      transport(page, { type: "SYNC_ZOTERO_SSE", text: answer, done: true, activeStreamCount: 1 });
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 0 });
    } },
  ]);
  const { events, port } = recorder(clock);
  let thrown = null;
  await assert.rejects(
    page.streamResponseSnapshots(port, 11, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 60_000).catch((error) => { thrown = error; throw error; }),
    originalError,
  );
  assert.ok(clock.elapsed() >= 60_000);
  assert.equal(thrown.reasonCode, "transcript_not_mounted");
  assert.ok(events.every((e) => e.type !== "terminal"));
});

function pendingTranscriptSteps(page, extra = []) {
  return [
    { at: 0, run: () => transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 1 }) },
    { at: 5_000, run: () => {
      transport(page, { type: "SYNC_ZOTERO_SSE", text: answer, done: true, activeStreamCount: 1 });
      transport(page, { type: "SYNC_ZOTERO_STREAM_STATE", activeCount: 0 });
    } },
    ...extra,
  ];
}

test("ChatGPT pending transcript that never mounts fails five minutes after entering the pending state", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const clock = installClock(page, pendingTranscriptSteps(page));
  const { events, port } = recorder(clock);
  let thrown = null;
  await assert.rejects(
    page.streamResponseSnapshots(port, 12, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 20 * 60_000).catch((error) => { thrown = error; throw error; }),
    originalError,
  );
  const pendingAt = events.find((e) => e.type === "turn_state" && e.diagnostic?.reasonCode === "transcript_not_mounted")?.at;
  assert.ok(pendingAt > 30_000 && pendingAt < 32_000);
  assert.ok(clock.elapsed() > pendingAt + 5 * 60_000);
  assert.ok(clock.elapsed() < pendingAt + 5 * 60_000 + 5_000);
  assert.equal(thrown.reasonCode, "transcript_not_mounted");
  assert.ok(events.every((e) => e.type !== "terminal"));
});

test("ChatGPT pending transcript that mounts within five minutes still completes", async () => {
  const page = content(composer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const mountAt = 31_000 + 4 * 60_000;
  const clock = installClock(page, pendingTranscriptSteps(page, [
    { at: 4_000, run: () => { page.window.location = new URL(realChatUrl); } },
    { at: mountAt, run: () => { page.document.body.innerHTML = fixture; } },
  ]));
  const { events, port } = recorder(clock);
  await page.streamResponseSnapshots(port, 13, 1, baseline, prompt, "|0", { clickAttempts: 1 }, 20 * 60_000);
  assert.equal(events.filter((e) => e.type === "turn_state" && e.diagnostic?.reasonCode === "transcript_not_mounted").length, 1);
  const terminals = events.filter((e) => e.type === "terminal");
  assert.equal(terminals.length, 1);
  assert.ok(terminals[0].at >= mountAt);
  assert.equal(terminals[0].runState, "done");
  assert.equal(terminals[0].text, answer);
  assert.equal(terminals[0].userTurnKey, "a3f0c2d4-user-0001");
});

const modernComposer = '<div role="textbox" contenteditable="true" data-composer-markdown aria-label="Ask ChatGPT"></div>';
const modeToggle = '<div role="group" aria-label="Composer mode"><button aria-pressed="false">Chat</button><button aria-pressed="true">Work</button></div>';

test("ChatGPT selects Chat before accepting the modern composer", async () => {
  const page = content(modeToggle + modernComposer);
  const chat = page.document.querySelector("button");
  let clicks = 0;
  chat.addEventListener("click", () => { clicks++; chat.setAttribute("aria-pressed", "true"); });
  installClock(page, []);
  await page.ensureChatGPTChatMode();
  await page.ensureChatGPTChatMode();
  assert.equal(clicks, 1);
});

test("ChatGPT refuses an unconfirmed mode or an existing Work conversation", async () => {
  const page = content(modeToggle + modernComposer);
  installClock(page, []);
  await assert.rejects(page.ensureChatGPTChatMode(() => true, 500), /did not confirm Chat mode/);
  const work = content(modernComposer.replace("Ask ChatGPT", "Work with ChatGPT"), realChatUrl);
  await assert.rejects(work.ensureChatGPTChatMode(), /Start a new WebChat/);
});

test("ChatGPT waits for hydration and aborts when the request is cancelled", async () => {
  const page = content(modeToggle.replaceAll('<button ', '<button disabled ') + modernComposer);
  const chat = page.document.querySelector("button");
  chat.addEventListener("click", () => chat.setAttribute("aria-pressed", "true"));
  installClock(page, [{at: 200, run: () => chat.removeAttribute("disabled")}]);
  await page.ensureChatGPTChatMode();
  await assert.rejects(page.ensureChatGPTChatMode(() => false));
});

test("ChatGPT modern transcript binds the answer and PDF without reasoning or file text in the prompt", () => {
  const html = `<div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="modern-user">
    <button aria-label="paper.pdf"></button><span title="paper.pdf">paper.pdf</span><span>PDF</span>
    <div data-user-message-bubble>${prompt}</div></div>
    <div data-chatgpt-search-unit-key="turn:1:reasoning">Do not return reasoning.</div>
    <div><div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="modern-answer modern-answer">
    <h4 class="sr-only">ChatGPT said:</h4><div data-markdown-text-style="assistant-message"><ul><li>${answer}</li><li>Second point.</li></ul></div></div>
    <button aria-label="Copy"></button></div>`;
  const page = content(html, realChatUrl);
  const transcript = page.extractConversationTranscript();
  assert.equal(transcript.count, 2);
  assert.equal(transcript.messages[0].text, prompt);
  assert.ok(transcript.messages[0].attachments.includes("paper.pdf"));
  assert.equal(transcript.messages[1].messageKey, "modern-answer");
  assert.match(transcript.messages[1].text, /Second point/);
  assert.doesNotMatch(transcript.messages[1].text, /ChatGPT said|reasoning/);
  assert.equal(page.resolveBoundAssistantTurn(transcript, "modern-user").messageKey, "modern-answer");
  assert.equal(page.hasResponseActionBar(), true);
});

test("ChatGPT modern DOM completes the response pipeline without a network transcript", async () => {
  const page = content(modernComposer, homeUrl);
  const baseline = page.extractConversationTranscript();
  const clock = installClock(page, [{at: 1000, run: () => {
    page.window.location = new URL(realChatUrl);
    page.document.body.insertAdjacentHTML("afterbegin", `<div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="new-user"><div data-user-message-bubble>${prompt}</div></div>
      <div class="group"><div><div><div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="new-answer"><div data-markdown-text-style="assistant-message"><p>${answer}</p></div></div></div></div><button aria-label="Copy"></button></div>`);
  }}]);
  const {events, port} = recorder(clock);
  await page.streamResponseSnapshots(port, 20, 1, baseline, prompt, "|0", {clickAttempts:1}, 60000);
  const terminals = events.filter(event => event.type === "terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].runState, "done");
  assert.equal(terminals[0].text, answer);
  assert.equal(terminals[0].diagnostic.reasonCode, "verified_done");
  assert.equal(terminals[0].assistantTurnKey, "new-answer");
});

test("ChatGPT does not reuse completion controls from an earlier modern answer", () => {
  const page = content(`<section><div><div data-chatgpt-search-unit-key="turn:0:assistant">Old answer</div><button aria-label="Copy"></button></div><div><div data-chatgpt-search-unit-key="turn:1:assistant">New answer still streaming</div></div></section>`, realChatUrl);
  assert.equal(page.hasResponseActionBar(), false);
});

test("ChatGPT counts nested legacy and modern markup as one message", () => {
  const page = content(`<div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="user-id"><div data-message-author-role="user" data-message-id="user-id"><div data-user-message-bubble>${prompt}</div></div></div>`, realChatUrl);
  assert.equal(page.extractConversationTranscript().count, 1);
});
