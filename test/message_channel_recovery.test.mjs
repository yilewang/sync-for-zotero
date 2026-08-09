import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");
const backgroundSource = fs.readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
const contentScriptSource = fs.readFileSync(
  new URL("../extension/content_script.js", import.meta.url),
  "utf8",
);
const popupSource = fs.readFileSync(
  new URL("../extension/popup.js", import.meta.url),
  "utf8",
);

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

test("tracks an active relay attempt and rejects terminal or superseded leases", () => {
  assert.deepEqual(
    shared.classifyRelayAttemptState(
      {
        status: "running",
        current_seq: 17,
        current_attempt: 3,
        responses: [],
      },
      { seq: 17, attempt: 3 },
    ),
    {
      active: true,
      reason: null,
      error: null,
      completionReason: null,
    },
  );

  assert.deepEqual(
    shared.classifyRelayAttemptState(
      {
        status: "error",
        current_seq: 17,
        current_attempt: 3,
        responses: [
          {
            seq: 17,
            attempt: 3,
            error: "provider timed out",
            completion_reason: "timeout",
          },
        ],
      },
      { seq: 17, attempt: 3 },
    ),
    {
      active: false,
      reason: "terminal_response",
      error: "provider timed out",
      completionReason: "timeout",
    },
  );

  assert.equal(
    shared.classifyRelayAttemptState(
      {
        status: "running",
        current_seq: 18,
        current_attempt: 1,
        responses: [],
      },
      { seq: 17, attempt: 3 },
    ).reason,
    "seq_mismatch",
  );
  assert.equal(
    shared.classifyRelayAttemptState(
      {
        status: "running",
        current_seq: 17,
        current_attempt: 4,
        responses: [],
      },
      { seq: 17, attempt: 3 },
    ).reason,
    "attempt_mismatch",
  );
});

test("requires terminal evidence before DeepSeek quiescence can finish a turn", () => {
  const candidate = {
    siteId: "deepseek",
    activeRun: false,
    stopControlVisible: false,
    busyComposer: false,
    hasRequestContext: true,
    hasAssistantTurn: true,
    attachmentContractVerified: true,
    quietSinceMs: 20_000,
    quietThresholdMs: 1_500,
    completionPhase: "candidate_done",
  };

  assert.equal(
    shared.canUseDeepSeekQuiescentCompletion({
      ...candidate,
      terminalEvidence: false,
    }),
    false,
  );
  assert.equal(
    shared.canUseDeepSeekQuiescentCompletion({
      ...candidate,
      terminalEvidence: true,
    }),
    true,
  );
});

test("stops the exact submitted attempt before a local pipeline abort", async () => {
  const messages = [];
  const stopped = await shared.stopSubmittedProviderAttempt({
    submitted: true,
    seq: 41,
    attempt: 3,
    sendStop: (message, complete) => {
      messages.push(message);
      complete({ ok: true });
    },
  });

  assert.deepEqual(messages, [{ type: "STOP", seq: 41, attempt: 3 }]);
  assert.deepEqual(stopped, { requested: true, acknowledged: true });

  let preSubmitStopCount = 0;
  const skipped = await shared.stopSubmittedProviderAttempt({
    submitted: false,
    seq: 42,
    attempt: 1,
    sendStop: () => {
      preSubmitStopCount += 1;
    },
  });
  assert.equal(preSubmitStopCount, 0);
  assert.deepEqual(skipped, { requested: false, acknowledged: false });
});

test("stops the matching provider attempt after a submitted port disconnect", async () => {
  const attemptToken = shared.attemptToken(41, 3);
  let currentAttemptToken = attemptToken;
  let nowMs = 0;
  let stopControlVisible = false;
  let clickCount = 0;

  const stopped = await shared.stopDisconnectedProviderAttempt({
    attemptToken,
    isAttemptCurrent: (token) => currentAttemptToken === token,
    findStopControl: () => stopControlVisible ? { attemptToken } : null,
    clickStopControl: (control) => {
      assert.equal(control.attemptToken, attemptToken);
      clickCount += 1;
      currentAttemptToken = null;
    },
    wait: async (ms) => {
      nowMs += ms;
      stopControlVisible = nowMs >= 200;
    },
    now: () => nowMs,
    timeoutMs: 1000,
    pollIntervalMs: 100,
  });

  assert.deepEqual(stopped, {
    requested: true,
    acknowledged: true,
    attempts: 3,
  });
  assert.equal(clickCount, 1);

  const disconnectStart = contentScriptSource.indexOf(
    "port.onDisconnect.addListener(() => {",
    contentScriptSource.indexOf('port.name !== "sync-zotero"'),
  );
  const disconnectEnd = contentScriptSource.indexOf(
    "port.onMessage.addListener(async (msg) => {",
    disconnectStart,
  );
  const disconnectSource = contentScriptSource.slice(
    disconnectStart,
    disconnectEnd,
  );
  assert.match(
    disconnectSource,
    /portProviderMayBeRunning && !portTerminalPosted/,
  );
  assert.match(
    disconnectSource,
    /stopDisconnectedSyncZoteroAttempt\(portAttemptToken\)/,
  );

  const terminalEmitterStart = contentScriptSource.indexOf(
    "const emitTerminal = (payload) => {",
  );
  const terminalEmitterEnd = contentScriptSource.indexOf(
    "};",
    terminalEmitterStart,
  );
  const terminalEmitterSource = contentScriptSource.slice(
    terminalEmitterStart,
    terminalEmitterEnd,
  );
  assert.ok(
    terminalEmitterSource.indexOf("onTerminalPosted()") <
      terminalEmitterSource.indexOf("postTerminal(port, payload)"),
  );
});

test("does not stop a superseding provider attempt", async () => {
  const disconnectedToken = shared.attemptToken(41, 3);
  const supersedingToken = shared.attemptToken(42, 1);
  const currentAttemptToken = supersedingToken;
  let nowMs = 0;
  let clickCount = 0;

  const staleStop = await shared.stopDisconnectedProviderAttempt({
    attemptToken: disconnectedToken,
    isAttemptCurrent: (token) => currentAttemptToken === token,
    findStopControl: () => ({ attemptToken: currentAttemptToken }),
    clickStopControl: () => {
      clickCount += 1;
    },
    wait: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    timeoutMs: 1000,
  });
  assert.deepEqual(staleStop, {
    requested: true,
    acknowledged: false,
    attempts: 0,
  });
  assert.equal(clickCount, 0);
});

test("bounds disconnected-attempt stop polling", async () => {
  const attemptToken = shared.attemptToken(43, 1);
  let nowMs = 0;

  const stopped = await shared.stopDisconnectedProviderAttempt({
    attemptToken,
    isAttemptCurrent: (token) => token === attemptToken,
    findStopControl: () => null,
    clickStopControl: () => assert.fail("no stop control should be clicked"),
    wait: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    timeoutMs: 250,
    pollIntervalMs: 100,
  });

  assert.equal(nowMs, 250);
  assert.deepEqual(stopped, {
    requested: true,
    acknowledged: false,
    attempts: 4,
  });
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

test("waits for the matching durable phase acknowledgement before continuing", async () => {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  const postedMessages = [];
  const port = {
    onMessage: {
      addListener: (listener) => messageListeners.add(listener),
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
    postMessage: (message) => postedMessages.push(message),
  };

  let sideEffectAllowed = false;
  const gatedSideEffect = shared
    .postPhaseAndWaitForAck(port, {
      seq: 41,
      attempt: 2,
      phase: "submit_started",
      diagnostic: { composerTextMatched: true },
      timeoutMs: 1_000,
    })
    .then(() => {
      sideEffectAllowed = true;
    });

  await Promise.resolve();
  assert.equal(sideEffectAllowed, false);
  assert.deepEqual(postedMessages, [
    {
      type: "phase",
      seq: 41,
      attempt: 2,
      phase: "submit_started",
      diagnostic: { composerTextMatched: true },
    },
  ]);

  for (const listener of messageListeners) {
    listener({
      type: "phase_ack",
      seq: 41,
      attempt: 1,
      phase: "submit_started",
    });
  }
  await Promise.resolve();
  assert.equal(sideEffectAllowed, false);

  for (const listener of messageListeners) {
    listener({
      type: "phase_ack",
      seq: 41,
      attempt: 2,
      phase: "submit_started",
    });
  }
  await gatedSideEffect;

  assert.equal(sideEffectAllowed, true);
  assert.equal(messageListeners.size, 0);
  assert.equal(disconnectListeners.size, 0);
});

test("orders the durable submit handshake before the send side effect", () => {
  const pipelineStart = contentScriptSource.indexOf(
    "await typePromptAndVerify(msg.prompt",
  );
  const pipelineEnd = contentScriptSource.indexOf(
    "await streamResponseSnapshots(",
    pipelineStart,
  );
  const pipelineSource = contentScriptSource.slice(pipelineStart, pipelineEnd);
  const promptAppliedIndex = pipelineSource.indexOf(
    'phase: "prompt_applied"',
  );
  const submitStartedIndex = pipelineSource.indexOf(
    'phase: "submit_started"',
  );
  const sendSideEffectIndex = pipelineSource.indexOf(
    "const submission = await submitMessageAndVerify(",
  );

  assert.ok(pipelineStart >= 0);
  assert.ok(pipelineEnd > pipelineStart);
  assert.ok(promptAppliedIndex >= 0);
  assert.ok(submitStartedIndex > promptAppliedIndex);
  assert.ok(sendSideEffectIndex > submitStartedIndex);
  assert.match(
    pipelineSource,
    /await shared\.postPhaseAndWaitForAck\(port, \{[\s\S]*phase: "submit_started"/,
  );

  const durableAckStart = backgroundSource.indexOf(
    "const requiresDurableAck =",
  );
  const durableAckEnd = backgroundSource.indexOf(
    '} else if (msg.type === "turn_state")',
    durableAckStart,
  );
  const durableAckSource = backgroundSource.slice(
    durableAckStart,
    durableAckEnd,
  );
  const relayAckIndex = durableAckSource.indexOf("await ackQueryPhase(");
  const portAckIndex = durableAckSource.indexOf('type: "phase_ack"');

  assert.ok(durableAckStart >= 0);
  assert.ok(durableAckEnd > durableAckStart);
  assert.match(durableAckSource, /msg\.phase === "submit_started"/);
  assert.ok(relayAckIndex >= 0);
  assert.ok(portAckIndex > relayAckIndex);
});

test("refreshes the popup relay indicator after connection recovery", () => {
  assert.match(
    backgroundSource,
    /type: "STATUS_UPDATE",[\s\S]*relayAlive: zoteroConnected/,
  );
  assert.match(
    popupSource,
    /typeof msg\.relayAlive === "boolean"[\s\S]*setIndicator\([\s\S]*msg\.relayAlive/,
  );
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

test("uses a short verification window only for combined terminal signals", () => {
  const strongSignal = {
    sseDone: false,
    transportObserved: true,
    activeConversationStreamCount: 0,
    actionBarVisible: true,
    stopButtonVisible: false,
    busyComposer: false,
  };

  assert.equal(
    shared.hasStrongTransportCompletionSignal(strongSignal),
    true,
  );
  assert.equal(
    shared.hasStrongTransportCompletionSignal({
      ...strongSignal,
      stopButtonVisible: true,
    }),
    false,
  );
  assert.equal(
    shared.hasStrongTransportCompletionSignal({
      ...strongSignal,
      actionBarVisible: false,
    }),
    false,
  );
  assert.equal(
    shared.hasStrongTransportCompletionSignal({
      ...strongSignal,
      transportObserved: false,
    }),
    false,
  );
  assert.deepEqual(
    shared.completionTimingForSignals({
      ...strongSignal,
      strongTransportCompletion: true,
      answerVisible: true,
      toolUseDetected: false,
    }),
    {
      quietWindowMs: 500,
      reboundWindowMs: 250,
    },
  );
});

test("requires ChatGPT's rendered terminal controls before declaring success", () => {
  const base = {
    siteId: "chatgpt",
    activeConversationStreamCount: 0,
    stopButtonVisible: false,
    busyComposer: false,
  };

  assert.equal(
    shared.hasVerifiedTerminalEvidence({
      ...base,
      sseDone: true,
      actionBarVisible: false,
    }),
    false,
  );
  assert.equal(
    shared.hasVerifiedTerminalEvidence({
      ...base,
      sseDone: true,
      actionBarVisible: true,
    }),
    true,
  );
  assert.equal(
    shared.hasVerifiedTerminalEvidence({
      ...base,
      sseDone: true,
      actionBarVisible: true,
      stopButtonVisible: true,
    }),
    false,
  );
});

test("keeps a stable answer prefix active without terminal UI evidence", () => {
  const tracker = shared.createTurnCompletionTracker(0);
  const result = shared.advanceTurnCompletionTracker(tracker, {
    nowMs: 60_000,
    answerVisible: true,
    activeRun: false,
    answerRevision: 1,
    transcriptRevision: 1,
    hasUserTurn: true,
    hasAssistantTurn: true,
    terminalEvidence: false,
    quietWindowMs: 500,
    reboundWindowMs: 250,
  });

  assert.equal(result.phase, "active");
  assert.equal(result.runState, "active");
  assert.equal(result.emitDone, false);
});

test("only settles a stable answer after terminal UI evidence", () => {
  let tracker = shared.createTurnCompletionTracker(0);
  tracker = shared.advanceTurnCompletionTracker(tracker, {
    nowMs: 1_000,
    answerVisible: true,
    activeRun: false,
    answerRevision: 1,
    transcriptRevision: 1,
    hasUserTurn: true,
    hasAssistantTurn: true,
    terminalEvidence: true,
    quietWindowMs: 500,
    reboundWindowMs: 250,
  }).tracker;
  tracker = shared.advanceTurnCompletionTracker(tracker, {
    nowMs: 1_600,
    answerVisible: true,
    activeRun: false,
    answerRevision: 1,
    transcriptRevision: 1,
    hasUserTurn: true,
    hasAssistantTurn: true,
    terminalEvidence: true,
    quietWindowMs: 500,
    reboundWindowMs: 250,
  }).tracker;
  const result = shared.advanceTurnCompletionTracker(tracker, {
    nowMs: 1_900,
    answerVisible: true,
    activeRun: false,
    answerRevision: 1,
    transcriptRevision: 1,
    hasUserTurn: true,
    hasAssistantTurn: true,
    terminalEvidence: true,
    quietWindowMs: 500,
    reboundWindowMs: 250,
  });

  assert.equal(result.phase, "verified_done");
  assert.equal(result.runState, "done");
  assert.equal(result.emitDone, true);
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

test("never auto-cancels a quiet active provider response", () => {
  const streamStart = contentScriptSource.indexOf(
    "async function streamResponseSnapshots(",
  );
  const streamEnd = contentScriptSource.indexOf(
    "// ---------------------------------------------------------------------------\n// Step 5:",
    streamStart,
  );
  const streamSource = contentScriptSource.slice(streamStart, streamEnd);

  assert.ok(streamStart >= 0);
  assert.ok(streamEnd > streamStart);
  assert.doesNotMatch(streamSource, /stopBtn\?\.click\?\.\(\)/);
  assert.doesNotMatch(streamSource, /forced_cancel_attempt/);
  assert.match(
    streamSource,
    /never click Stop from\s*\/\/ an inactivity heuristic/,
  );
});

test("ends stale content work when the relay attempt or port ends", () => {
  assert.match(
    backgroundSource,
    /classifyRelayAttemptState\(state, \{[\s\S]*seq: payload\.seq,[\s\S]*attempt: payload\.attempt/,
  );
  assert.match(
    backgroundSource,
    /error\.name = "RelayAttemptEnded";[\s\S]*await failPipeline\(error\)/,
  );
  assert.match(
    backgroundSource,
    /relayWatchdogFailureCount >=[\s\S]*await failPipeline/,
  );
  assert.match(
    backgroundSource,
    /relayPostFailureCount >= 3[\s\S]*await failPipeline/,
  );
  assert.match(
    contentScriptSource,
    /const isPipelineCurrent = \(\) =>[\s\S]*_syncZoteroAttemptToken === portAttemptToken/,
  );
  assert.match(
    contentScriptSource,
    /while \(Date\.now\(\) < deadline\) \{\s*assertPipelineCurrent\(isPipelineCurrent\)/,
  );
  assert.match(
    contentScriptSource,
    /if \(err\?\.name === "PipelineCancelled"\) return;/,
  );
});

test("extracts only visible turns and preserves live answer content", () => {
  const assistantNodesStart = contentScriptSource.indexOf(
    "function getAssistantMessageNodes()",
  );
  const assistantNodesEnd = contentScriptSource.indexOf(
    "function getUserMessageCount()",
    assistantNodesStart,
  );
  const transcriptNodesStart = contentScriptSource.indexOf(
    "function getConversationMessageNodes()",
  );
  const transcriptNodesEnd = contentScriptSource.indexOf(
    "function buildTranscriptMessageKey(",
    transcriptNodesStart,
  );
  const pruneStart = contentScriptSource.indexOf(
    "function pruneAssistantStatusNodes(",
  );
  const pruneEnd = contentScriptSource.indexOf(
    "function extractAssistantThinkingText(",
    pruneStart,
  );

  assert.match(
    contentScriptSource.slice(assistantNodesStart, assistantNodesEnd),
    /!isVisibleElement\(node\)/,
  );
  assert.match(
    contentScriptSource.slice(transcriptNodesStart, transcriptNodesEnd),
    /!isVisibleElement\(node\)/,
  );
  assert.doesNotMatch(
    contentScriptSource.slice(pruneStart, pruneEnd),
    /\[aria-live\]/,
  );
});
