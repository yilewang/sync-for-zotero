import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");

test("classifies Chrome message-channel lifecycle failures as recoverable", () => {
  const messages = [
    "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
    "The message port closed before a response was received.",
    "Could not establish connection. Receiving end does not exist.",
    "Frame with ID 0 was removed.",
  ];

  for (const message of messages) {
    assert.equal(
      shared.isRecoverableContentScriptMessageError(new Error(message)),
      true,
      message,
    );
  }
});

test("does not misclassify ordinary readiness or network failures", () => {
  const messages = [
    "Timed out waiting for the conversation to become ready.",
    "Failed to fetch",
    "ChatGPT did not produce a visible final answer.",
  ];

  for (const message of messages) {
    assert.equal(
      shared.isRecoverableContentScriptMessageError(new Error(message)),
      false,
      message,
    );
  }
});

test("treats a closed tab as terminal for that tab identity", () => {
  assert.deepEqual(
    shared.classifyContentScriptMessageError(
      new Error("No tab with id: 42."),
    ),
    {
      code: "tab_unavailable",
      recoverable: false,
      message: "No tab with id: 42.",
    },
  );
});

test("retries only idempotent content-script messages", () => {
  for (const type of [
    "HEALTH_CHECK",
    "WAIT_FOR_CHAT_READY",
    "SCRAPE_HISTORY_NOW",
    "SCRAPE_MESSAGES",
    "RESET_NETWORK_CACHE",
  ]) {
    assert.equal(shared.isRetrySafeContentScriptMessage({ type }), true, type);
  }

  for (const type of ["START", "STOP", "NAVIGATE", "DELETE_CHAT"]) {
    assert.equal(shared.isRetrySafeContentScriptMessage({ type }), false, type);
  }
});

test("returns a stable message response without invoking recovery", async () => {
  let sendAttempts = 0;
  let recoveries = 0;

  const result = await shared.retryRecoverableContentScriptMessage({
    maxAttempts: 3,
    sendAttempt: async () => {
      sendAttempts += 1;
      return { ok: true, ready: true };
    },
    recover: async () => {
      recoveries += 1;
    },
  });

  assert.deepEqual(result, { ok: true, ready: true });
  assert.equal(sendAttempts, 1);
  assert.equal(recoveries, 0);
});

test("recovers a closed message channel and retries the read-only operation", async () => {
  let sendAttempts = 0;
  let recoveries = 0;

  const result = await shared.retryRecoverableContentScriptMessage({
    maxAttempts: 3,
    sendAttempt: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error(
          "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
        );
      }
      return { ok: true };
    },
    recover: async ({ attempt, nextAttempt }) => {
      recoveries += 1;
      assert.equal(attempt, 1);
      assert.equal(nextAttempt, 2);
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(sendAttempts, 2);
  assert.equal(recoveries, 1);
});

test("does not retry non-lifecycle failures", async () => {
  let sendAttempts = 0;
  let recoveries = 0;

  await assert.rejects(
    shared.retryRecoverableContentScriptMessage({
      maxAttempts: 3,
      sendAttempt: async () => {
        sendAttempts += 1;
        throw new Error("Timed out waiting for the conversation to become ready.");
      },
      recover: async () => {
        recoveries += 1;
      },
    }),
    /Timed out waiting/,
  );

  assert.equal(sendAttempts, 1);
  assert.equal(recoveries, 0);
});

test("does not retry when the target tab disappeared during recovery", async () => {
  let sendAttempts = 0;

  await assert.rejects(
    shared.retryRecoverableContentScriptMessage({
      maxAttempts: 3,
      sendAttempt: async () => {
        sendAttempts += 1;
        throw new Error(
          "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
        );
      },
      recover: async () => {
        throw new Error("No tab with id: 42.");
      },
    }),
    /No tab with id/,
  );

  assert.equal(sendAttempts, 1);
});

test("bounds recovery attempts and preserves the terminal channel error", async () => {
  let sendAttempts = 0;
  let recoveries = 0;
  const channelError =
    "Could not establish connection. Receiving end does not exist.";

  await assert.rejects(
    shared.retryRecoverableContentScriptMessage({
      maxAttempts: 3,
      sendAttempt: async () => {
        sendAttempts += 1;
        throw new Error(channelError);
      },
      recover: async () => {
        recoveries += 1;
      },
    }),
    new RegExp(channelError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  assert.equal(sendAttempts, 3);
  assert.equal(recoveries, 2);
});

test("does not block a usable tab on Chrome's coarse loading status", () => {
  assert.equal(
    shared.tabNeedsLifecycleReload({
      discarded: false,
      status: "loading",
    }),
    false,
  );
  assert.equal(
    shared.tabNeedsLifecycleReload({
      discarded: true,
      status: "complete",
    }),
    true,
  );
});

test("activates an inactive chat tab before relying on its rendered text", () => {
  assert.equal(shared.tabNeedsActivation({ active: false }), true);
  assert.equal(shared.tabNeedsActivation({ active: true }), false);
});

test("does not shorten completion timing from the action bar alone", () => {
  assert.deepEqual(
    shared.completionTimingForSignals({
      actionBarVisible: true,
      answerVisible: true,
      toolUseDetected: false,
      sseDone: false,
      activeConversationStreamCount: 0,
    }),
    {
      quietWindowMs: shared.TURN_COMPLETION_QUIET_WINDOW_MS,
      reboundWindowMs: shared.TURN_COMPLETION_REBOUND_WINDOW_MS,
    },
  );
});

test("rejects a growing answer prefix as a stable terminal snapshot", () => {
  assert.equal(
    shared.terminalAnswerSnapshotIsStable(
      {
        text: "ACK SYNC_E2E_DISCARDED",
        assistantTurnKey: "assistant-1",
      },
      {
        text: "ACK SYNC_E2E_DISCARDED_TAB_20260726_F",
        assistantTurnKey: "assistant-1",
      },
    ),
    false,
  );
  assert.equal(
    shared.terminalAnswerSnapshotIsStable(
      {
        text: "ACK SYNC_E2E_DISCARDED_TAB_20260726_F",
        assistantTurnKey: "assistant-1",
      },
      {
        text: "ACK SYNC_E2E_DISCARDED_TAB_20260726_F",
        assistantTurnKey: "assistant-1",
      },
    ),
    true,
  );
});
