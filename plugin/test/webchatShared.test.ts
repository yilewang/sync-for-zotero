import { assert } from "chai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const shared = require("../../extension/webchat_shared.js") as {
  composerTextMatchesPrompt: (promptText: string, composerText: string) => boolean;
  hasMeaningfulAssistantText: (text: string) => boolean;
  hasDeliverySignal: (snapshot: {
    baselineOutboundRequestSerial?: number;
    outboundRequestSerial?: number;
    baselineUserMessageCount?: number;
    userMessageCount?: number;
    stopButtonVisible?: boolean;
    composerTextAfter?: string;
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

  it("treats outbound requests and visible composer transitions as delivery signals", function () {
    assert.isTrue(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 4,
      outboundRequestSerial: 5,
      baselineUserMessageCount: 1,
      userMessageCount: 1,
      stopButtonVisible: false,
      composerTextAfter: "Prompt still visible",
    }));

    assert.isTrue(shared.hasDeliverySignal({
      baselineOutboundRequestSerial: 2,
      outboundRequestSerial: 2,
      baselineUserMessageCount: 3,
      userMessageCount: 4,
      stopButtonVisible: false,
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
      composerTextAfter: "Prompt still visible",
    }));
  });
});
