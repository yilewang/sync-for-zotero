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

  function completionTimingForSignals(signals = {}) {
    if (signals.toolUseDetected === true) {
      return {
        quietWindowMs: 15000,
        reboundWindowMs: 3000,
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

  return {
    TURN_COMPLETION_QUIET_WINDOW_MS,
    TURN_COMPLETION_REBOUND_WINDOW_MS,
    advanceTurnCompletionTracker,
    attemptToken,
    canReuseReadyTranscriptForScrape,
    classifyContentScriptMessageError,
    completionTimingForSignals,
    composerTextMatchesPrompt,
    contentScriptMessageRetryDelayMs,
    conversationUrlsMatch,
    createTurnCompletionTracker,
    hasMeaningfulAssistantText,
    hasDeliverySignal,
    isPlaceholderAssistantText,
    isRecoverableContentScriptMessageError,
    isRetrySafeContentScriptMessage,
    normalizeComposerText,
    normalizeConversationUrl,
    retryRecoverableContentScriptMessage,
    tabNeedsActivation,
    tabNeedsLifecycleReload,
    terminalAnswerSnapshotIsStable,
  };
});
