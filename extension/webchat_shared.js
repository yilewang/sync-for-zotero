(function (root, factory) {
  const api = factory();
  root.SyncZoteroShared = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TURN_COMPLETION_QUIET_WINDOW_MS = 7000;
  const TURN_COMPLETION_REBOUND_WINDOW_MS = 1500;

  function normalizeComposerText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function composerTextMatchesPrompt(promptText, composerText) {
    const a = normalizeComposerText(promptText);
    const b = normalizeComposerText(composerText);
    if (a === b) return true;
    // Lenient match: collapse all whitespace and compare — contentEditable
    // may reformat newlines, merge paragraphs, or strip trailing spaces.
    const collapse = (s) => s.replace(/\s+/g, " ").trim();
    return collapse(a) === collapse(b);
  }

  function normalizeAttachmentEvidence(text) {
    return String(text || "")
      .normalize("NFC")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function attachmentEvidenceMatchesFilename(evidence, expectedFilename) {
    const normalizedEvidence = normalizeAttachmentEvidence(evidence);
    const normalizedFilename = normalizeAttachmentEvidence(expectedFilename);
    if (!normalizedFilename || !normalizedEvidence) return false;
    if (normalizedEvidence.includes(normalizedFilename)) return true;

    const pdfMatch = normalizedFilename.match(/^(.*)(\.pdf)$/);
    if (!pdfMatch) return false;
    const escapeRegExp = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const providerDuplicateName = new RegExp(
      `${escapeRegExp(pdfMatch[1])}\\s*\\(\\d+\\)${escapeRegExp(pdfMatch[2])}(?:\\b|$)`,
      "i",
    );
    return providerDuplicateName.test(normalizedEvidence);
  }

  function attachmentEvidenceIsReady(evidence, expectedFilename) {
    if (!attachmentEvidenceMatchesFilename(evidence, expectedFilename)) {
      return false;
    }
    const normalizedEvidence = normalizeAttachmentEvidence(evidence);
    return !(
      /\b(?:parsing|uploading|processing|scanning|reading)\b/.test(
        normalizedEvidence,
      ) ||
      /(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
        normalizedEvidence,
      )
    );
  }

  function attachmentEvidenceHasFileCardSignal(
    evidence,
    hasExplicitFileControl = false,
  ) {
    const normalizedEvidence = normalizeAttachmentEvidence(evidence);
    return Boolean(
      /\b\d+(?:\.\d+)?\s*(?:kb|mb|gb)\b/.test(normalizedEvidence) ||
        /\b(?:parsing|uploading|processing|scanning|reading|ready)\b/.test(
          normalizedEvidence,
        ) ||
        /(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
          normalizedEvidence,
        ) ||
        (hasExplicitFileControl && /\bpdf\b/.test(normalizedEvidence)),
    );
  }

  function hasPendingPdfEvidence(evidenceList) {
    return (Array.isArray(evidenceList) ? evidenceList : []).some((evidence) =>
      /\.pdf(?:\b|$)/i.test(normalizeAttachmentEvidence(evidence)),
    );
  }

  function attachmentListContainsExpectedFilename(
    attachments,
    expectedFilename,
  ) {
    return (Array.isArray(attachments) ? attachments : []).some((attachment) =>
      attachmentEvidenceMatchesFilename(attachment, expectedFilename),
    );
  }

  function conversationMessagesAfterBaseline(
    currentMessages,
    baselineMessages,
    baselineCount = 0,
  ) {
    const current = Array.isArray(currentMessages) ? currentMessages : [];
    const baseline = Array.isArray(baselineMessages) ? baselineMessages : [];
    const baselineKeys = new Set(
      baseline
        .map((message) => String(message?.messageKey || ""))
        .filter(Boolean),
    );
    const messagesWithNewKeys = baselineKeys.size > 0
      ? current.filter((message) => {
        const key = String(message?.messageKey || "");
        return key && !baselineKeys.has(key);
      })
      : [];

    if (messagesWithNewKeys.length > 0) {
      return messagesWithNewKeys;
    }
    return current.slice(Math.max(0, Number(baselineCount) || 0));
  }

  function hasNewExpectedAttachmentEvidence({
    baselineEvidence = [],
    currentEvidence = [],
    expectedFilename = "",
    requireReady = true,
  } = {}) {
    const countMatchingEvidence = (evidenceList) =>
      (Array.isArray(evidenceList) ? evidenceList : []).filter((evidence) =>
        requireReady
          ? attachmentEvidenceIsReady(evidence, expectedFilename)
          : attachmentEvidenceMatchesFilename(evidence, expectedFilename),
      ).length;

    return (
      countMatchingEvidence(currentEvidence) >
      countMatchingEvidence(baselineEvidence)
    );
  }

  async function waitForNewExpectedAttachmentEvidence({
    baselineEvidence = [],
    expectedFilename = "",
    readEvidence,
    wait,
    now = () => Date.now(),
    timeoutMs = 7000,
    pollIntervalMs = 100,
    requireReady = true,
  } = {}) {
    if (!expectedFilename) {
      throw new TypeError("expectedFilename is required");
    }
    if (typeof readEvidence !== "function") {
      throw new TypeError("readEvidence must be a function");
    }
    if (typeof wait !== "function") {
      throw new TypeError("wait must be a function");
    }

    const startedAt = now();
    const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    const boundedPollIntervalMs = Math.max(
      10,
      Number(pollIntervalMs) || 100,
    );
    const deadline = startedAt + boundedTimeoutMs;

    while (true) {
      const currentEvidence = await readEvidence();
      if (
        hasNewExpectedAttachmentEvidence({
          baselineEvidence,
          currentEvidence,
          expectedFilename,
          requireReady,
        })
      ) {
        const evidence = currentEvidence.find((entry) =>
          requireReady
            ? attachmentEvidenceIsReady(entry, expectedFilename)
            : attachmentEvidenceMatchesFilename(entry, expectedFilename),
        );
        return {
          evidence: evidence || expectedFilename,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }

      const currentTime = now();
      if (currentTime >= deadline) {
        throw new Error(
          requireReady
            ? `The website did not confirm that "${expectedFilename}" was ready.`
            : `The website did not confirm attachment of "${expectedFilename}".`,
        );
      }
      await wait(
        Math.min(boundedPollIntervalMs, Math.max(0, deadline - currentTime)),
      );
    }
  }

  function isPlaceholderAssistantText(text) {
    const normalized = normalizeComposerText(text).toLowerCase();
    const collapsed = normalized.replace(/\s+/g, " ").trim();
    if (!collapsed) return true;
    if (
      collapsed === "thinking" ||
      collapsed === "thinking..." ||
      collapsed === "stopped thinking" ||
      collapsed === "quick answer" ||
      collapsed === "stopped thinking quick answer"
    ) {
      return true;
    }
    if (/^thought for .+$/.test(collapsed)) {
      return true;
    }
    // Tool-use status messages (not actual responses)
    if (/^reading\s+documents?\.?$/i.test(collapsed)) return true;
    if (/^searching(\s+the\s+web)?\.?$/i.test(collapsed)) return true;
    if (/^analyzing\.?$/i.test(collapsed)) return true;
    if (/^browsing\.?$/i.test(collapsed)) return true;
    // Chinese equivalents (DeepSeek Chinese UI)
    if (collapsed === "思考中" || collapsed === "思考中..." ||
        collapsed === "深度思考" || collapsed === "停止思考") return true;
    if (/^已深度思考/.test(collapsed) || /^已思考/.test(collapsed) ||
        /^思考了/.test(collapsed)) return true;
    if (/^正在阅读/.test(collapsed) || /^正在搜索/.test(collapsed) ||
        /^正在分析/.test(collapsed) || /^正在浏览/.test(collapsed)) return true;
    return false;
  }

  function hasMeaningfulAssistantText(text) {
    const normalized = normalizeComposerText(text);
    return normalized.length > 1 && !isPlaceholderAssistantText(normalized);
  }

  function normalizeConversationUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";

    try {
      const parsed = new URL(raw);
      if (parsed.hostname.toLowerCase() === "chatgpt.com") {
        const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
        if (match) return `${parsed.origin}/c/${match[1]}`;
      }
    } catch (_) {}

    return raw.replace(/\/+$/, "");
  }

  function conversationUrlsMatch(actualUrl, expectedUrl) {
    const normalizedExpected = normalizeConversationUrl(expectedUrl);
    if (!normalizedExpected) return true;
    return normalizeConversationUrl(actualUrl) === normalizedExpected;
  }

  function hasRelayTranscriptMessageContent(message) {
    if (!message || typeof message !== "object") return false;
    if (normalizeComposerText(message.text || "")) return true;
    if (normalizeComposerText(message.thinking || "")) return true;
    return Array.isArray(message.attachments) && message.attachments.length > 0;
  }

  function canReuseReadyTranscriptForScrape(siteId, ready) {
    if (String(siteId || "").toLowerCase() !== "chatgpt") return false;
    const messages = Array.isArray(ready?.messages) ? ready.messages : [];
    return messages.some(hasRelayTranscriptMessageContent);
  }

  function hasDeliverySignal(snapshot) {
    const promptText = normalizeComposerText(snapshot.promptText || "");
    const composerTextAfter = normalizeComposerText(snapshot.composerTextAfter || "");
    const composerStillMatchesPrompt = promptText.length > 0 &&
      composerTextMatchesPrompt(promptText, composerTextAfter);
    if ((snapshot.outboundRequestSerial || 0) > (snapshot.baselineOutboundRequestSerial || 0) &&
        !composerStillMatchesPrompt) {
      return true;
    }
    if (snapshot.stopButtonVisible) return true;
    if ((snapshot.userMessageCount || 0) > (snapshot.baselineUserMessageCount || 0)) {
      return true;
    }
    return false;
  }

  function tabNeedsLifecycleReload(tab) {
    return Boolean(tab?.discarded);
  }

  function tabNeedsActivation(tab) {
    return tab?.active === false;
  }

  function hasStrongTransportCompletionSignal(signals = {}) {
    return Boolean(
      (signals.sseDone === true || signals.transportObserved === true) &&
        Number(signals.activeConversationStreamCount || 0) === 0 &&
        signals.actionBarVisible === true &&
        signals.stopButtonVisible !== true &&
        signals.busyComposer !== true,
    );
  }

  function completionTimingForSignals(signals = {}) {
    if (signals.toolUseDetected === true) {
      return {
        quietWindowMs: 15000,
        reboundWindowMs: 3000,
      };
    }
    if (
      signals.strongTransportCompletion === true &&
      signals.answerVisible === true
    ) {
      return {
        quietWindowMs: 500,
        reboundWindowMs: 250,
      };
    }
    if (
      signals.sseDone === true &&
      Number(signals.activeConversationStreamCount || 0) === 0 &&
      signals.answerVisible === true
    ) {
      return {
        quietWindowMs: 2000,
        reboundWindowMs: 500,
      };
    }
    return {
      quietWindowMs: TURN_COMPLETION_QUIET_WINDOW_MS,
      reboundWindowMs: TURN_COMPLETION_REBOUND_WINDOW_MS,
    };
  }

  function terminalAnswerSnapshotIsStable(candidate, latest) {
    const candidateText = normalizeComposerText(candidate?.text || "");
    const latestText = normalizeComposerText(latest?.text || "");
    if (
      !hasMeaningfulAssistantText(candidateText) ||
      !hasMeaningfulAssistantText(latestText) ||
      candidateText !== latestText
    ) {
      return false;
    }

    const candidateTurnKey = String(candidate?.assistantTurnKey || "");
    const latestTurnKey = String(latest?.assistantTurnKey || "");
    return (
      !candidateTurnKey ||
      !latestTurnKey ||
      candidateTurnKey === latestTurnKey
    );
  }

  function attemptToken(seq, attempt) {
    return `${Number(seq) || 0}:${Number(attempt) || 0}`;
  }

  function createTurnCompletionTracker(nowMs) {
    const ts = Number.isFinite(nowMs) ? Number(nowMs) : 0;
    return {
      phase: "active",
      activeRunSeen: false,
      lastAnswerRevision: 0,
      lastThinkingRevision: 0,
      lastTranscriptRevision: 0,
      lastAnswerChangeAt: ts,
      lastThinkingChangeAt: ts,
      lastTranscriptChangeAt: ts,
      lastActiveRunAt: ts,
      quietWindowStartedAt: ts,
      candidateSince: null,
      verificationStartedAt: null,
    };
  }

  function advanceTurnCompletionTracker(currentTracker, sample) {
    const nowMs = Number.isFinite(sample?.nowMs) ? Number(sample.nowMs) : Date.now();
    const quietWindowMs = Number.isFinite(sample?.quietWindowMs) && Number(sample.quietWindowMs) > 0
      ? Number(sample.quietWindowMs)
      : TURN_COMPLETION_QUIET_WINDOW_MS;
    const reboundWindowMs = Number.isFinite(sample?.reboundWindowMs) && Number(sample.reboundWindowMs) > 0
      ? Number(sample.reboundWindowMs)
      : TURN_COMPLETION_REBOUND_WINDOW_MS;
    const tracker = currentTracker
      ? { ...currentTracker }
      : createTurnCompletionTracker(nowMs);
    const previousPhase = tracker.phase || "active";

    const answerRevision = Number.isFinite(sample?.answerRevision)
      ? Math.max(0, Math.floor(Number(sample.answerRevision)))
      : tracker.lastAnswerRevision;
    const thinkingRevision = Number.isFinite(sample?.thinkingRevision)
      ? Math.max(0, Math.floor(Number(sample.thinkingRevision)))
      : tracker.lastThinkingRevision;
    const transcriptRevision = Number.isFinite(sample?.transcriptRevision)
      ? Math.max(0, Math.floor(Number(sample.transcriptRevision)))
      : tracker.lastTranscriptRevision;

    const answerVisible = sample?.answerVisible === true;
    const thinkingVisible = sample?.thinkingVisible === true;
    const activeRun = sample?.activeRun === true;
    const hasUserTurn = sample?.hasUserTurn === true;
    const hasAssistantTurn = sample?.hasAssistantTurn === true;
    const forceIncomplete = sample?.forceIncomplete === true;

    if (answerRevision !== tracker.lastAnswerRevision) {
      tracker.lastAnswerRevision = answerRevision;
      tracker.lastAnswerChangeAt = nowMs;
    }
    if (thinkingRevision !== tracker.lastThinkingRevision) {
      tracker.lastThinkingRevision = thinkingRevision;
      tracker.lastThinkingChangeAt = nowMs;
    }
    if (transcriptRevision !== tracker.lastTranscriptRevision) {
      tracker.lastTranscriptRevision = transcriptRevision;
      tracker.lastTranscriptChangeAt = nowMs;
    }
    if (activeRun) {
      tracker.lastActiveRunAt = nowMs;
      tracker.activeRunSeen = true;
    }

    const quietWindowStartedAt = Math.max(
      tracker.lastAnswerChangeAt,
      tracker.lastThinkingChangeAt,
      tracker.lastTranscriptChangeAt,
      tracker.lastActiveRunAt,
    );
    tracker.quietWindowStartedAt = quietWindowStartedAt;
    const quietForMs = Math.max(0, nowMs - quietWindowStartedAt);

    if (forceIncomplete) {
      tracker.phase = "incomplete";
      tracker.candidateSince = null;
      tracker.verificationStartedAt = null;
    } else if (answerVisible && !activeRun) {
      tracker.phase = "candidate_done";
      if (previousPhase !== "candidate_done") {
        tracker.candidateSince = nowMs;
      } else if (!Number.isFinite(tracker.candidateSince)) {
        tracker.candidateSince = nowMs;
      }

      if (quietForMs >= quietWindowMs) {
        if (!Number.isFinite(tracker.verificationStartedAt)) {
          tracker.verificationStartedAt = nowMs;
        }
        if (nowMs - tracker.verificationStartedAt >= reboundWindowMs) {
          tracker.phase = "verified_done";
        }
      } else {
        tracker.verificationStartedAt = null;
      }
    } else {
      tracker.phase = "active";
      tracker.candidateSince = null;
      tracker.verificationStartedAt = null;
    }

    let turnStatus = "submitted";
    if (tracker.phase === "verified_done") {
      turnStatus = "done";
    } else if (tracker.phase === "incomplete") {
      turnStatus = "incomplete";
    } else if (tracker.phase === "candidate_done") {
      turnStatus = "assistant_settling";
    } else if (hasAssistantTurn || answerVisible || thinkingVisible) {
      turnStatus = "assistant_turn_matched";
    } else if (hasUserTurn) {
      turnStatus = "user_turn_matched";
    }

    let runState = "submitted";
    if (tracker.phase === "verified_done") {
      runState = "done";
    } else if (tracker.phase === "incomplete") {
      runState = "incomplete";
    } else if (tracker.phase === "candidate_done") {
      runState = "settling";
    } else if (
      answerVisible ||
      thinkingVisible ||
      activeRun ||
      tracker.activeRunSeen ||
      hasAssistantTurn
    ) {
      runState = "active";
    }

    return {
      tracker,
      phase: tracker.phase,
      previousPhase,
      phaseChanged: tracker.phase !== previousPhase,
      turnStatus,
      runState,
      quietForMs,
      verificationForMs: Number.isFinite(tracker.verificationStartedAt)
        ? Math.max(0, nowMs - tracker.verificationStartedAt)
        : 0,
      emitDone: tracker.phase === "verified_done" && previousPhase !== "verified_done",
      emitIncomplete: tracker.phase === "incomplete" && previousPhase !== "incomplete",
      activeRunSeen: tracker.activeRunSeen,
      quietWindowStartedAt,
      candidateSince: tracker.candidateSince,
      verificationStartedAt: tracker.verificationStartedAt,
    };
  }

  const RETRY_SAFE_CONTENT_SCRIPT_MESSAGES = new Set([
    "HEALTH_CHECK",
    "WAIT_FOR_CHAT_READY",
    "SCRAPE_HISTORY_NOW",
    "SCRAPE_MESSAGES",
    "RESET_NETWORK_CACHE",
  ]);

  function classifyContentScriptMessageError(error) {
    const message = String(error?.message || error || "").trim();
    const code = String(error?.code || "").trim();
    if (
      code === "content_script_unresponsive" ||
      /message channel closed before a response was received/i.test(message) ||
      /message port closed before a response was received/i.test(message) ||
      /port closed before a response was received/i.test(message)
    ) {
      return { code: "channel_closed", recoverable: true, message };
    }
    if (
      /receiving end does not exist/i.test(message) ||
      /could not establish connection/i.test(message)
    ) {
      return { code: "receiver_missing", recoverable: true, message };
    }
    if (
      /frame (?:with id )?[^ ]+ was (?:removed|detached)/i.test(message) ||
      /extension context invalidated/i.test(message)
    ) {
      return { code: "context_replaced", recoverable: true, message };
    }
    if (
      /no tab with id/i.test(message) ||
      /tab (?:was )?closed/i.test(message) ||
      /tab not found/i.test(message)
    ) {
      return { code: "tab_unavailable", recoverable: false, message };
    }
    return { code: "other", recoverable: false, message };
  }

  function isRecoverableContentScriptMessageError(error) {
    return classifyContentScriptMessageError(error).recoverable;
  }

  function isRetrySafeContentScriptMessage(message) {
    return RETRY_SAFE_CONTENT_SCRIPT_MESSAGES.has(
      String(message?.type || "").trim(),
    );
  }

  function contentScriptMessageRetryDelayMs(attempt) {
    const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    return Math.min(1000, 100 * 2 ** (normalizedAttempt - 1));
  }

  async function retryRecoverableContentScriptMessage({
    sendAttempt,
    recover,
    maxAttempts = 3,
  }) {
    if (typeof sendAttempt !== "function") {
      throw new TypeError("sendAttempt must be a function");
    }
    const boundedAttempts = Math.max(
      1,
      Math.min(5, Math.floor(Number(maxAttempts) || 1)),
    );

    for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
      try {
        return await sendAttempt(attempt);
      } catch (error) {
        const classification = classifyContentScriptMessageError(error);
        if (!classification.recoverable || attempt >= boundedAttempts) {
          throw error;
        }
        if (typeof recover === "function") {
          try {
            await recover({
              attempt,
              nextAttempt: attempt + 1,
              error,
              classification,
              delayMs: contentScriptMessageRetryDelayMs(attempt),
            });
          } catch (recoveryError) {
            if (!isRecoverableContentScriptMessageError(recoveryError)) {
              throw recoveryError;
            }
          }
        }
      }
    }

    throw new Error("Content-script message retry exhausted unexpectedly.");
  }

  function postPhaseAndWaitForAck(
    port,
    {
      seq,
      attempt,
      phase,
      diagnostic = null,
      timeoutMs = 15_000,
    } = {},
  ) {
    if (
      !port ||
      typeof port.postMessage !== "function" ||
      typeof port.onMessage?.addListener !== "function"
    ) {
      return Promise.reject(
        new TypeError("A connected extension port is required."),
      );
    }
    if (!phase) {
      return Promise.reject(new TypeError("phase is required"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        port.onMessage.removeListener?.(handleMessage);
        port.onDisconnect?.removeListener?.(handleDisconnect);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const handleMessage = (message) => {
        if (
          message?.type !== "phase_ack" ||
          message.seq !== seq ||
          message.attempt !== attempt ||
          message.phase !== phase
        ) {
          return;
        }
        finish(resolve, message);
      };
      const handleDisconnect = () => {
        finish(
          reject,
          new Error(
            `Extension port disconnected before the ${phase} phase was acknowledged.`,
          ),
        );
      };

      port.onMessage.addListener(handleMessage);
      port.onDisconnect?.addListener?.(handleDisconnect);
      timeoutId = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              `Timed out waiting for the ${phase} phase acknowledgement.`,
            ),
          ),
        Math.max(1, Number(timeoutMs) || 15_000),
      );

      try {
        port.postMessage({
          type: "phase",
          seq,
          attempt,
          phase,
          ...(diagnostic ? { diagnostic } : {}),
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  return {
    TURN_COMPLETION_QUIET_WINDOW_MS,
    TURN_COMPLETION_REBOUND_WINDOW_MS,
    advanceTurnCompletionTracker,
    attachmentListContainsExpectedFilename,
    attachmentEvidenceMatchesFilename,
    attachmentEvidenceHasFileCardSignal,
    attachmentEvidenceIsReady,
    attemptToken,
    canReuseReadyTranscriptForScrape,
    classifyContentScriptMessageError,
    completionTimingForSignals,
    composerTextMatchesPrompt,
    conversationMessagesAfterBaseline,
    contentScriptMessageRetryDelayMs,
    conversationUrlsMatch,
    createTurnCompletionTracker,
    hasMeaningfulAssistantText,
    hasNewExpectedAttachmentEvidence,
    hasPendingPdfEvidence,
    hasDeliverySignal,
    hasStrongTransportCompletionSignal,
    isPlaceholderAssistantText,
    isRecoverableContentScriptMessageError,
    isRetrySafeContentScriptMessage,
    normalizeComposerText,
    normalizeConversationUrl,
    postPhaseAndWaitForAck,
    retryRecoverableContentScriptMessage,
    tabNeedsActivation,
    tabNeedsLifecycleReload,
    terminalAnswerSnapshotIsStable,
    waitForNewExpectedAttachmentEvidence,
  };
});
