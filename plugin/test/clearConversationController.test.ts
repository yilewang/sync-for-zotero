import { assert } from "chai";
import { createClearConversationController } from "../src/modules/contextPanel/setupHandlers/controllers/clearConversationController";

describe("clearConversationController", function () {
  it("clears the current conversation in place", async function () {
    const calls: string[] = [];
    let resetHistoryKey = 0;
    let markedLoadedKey = 0;
    let clearedComposeItemID = 0;
    let statusMessage = "";
    let statusLevel = "";

    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => 7001,
      getCurrentItemID: () => 7001,
      clearPendingTurnDeletion: (conversationKey) => {
        calls.push(`pending:${conversationKey}`);
      },
      clearTransientComposeStateForItem: (itemId) => {
        clearedComposeItemID = itemId;
        calls.push(`compose:${itemId}`);
      },
      resetComposePreviewUI: () => {
        calls.push("preview");
      },
      resetConversationHistory: (conversationKey) => {
        resetHistoryKey = conversationKey;
        calls.push(`history:${conversationKey}`);
      },
      markConversationLoaded: (conversationKey) => {
        markedLoadedKey = conversationKey;
        calls.push(`loaded:${conversationKey}`);
      },
      clearStoredConversation: async (conversationKey) => {
        calls.push(`stored:${conversationKey}`);
      },
      resetConversationTitle: async (conversationKey) => {
        calls.push(`title:${conversationKey}`);
      },
      clearOwnerAttachmentRefs: async (_ownerType, ownerKey) => {
        calls.push(`refs:${ownerKey}`);
      },
      removeConversationAttachmentFiles: async (conversationKey) => {
        calls.push(`files:${conversationKey}`);
      },
      refreshChatPreservingScroll: () => {
        calls.push("refresh");
      },
      refreshGlobalHistoryHeader: async () => {
        calls.push("history-header");
      },
      scheduleAttachmentGc: () => {
        calls.push("gc");
      },
      setStatusMessage: (message, level) => {
        statusMessage = message;
        statusLevel = level;
      },
    });

    await clearCurrentConversation();

    assert.equal(clearedComposeItemID, 7001);
    assert.equal(resetHistoryKey, 7001);
    assert.equal(markedLoadedKey, 7001);
    assert.equal(statusMessage, "Cleared");
    assert.equal(statusLevel, "ready");
    assert.deepEqual(calls, [
      "pending:7001",
      "compose:7001",
      "history:7001",
      "loaded:7001",
      "preview",
      "stored:7001",
      "title:7001",
      "refs:7001",
      "files:7001",
      "refresh",
      "history-header",
      "gc",
    ]);
  });

  it("does nothing when there is no active conversation", async function () {
    let called = false;
    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => null,
      getCurrentItemID: () => null,
      clearTransientComposeStateForItem: () => {
        called = true;
      },
      resetComposePreviewUI: () => {
        called = true;
      },
      resetConversationHistory: () => {
        called = true;
      },
      markConversationLoaded: () => {
        called = true;
      },
      clearStoredConversation: async () => {
        called = true;
      },
      resetConversationTitle: async () => {
        called = true;
      },
      clearOwnerAttachmentRefs: async () => {
        called = true;
      },
      removeConversationAttachmentFiles: async () => {
        called = true;
      },
      refreshChatPreservingScroll: () => {
        called = true;
      },
      refreshGlobalHistoryHeader: () => {
        called = true;
      },
      scheduleAttachmentGc: () => {
        called = true;
      },
    });

    await clearCurrentConversation();

    assert.isFalse(called);
  });
});
