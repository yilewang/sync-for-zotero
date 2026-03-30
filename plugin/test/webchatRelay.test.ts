import { assert } from "chai";

type EndpointReply = [number, string | Record<string, string>, string?];

function parseJsonReply(reply: number | EndpointReply) {
  if (typeof reply === "number") {
    throw new Error(`Expected JSON reply tuple, received status ${reply}`);
  }
  return JSON.parse(reply[2] || "{}");
}

describe("webchat relay", function () {
  const originalZotero = globalThis.Zotero;
  const originalZtoolkit = (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit;
  let relay: typeof import("../src/webchat/relayServer");

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

  it("keeps poll_query non-consuming until a claim succeeds", function () {
    const submitted = relay.relaySubmitQuery({
      prompt: "hello",
      force_new_chat: true,
    });
    assert.isTrue(submitted.ok);

    const firstPoll = relay.relayPollQuery();
    const secondPoll = relay.relayPollQuery();
    const snapshot = relay.relayGetStateSnapshot();

    assert.equal(firstPoll.status, "pending");
    assert.equal(firstPoll.query?.seq, submitted.seq);
    assert.equal(firstPoll.query?.phase, "pending");
    assert.equal(firstPoll.query?.force_new_chat, true);
    assert.equal(secondPoll.status, "pending");
    assert.equal(secondPoll.query?.seq, submitted.seq);
    assert.equal(snapshot.status, "pending");
    assert.equal(snapshot.active_seq, 0);
    assert.equal(snapshot.query.phase, "pending");
  });

  it("claims queries atomically and rejects mismatched phases", function () {
    const submitted = relay.relaySubmitQuery({ prompt: "claim me" });
    assert.isTrue(submitted.ok);

    const claimed = relay.relayClaimQuery(submitted.seq);
    const duplicateClaim = relay.relayClaimQuery(submitted.seq);
    const badAck = relay.relayAckQueryPhase(submitted.seq, "submitted", 999);
    const snapshot = relay.relayGetStateSnapshot();

    assert.isTrue(claimed.ok);
    assert.equal(claimed.query?.attempt, 1);
    assert.equal(claimed.query?.phase, "claimed");
    assert.isFalse(duplicateClaim.ok);
    assert.equal(duplicateClaim.reason, "not_pending");
    assert.isFalse(badAck.ok);
    assert.equal(badAck.reason, "attempt_mismatch");
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.active_seq, submitted.seq);
    assert.equal(snapshot.active_attempt, 1);
  });

  it("reclaims stale pre-submit claims and increments the next attempt", function () {
    const originalNow = Date.now;
    try {
      const submitted = relay.relaySubmitQuery({ prompt: "stale claim" });
      assert.isTrue(submitted.ok);

      const claimed = relay.relayClaimQuery(submitted.seq);
      assert.isTrue(claimed.ok);

      const staleAt = originalNow() + 121_000;
      Date.now = () => staleAt;

      const pollAfterExpiry = relay.relayPollQuery();
      const reclaimed = relay.relayClaimQuery(submitted.seq);

      assert.equal(pollAfterExpiry.status, "pending");
      assert.equal(pollAfterExpiry.query?.phase, "pending");
      assert.isTrue(reclaimed.ok);
      assert.equal(reclaimed.query?.attempt, 2);
      assert.equal(reclaimed.query?.phase, "claimed");
    } finally {
      Date.now = originalNow;
    }
  });

  it("rejects wrong-attempt updates through the HTTP endpoint classes", async function () {
    const submitted = relay.relaySubmitQuery({
      prompt: "response guard",
      force_new_chat: true,
    });
    assert.isTrue(submitted.ok);

    const claimed = relay.relayClaimQuery(submitted.seq);
    assert.isTrue(claimed.ok);
    assert.equal(claimed.query?.force_new_chat, true);

    const UpdatePartial = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/update_partial"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };
    const SubmitResponse = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/submit_response"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };

    const partialReply = parseJsonReply(await new UpdatePartial().init({
      method: "POST",
      pathname: "/llm-for-zotero/webchat/update_partial",
      query: {},
      headers: {},
      data: { seq: submitted.seq, attempt: 999, text: "wrong" },
    }));
    const finalReply = parseJsonReply(await new SubmitResponse().init({
      method: "POST",
      pathname: "/llm-for-zotero/webchat/submit_response",
      query: {},
      headers: {},
      data: {
        seq: submitted.seq,
        attempt: claimed.query?.attempt,
        response: "ok",
        error: null,
      },
    }));

    assert.isFalse(partialReply.ok);
    assert.equal(partialReply.reason, "attempt_mismatch");
    assert.isTrue(finalReply.ok);
    assert.equal(relay.relayGetStateSnapshot().query.phase, "done");
  });

  it("tracks load-chat navigation targets and remote ready metadata", async function () {
    const UpdateHistory = globalThis.Zotero.Server.Endpoints[
      "/llm-for-zotero/webchat/update_chat_history"
    ] as new () => { init: (opts: unknown) => Promise<number | EndpointReply> };

    await new UpdateHistory().init({
      method: "POST",
      pathname: "/llm-for-zotero/webchat/update_chat_history",
      query: {},
      headers: {},
      data: {
        sessions: [
          {
            id: "chat-123",
            title: "Figure 4 follow-up",
            chatUrl: "https://chatgpt.com/c/chat-123",
          },
        ],
      },
    });

    const loaded = relay.relayLoadChat("chat-123");
    const navigating = relay.relayGetStateSnapshot();

    assert.isTrue(loaded.ok);
    assert.equal(navigating.turn_status, "navigating");
    assert.equal(navigating.remote_chat_url, "https://chatgpt.com/c/chat-123");
    assert.equal(navigating.remote_chat_id, "chat-123");
    assert.deepEqual(navigating.pendingCommand, {
      type: "LOAD_CHAT",
      chatUrl: "https://chatgpt.com/c/chat-123",
      chatId: "chat-123",
    });

    relay.relayUpdateTurnState({
      remote_chat_url: "https://chatgpt.com/c/chat-123",
      remote_chat_id: "chat-123",
      baseline_transcript_count: 8,
      baseline_transcript_hash: "hash-123",
      turn_status: "ready",
    });

    const ready = relay.relayGetStateSnapshot();
    assert.equal(ready.turn_status, "ready");
    assert.equal(ready.baseline_transcript_count, 8);
    assert.equal(ready.baseline_transcript_hash, "hash-123");
  });
});
