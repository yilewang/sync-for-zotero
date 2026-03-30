import { assert } from "chai";

type EndpointReply = [number, string | Record<string, string>, string?];

describe("webchat client", function () {
  const originalZotero = globalThis.Zotero;
  const originalZtoolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit;
  let relay: typeof import("../src/webchat/relayServer");
  let client: typeof import("../src/webchat/client");

  before(async function () {
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => (key === "httpServer.port" ? 23119 : undefined),
      },
      Server: {
        Endpoints: {},
      },
    } as typeof Zotero;
    (globalThis as typeof globalThis & { ztoolkit: { log: (...args: unknown[]) => void } }).ztoolkit = {
      log: () => undefined,
    };

    relay = await import("../src/webchat/relayServer");
    client = await import("../src/webchat/client");
    relay.registerWebChatRelay();
  });

  after(function () {
    relay.unregisterWebChatRelay();
    globalThis.Zotero = originalZotero;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  beforeEach(function () {
    relay.relayResetForTests();
  });

  it("waits for the explicit final response instead of promoting a stale partial", async function () {
    this.timeout(10_000);

    const submitted = await client.submitQuery(
      "http://unused",
      "can you explain figure 1?",
      null,
      null,
    );
    const claimed = relay.relayClaimQuery(submitted.seq);
    assert.isTrue(claimed.ok);
    const attempt = claimed.query?.attempt || 0;

    const UpdatePartial = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/update_partial"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };
    const SubmitResponse = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/submit_response"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };

    const partialText = "I need to base my answer on the file and figure 1.";
    const finalText = "Yes. Figure 1 is basically the paper's roadmap.";
    const snapshots: string[] = [];
    const startedAt = Date.now();

    const pollPromise = client.pollForResponse(
      "http://unused",
      submitted.seq,
      (text) => {
        snapshots.push(text);
      },
      undefined,
      undefined,
    );

    setTimeout(() => {
      void new UpdatePartial().init({
        method: "POST",
        pathname: "/llm-for-zotero/webchat/update_partial",
        query: {},
        headers: {},
        data: {
          seq: submitted.seq,
          attempt,
          text: partialText,
          remote_chat_url: "https://chatgpt.com/c/chat-1",
          remote_chat_id: "chat-1",
          user_turn_key: "user-turn-1",
          assistant_turn_key: "assistant-turn-1",
          baseline_transcript_count: 4,
          baseline_transcript_hash: "baseline-hash-1",
          turn_status: "assistant_turn_matched",
        },
      });
    }, 100);

    setTimeout(() => {
      void new SubmitResponse().init({
        method: "POST",
        pathname: "/llm-for-zotero/webchat/submit_response",
        query: {},
        headers: {},
        data: {
          seq: submitted.seq,
          attempt,
          response: finalText,
          error: null,
          remote_chat_url: "https://chatgpt.com/c/chat-1",
          remote_chat_id: "chat-1",
          user_turn_key: "user-turn-1",
          assistant_turn_key: "assistant-turn-1",
          baseline_transcript_count: 4,
          baseline_transcript_hash: "baseline-hash-1",
          turn_status: "done",
        },
      });
    }, 4_200);

    const result = await pollPromise;

    assert.equal(result.text, finalText);
    assert.equal(result.runState, "done");
    assert.equal(result.completionReason, "settled");
    assert.equal(result.remoteChatUrl, "https://chatgpt.com/c/chat-1");
    assert.equal(result.remoteChatId, "chat-1");
    assert.equal(result.userTurnKey, "user-turn-1");
    assert.equal(result.assistantTurnKey, "assistant-turn-1");
    assert.equal(result.turnStatus, "done");
    assert.isAtLeast(Date.now() - startedAt, 4_000);
    assert.deepEqual(snapshots, [partialText, finalText]);
  });

  it("surfaces incomplete runs without promoting them to successful finals", async function () {
    this.timeout(10_000);

    const submitted = await client.submitQuery(
      "http://unused",
      "summarize the paper",
      null,
      null,
    );
    const claimed = relay.relayClaimQuery(submitted.seq);
    assert.isTrue(claimed.ok);
    const attempt = claimed.query?.attempt || 0;

    const UpdatePartial = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/update_partial"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };
    const SubmitResponse = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/submit_response"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };

    const partialText = "Here is the first visible part of the answer.";
    const thinkingSnapshots: string[] = [];
    const answerSnapshots: string[] = [];

    const pollPromise = client.pollForResponse(
      "http://unused",
      submitted.seq,
      (text) => {
        answerSnapshots.push(text);
      },
      (text) => {
        thinkingSnapshots.push(text);
      },
      undefined,
    );

    setTimeout(() => {
      void new UpdatePartial().init({
        method: "POST",
        pathname: "/llm-for-zotero/webchat/update_partial",
        query: {},
        headers: {},
        data: {
          seq: submitted.seq,
          attempt,
          text: partialText,
          thinking: "Inspecting the paper",
          answer_revision: 1,
          thinking_revision: 1,
          run_state: "active",
        },
      });
    }, 100);

    setTimeout(() => {
      void new SubmitResponse().init({
        method: "POST",
        pathname: "/llm-for-zotero/webchat/submit_response",
        query: {},
        headers: {},
        data: {
          seq: submitted.seq,
          attempt,
          response: partialText,
          thinking: "Inspecting the paper",
          error: null,
          answer_revision: 1,
          thinking_revision: 1,
          run_state: "incomplete",
          completion_reason: "timeout",
        },
      });
    }, 500);

    const result = await pollPromise;

    assert.equal(result.runState, "incomplete");
    assert.equal(result.completionReason, "timeout");
    assert.equal(result.text, partialText);
    assert.deepEqual(answerSnapshots, [partialText, partialText]);
    assert.deepEqual(thinkingSnapshots, ["Inspecting the paper"]);
  });

  it("waits for remote ready after a new-chat navigation", async function () {
    this.timeout(10_000);

    await client.sendNewChat("http://unused");

    setTimeout(() => {
      relay.relayUpdateTurnState({
        remote_chat_url: "https://chatgpt.com/",
        remote_chat_id: null,
        baseline_transcript_count: 0,
        baseline_transcript_hash: "empty",
        turn_status: "ready",
      });
    }, 300);

    const ready = await client.waitForRemoteReadyIfNavigating("http://unused");
    assert.equal(ready.turnStatus, "ready");
    assert.equal(ready.remoteChatUrl, "https://chatgpt.com/");
    assert.equal(ready.baselineTranscriptHash, "empty");
  });

  it("loads a chat session only after the extension reports ready and scraped transcript", async function () {
    this.timeout(10_000);

    const UpdateHistory = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/update_chat_history"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };
    const ChatHistory = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/chat_history"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };

    await new UpdateHistory().init({
      method: "POST",
      pathname: "/llm-for-zotero/webchat/update_chat_history",
      query: {},
      headers: {},
      data: {
        sessions: [
          {
            id: "chat-xyz",
            title: "Loaded chat",
            chatUrl: "https://chatgpt.com/c/chat-xyz",
          },
        ],
      },
    });

    const loadPromise = client.loadChatSession("http://unused", "chat-xyz");

    setTimeout(() => {
      relay.relayUpdateTurnState({
        remote_chat_url: "https://chatgpt.com/c/chat-xyz",
        remote_chat_id: "chat-xyz",
        baseline_transcript_count: 2,
        baseline_transcript_hash: "hash-xyz",
        turn_status: "ready",
      });
      void new ChatHistory().init({
        method: "POST",
        pathname: "/llm-for-zotero/webchat/chat_history",
        query: {},
        headers: {},
        data: {
          action: "submit_scraped",
          messages: [
            { role: "user", text: "hello" },
            {
              role: "assistant",
              text: "hi there",
              thinking: "Inspecting the transcript",
            },
          ],
        },
      });
    }, 250);

    const loaded = await loadPromise;
    assert.isNotNull(loaded);
    assert.deepEqual(loaded?.messages.map((message) => message.kind), [
      "user",
      "bot",
    ]);
    assert.equal(loaded?.messages[1].thinking, "Inspecting the transcript");
  });
});
