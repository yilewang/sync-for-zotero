import { assert } from "chai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const shared = require("../../extension/webchat_shared.js") as {
  TURN_COMPLETION_QUIET_WINDOW_MS: number;
  TURN_COMPLETION_REBOUND_WINDOW_MS: number;
  advanceTurnCompletionTracker: (
    tracker: unknown,
    sample: {
      nowMs: number;
      answerVisible?: boolean;
      thinkingVisible?: boolean;
      activeRun?: boolean;
      answerRevision?: number;
      thinkingRevision?: number;
      transcriptRevision?: number;
      hasUserTurn?: boolean;
      hasAssistantTurn?: boolean;
      forceIncomplete?: boolean;
    },
  ) => {
    tracker: unknown;
    phase: string;
    turnStatus: string;
    runState: string;
    emitDone: boolean;
    emitIncomplete: boolean;
    verificationForMs: number;
  };
  composerTextMatchesPrompt: (promptText: string, composerText: string) => boolean;
  createTurnCompletionTracker: (nowMs: number) => unknown;
  hasMeaningfulAssistantText: (text: string) => boolean;
  hasDeliverySignal: (snapshot: {
    baselineOutboundRequestSerial?: number;
    outboundRequestSerial?: number;
    baselineUserMessageCount?: number;
    userMessageCount?: number;
    stopButtonVisible?: boolean;
    composerTextAfter?: string;
    promptText?: string;
  }) => boolean;
  normalizeComposerText: (text: string) => string;
};

describe("webchat shared helpers", function () {
  it("normalizes composer text before matching a prompt", function () {
    assert.isTrue(
      shared.composerTextMatchesPrompt("Hello\n\nWorld", " Hello\n\nWorld "),
    );
    assert.equal(
      shared.normalizeComposerText("Hello\u00a0 \n\n\nWorld"),
      "Hello\n\nWorld",
    );
  });

  it("detects prompt mismatch after verification", function () {
    assert.isFalse(
      shared.composerTextMatchesPrompt("Exact prompt", "Different prompt"),
    );
  });

  it("filters assistant placeholder text from final-response detection", function () {
    assert.isFalse(shared.hasMeaningfulAssistantText("Thinking"));
    assert.isFalse(shared.hasMeaningfulAssistantText("Stopped thinking\nQuick answer"));
    assert.isFalse(shared.hasMeaningfulAssistantText("Thought for 22 seconds"));
    assert.isTrue(shared.hasMeaningfulAssistantText("Here is the real answer."));
  });

  it("treats outbound requests as delivery only after the composer stops holding the same prompt", function () {
    assert.isTrue(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 4,
      outboundRequestSerial: 5,
      baselineUserMessageCount: 1,
      userMessageCount: 1,
      stopButtonVisible: false,
      promptText: "Prompt still visible",
      composerTextAfter: "",
    }));

    assert.isFalse(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 4,
      outboundRequestSerial: 5,
      baselineUserMessageCount: 1,
      userMessageCount: 1,
      stopButtonVisible: false,
      promptText: "Prompt still visible",
      composerTextAfter: "Prompt still visible",
    }));

    assert.isTrue(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 2,
      outboundRequestSerial: 2,
      baselineUserMessageCount: 3,
      userMessageCount: 4,
      stopButtonVisible: false,
      promptText: "Prompt still visible",
      composerTextAfter: "Prompt still visible",
    }));
  });

  it("returns false when submit produced no observable delivery signal", function () {
    assert.isFalse(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 7,
      outboundRequestSerial: 7,
      baselineUserMessageCount: 2,
      userMessageCount: 2,
      stopButtonVisible: false,
      promptText: "Prompt still visible",
      composerTextAfter: "",
    }));

    assert.isFalse(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 7,
      outboundRequestSerial: 7,
      baselineUserMessageCount: 2,
      userMessageCount: 2,
      stopButtonVisible: false,
      promptText: "Prompt still visible",
      composerTextAfter: "Prompt still visible",
    }));
  });

  it("does not finalize when a long answer pauses briefly and then continues", function () {
    const start = 1_000;
    let tracker = shared.createTurnCompletionTracker(start);
    let step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 100,
      answerVisible: true,
      activeRun: true,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    tracker = step.tracker;

    step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 2_000,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    tracker = step.tracker;
    assert.equal(step.phase, "candidate_done");
    assert.isFalse(step.emitDone);

    step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 3_000,
      answerVisible: true,
      activeRun: true,
      answerRevision: 2,
      transcriptRevision: 2,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    assert.equal(step.phase, "active");
    assert.isFalse(step.emitDone);
  });

  it("does not finalize when active-run flickers off and then returns", function () {
    const start = 5_000;
    let tracker = shared.createTurnCompletionTracker(start);
    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 50,
      answerVisible: true,
      activeRun: true,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 500,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    const step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 900,
      answerVisible: true,
      activeRun: true,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    assert.equal(step.phase, "active");
    assert.equal(step.runState, "active");
    assert.isFalse(step.emitDone);
  });

  it("requires the full quiet and rebound windows before finalizing", function () {
    const start = 10_000;
    const quietWindow = shared.TURN_COMPLETION_QUIET_WINDOW_MS;
    const reboundWindow = shared.TURN_COMPLETION_REBOUND_WINDOW_MS;
    let tracker = shared.createTurnCompletionTracker(start);

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 100,
      answerVisible: true,
      activeRun: true,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    let step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200 + quietWindow - 100,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    tracker = step.tracker;
    assert.equal(step.phase, "candidate_done");
    assert.isFalse(step.emitDone);

    step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200 + quietWindow + reboundWindow - 200,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    tracker = step.tracker;
    assert.equal(step.phase, "candidate_done");
    assert.isFalse(step.emitDone);

    step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200 + quietWindow + reboundWindow + 100,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    assert.equal(step.phase, "verified_done");
    assert.equal(step.turnStatus, "done");
    assert.isTrue(step.emitDone);
  });

  it("resets completion verification when the transcript changes during the quiet window", function () {
    const start = 15_000;
    const quietWindow = shared.TURN_COMPLETION_QUIET_WINDOW_MS;
    let tracker = shared.createTurnCompletionTracker(start);

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 100,
      answerVisible: true,
      activeRun: true,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    tracker = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200 + quietWindow + 100,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 1,
      hasUserTurn: true,
      hasAssistantTurn: true,
    }).tracker;

    const step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: start + 200 + quietWindow + 400,
      answerVisible: true,
      activeRun: false,
      answerRevision: 1,
      transcriptRevision: 2,
      hasUserTurn: true,
      hasAssistantTurn: true,
    });
    assert.equal(step.phase, "candidate_done");
    assert.isFalse(step.emitDone);
    assert.equal(step.verificationForMs, 0);
  });

  it("marks the tracker incomplete without emitting done when forced", function () {
    const tracker = shared.createTurnCompletionTracker(20_000);
    const step = shared.advanceTurnCompletionTracker(tracker, {
      nowMs: 20_500,
      answerVisible: true,
      activeRun: true,
      answerRevision: 3,
      transcriptRevision: 3,
      hasUserTurn: true,
      hasAssistantTurn: true,
      forceIncomplete: true,
    });
    assert.equal(step.phase, "incomplete");
    assert.equal(step.runState, "incomplete");
    assert.equal(step.turnStatus, "incomplete");
    assert.isFalse(step.emitDone);
    assert.isTrue(step.emitIncomplete);
  });
});
