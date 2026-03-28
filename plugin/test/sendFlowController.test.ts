import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../src/modules/contextPanel/types";
import { createSendFlowController } from "../src/modules/contextPanel/setupHandlers/controllers/sendFlowController";

describe("sendFlowController", function () {
  const item = { id: 101 } as unknown as Zotero.Item;
  const selectedPaper: PaperContextRef = {
    itemId: 12,
    contextItemId: 34,
    title: "Pinned paper",
  };
  const selectedFile: ChatAttachment = {
    id: "file-1",
    name: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 20,
    category: "markdown",
  };
  const selectedTextContexts: SelectedTextContext[] = [
    { text: "selected text", source: "pdf" },
  ];

  function createBaseDeps(overrides: Record<string, unknown> = {}) {
    const inputBox = { value: "ask question" } as HTMLTextAreaElement;
    let draftValue = inputBox.value;
    let sendCalled = 0;
    let editCalled = 0;
    let retainImageCalled = 0;
    let retainPaperStateCalled = 0;
    let consumePaperModeStateCalled = 0;
    let retainFileCalled = 0;
    let retainTextCalled = 0;
    let persistDraftInputCalls = 0;
    let setActiveEditSessionCalls = 0;
    let lastSentQuestion = "";
    let lastRuntimeMode = "";
    let lastEditRuntimeMode = "";
    let lastWebchatForceNewChat = false;
    let lastWebchatSendPdf = false;
    let markWebchatPdfUploadedCalls = 0;

    const deps = {
      body: {} as Element,
      inputBox,
      getItem: () => item,
      closeSlashMenu: () => undefined,
      closePaperPicker: () => undefined,
      getSelectedTextContextEntries: () => selectedTextContexts,
      getSelectedPaperContexts: () => [selectedPaper],
      getFullTextPaperContexts: () => [selectedPaper],
      getPdfModePaperContexts: () => [],
      hasActivePdfFullTextPapers: () => false,
      hasUploadedPdfInCurrentWebChatConversation: () => false,
      markWebChatPdfUploadedForCurrentConversation: () => {
        markWebchatPdfUploadedCalls += 1;
      },
      resolvePdfPaperAttachments: async () => [],
      renderPdfPagesAsImages: async () => [],
      getModelPdfSupport: () => "none" as const,
      uploadPdfForProvider: async () => null,
      resolvePdfBytes: async () => new Uint8Array(),
      getSelectedFiles: () => [selectedFile],
      getSelectedImages: () => ["data:image/png;base64,AAA"],
      resolvePromptText: () => "ask question",
      buildQuestionWithSelectedTextContexts: (
        _selectedTexts: string[],
        _sources: unknown,
        promptText: string,
      ) => `${promptText} (with selected text)`,
      buildModelPromptWithFileContext: (
        question: string,
        attachments: ChatAttachment[],
      ) => `${question} [files=${attachments.length}]`,
      isAgentMode: () => false,
      isGlobalMode: () => false,
      normalizeConversationTitleSeed: (raw: unknown) => String(raw || ""),
      getConversationKey: () => item.id,
      touchGlobalConversationTitle: async () => undefined,
      touchPaperConversationTitle: async () => undefined,
      getSelectedProfile: () => null,
      getCurrentModelName: () => "",
      isScreenshotUnsupportedModel: () => false,
      getSelectedReasoning: () => undefined,
      getAdvancedModelParams: () => undefined,
      consumeWebChatForceNewChatIntent: () => false,
      getActiveEditSession: () => null,
      setActiveEditSession: () => {
        setActiveEditSessionCalls += 1;
      },
      getLatestEditablePair: async () => null,
      editLatestUserMessageAndRetry: async (opts: { targetRuntimeMode?: "chat" | "agent" }) => {
        editCalled += 1;
        lastEditRuntimeMode = opts.targetRuntimeMode || "";
        return "ok" as const;
      },
      sendQuestion: async (opts: {
        question: string;
        runtimeMode?: "chat" | "agent";
        webchatSendPdf?: boolean;
        webchatForceNewChat?: boolean;
      }) => {
        sendCalled += 1;
        lastSentQuestion = opts.question;
        lastRuntimeMode = opts.runtimeMode || "";
        lastWebchatSendPdf = opts.webchatSendPdf === true;
        lastWebchatForceNewChat = opts.webchatForceNewChat === true;
      },
      retainPinnedImageState: () => {
        retainImageCalled += 1;
      },
      retainPaperState: () => {
        retainPaperStateCalled += 1;
      },
      consumePaperModeState: () => {
        consumePaperModeStateCalled += 1;
      },
      retainPinnedFileState: () => {
        retainFileCalled += 1;
      },
      retainPinnedTextState: () => {
        retainTextCalled += 1;
      },
      updatePaperPreviewPreservingScroll: () => undefined,
      updateFilePreviewPreservingScroll: () => undefined,
      updateImagePreviewPreservingScroll: () => undefined,
      updateSelectedTextPreviewPreservingScroll: () => undefined,
      scheduleAttachmentGc: () => undefined,
      refreshGlobalHistoryHeader: () => undefined,
      persistDraftInput: () => {
        persistDraftInputCalls += 1;
        draftValue = inputBox.value;
      },
      autoLockGlobalChat: () => undefined,
      autoUnlockGlobalChat: () => undefined,
      setStatusMessage: () => undefined,
      editStaleStatusText: "stale",
      ...overrides,
    };

    const controller = createSendFlowController(deps as any);
    return {
      controller,
      inputBox,
      getCounts: () => ({
        sendCalled,
        editCalled,
        retainImageCalled,
        retainPaperStateCalled,
        consumePaperModeStateCalled,
        retainFileCalled,
        retainTextCalled,
        persistDraftInputCalls,
        setActiveEditSessionCalls,
      }),
      getDraftValue: () => draftValue,
      getLastSend: () => ({
        lastSentQuestion,
        lastRuntimeMode,
        lastWebchatSendPdf,
        lastWebchatForceNewChat,
        markWebchatPdfUploadedCalls,
      }),
      getLastEditRuntimeMode: () => lastEditRuntimeMode,
    };
  }

  it("uses retain-pinned callbacks for normal send flow", async function () {
    const { controller, inputBox, getCounts } = createBaseDeps();
    await controller.doSend();
    const counts = getCounts();

    assert.equal(inputBox.value, "");
    assert.equal(counts.sendCalled, 1);
    assert.equal(counts.editCalled, 0);
    assert.equal(counts.retainImageCalled, 1);
    assert.equal(counts.consumePaperModeStateCalled, 1);
    assert.equal(counts.retainPaperStateCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
  });

  it("uses retain-pinned callbacks for edit-latest flow", async function () {
    const { controller, inputBox, getCounts, getLastEditRuntimeMode } = createBaseDeps({
      getActiveEditSession: () => ({
        conversationKey: item.id,
        userTimestamp: 10,
        assistantTimestamp: 20,
      }),
      getLatestEditablePair: async () => ({
        conversationKey: item.id,
        pair: {
          userMessage: { timestamp: 10 },
          assistantMessage: { timestamp: 20, streaming: false },
        },
      }),
    });
    await controller.doSend();
    const counts = getCounts();

    assert.equal(inputBox.value, "");
    assert.equal(counts.sendCalled, 0);
    assert.equal(counts.editCalled, 1);
    assert.equal(counts.retainImageCalled, 1);
    assert.equal(counts.consumePaperModeStateCalled, 1);
    assert.equal(counts.retainPaperStateCalled, 1);
    assert.equal(counts.retainFileCalled, 1);
    assert.equal(counts.retainTextCalled, 1);
    assert.isAtLeast(counts.setActiveEditSessionCalls, 1);
    assert.equal(getLastEditRuntimeMode(), "chat");
  });

  it("passes the current runtime mode into latest-turn edit retries", async function () {
    const { controller, getLastEditRuntimeMode } = createBaseDeps({
      isAgentMode: () => true,
      getActiveEditSession: () => ({
        conversationKey: item.id,
        userTimestamp: 10,
        assistantTimestamp: 20,
      }),
      getLatestEditablePair: async () => ({
        conversationKey: item.id,
        pair: {
          userMessage: { timestamp: 10 },
          assistantMessage: { timestamp: 20, streaming: false },
        },
      }),
    });

    await controller.doSend();

    assert.equal(getLastEditRuntimeMode(), "agent");
  });

  it("persists the cleared draft before preview sync in normal send flow", async function () {
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
      updatePaperPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateFilePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateImagePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateSelectedTextPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
    });

    await controller.doSend();
    const counts = getCounts();

    assert.equal(getDraftValue(), "");
    assert.equal(inputBox.value, "");
    assert.equal(counts.persistDraftInputCalls, 1);
  });

  it("persists the cleared draft before preview sync in edit flow", async function () {
    const { controller, inputBox, getCounts, getDraftValue } = createBaseDeps({
      getActiveEditSession: () => ({
        conversationKey: item.id,
        userTimestamp: 10,
        assistantTimestamp: 20,
      }),
      getLatestEditablePair: async () => ({
        conversationKey: item.id,
        pair: {
          userMessage: { timestamp: 10 },
          assistantMessage: { timestamp: 20, streaming: false },
        },
      }),
      updatePaperPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateFilePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateImagePreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
      updateSelectedTextPreviewPreservingScroll: () => {
        inputBox.value = getDraftValue();
      },
    });

    await controller.doSend();
    const counts = getCounts();

    assert.equal(getDraftValue(), "");
    assert.equal(inputBox.value, "");
    assert.equal(counts.persistDraftInputCalls, 1);
  });

  it("sends raw prompt text in agent mode and marks runtime mode as agent", async function () {
    const { controller, getLastSend } = createBaseDeps({
      isAgentMode: () => true,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.equal(lastSend.lastSentQuestion, "ask question");
    assert.equal(lastSend.lastRuntimeMode, "agent");
  });

  it("passes force-new-chat intent through webchat sends exactly once", async function () {
    let consumeCalls = 0;
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat",
        model: "chatgpt",
        apiBase: "http://localhost",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat" as const,
        providerProtocol: "web_sync" as const,
      }),
      consumeWebChatForceNewChatIntent: () => {
        consumeCalls += 1;
        return true;
      },
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.equal(consumeCalls, 1);
    assert.isTrue(lastSend.lastWebchatForceNewChat);
  });

  it("skips PDF upload for webchat retrieval mode", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat",
        model: "chatgpt",
        apiBase: "http://localhost",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat" as const,
        providerProtocol: "web_sync" as const,
      }),
      hasActivePdfFullTextPapers: () => false,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.isFalse(lastSend.lastWebchatSendPdf);
    assert.equal(lastSend.markWebchatPdfUploadedCalls, 0);
  });

  it("uploads the PDF once for webchat full-send mode and records it", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat",
        model: "chatgpt",
        apiBase: "http://localhost",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat" as const,
        providerProtocol: "web_sync" as const,
      }),
      hasActivePdfFullTextPapers: () => true,
      hasUploadedPdfInCurrentWebChatConversation: () => false,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.isTrue(lastSend.lastWebchatSendPdf);
    assert.equal(lastSend.markWebchatPdfUploadedCalls, 1);
  });

  it("does not re-upload the PDF in the same webchat conversation unless a fresh chat is requested", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat",
        model: "chatgpt",
        apiBase: "http://localhost",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat" as const,
        providerProtocol: "web_sync" as const,
      }),
      hasActivePdfFullTextPapers: () => true,
      hasUploadedPdfInCurrentWebChatConversation: () => true,
      consumeWebChatForceNewChatIntent: () => false,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.isFalse(lastSend.lastWebchatSendPdf);
    assert.equal(lastSend.markWebchatPdfUploadedCalls, 0);
  });

  it("re-uploads the PDF after a fresh-chat request even if the current conversation already had it", async function () {
    const { controller, getLastSend } = createBaseDeps({
      getSelectedProfile: () => ({
        entryId: "webchat",
        model: "chatgpt",
        apiBase: "http://localhost",
        apiKey: "",
        providerLabel: "ChatGPT",
        authMode: "webchat" as const,
        providerProtocol: "web_sync" as const,
      }),
      hasActivePdfFullTextPapers: () => true,
      hasUploadedPdfInCurrentWebChatConversation: () => true,
      consumeWebChatForceNewChatIntent: () => true,
    });

    await controller.doSend();
    const lastSend = getLastSend();

    assert.isTrue(lastSend.lastWebchatSendPdf);
    assert.isTrue(lastSend.lastWebchatForceNewChat);
    assert.equal(lastSend.markWebchatPdfUploadedCalls, 1);
  });
});
