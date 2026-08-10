/**
 * content_script.js — Runs on supported chat sites (chatgpt.com, chat.deepseek.com).
 *
 * Handles the RUN_PIPELINE message:
 *   1. Attach the PDF to the chat's file input
 *   2. Type the prompt into the composer
 *   3. Submit the message
 *   4. Wait for the response to finish streaming
 *   5. Extract the response as markdown text
 *   6. Return it to the background script
 *
 * Also continuously scrapes the sidebar history and handles DELETE_CHAT commands.
 *
 * Site-specific logic is abstracted via SITE_ADAPTER (selected by hostname).
 */

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const SUPPORTED_DELIVERY_CONTRACTS = Object.freeze([1]);

const shared = globalThis.SyncZoteroShared || {
  TURN_COMPLETION_QUIET_WINDOW_MS: 7000,
  TURN_COMPLETION_REBOUND_WINDOW_MS: 1500,
  attemptToken: (seq, attempt) => `${Number(seq) || 0}:${Number(attempt) || 0}`,
  composerTextMatchesPrompt: (promptText, composerText) => String(promptText || "").trim() === String(composerText || "").trim(),
  composerBridgeAllowsSynchronousFallback: (result) => Boolean(
    result?.handled === true &&
      result?.applied !== true &&
      result?.pasteAccepted !== true,
  ),
  composerBridgeWriteTransition: (result) => {
    const allowSynchronousFallback = Boolean(
      result?.handled === true &&
        result?.applied !== true &&
        result?.pasteAccepted !== true,
    );
    return {
      allowSynchronousFallback,
      pendingBridgeCommit: !allowSynchronousFallback,
    };
  },
  composerPromptVerificationPolicy: (pendingBridgeCommit) => ({
    matchTimeoutMs: pendingBridgeCommit === true ? 10000 : 300,
    allowRetry: pendingBridgeCommit !== true,
  }),
  createTurnCompletionTracker: (nowMs) => {
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
  },
  advanceTurnCompletionTracker: (currentTracker, sample) => {
    const nowMs = Number.isFinite(sample?.nowMs) ? Number(sample.nowMs) : Date.now();
    const quietWindowMs = Number.isFinite(sample?.quietWindowMs) && Number(sample.quietWindowMs) > 0
      ? Number(sample.quietWindowMs)
      : 7000;
    const reboundWindowMs = Number.isFinite(sample?.reboundWindowMs) && Number(sample.reboundWindowMs) > 0
      ? Number(sample.reboundWindowMs)
      : 1500;
    const tracker = currentTracker
      ? { ...currentTracker }
      : {
        phase: "active",
        activeRunSeen: false,
        lastAnswerRevision: 0,
        lastThinkingRevision: 0,
        lastTranscriptRevision: 0,
        lastAnswerChangeAt: nowMs,
        lastThinkingChangeAt: nowMs,
        lastTranscriptChangeAt: nowMs,
        lastActiveRunAt: nowMs,
        quietWindowStartedAt: nowMs,
        candidateSince: null,
        verificationStartedAt: null,
      };
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
    const terminalEvidence = sample?.terminalEvidence === true;
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
    } else if (answerVisible && !activeRun && terminalEvidence) {
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
  },
  hasMeaningfulAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length <= 1) return false;
    if (
      normalized === "thinking" ||
      normalized === "thinking..." ||
      normalized === "stopped thinking" ||
      normalized === "quick answer" ||
      normalized === "stopped thinking quick answer"
    ) return false;
    if (/^thought for .+$/.test(normalized)) return false;
    if (/^reading\s+documents?\.?$/i.test(normalized)) return false;
    if (/^searching(\s+the\s+web)?\.?$/i.test(normalized)) return false;
    if (/^analyzing\.?$/i.test(normalized)) return false;
    if (/^browsing\.?$/i.test(normalized)) return false;
    // Chinese equivalents (DeepSeek Chinese UI)
    const raw = String(text || "").trim().replace(/\s+/g, " ");
    if (raw === "思考中" || raw === "思考中..." || raw === "深度思考" || raw === "停止思考") return false;
    if (/^已深度思考/.test(raw) || /^已思考/.test(raw) || /^思考了/.test(raw)) return false;
    if (/^正在阅读/.test(raw) || /^正在搜索/.test(raw) ||
        /^正在分析/.test(raw) || /^正在浏览/.test(raw)) return false;
    return true;
  },
  hasDeliverySignal: (snapshot) => {
    if ((snapshot.outboundRequestSerial || 0) > (snapshot.baselineOutboundRequestSerial || 0)) return true;
    if (snapshot.stopButtonVisible) return true;
    if ((snapshot.userMessageCount || 0) > (snapshot.baselineUserMessageCount || 0)) return true;
    return false;
  },
  completionTimingForSignals: (signals = {}) => {
    if (signals.toolUseDetected === true) {
      return { quietWindowMs: 15000, reboundWindowMs: 3000 };
    }
    if (
      signals.strongTransportCompletion === true &&
      signals.answerVisible === true
    ) {
      return { quietWindowMs: 500, reboundWindowMs: 250 };
    }
    if (
      signals.sseDone === true &&
      Number(signals.activeConversationStreamCount || 0) === 0 &&
      signals.answerVisible === true
    ) {
      return { quietWindowMs: 2000, reboundWindowMs: 500 };
    }
    return { quietWindowMs: 7000, reboundWindowMs: 1500 };
  },
  hasStrongTransportCompletionSignal: (signals = {}) =>
    (signals.sseDone === true || signals.transportObserved === true) &&
    Number(signals.activeConversationStreamCount || 0) === 0 &&
    signals.actionBarVisible === true &&
    signals.stopButtonVisible !== true &&
    signals.busyComposer !== true,
  hasVerifiedTerminalEvidence: (signals = {}) => {
    if (
      Number(signals.activeConversationStreamCount || 0) > 0 ||
      signals.stopButtonVisible === true ||
      signals.busyComposer === true
    ) {
      return false;
    }
    if (String(signals.siteId || "").toLowerCase() === "chatgpt") {
      return signals.actionBarVisible === true;
    }
    return signals.actionBarVisible === true || signals.sseDone === true;
  },
  isPlaceholderAssistantText: (text) => {
    const normalized = String(text || "").trim().toLowerCase();
    return !normalized || normalized === "thinking" || normalized === "quick answer";
  },
  normalizeConversationUrl: (url) => {
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
  },
  conversationUrlsMatch: (actualUrl, expectedUrl) => {
    const normalize = shared.normalizeConversationUrl ||
      ((value) => String(value || "").replace(/\/+$/, ""));
    const normalizedExpected = normalize(expectedUrl);
    if (!normalizedExpected) return true;
    return normalize(actualUrl) === normalizedExpected;
  },
  normalizeComposerText: (text) => String(text || "").trim(),
  conversationMessagesAfterBaseline: (
    currentMessages,
    _baselineMessages,
    baselineCount,
  ) =>
    (Array.isArray(currentMessages) ? currentMessages : [])
      .slice(Math.max(0, Number(baselineCount) || 0)),
  attachmentEvidenceMatchesFilename: (evidence, expectedFilename) => {
    const normalize = (value) =>
      String(value || "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const normalizedEvidence = normalize(evidence);
    const normalizedFilename = normalize(expectedFilename);
    if (!normalizedFilename || !normalizedEvidence) return false;
    if (normalizedEvidence.includes(normalizedFilename)) return true;
    const MIN_ELIDED_PREFIX = 16;
    if (normalizedFilename.length > MIN_ELIDED_PREFIX) {
      const elisions = /…|\.\.\./g;
      let elision;
      while ((elision = elisions.exec(normalizedEvidence))) {
        const before = normalizedEvidence.slice(0, elision.index);
        for (
          let len = Math.min(before.length, normalizedFilename.length);
          len >= MIN_ELIDED_PREFIX;
          len--
        ) {
          if (before.endsWith(normalizedFilename.slice(0, len))) return true;
        }
      }
    }
    const pdfMatch = normalizedFilename.match(/^(.*)(\.pdf)$/);
    if (!pdfMatch) return false;
    const escapeRegExp = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `${escapeRegExp(pdfMatch[1])}\\s*\\(\\d+\\)${escapeRegExp(pdfMatch[2])}(?:\\b|$)`,
      "i",
    ).test(normalizedEvidence);
  },
  attachmentStatusEvidence: (evidence, expectedFilename = "") => {
    const normalize = (value) =>
      String(value || "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    let normalizedEvidence = normalize(evidence);
    const normalizedFilename = normalize(expectedFilename);
    if (!normalizedFilename) return normalizedEvidence;
    normalizedEvidence = normalizedEvidence
      .split(normalizedFilename)
      .join(" ");
    const pdfMatch = normalizedFilename.match(/^(.*)(\.pdf)$/);
    if (pdfMatch) {
      const escapeRegExp = (value) =>
        value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      normalizedEvidence = normalizedEvidence.replace(
        new RegExp(
          `${escapeRegExp(pdfMatch[1])}\\s*\\(\\d+\\)${escapeRegExp(pdfMatch[2])}(?:\\b|$)`,
          "gi",
        ),
        " ",
      );
    }
    return normalizedEvidence.replace(/\s+/g, " ").trim();
  },
  attachmentEvidenceHasFailure: (evidence, expectedFilename = "") =>
    (!expectedFilename ||
      shared.attachmentEvidenceMatchesFilename(evidence, expectedFilename)) &&
    (/\b(?:upload\s+failed|failed\s+to\s+upload|could\s+not\s+upload|couldn't\s+upload|unsupported|file\s+too\s+large|error)\b/i.test(
      shared.attachmentStatusEvidence(evidence, expectedFilename),
    ) ||
      /(?:上传失败|无法上传|不支持|文件过大|错误)/.test(
        shared.attachmentStatusEvidence(evidence, expectedFilename),
      )),
  attachmentEvidenceIsReady: (evidence, expectedFilename) =>
    shared.attachmentEvidenceMatchesFilename(evidence, expectedFilename) &&
    !/\b(?:parsing|uploading|processing|scanning|reading)\b/i.test(
      shared.attachmentStatusEvidence(evidence, expectedFilename),
    ) &&
    !/(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
      shared.attachmentStatusEvidence(evidence, expectedFilename),
    ) &&
    !shared.attachmentEvidenceHasFailure(evidence, expectedFilename),
  attachmentEvidenceHasFileCardSignal: (
    evidence,
    hasExplicitFileControl = false,
  ) =>
    /\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\b/i.test(String(evidence || "")) ||
    /\b(?:parsing|uploading|processing|scanning|reading|ready)\b/i.test(
      String(evidence || ""),
    ) ||
    (hasExplicitFileControl && /\bPDF\b/i.test(String(evidence || ""))),
  hasPendingPdfEvidence: (
    evidenceList,
    hasExplicitFileControl = false,
  ) =>
    (Array.isArray(evidenceList) ? evidenceList : []).some((evidence) => {
      const text = String(evidence || "");
      return (
        /\.pdf(?:\b|$)/i.test(text) ||
        (/\bpdf\b/i.test(text) &&
          shared.attachmentEvidenceHasFileCardSignal(
            text,
            hasExplicitFileControl,
          ))
      );
    }),
  supportsDeliveryContract: (supportedVersions, requiredVersion) =>
    Number.isInteger(Number(requiredVersion)) &&
    Number(requiredVersion) > 0 &&
    (Array.isArray(supportedVersions) ? supportedVersions : []).some(
      (version) => Number(version) === Number(requiredVersion),
    ),
  WEBCHAT_PLUGIN_OUTDATED_MESSAGE:
    "The installed LLM for Zotero plugin is too old for this version of " +
    "the Sync for Zotero extension. Update the LLM for Zotero plugin in " +
    "Zotero (Tools → Plugins and Themes), then try again. " +
    "No prompt or PDF was sent.",
  unsupportedDeliveryContractMessage: (requestedVersion, supportedVersions) => {
    const supported = (Array.isArray(supportedVersions) ? supportedVersions : [])
      .map((version) => Number(version))
      .filter((version) => Number.isInteger(version) && version > 0);
    return (
      `This Zotero request uses WebChat delivery contract ` +
      `${Number(requestedVersion)}, but the installed Sync for Zotero ` +
      `extension only supports version ${supported.join(", ") || "none"}. ` +
      "Update the Sync for Zotero browser extension, then try again. " +
      "No prompt or PDF was sent."
    );
  },
  canUseDeepSeekQuiescentCompletion: (input) => Boolean(
    input?.siteId === "deepseek" &&
      input?.activeRun !== true &&
      input?.stopControlVisible !== true &&
      input?.busyComposer !== true &&
      (input?.hasRequestContext === true || input?.hasAssistantTurn === true) &&
      input?.attachmentContractVerified === true &&
      input?.terminalEvidence === true &&
      Number(input?.quietSinceMs) >= Number(input?.quietThresholdMs) &&
      input?.completionPhase !== "verified_done",
  ),
  stopDisconnectedProviderAttempt: async ({
    attemptToken,
    isAttemptCurrent,
    findStopControl,
    clickStopControl,
    wait,
    now = () => Date.now(),
    timeoutMs = 5000,
    pollIntervalMs = 100,
  }) => {
    if (
      !attemptToken ||
      typeof isAttemptCurrent !== "function" ||
      typeof findStopControl !== "function" ||
      typeof clickStopControl !== "function" ||
      typeof wait !== "function"
    ) {
      return { requested: false, acknowledged: false, attempts: 0 };
    }
    const deadline = now() + Math.max(1, Number(timeoutMs) || 5000);
    const intervalMs = Math.max(1, Number(pollIntervalMs) || 100);
    let attempts = 0;
    while (isAttemptCurrent(attemptToken) && now() <= deadline) {
      attempts += 1;
      const stopControl = findStopControl();
      if (stopControl) {
        clickStopControl(stopControl);
        return { requested: true, acknowledged: true, attempts };
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await wait(Math.min(intervalMs, remainingMs));
    }
    return { requested: true, acknowledged: false, attempts };
  },
  classifyChatReadinessBlocker: ({
    siteId = null,
    visibleText = "",
  } = {}) => {
    const normalized = String(visibleText || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const siteLabel = String(siteId || "").toLowerCase() === "chatgpt"
      ? "ChatGPT"
      : "The chat site";
    if (
      /too many requests/.test(normalized) &&
      /(?:requests too quickly|temporarily limited|rate.?limit)/.test(
        normalized,
      )
    ) {
      return {
        reasonCode: "site_rate_limited",
        message: `${siteLabel} is temporarily rate-limited; no prompt or PDF was sent.`,
      };
    }
    if (
      /(?:verify (?:that )?you are human|checking your browser|captcha)/.test(
        normalized,
      )
    ) {
      return {
        reasonCode: "human_verification_required",
        message: `${siteLabel} requires human verification; no prompt or PDF was sent.`,
      };
    }
    if (/\blog in\b/.test(normalized) && /\bsign up\b/.test(normalized)) {
      return {
        reasonCode: "authentication_required",
        message: `${siteLabel} requires sign-in; no prompt or PDF was sent.`,
      };
    }
    return null;
  },
  hasUsableChatReadinessSignals: ({
    urlMatches = true,
    composerReady = false,
    activeRun = false,
    domSettled = false,
    bodyReady = true,
    mainReady = true,
  } = {}) => Boolean(
    urlMatches &&
      composerReady &&
      !activeRun &&
      domSettled &&
      bodyReady &&
      mainReady
  ),
  classifyChatReadinessTimeout: ({
    urlMatches = true,
    composerReady = false,
    activeRun = false,
    domSettled = false,
    transcriptStable = false,
  } = {}) => {
    if (!urlMatches) {
      return {
        reasonCode: "conversation_url_mismatch",
        message: "The chat tab did not reach the requested conversation; no prompt or PDF was sent.",
      };
    }
    if (!composerReady) {
      return {
        reasonCode: "composer_not_ready",
        message: "The chat composer did not become available; no prompt or PDF was sent.",
      };
    }
    if (activeRun) {
      return {
        reasonCode: "prior_turn_still_running",
        message: "The previous chat turn is still running; no new prompt or PDF was sent.",
      };
    }
    if (!domSettled) {
      return {
        reasonCode: "chat_dom_unstable",
        message: "The chat page did not finish rendering; no prompt or PDF was sent.",
      };
    }
    if (!transcriptStable) {
      return {
        reasonCode: "transcript_unstable",
        message: "The chat transcript did not stabilize; no prompt or PDF was sent.",
      };
    }
    return {
      reasonCode: "conversation_not_ready",
      message: "The conversation did not become ready; no prompt or PDF was sent.",
    };
  },
  attachmentListContainsExpectedFilename: (
    attachments,
    expectedFilename,
  ) =>
    (Array.isArray(attachments) ? attachments : []).some((attachment) =>
      shared.attachmentEvidenceMatchesFilename(
        attachment,
        expectedFilename,
      ),
    ),
  classifySubmittedPdfContract: (attachments, expectedFilename = "") => {
    const normalizedAttachments = (Array.isArray(attachments)
      ? attachments
      : [])
      .map((attachment) => String(attachment || "").trim())
      .filter(Boolean);
    const attachmentRequested = Boolean(String(expectedFilename || "").trim());
    const normalize = (value) =>
      String(value || "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const isPdfAttachment = (attachment) =>
      /\.pdf(?:\b|$)/i.test(normalize(attachment)) ||
      /\bpdf\b/i.test(normalize(attachment)) ||
      (attachmentRequested &&
        shared.attachmentEvidenceMatchesFilename(
          attachment,
          expectedFilename,
        ));
    const isImageAttachment = (attachment) =>
      /^(?:image(?:_\d+)?|.+\.(?:png|jpe?g|gif|webp|heic))$/i.test(
        normalize(attachment),
      );
    const pdfAttachments = normalizedAttachments.filter(isPdfAttachment);
    const unidentifiedAttachments = normalizedAttachments.filter(
      (attachment) =>
        !isPdfAttachment(attachment) && !isImageAttachment(attachment),
    );
    const filenameMatched = attachmentRequested
      ? shared.attachmentListContainsExpectedFilename(
        pdfAttachments,
        expectedFilename,
      )
      : null;
    const matchedPdfCount = attachmentRequested
      ? pdfAttachments.filter((attachment) =>
        shared.attachmentEvidenceMatchesFilename(
          attachment,
          expectedFilename,
        )).length
      : 0;
    return {
      attachmentRequested,
      attachmentCount: normalizedAttachments.length,
      pdfAttachmentCount: pdfAttachments.length,
      filenameMatched,
      contractVerified: attachmentRequested
        ? filenameMatched === true &&
          matchedPdfCount === 1 &&
          pdfAttachments.length === 1 &&
          unidentifiedAttachments.length === 0
        : pdfAttachments.length === 0 &&
          unidentifiedAttachments.length === 0,
    };
  },
  hasNewExpectedAttachmentEvidence: ({
    baselineEvidence = [],
    currentEvidence = [],
    expectedFilename = "",
    requireReady = true,
  } = {}) => {
    const matches = (entry) =>
      requireReady
        ? shared.attachmentEvidenceIsReady(entry, expectedFilename)
        : shared.attachmentEvidenceMatchesFilename(
          entry,
          expectedFilename,
        );
    return currentEvidence.filter(matches).length >
      baselineEvidence.filter(matches).length;
  },
  waitForNewExpectedAttachmentEvidence: async ({
    baselineEvidence = [],
    expectedFilename = "",
    readEvidence,
    wait,
    timeoutMs = 7000,
    pollIntervalMs = 100,
    requireReady = true,
  } = {}) => {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (true) {
      const currentEvidence = await readEvidence();
      if (shared.hasNewExpectedAttachmentEvidence({
        baselineEvidence,
        currentEvidence,
        expectedFilename,
        requireReady,
      })) {
        return {
          evidence:
            currentEvidence.find((entry) =>
              requireReady
                ? shared.attachmentEvidenceIsReady(
                  entry,
                  expectedFilename,
                )
                : shared.attachmentEvidenceMatchesFilename(
                  entry,
                  expectedFilename,
                ),
            ) || expectedFilename,
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          requireReady
            ? `The website did not confirm that "${expectedFilename}" was ready.`
            : `The website did not confirm attachment of "${expectedFilename}".`,
        );
      }
      await wait(Math.min(pollIntervalMs, deadline - Date.now()));
    }
  },
  attachmentCardIsSettled: (card) =>
    !/\b(?:parsing|uploading|processing|scanning|reading)\b/i.test(
      String(card || ""),
    ) &&
    !/(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
      String(card || ""),
    ),
  confirmAttachmentAcceptedThenReady: async ({
    baselineEvidence = [],
    expectedFilename = "",
    readState,
    wait,
    acceptTimeoutMs = 15000,
    readyTimeoutMs = 30000,
    pollIntervalMs = 100,
    readyQuietWindowMs = 750,
  } = {}) => {
    if (!String(expectedFilename || "").trim()) {
      throw new TypeError("expectedFilename is required");
    }
    const startedAt = Date.now();
    const poll = async (deadline, isSatisfied) => {
      while (true) {
        const state = (await readState()) || {};
        const evidence = state.evidence || [];
        const newCards = state.newCards || [];
        if (
          evidence.some((entry) =>
            shared.attachmentEvidenceHasFailure(entry, expectedFilename),
          ) ||
          newCards.some((card) =>
            shared.attachmentEvidenceHasFailure(
              shared.attachmentStatusEvidence(card, expectedFilename),
            ),
          )
        ) {
          throw new Error(
            `The website reported that "${expectedFilename}" failed to upload.`,
          );
        }
        const satisfied = isSatisfied(evidence, newCards);
        if (satisfied) return satisfied;
        if (Date.now() >= deadline) return null;
        await wait(Math.min(pollIntervalMs, deadline - Date.now()));
      }
    };

    const acceptance = await poll(
      startedAt + acceptTimeoutMs,
      (evidence, newCards) => {
        if (
          shared.hasNewExpectedAttachmentEvidence({
            baselineEvidence,
            currentEvidence: evidence,
            expectedFilename,
            requireReady: false,
          })
        ) {
          return {
            evidence:
              evidence.find((entry) =>
                shared.attachmentEvidenceMatchesFilename(
                  entry,
                  expectedFilename,
                ),
              ) || expectedFilename,
            filenameConfirmed: true,
          };
        }
        if (newCards.length > 0) {
          return {
            evidence: newCards[newCards.length - 1] || expectedFilename,
            filenameConfirmed: false,
          };
        }
        return null;
      },
    );
    if (!acceptance) {
      throw new Error(
        `The website did not confirm attachment of "${expectedFilename}".`,
      );
    }

    let readySince = null;
    const quietWindowMs = Math.max(0, Number(readyQuietWindowMs) || 0);
    const readiness = await poll(
      Date.now() + readyTimeoutMs,
      acceptance.filenameConfirmed
        ? (evidence) => {
            const ready = shared.hasNewExpectedAttachmentEvidence({
              baselineEvidence,
              currentEvidence: evidence,
              expectedFilename,
              requireReady: true,
            });
            if (!ready) {
              readySince = null;
              return null;
            }
            if (readySince === null) readySince = Date.now();
            if (Date.now() - readySince < quietWindowMs) return null;
            return {
              evidence:
                evidence.find((entry) =>
                  shared.attachmentEvidenceIsReady(
                    entry,
                    expectedFilename,
                  ),
                ) || acceptance.evidence,
            };
          }
        : (evidence, newCards) => {
            // Nothing here identifies the file, so the best available
            // signal that the upload finished is that no card is still
            // reporting progress.
            const settled =
              newCards.length > 0 &&
              newCards.every(shared.attachmentCardIsSettled);
            if (!settled) {
              readySince = null;
              return null;
            }
            if (readySince === null) readySince = Date.now();
            if (Date.now() - readySince < quietWindowMs) return null;
            return {
              evidence: newCards[newCards.length - 1] || acceptance.evidence,
            };
          },
    );

    if (!readiness && acceptance.filenameConfirmed) {
      throw new Error(
        `The website did not confirm that "${expectedFilename}" was ready.`,
      );
    }

    return {
      evidence: readiness?.evidence || acceptance.evidence,
      filenameConfirmed: acceptance.filenameConfirmed,
      readyConfirmed: Boolean(readiness),
      elapsedMs: Date.now() - startedAt,
    };
  },
  terminalAnswerSnapshotIsStable: (candidate, latest) => {
    const candidateText = String(candidate?.text || "").trim();
    const latestText = String(latest?.text || "").trim();
    if (!candidateText || candidateText !== latestText) return false;
    const candidateTurnKey = String(candidate?.assistantTurnKey || "");
    const latestTurnKey = String(latest?.assistantTurnKey || "");
    return !candidateTurnKey || !latestTurnKey ||
      candidateTurnKey === latestTurnKey;
  },
};

const WEBCHAT_DEBUG = false;
const TURN_DEBUG_EVENT_LIMIT = 200;
const RESPONSE_TIMEOUT_MS = 60 * 60_000;
let turnDebugEvents = [];
let activeTurnDebugToken = null;

function debugLog(event, payload) {
  if (!WEBCHAT_DEBUG) return;
  console.log("[sync-zotero][webchat]", event, payload || "");
}

function resetTurnDebug(seq, attempt) {
  activeTurnDebugToken = `${Number(seq) || 0}:${Number(attempt) || 0}`;
  turnDebugEvents = [];
}

function recordTurnDebug(event, payload) {
  const entry = {
    at: Date.now(),
    token: activeTurnDebugToken,
    event,
    payload: payload || null,
  };
  turnDebugEvents.push(entry);
  if (turnDebugEvents.length > TURN_DEBUG_EVENT_LIMIT) {
    turnDebugEvents.splice(0, turnDebugEvents.length - TURN_DEBUG_EVENT_LIMIT);
  }
  if (WEBCHAT_DEBUG) {
    console.log("[sync-zotero][webchat]", event, payload || "");
  }
}

globalThis.__syncZoteroWebchatDebug = {
  getEvents: () => turnDebugEvents.slice(),
  getActiveToken: () => activeTurnDebugToken,
  getState: () => ({
    activeToken: activeTurnDebugToken,
    siteId: SITE_ADAPTER?.siteId || null,
    outboundRequestSerial,
    outboundRequests: Array.isArray(outboundRequestEvents)
      ? outboundRequestEvents.slice(-10)
      : [],
    activeConversationStreamCount,
    lastTransportActivityAt,
    sseDone,
    sseTextLength: String(sseText || "").length,
    sseThinkingLength: String(sseThinking || "").length,
    lastScrape: typeof lastScrapeDebug === "object" ? lastScrapeDebug : null,
    recentEvents: turnDebugEvents.slice(-20),
  }),
};

// ---------------------------------------------------------------------------
// Site adapter — abstracts DOM selectors and site-specific behavior
// ---------------------------------------------------------------------------

const SITE_ADAPTERS = {
  "chatgpt.com": {
    siteId: "chatgpt",
    homeUrl: "https://chatgpt.com/",
    composerSelectors: [
      "#prompt-textarea",
      "[data-testid='text-input']",
      "[role='textbox'][contenteditable='true']",
      "div[contenteditable='true']",
      "textarea",
    ],
    sendButtonSelectors(composer) {
      const roots = [
        composer?.closest("form") || null,
        composer?.closest("[class*='composer']") || null,
        composer?.closest("[data-testid*='composer']") || null,
        composer?.parentElement || null,
        document,
      ];
      for (const root of roots) {
        if (!root) continue;
        const match =
          root.querySelector?.("button[data-testid='send-button']") ||
          root.querySelector?.("button[aria-label='Send message']") ||
          root.querySelector?.("button[aria-label='Send prompt']") ||
          root.querySelector?.("button[aria-label='Send']") ||
          root.querySelector?.("button[type='submit']");
        if (match && isVisibleElement(match)) return match;
      }
      return null;
    },
    stopButtonSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button[aria-label="Cancel"]',
      'button[aria-label="Cancel response"]',
      'button[title="Cancel"]',
      'button[title="Stop"]',
      '[data-testid*="cancel"]',
    ],
    userMessageSelector: "[data-message-author-role='user']",
    assistantMessageSelectors: [
      "[data-message-author-role='assistant']",
      "article[data-testid*='assistant']",
    ],
    conversationMessageSelector: "[data-message-author-role]",
    getMessageRole(node) {
      return node.getAttribute("data-message-author-role");
    },
    getMessageId(node) {
      return node.getAttribute?.("data-message-id") || node.id || null;
    },
    conversationTurnSelector: "[data-testid^='conversation-turn']",
    actionBarSelectors: [
      'button[aria-label="Copy"]',
      'button[aria-label="Regenerate"]',
      'button[aria-label="Read aloud"]',
      'button[aria-label="Good response"]',
      'button[aria-label="Bad response"]',
      'button[data-testid="copy-turn-action-button"]',
      'button[data-testid="regenerate-turn-action-button"]',
      'button[data-testid="thumbs-up-turn-action-button"]',
      'button[data-testid="thumbs-down-turn-action-button"]',
      'button[data-testid*="voice-play"]',
    ],
    thinkingSelectors: [
      "[data-testid='reasoning-content']",
      "[data-testid='thinking-content']",
      "[data-testid='thinking']",
      "[class*='thinking'] .markdown",
      "[class*='reasoning'] .markdown",
    ],
    pruneThinkingSelectors: [
      "[data-testid='reasoning-content']",
      "[data-testid='thinking-content']",
      "[data-testid='thinking']",
      "[class*='thinking']",
      "[class*='reasoning']",
    ],
    dropTargetSelectors: [
      "#prompt-textarea",
      "[data-testid='text-input']",
      "form",
    ],
    attachmentPillSelector:
      '[data-testid*="file"], [class*="attachment"], [class*="file-pill"], ' +
      '[aria-label*="pdf"], [aria-label*="PDF"], [class*="FileIcon"]',
    getChatIdFromUrl(url) {
      try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
        return match ? match[1] : null;
      } catch (_) {
        return null;
      }
    },
    historyLinkSelector: 'nav a[href^="/c/"]',
    buildHistoryEntry(a) {
      const href = a.getAttribute("href");
      const chatId = href.replace("/c/", "");
      const title = a.textContent.trim();
      return { id: chatId, title, chatUrl: `https://chatgpt.com${href}` };
    },
    deleteChatLinkSelector(chatId) {
      return `nav a[href="/c/${chatId}"]`;
    },
    supportsFileUpload: true,
    supportsModelSelector: true,
    /** Whether composer uses a <form> wrapper (enables form.requestSubmit). */
    hasFormWrapper: true,
  },

  "chat.deepseek.com": {
    siteId: "deepseek",
    homeUrl: "https://chat.deepseek.com/",
    composerSelectors: [
      'textarea[placeholder="Message DeepSeek"]',
      "textarea",
    ],
    sendButtonSelectors(composer) {
      let container = composer;
      for (let i = 0; i < 8 && container?.parentElement; i++) {
        container = container.parentElement;
        const btns = container.querySelectorAll(
          'button, [role="button"], div.ds-icon-button'
        );
        if (btns.length >= 2) break;
      }
      if (!container) container = document.body;

      const composerRect = composer?.getBoundingClientRect?.() || null;
      const candidateNodes = Array.from(
        container.querySelectorAll(
          [
            "button",
            '[role="button"]',
            "div.ds-icon-button",
            '[class*="send"]',
            '[class*="Send"]',
            '[aria-label*="send"]',
            '[aria-label*="Send"]',
            '[data-testid*="send"]',
            '[data-testid*="Send"]',
          ].join(", ")
        )
      );

      let best = null;
      let bestScore = -Infinity;
      const seen = new Set();
      for (const node of candidateNodes) {
        const btn =
          node.closest?.('button, [role="button"], div.ds-icon-button') ||
          node;
        if (!btn || seen.has(btn)) continue;
        seen.add(btn);
        if (!isVisibleElement(btn)) continue;
        if (btn.querySelector?.('input[type="file"]')) continue;
        if (btn.parentElement?.querySelector?.('input[type="file"]')) continue;

        const label = [
          btn.getAttribute?.("aria-label"),
          btn.getAttribute?.("title"),
          btn.textContent,
          btn.className,
        ].filter(Boolean).join(" ").toLowerCase();
        if (/attach|upload|file|paperclip|deepthink|search/.test(label)) {
          continue;
        }

        const rect = btn.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        let score = 0;
        if (composerRect) {
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const composerCenterY = composerRect.top + composerRect.height / 2;
          const isComposerAdjacentY =
            centerY >= composerRect.top - 80 &&
            centerY <= composerRect.bottom + 120;

          if (!isComposerAdjacentY) continue;
          score += centerX - composerRect.left;
          score -= Math.abs(centerY - composerCenterY);
          if (centerX >= composerRect.right - 140) score += 500;
          if (centerY >= composerRect.top) score += 100;
        }
        if (/send|发送/.test(label)) score += 300;
        if (/primary|circle|filled/.test(label)) score += 80;
        if (/disabled/.test(label)) score -= 1000;
        if (btn.tagName === "BUTTON") score += 20;

        if (score > bestScore) {
          best = btn;
          bestScore = score;
        }
      }
      return best;
    },
    stopButtonSelectors: [
      // DeepSeek transforms the send button into a stop button during streaming
      // (same element, different SVG). We can't distinguish stop vs send by selector
      // alone, so we rely entirely on SSE [DONE] + turn completion tracker for
      // completion detection. Empty array = findStopButton() always returns null.
    ],
    userMessageSelector: "div.ds-message",
    assistantMessageSelectors: [
      "div.ds-message",
    ],
    conversationMessageSelector: "div.ds-message",
    getMessageRole(node) {
      // Structural detection: assistant messages contain .ds-markdown child, user messages don't
      if (node.querySelector?.(".ds-markdown")) return "assistant";
      if (node.classList?.contains("ds-message")) return "user";
      return null;
    },
    getMessageId(node) {
      return node.id || null;
    },
    conversationTurnSelector: null, // DeepSeek doesn't use conversation-turn wrappers
    actionBarSelectors: [
      // DeepSeek's action bar buttons are custom ds-button role buttons.
      "div.ds-button[role='button']",
      "div.ds-icon-button[role='button']",
    ],
    thinkingSelectors: [
      // DeepSeek's DeepThink thinking content
      ".ds-think-content .ds-markdown",
      ".ds-think-content",
      "[class*='think'] .ds-markdown",
      "[class*='think']",
      "[class*='thinking'] .ds-markdown",
      "[class*='thinking']",
      "[class*='reasoning'] .ds-markdown",
      "[class*='reasoning']",
    ],
    pruneThinkingSelectors: [
      ".ds-think-content",
      "[class*='think']",
      "[class*='thinking']",
      "[class*='reasoning']",
    ],
    dropTargetSelectors: [
      'textarea[placeholder="Message DeepSeek"]',
      "textarea",
    ],
    attachmentPillSelector:
      '[class*="attachment"], [class*="file-pill"], [class*="upload"]',
    getChatIdFromUrl(url) {
      try {
        const parsed = new URL(url);
        // DeepSeek URL: /a/chat/s/{session-uuid}
        const match = parsed.pathname.match(/\/a\/chat\/s\/([^/?#]+)/);
        return match ? match[1] : null;
      } catch (_) {
        return null;
      }
    },
    historyLinkSelector: 'a[href*="/a/chat/s/"]',
    buildHistoryEntry(a) {
      const href = a.getAttribute("href");
      const match = href.match(/\/a\/chat\/s\/([^/?#]+)/);
      const chatId = match ? match[1] : href;
      const title = a.textContent.trim();
      return { id: chatId, title, chatUrl: `https://chat.deepseek.com${href}` };
    },
    deleteChatLinkSelector(chatId) {
      return `a[href*="/a/chat/s/${chatId}"]`;
    },
    supportsFileUpload: true,
    supportsModelSelector: false,
    hasFormWrapper: false,
    /** Composer textarea is disabled while model is streaming. */
    disablesComposerDuringStreaming: true,
  },

};

const SITE_ADAPTER = SITE_ADAPTERS[window.location.hostname];
if (!SITE_ADAPTER) {
  // Unknown site — content script should not run
  console.warn("[sync-zotero] Unsupported site:", window.location.hostname);
}

/** Wait until a selector matches, polling every 200 ms up to `timeout` ms. */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const interval = setInterval(() => {
      const found = document.querySelector(selector);
      if (found) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(found);
      }
    }, 200);

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for selector: ${selector}`));
    }, timeout);
  });
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dispatch synthetic React-compatible input events on an element. */
function setNativeValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  try {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: value ?? "",
      inputType: value ? "insertText" : "deleteContentBackward",
    }));
  } catch (_) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (typeof el.setSelectionRange === "function") {
    const caret = String(value || "").length;
    el.setSelectionRange(caret, caret);
  }
}

function isVisibleElement(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isUsableComposer(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (!isVisibleElement(el)) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  const contentEditable = el.getAttribute("contenteditable");
  if (contentEditable && contentEditable !== "true" && contentEditable !== "plaintext-only") {
    return false;
  }
  return true;
}

function getComposerCandidates() {
  const selectors = SITE_ADAPTER?.composerSelectors || ["textarea"];
  const candidates = [];
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (isUsableComposer(node)) {
        candidates.push(node);
      }
    }
  }
  return candidates;
}

async function getComposerElement(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = findComposerNow();
    if (composer) return composer;
    await sleep(100);
  }
  throw new Error("Chat composer was not ready in time.");
}

function findComposerNow() {
  return getComposerCandidates()[0] || null;
}

function readComposerText(composer) {
  if (!composer) return "";
  if (composer.tagName === "TEXTAREA") {
    return composer.value || "";
  }
  return composer.innerText || composer.textContent || "";
}

function dispatchComposerInput(composer, inputType, data) {
  try {
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: data ?? null,
      inputType,
    }));
  } catch (_) {
    composer.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  }
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

let composerTextBridgeSerial = 0;

function setMainWorldChatGPTComposerText(promptText, timeoutMs = 2000) {
  const requestId = [
    Date.now(),
    ++composerTextBridgeSerial,
    Math.random().toString(36).slice(2),
  ].join(":");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(result);
    };
    const onMessage = (event) => {
      const payload = event.data;
      if (
        !payload ||
        payload.source !== "sync-zotero-page" ||
        payload.type !== "SYNC_ZOTERO_SET_COMPOSER_TEXT_RESULT_V2" ||
        payload.requestId !== requestId
      ) {
        return;
      }
      finish({
        handled: true,
        applied: payload.ok === true,
        pasteAccepted: payload.pasteAccepted === true,
        error: payload.error || null,
      });
    };
    const timer = setTimeout(() => finish({
      handled: false,
      applied: false,
      pasteAccepted: false,
      timedOut: true,
    }), timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({
      source: "sync-zotero-content",
      type: "SYNC_ZOTERO_SET_COMPOSER_TEXT_V2",
      requestId,
      text: String(promptText || ""),
    }, "*");
  });
}

function selectComposerContents(composer) {
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return { range, selection };
}

async function setContentEditableText(composer, promptText) {
  selectComposerContents(composer);

  // ChatGPT's composer is ProseMirror-backed. Its paste handler applies a real
  // editor transaction (including replacement with an empty string), whereas
  // direct DOM mutation and execCommand can make text visible without updating
  // the editor state that controls Send.
  if (SITE_ADAPTER?.siteId === "chatgpt") {
    try {
      const bridgeResult = await setMainWorldChatGPTComposerText(promptText);
      if (bridgeResult.applied &&
        shared.composerTextMatchesPrompt(
          shared.normalizeComposerText(promptText),
          shared.normalizeComposerText(
            readComposerText(findComposerNow() || composer),
          ),
        )
      ) {
        return { pendingBridgeCommit: false };
      }
      const transition = shared.composerBridgeWriteTransition(bridgeResult);
      if (!transition.allowSynchronousFallback) {
        // A canceled paste event was accepted by ProseMirror even if its DOM
        // commit is still pending. Retrying or falling back can race that
        // transaction and duplicate or overwrite the prompt.
        return { pendingBridgeCommit: transition.pendingBridgeCommit };
      }
    } catch (_) {
      // An interrupted bridge may still have dispatched the paste. Fail safe
      // without a second insertion whose ordering cannot be known.
      return { pendingBridgeCommit: true };
    }
  }

  // The main-world bridge is asynchronous and may have changed the editor DOM
  // even when it could not confirm the final text. Never reuse a Range created
  // before that attempt; a detached range can append instead of replacing and
  // duplicate the prompt.
  composer = findComposerNow() || composer;
  const { range, selection } = selectComposerContents(composer);

  // execCommand is retained for other contenteditable composers and as a
  // compatibility fallback when a site does not handle synthetic paste.
  let insertedByEditor = false;
  try {
    if (typeof document.execCommand === "function") {
      insertedByEditor = promptText
        ? document.execCommand("insertText", false, promptText)
        : document.execCommand("delete", false);
    }
  } catch (_) {
    insertedByEditor = false;
  }

  if (insertedByEditor) return { pendingBridgeCommit: false };

  range.selectNodeContents(composer);
  range.deleteContents();
  range.collapse(true);
  if (!promptText) {
    composer.textContent = "";
    selection?.removeAllRanges();
    selection?.addRange(range);
    dispatchComposerInput(composer, "deleteContentBackward", "");
    return { pendingBridgeCommit: false };
  }

  const textNode = document.createTextNode(promptText);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  dispatchComposerInput(composer, "insertText", promptText);
  return { pendingBridgeCommit: false };
}

async function waitForComposerPromptMatch(
  expectedText,
  composer,
  timeoutMs,
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (true) {
    const currentComposer = findComposerNow() || composer;
    const actualText = shared.normalizeComposerText(
      readComposerText(currentComposer),
    );
    if (shared.composerTextMatchesPrompt(expectedText, actualText)) {
      return currentComposer;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(50, remaining));
  }
}

// ---------------------------------------------------------------------------
// Step 1a: Attach images (screenshots) to ChatGPT
// ---------------------------------------------------------------------------

async function attachImages(imageDataUrls) {
  if (!imageDataUrls || !imageDataUrls.length) return;

  for (const dataUrl of imageDataUrls) {
    // Convert data URL to File
    const [header, base64] = dataUrl.split(",");
    const mimeMatch = header.match(/data:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "image/png";
    const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], `screenshot.${ext}`, { type: mime });

    const dt = new DataTransfer();
    dt.items.add(file);

    let dropTarget = document.body;
    for (const sel of (SITE_ADAPTER?.dropTargetSelectors || [])) {
      const el = document.querySelector(sel);
      if (el) { dropTarget = el; break; }
    }

    dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(100);
    dropTarget.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(100);
    dropTarget.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, dataTransfer: dt }));

    // Wait briefly for the upload to be accepted
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Step 1b: Attach PDF
// ---------------------------------------------------------------------------

const PDF_ATTACHMENT_ACCEPT_TIMEOUT_MS = 15000;
const PDF_ATTACHMENT_READY_TIMEOUT_MS = 30000;
const PDF_ATTACHMENT_POLL_INTERVAL_MS = 100;
const SUBMITTED_ATTACHMENT_CONTRACT_TIMEOUT_MS = 3000;

function readAttachmentEvidenceText(element) {
  if (!element) return "";
  const renderedText =
    typeof element.innerText === "string"
      ? element.innerText
      : element.textContent;
  return [
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    renderedText,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitComposerFileControl(region, expectedFilename) {
  if (!region) return false;
  const selectors = [
    "[data-testid*='file']",
    "[class*='attachment']",
    "[class*='file-pill']",
    "button[aria-label*='Remove file']",
  ];
  return selectors.some((selector) =>
    Array.from(region.querySelectorAll?.(selector) || []).some((control) => {
      if (!isVisibleElement(control)) return false;
      const controlText = readAttachmentEvidenceText(control);
      return expectedFilename
        ? shared.attachmentEvidenceMatchesFilename(
          controlText,
          expectedFilename,
        )
        : true;
    }),
  );
}

function collectComposerRegionAttachmentEvidence(
  expectedFilename,
  messageSelector,
) {
  const composer = findComposerNow();
  if (!composer) return null;
  let region = composer?.parentElement || null;

  for (let depth = 0; depth < 8 && region; depth++) {
    if (
      region.matches?.("main, [role='main'], .ds-virtual-list") ||
      region.querySelector?.(messageSelector)
    ) {
      break;
    }
    const text = readAttachmentEvidenceText(region);
    if (text.length > 5000) {
      break;
    }
    const hasExplicitFileControl =
      hasExplicitComposerFileControl(region, expectedFilename);
    const hasAttachmentMetadata =
      shared.attachmentEvidenceHasFileCardSignal(
        text,
        hasExplicitFileControl,
      );
    const matchesExpected = expectedFilename
      ? shared.attachmentEvidenceMatchesFilename(text, expectedFilename)
      : shared.hasPendingPdfEvidence([text], hasExplicitFileControl);
    if (matchesExpected && hasAttachmentMetadata) {
      if (!expectedFilename) {
        return [text];
      }
      const normalizedText = String(text || "").normalize("NFC").toLowerCase();
      const normalizedFilename = String(expectedFilename || "")
        .normalize("NFC")
        .toLowerCase();
      let occurrenceCount = 0;
      let searchFrom = 0;
      while (normalizedFilename) {
        const foundAt = normalizedText.indexOf(
          normalizedFilename,
          searchFrom,
        );
        if (foundAt < 0) break;
        occurrenceCount += 1;
        searchFrom = foundAt + normalizedFilename.length;
      }
      return Array(Math.max(1, occurrenceCount)).fill(text);
    }
    region = region.parentElement;
  }

  // Nothing conclusive around the composer — let the caller fall back to the
  // document-wide scan instead of reporting "no attachment".
  return null;
}

function collectVisibleComposerAttachmentEvidence(expectedFilename) {
  const selector =
    SITE_ADAPTER?.attachmentPillSelector ||
    '[data-testid*="file"], [class*="attachment"], [class*="file-pill"]';
  const messageSelector =
    SITE_ADAPTER?.conversationMessageSelector ||
    "[data-message-author-role]";
  const composerRegionEvidence =
    collectComposerRegionAttachmentEvidence(
      expectedFilename,
      messageSelector,
    );
  if (composerRegionEvidence !== null) {
    return composerRegionEvidence;
  }
  const evidence = [];
  const seenEvidenceNodes = new Set();
  const candidates = Array.from(document.querySelectorAll(selector));
  const seenCandidates = new Set(candidates);
  document
    .querySelectorAll("div, span, [aria-label], [title]")
    .forEach((candidate) => {
      const text = readAttachmentEvidenceText(candidate);
      const isRelevant =
        text.length <= 2000 &&
        (expectedFilename
          ? shared.attachmentEvidenceMatchesFilename(
            text,
            expectedFilename,
          )
          : shared.hasPendingPdfEvidence([text]));
      if (isRelevant && !seenCandidates.has(candidate)) {
        seenCandidates.add(candidate);
        candidates.push(candidate);
      }
    });

  for (const candidate of candidates) {
    if (!isVisibleElement(candidate)) continue;
    if (!expectedFilename && candidate.closest?.(messageSelector)) {
      continue;
    }

    let evidenceNode = candidate;
    for (let depth = 0; depth < 5 && evidenceNode; depth++) {
      if (
        !expectedFilename &&
        evidenceNode.closest?.(messageSelector)
      ) {
        break;
      }
      const text = readAttachmentEvidenceText(evidenceNode);
      const hasExplicitFileControl = hasExplicitComposerFileControl(
        evidenceNode,
        expectedFilename,
      );
      const hasAttachmentMetadata =
        shared.attachmentEvidenceHasFileCardSignal(
          text,
          hasExplicitFileControl,
        );
      const matchesExpected = expectedFilename
        ? shared.attachmentEvidenceMatchesFilename(text, expectedFilename)
        : shared.hasPendingPdfEvidence([text], hasExplicitFileControl);
      if (matchesExpected && hasAttachmentMetadata) {
        if (!seenEvidenceNodes.has(evidenceNode)) {
          seenEvidenceNodes.add(evidenceNode);
          evidence.push(text);
        }
        break;
      }
      evidenceNode = evidenceNode.parentElement;
    }
  }

  return evidence;
}

// A file card is short — a name, a type, a size. Prose that merely mentions a
// PDF is not, so length is what separates the two when class names tell us
// nothing (DeepSeek ships scrambled class names such as "e70accd6").
const FILE_CARD_MAX_TEXT_LENGTH = 300;

/**
 * Every visible file card node attached to the composer, regardless of what it
 * is named. Diffing these against the pre-drop snapshot is how an upload is
 * confirmed when the site renders a name we cannot match — ChatGPT's card, for
 * one, is identifiable only by a localized "Remove file" label.
 */
function collectComposerFileCardNodes() {
  const selector =
    SITE_ADAPTER?.attachmentPillSelector ||
    '[data-testid*="file"], [class*="attachment"], [class*="file-pill"]';
  const messageSelector =
    SITE_ADAPTER?.conversationMessageSelector ||
    "[data-message-author-role]";
  const isCandidate = (node) =>
    isVisibleElement(node) &&
    !node.closest?.(messageSelector) &&
    readAttachmentEvidenceText(node);
  const candidates = Array.from(document.querySelectorAll(selector)).filter(
    isCandidate,
  );
  // Sites whose class names are generated expose no selector to match, so fall
  // back to shape: a small node whose text reads like a file card.
  document.querySelectorAll("div, span").forEach((node) => {
    if (candidates.includes(node) || !isCandidate(node)) return;
    const text = readAttachmentEvidenceText(node);
    if (text.length > FILE_CARD_MAX_TEXT_LENGTH) return;
    if (
      /\.pdf(?:\b|$)/i.test(text) &&
      shared.attachmentEvidenceHasFileCardSignal(text, true)
    ) {
      candidates.push(node);
    }
  });
  // Keep the innermost node of each nested group so one card counts once even
  // when a wrapper matches too.
  return candidates.filter(
    (node) =>
      !candidates.some((other) => other !== node && node.contains(other)),
  );
}

function collectVisibleComposerPdfCardEvidence() {
  const messageSelector =
    SITE_ADAPTER?.conversationMessageSelector ||
    "[data-message-author-role]";
  // This preflight must remain inside the composer ancestry. A document-wide
  // fallback sees PDF cards in already-submitted user turns and falsely blocks
  // the next prompt-only send.
  return Array.from(
    new Set(
      collectComposerRegionAttachmentEvidence("", messageSelector) || [],
    ),
  );
}

function readPdfAttachmentState(pdfFilename, baselineCardNodes) {
  return {
    evidence: collectVisibleComposerAttachmentEvidence(pdfFilename),
    newCards: collectComposerFileCardNodes()
      .filter((node) => !baselineCardNodes.has(node))
      .map(readAttachmentEvidenceText),
  };
}

async function waitForPdfAttachmentConfirmation({
  baselineEvidence,
  baselineCardNodes,
  pdfFilename,
}) {
  return shared.confirmAttachmentAcceptedThenReady({
    baselineEvidence,
    expectedFilename: pdfFilename,
    readState: () => readPdfAttachmentState(pdfFilename, baselineCardNodes),
    wait: sleep,
    acceptTimeoutMs: PDF_ATTACHMENT_ACCEPT_TIMEOUT_MS,
    readyTimeoutMs: PDF_ATTACHMENT_READY_TIMEOUT_MS,
    pollIntervalMs: PDF_ATTACHMENT_POLL_INTERVAL_MS,
  });
}

async function attachPDF(pdfBase64, pdfFilename) {
  const startedAt = Date.now();
  const baselineEvidence =
    collectVisibleComposerAttachmentEvidence(pdfFilename);
  const baselineCardNodes = new Set(collectComposerFileCardNodes());

  // Decode base64 → Uint8Array → File
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], pdfFilename, { type: "application/pdf" });

  const dt = new DataTransfer();
  dt.items.add(file);

  let dropTarget = document.body;
  for (const sel of (SITE_ADAPTER?.dropTargetSelectors || [])) {
    const el = document.querySelector(sel);
    if (el) {
      dropTarget = el;
      break;
    }
  }
  dropTarget.dispatchEvent(
    new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }),
  );
  await sleep(100);
  dropTarget.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }),
  );
  await sleep(100);
  dropTarget.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }),
  );

  let confirmation;
  try {
    confirmation = await waitForPdfAttachmentConfirmation({
      baselineEvidence,
      baselineCardNodes,
      pdfFilename,
    });
  } catch (error) {
    throw new Error(
      `PDF attachment failed for "${pdfFilename}": ${error?.message || String(error)}`,
    );
  }
  return {
    ...confirmation,
    method: "drag_drop",
    totalElapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Step 1c: Detect and select ChatGPT model / thinking mode
// ---------------------------------------------------------------------------

// Track the last mode we successfully set, so we can skip the dropdown
// when the mode hasn't changed (avoids disrupting the composer on follow-ups).
let _lastSetChatGPTMode = null;

/**
 * Switch ChatGPT's model and thinking effort before sending a message.
 *
 * Supported modes:
 *   "instant"           → Select "Instant" (fast, no thinking)
 *   "thinking_standard"  → Select "Thinking" + "Standard" effort
 *   "thinking_extended"  → Select "Thinking" + "Extended" effort
 *
 * Skips if mode matches the last successfully set mode.
 * Skips if mode is null/undefined (leave whatever the user already has).
 */
async function selectChatGPTMode(mode) {
  if (!mode) return;
  if (mode === _lastSetChatGPTMode) {
    console.log(`[sync-zotero] Mode already ${mode} — skipping switch`);
    return;
  }

  try {
    // --- Step 1: Open the model selector dropdown ---
    const modelBtnSelectors = [
      'button[data-testid="model-selector"]',
      'button[aria-haspopup="menu"][class*="model"]',
    ];

    let modelBtn = null;
    for (const sel of modelBtnSelectors) {
      modelBtn = document.querySelector(sel);
      if (modelBtn) break;
    }

    // Broader fallback: find button with "ChatGPT" text
    if (!modelBtn) {
      const buttons = document.querySelectorAll('button[aria-haspopup]');
      for (const btn of buttons) {
        if (/chatgpt/i.test(btn.textContent)) {
          modelBtn = btn;
          break;
        }
      }
    }

    if (!modelBtn) {
      console.warn("[sync-zotero] Could not find ChatGPT model selector button — skipping mode switch");
      return;
    }

    modelBtn.click();
    await sleep(400);

    // --- Step 2: Select the model type (Instant vs Thinking) ---
    const wantThinking = mode.startsWith("thinking");
    const targetLabel = wantThinking ? "thinking" : "instant";

    // Find menu items in the dropdown
    const menuItems = document.querySelectorAll(
      '[role="menuitem"], [role="option"], [data-testid*="model-option"], [class*="menu"] button'
    );

    let targetItem = null;
    for (const item of menuItems) {
      const text = item.textContent.toLowerCase().trim();
      if (text.includes(targetLabel)) {
        targetItem = item;
        break;
      }
    }

    // Also try generic menu items
    if (!targetItem) {
      const allClickables = document.querySelectorAll('[role="dialog"] button, [role="menu"] button, [role="listbox"] [role="option"]');
      for (const el of allClickables) {
        if (el.textContent.toLowerCase().includes(targetLabel)) {
          targetItem = el;
          break;
        }
      }
    }

    if (targetItem) {
      targetItem.click();
      await sleep(400);
    } else {
      console.warn(`[sync-zotero] Could not find "${targetLabel}" option in model menu`);
    }

    // --- Step 3: If thinking mode, set the effort level ---
    if (wantThinking && targetItem) {
      const effort = mode === "thinking_extended" ? "extended" : "standard";
      await sleep(300);

      // Look for the thinking effort dropdown/chip
      const effortSelectors = [
        'button[aria-label*="thinking"]',
        'button[class*="thinking"]',
        '[data-testid*="thinking"]',
      ];

      let effortBtn = null;
      for (const sel of effortSelectors) {
        effortBtn = document.querySelector(sel);
        if (effortBtn) break;
      }

      // Fallback: find button containing "thinking" text near the composer
      if (!effortBtn) {
        const composerArea = document.querySelector('form') || document.querySelector('[class*="composer"]') || document.body;
        const btns = composerArea.querySelectorAll('button');
        for (const btn of btns) {
          if (/thinking/i.test(btn.textContent) && btn.textContent.length < 50) {
            effortBtn = btn;
            break;
          }
        }
      }

      if (effortBtn) {
        effortBtn.click();
        await sleep(300);

        const effortItems = document.querySelectorAll(
          '[role="menuitem"], [role="option"], [role="dialog"] button, [role="menu"] button'
        );
        for (const item of effortItems) {
          if (item.textContent.toLowerCase().includes(effort)) {
            item.click();
            await sleep(200);
            break;
          }
        }
      }
    }
  } finally {
    // Always close any remaining open menus/dropdowns to unblock the composer
    await sleep(100);
    const openMenus = document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]');
    for (const menu of openMenus) {
      // Only close if it looks like a floating/overlay menu (not the main page)
      if (menu.closest('[data-radix-popper-content-wrapper]') || menu.closest('[class*="popover"]')) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(200);
        break;
      }
    }
    // Final Escape to be safe — clicking outside won't work if composer is covered
    document.body.click();
    await sleep(100);
  }
  // Record the mode we just set so we can skip next time if unchanged
  _lastSetChatGPTMode = mode;
}

// ---------------------------------------------------------------------------
// Step 2: Type prompt
// ---------------------------------------------------------------------------

async function typePromptAndVerify(
  promptText,
  { requireEnabledSendControl = false } = {},
) {
  const expectedText = shared.normalizeComposerText(promptText);
  let promptTextMatched = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const composer = await getComposerElement();
    composer.focus();
    let pendingBridgeCommit = false;

    if (composer.tagName === "TEXTAREA") {
      setNativeValue(composer, "");
      setNativeValue(composer, promptText);
    } else {
      // setContentEditableText selects the full editor contents and replaces
      // them atomically. A separate asynchronous clear transaction can race
      // the insertion and was the source of duplicated ChatGPT prompts.
      const writeResult = await setContentEditableText(composer, promptText);
      pendingBridgeCommit = writeResult?.pendingBridgeCommit === true;
    }

    const verificationPolicy = shared.composerPromptVerificationPolicy(
      pendingBridgeCommit,
    );
    const currentComposer = await waitForComposerPromptMatch(
      expectedText,
      composer,
      verificationPolicy.matchTimeoutMs,
    );
    if (currentComposer) {
      promptTextMatched = true;
      if (!requireEnabledSendControl) return currentComposer;

      const sendBtn = await waitForSendButtonEnabled(1500);
      if (isEnabledButton(sendBtn)) return currentComposer;
    }
    if (!verificationPolicy.allowRetry) break;
  }

  if (promptTextMatched && requireEnabledSendControl) {
    throw new Error(
      "Prompt verification failed: ChatGPT displayed the prompt but did not enable Send.",
    );
  }
  throw new Error("Prompt verification failed: composer text did not match the requested prompt.");
}

// ---------------------------------------------------------------------------
// Step 3: Submit
// ---------------------------------------------------------------------------

function isEnabledButton(btn) {
  const classText =
    typeof btn?.className === "string"
      ? btn.className
      : btn?.getAttribute?.("class") || "";
  return Boolean(btn) &&
    !btn.disabled &&
    !btn.hasAttribute("disabled") &&
    btn.getAttribute?.("aria-disabled") !== "true" &&
    !/disabled/i.test(classText) &&
    isVisibleElement(btn);
}

async function waitForSendButton(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = findSendButton();
    if (button) return button;
    await sleep(100);
  }
  return null;
}

function findSendButton(composer = findComposerNow()) {
  if (SITE_ADAPTER?.sendButtonSelectors && typeof SITE_ADAPTER.sendButtonSelectors === "function") {
    return SITE_ADAPTER.sendButtonSelectors(composer);
  }
  return null;
}

async function waitForSendButtonEnabled(timeoutMs = 8000) {
  // Wait for the send button to exist AND not be disabled
  // (ChatGPT disables it while the uploaded file is being processed)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = findSendButton();
    if (isEnabledButton(btn)) {
      return btn;
    }
    await sleep(100);
  }
  return null;
}

function dispatchSubmitViaEnter(composer) {
  if (!composer) return;
  composer.focus();
  const eventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  composer.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  composer.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  composer.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}

function dispatchSubmitViaForm(composer) {
  const form = composer?.closest?.("form");
  if (!form) return;
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function dispatchPointerClick(el) {
  if (!el) return;
  el.focus?.();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1,
  };
  const pointerEventInit = {
    ...eventInit,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventCtor =
      type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
    el.dispatchEvent(
      new EventCtor(
        type,
        type.startsWith("pointer") ? pointerEventInit : eventInit
      )
    );
  }
}

function describeSubmitControl(btn) {
  if (!btn) return "not_found";
  const rect = btn.getBoundingClientRect?.();
  const classText =
    typeof btn.className === "string"
      ? btn.className
      : btn.getAttribute?.("class") || "";
  const state = isEnabledButton(btn) ? "enabled" : "disabled_or_hidden";
  const geometry = rect
    ? `x=${Math.round(rect.x)},y=${Math.round(rect.y)},w=${Math.round(rect.width)},h=${Math.round(rect.height)}`
    : "no_rect";
  return `${state}; ${btn.tagName.toLowerCase()}; class=${classText.slice(0, 120)}; ${geometry}`;
}

function buildDiagnostic(overrides = {}) {
  const diagnostic = {
    siteId: SITE_ADAPTER?.siteId || null,
    phase: overrides.phase || null,
    reasonCode: overrides.reasonCode || null,
    message: overrides.message || null,
    composerTextMatched:
      typeof overrides.composerTextMatched === "boolean"
        ? overrides.composerTextMatched
        : null,
    uploadDetected:
      typeof overrides.uploadDetected === "boolean"
        ? overrides.uploadDetected
        : null,
    sendControlState:
      overrides.sendControlState ||
      describeSubmitControl(findSendButton(findComposerNow())),
    clickAttempts:
      Number.isFinite(Number(overrides.clickAttempts))
        ? Math.max(0, Math.floor(Number(overrides.clickAttempts)))
        : null,
    requestObserved:
      typeof overrides.requestObserved === "boolean"
        ? overrides.requestObserved
        : null,
    streamObserved:
      typeof overrides.streamObserved === "boolean"
        ? overrides.streamObserved
        : null,
    userTurnMatched:
      typeof overrides.userTurnMatched === "boolean"
        ? overrides.userTurnMatched
        : null,
    assistantTurnMatched:
      typeof overrides.assistantTurnMatched === "boolean"
        ? overrides.assistantTurnMatched
        : null,
    attachmentFilename: overrides.attachmentFilename || null,
    attachmentMethod: overrides.attachmentMethod || null,
    attachmentVerificationMs:
      Number.isFinite(Number(overrides.attachmentVerificationMs))
        ? Math.max(0, Math.floor(Number(overrides.attachmentVerificationMs)))
        : null,
    attachmentPreviewVerified:
      typeof overrides.attachmentPreviewVerified === "boolean"
        ? overrides.attachmentPreviewVerified
        : null,
    attachmentRequested:
      typeof overrides.attachmentRequested === "boolean"
        ? overrides.attachmentRequested
        : null,
    attachmentFilenameConfirmed:
      typeof overrides.attachmentFilenameConfirmed === "boolean"
        ? overrides.attachmentFilenameConfirmed
        : null,
    attachmentReadyVerified:
      typeof overrides.attachmentReadyVerified === "boolean"
        ? overrides.attachmentReadyVerified
        : null,
    submittedAttachmentVerified:
      typeof overrides.submittedAttachmentVerified === "boolean"
        ? overrides.submittedAttachmentVerified
        : null,
    submittedAttachmentCount:
      Number.isFinite(Number(overrides.submittedAttachmentCount))
        ? Math.max(
          0,
          Math.floor(Number(overrides.submittedAttachmentCount)),
        )
        : null,
    submittedPdfCount:
      Number.isFinite(Number(overrides.submittedPdfCount))
        ? Math.max(0, Math.floor(Number(overrides.submittedPdfCount)))
        : null,
    attachmentContractVerified:
      typeof overrides.attachmentContractVerified === "boolean"
        ? overrides.attachmentContractVerified
        : null,
    completionDetectionMs:
      overrides.completionDetectionMs == null
        ? null
        : Math.max(
          0,
          Math.floor(Number(overrides.completionDetectionMs) || 0),
        ),
  };
  lastDiagnostic = {
    ...diagnostic,
    at: Date.now(),
  };
  return diagnostic;
}

function hasPromptSubmissionSignal(
  transcript,
  baselineTranscriptCount,
  promptText,
) {
  const baselineCount = Math.max(0, Number(baselineTranscriptCount) || 0);
  const newMessages = transcript.messages.slice(baselineCount);
  if (newMessages.length === 0) return false;

  if (findMatchingUserTurn(transcript, baselineCount, promptText)) {
    return true;
  }

  return newMessages.some((message) =>
    message.role === "assistant" ||
    (Array.isArray(message.attachments) && message.attachments.length > 0),
  );
}

function composerLooksSubmitted(promptText, composer = findComposerNow()) {
  if (!composer) return false;
  const expectedText = shared.normalizeComposerText(promptText);
  if (!expectedText) return false;

  const actualText = shared.normalizeComposerText(readComposerText(composer));
  if (!actualText) return true;
  return !shared.composerTextMatchesPrompt(expectedText, actualText);
}

async function waitForSubmissionSignal(
  promptText,
  baselineOutboundRequestSerial,
  baselineUserMessageCount,
  baselineTranscriptCount,
  timeoutMs = 15000,
  baselineActiveStreamCount = activeConversationStreamCount,
) {
  const deadline = Date.now() + timeoutMs;
  let observedRequestContext = null;
  let sawComposerSubmitted = false;

  while (Date.now() < deadline) {
    const isDeepSeek = SITE_ADAPTER?.siteId === "deepseek";
    if (!observedRequestContext && SITE_ADAPTER?.siteId === "deepseek") {
      observedRequestContext = findObservedDeepSeekRequestContext(
        baselineOutboundRequestSerial,
        promptText,
      );
      if (observedRequestContext) {
        return {
          delivered: true,
          requestObserved: true,
          streamObserved: false,
          composerSubmitted: sawComposerSubmitted,
          requestContext: observedRequestContext,
        };
      }
    }

    const composer = findComposerNow();
    const userMessageCount = getUserMessageCount();
    const streamObserved =
      SITE_ADAPTER?.siteId === "deepseek" &&
      activeConversationStreamCount > baselineActiveStreamCount;
    const signal = shared.hasDeliverySignal({
      baselineOutboundRequestSerial,
      outboundRequestSerial,
      baselineUserMessageCount,
      userMessageCount,
      stopButtonVisible: !!findStopButton(),
      composerTextAfter: readComposerText(composer),
      promptText,
    });
    if (signal) {
      if (isDeepSeek && userMessageCount <= baselineUserMessageCount && !streamObserved) {
        sawComposerSubmitted = composerLooksSubmitted(promptText, composer);
      } else {
        return {
          delivered: true,
          requestObserved: Boolean(observedRequestContext),
          streamObserved,
          composerSubmitted: sawComposerSubmitted,
          requestContext: observedRequestContext,
        };
      }
    }

    if (streamObserved) {
      return {
        delivered: true,
        requestObserved: Boolean(observedRequestContext),
        streamObserved: true,
        composerSubmitted: sawComposerSubmitted,
        requestContext: observedRequestContext,
      };
    }

    if (composerLooksSubmitted(promptText, composer)) {
      sawComposerSubmitted = true;
      if (!isDeepSeek) {
        return {
          delivered: true,
          requestObserved: Boolean(observedRequestContext),
          streamObserved: false,
          composerSubmitted: true,
          requestContext: observedRequestContext,
        };
      }
    }

    const promptSubmissionSignal = hasPromptSubmissionSignal(
      extractConversationTranscript(),
      baselineTranscriptCount,
      promptText,
    );
    if (promptSubmissionSignal) {
      return {
        delivered: true,
        requestObserved: Boolean(observedRequestContext),
        streamObserved,
        composerSubmitted: sawComposerSubmitted,
        requestContext: observedRequestContext,
      };
    }
    await workerSleep(200);
  }
  return {
    delivered: false,
    requestObserved: Boolean(observedRequestContext),
    streamObserved: false,
    composerSubmitted: sawComposerSubmitted,
    requestContext: observedRequestContext,
  };
}

function assertPipelineCurrent(isPipelineCurrent) {
  if (typeof isPipelineCurrent !== "function" || isPipelineCurrent()) return;
  const error = new Error(
    "WebChat pipeline was cancelled because its relay attempt ended.",
  );
  error.name = "PipelineCancelled";
  throw error;
}

async function submitMessageAndVerify(
  promptText,
  isPipelineCurrent = () => true,
) {
  if (SITE_ADAPTER?.siteId === "deepseek") {
    return submitDeepSeekMessageAndVerify(promptText, isPipelineCurrent);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    assertPipelineCurrent(isPipelineCurrent);
    let clickAttempts = 0;
    const submitStrategies = [
      async (composer) => {
        const sendBtn = await waitForSendButtonEnabled(30000);
        if (!isEnabledButton(sendBtn)) return false;
        clickAttempts++;
        sendBtn.click();
        return true;
      },
      (composer) => dispatchSubmitViaEnter(composer),
      (composer) => dispatchSubmitViaForm(composer),
    ];

    for (const submit of submitStrategies) {
      assertPipelineCurrent(isPipelineCurrent);
      const composer = await getComposerElement();
      const sendBtn = await waitForSendButton(4000);
      if (!sendBtn && attempt === 0) {
        await sleep(150);
      }

      const baselineTranscriptCount = extractConversationTranscript().count;
      const baselineUserMessageCount = getUserMessageCount();
      const baselineOutboundRequestSerial = outboundRequestSerial;

      assertPipelineCurrent(isPipelineCurrent);
      const submitStarted = await submit(composer, sendBtn);
      if (submitStarted === false) {
        continue;
      }

      const delivered = await waitForSubmissionSignal(
        promptText,
        baselineOutboundRequestSerial,
        baselineUserMessageCount,
        baselineTranscriptCount,
      );
      assertPipelineCurrent(isPipelineCurrent);
      if (delivered.delivered || delivered.requestObserved) {
        return {
          baselineOutboundRequestSerial,
          clickAttempts,
          requestObserved: Boolean(delivered.requestObserved),
          streamObserved: Boolean(delivered.streamObserved),
          requestContext:
            delivered.requestContext ||
            findObservedDeepSeekRequestContext(
              baselineOutboundRequestSerial,
              promptText,
            ) ||
            null,
        };
      }

      await typePromptAndVerify(promptText);
    }
  }

  throw new Error("Prompt delivery failed: chat did not accept the prompt after 2 attempts.");
}

async function submitDeepSeekMessageAndVerify(
  promptText,
  isPipelineCurrent = () => true,
) {
  let totalClickAttempts = 0;
  let lastSubmitControl = "not_checked";

  for (let attempt = 0; attempt < 2; attempt++) {
    assertPipelineCurrent(isPipelineCurrent);
    const composer = await getComposerElement();
    const baselineTranscriptCount = extractConversationTranscript().count;
    const baselineUserMessageCount = getUserMessageCount();
    const baselineOutboundRequestSerial = outboundRequestSerial;
    const baselineActiveStreamCount = activeConversationStreamCount;
    const deadline = Date.now() + 30000;
    let lastClickAt = 0;

    while (Date.now() < deadline) {
      assertPipelineCurrent(isPipelineCurrent);
      const remaining = Math.max(0, deadline - Date.now());
      const delivery = await waitForSubmissionSignal(
        promptText,
        baselineOutboundRequestSerial,
        baselineUserMessageCount,
        baselineTranscriptCount,
        Math.min(350, remaining),
        baselineActiveStreamCount,
      );
      if (delivery.delivered || delivery.requestObserved) {
        return {
          baselineOutboundRequestSerial,
          clickAttempts: totalClickAttempts,
          requestObserved: Boolean(delivery.requestObserved),
          streamObserved: Boolean(delivery.streamObserved),
          composerSubmitted: Boolean(delivery.composerSubmitted),
          requestContext:
            delivery.requestContext ||
            findObservedDeepSeekRequestContext(
              baselineOutboundRequestSerial,
              promptText,
            ) ||
            null,
        };
      }

      const currentComposer = findComposerNow() || composer;
      const sendBtn = findSendButton(currentComposer);
      lastSubmitControl = describeSubmitControl(sendBtn);
      const now = Date.now();
      if (isEnabledButton(sendBtn) && now - lastClickAt >= 350) {
        assertPipelineCurrent(isPipelineCurrent);
        lastClickAt = now;
        totalClickAttempts++;
        dispatchPointerClick(sendBtn);

        const postClick = await waitForSubmissionSignal(
          promptText,
          baselineOutboundRequestSerial,
          baselineUserMessageCount,
          baselineTranscriptCount,
          Math.min(1500, Math.max(0, deadline - Date.now())),
          baselineActiveStreamCount,
        );
        if (postClick.delivered || postClick.requestObserved) {
          return {
            baselineOutboundRequestSerial,
            clickAttempts: totalClickAttempts,
            requestObserved: Boolean(postClick.requestObserved),
            streamObserved: Boolean(postClick.streamObserved),
            composerSubmitted: Boolean(postClick.composerSubmitted),
            requestContext:
              postClick.requestContext ||
              findObservedDeepSeekRequestContext(
                baselineOutboundRequestSerial,
                promptText,
              ) ||
              null,
          };
        }
        if (composerLooksSubmitted(promptText, currentComposer)) {
          buildDiagnostic({
            phase: "submitted",
            reasonCode: "composer_changed_without_authoritative_signal",
            clickAttempts: totalClickAttempts,
            requestObserved: false,
            streamObserved: false,
          });
        }
      } else {
        await workerSleep(150);
      }
    }

    await typePromptAndVerify(promptText);
  }

  const detail = totalClickAttempts > 0
    ? `DeepSeek send was clicked ${totalClickAttempts} time(s), but no delivery signal was observed`
    : `no clickable DeepSeek send control was found (${lastSubmitControl})`;
  buildDiagnostic({
    phase: "submitted",
    reasonCode:
      totalClickAttempts > 0
        ? "submit_clicked_without_delivery_signal"
        : "send_control_not_clickable",
    message: detail,
    sendControlState: lastSubmitControl,
    clickAttempts: totalClickAttempts,
    requestObserved: false,
    streamObserved: false,
  });
  throw new Error(`Prompt delivery failed: ${detail}.`);
}

// ---------------------------------------------------------------------------
// SSE interception listener (receives data from injected.js in MAIN world)
// ---------------------------------------------------------------------------

let sseText = "";
let sseThinking = null;
let sseDone = false;
let sseDoneAt = 0; // timestamp when sseDone first became true (0 = not done)
let outboundRequestSerial = 0;
let outboundRequestEvents = [];
let activeConversationStreamCount = 0;
let lastTransportActivityAt = 0;
let lastTransportCompletedAt = 0;
let mainWorldInjected = false;
let networkHookActive = false;
let lastRequestAt = 0;
let lastStreamAt = 0;
let lastDiagnostic = null;
let historyScrapeInFlight = null; // null | Promise — concurrent callers wait
let lastScrapeDebug = null;

function mergeStreamFragments(previous, next) {
  const prev = String(previous || "");
  const upcoming = String(next || "");
  if (!upcoming) return prev;
  if (!prev) return upcoming;
  if (upcoming.startsWith(prev)) return upcoming;
  if (prev.startsWith(upcoming)) return prev;

  const maxOverlap = Math.min(prev.length, upcoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (prev.slice(-overlap) === upcoming.slice(0, overlap)) {
      return prev + upcoming.slice(overlap);
    }
  }
  return prev + upcoming;
}

function makePromptFingerprint(text) {
  const normalized = shared.normalizeComposerText(text)
    .normalize("NFC")
    .toLowerCase();
  if (!normalized) return "";
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function storeOutboundRequestEvent(payload = {}) {
  const requestSerial = Number(payload.requestSerial) || (outboundRequestSerial + 1);
  outboundRequestSerial = Math.max(outboundRequestSerial, requestSerial);
  outboundRequestEvents.push({
    requestSerial,
    chatUrl: typeof payload.chatUrl === "string" ? payload.chatUrl : null,
    chatId: typeof payload.chatId === "string" ? payload.chatId : null,
    sentAt: Number(payload.sentAt) || Date.now(),
    promptFingerprint:
      typeof payload.promptFingerprint === "string" && payload.promptFingerprint
        ? payload.promptFingerprint
        : null,
  });
  if (outboundRequestEvents.length > 40) {
    outboundRequestEvents = outboundRequestEvents.slice(-40);
  }
  return outboundRequestEvents[outboundRequestEvents.length - 1] || null;
}

function findObservedDeepSeekRequestContext(
  baselineRequestSerial,
  promptText = "",
) {
  if (SITE_ADAPTER?.siteId !== "deepseek") return null;
  const promptFingerprint = makePromptFingerprint(promptText);
  const candidates = outboundRequestEvents.filter(
    (event) => event.requestSerial > baselineRequestSerial,
  );
  if (!candidates.length) return null;
  if (!promptFingerprint) {
    return candidates[0] || null;
  }
  const exact = candidates.find(
    (event) =>
      !event.promptFingerprint || event.promptFingerprint === promptFingerprint,
  );
  return exact || candidates[0] || null;
}

const pendingNetworkHealthRequests = new Map();

function requestMainWorldHealth(timeoutMs = 250) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingNetworkHealthRequests.delete(nonce);
      resolve(false);
    }, timeoutMs);
    pendingNetworkHealthRequests.set(nonce, (ok) => {
      clearTimeout(timer);
      pendingNetworkHealthRequests.delete(nonce);
      resolve(Boolean(ok));
    });
    window.postMessage({
      type: "SYNC_ZOTERO_NETWORK_HEALTH_REQUEST",
      nonce,
    }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type === "SYNC_ZOTERO_INJECTED_READY") {
    mainWorldInjected = true;
    networkHookActive = event.data.networkHookActive !== false;
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_NETWORK_HEALTH") {
    mainWorldInjected = true;
    networkHookActive = event.data.networkHookActive !== false;
    const nonce = event.data.nonce || null;
    if (nonce && pendingNetworkHealthRequests.has(nonce)) {
      pendingNetworkHealthRequests.get(nonce)(networkHookActive);
    }
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_DEEPSEEK_TRANSCRIPT_CACHE") {
    storeDeepSeekTranscriptSnapshot(event.data.snapshot);
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_DEEPSEEK_HISTORY_CACHE") {
    storeDeepSeekHistorySnapshot(event.data.snapshot);
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_SSE") {
    sseText = mergeStreamFragments(sseText, event.data.text || "");
    sseThinking = mergeStreamFragments(sseThinking || "", event.data.thinking || "") || null;
    networkHookActive = true;
    lastStreamAt = Date.now();
    // Only mark SSE as done when this is the last active stream.
    // During multi-tool-use flows, earlier streams finish before the
    // actual answer stream — their [DONE] should not end the pipeline.
    if (event.data.done) {
      const activeCount = Number(event.data.activeStreamCount) || 0;
      const wasDone = sseDone;
      sseDone = activeCount <= 1;
      if (sseDone && !wasDone) sseDoneAt = Date.now();
    } else {
      sseDone = false;
      sseDoneAt = 0;
    }
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_STREAM_START") {
    // A new SSE stream is starting (e.g., tool-use continuation).
    // Reset done flag so the previous stream's [DONE] doesn't
    // cause premature pipeline exit.
    sseDone = false;
    sseDoneAt = 0;
    networkHookActive = true;
    lastStreamAt = Date.now();
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_REQUEST") {
    storeOutboundRequestEvent(event.data);
    networkHookActive = true;
    lastRequestAt = Date.now();
    lastTransportActivityAt = Date.now();
    return;
  }
  if (event.data?.type === "SYNC_ZOTERO_STREAM_STATE") {
    const previousActiveStreamCount = activeConversationStreamCount;
    activeConversationStreamCount = Math.max(0, Number(event.data.activeCount) || 0);
    networkHookActive = true;
    if (activeConversationStreamCount > 0) lastStreamAt = Date.now();
    if (
      previousActiveStreamCount > 0 &&
      activeConversationStreamCount === 0
    ) {
      lastTransportCompletedAt = Date.now();
    }
    lastTransportActivityAt = Date.now();
  }
});

requestDeepSeekNetworkCacheReplay();

// ---------------------------------------------------------------------------
// Step 4: Stream response — emit partials every 500ms, resolve when done
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves after `ms` milliseconds using a Web Worker
 * timer — immune to Chrome's background-tab throttling of setTimeout.
 */
function workerSleep(ms) {
  return new Promise((resolve) => {
    const blob = new Blob(
      [`setTimeout(() => postMessage('done'), ${ms})`],
      { type: "application/javascript" }
    );
    const url = URL.createObjectURL(blob);
    const w   = new Worker(url);
    w.onmessage = () => { w.terminate(); URL.revokeObjectURL(url); resolve(); };
  });
}

const STOP_SELECTORS = SITE_ADAPTER?.stopButtonSelectors || [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Cancel"]',
  'button[aria-label="Cancel response"]',
  'button[title="Cancel"]',
  'button[title="Stop"]',
  '[data-testid*="cancel"]',
];

function looksLikeRedCancelButton(el) {
  if (!(el instanceof HTMLButtonElement)) return false;
  const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`
    .trim()
    .toLowerCase();
  if (/\b(cancel|stop)\b/.test(label)) return true;
  if (!/^(x|×)$/.test(label)) return false;
  const style = window.getComputedStyle(el);
  const bg = style.backgroundColor || "";
  return /rgb(a)?\(\s*(1[6-9]\d|2[0-5]\d)\s*,\s*([0-9]|[1-9]\d|1[01]\d)\s*,\s*([0-9]|[1-9]\d|1[01]\d)/i.test(bg);
}

function findStopButton() {
  for (const sel of STOP_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isVisibleElement(el)) return el;
  }

  const composerRoot =
    findComposerNow()?.closest("form") ||
    document.querySelector("form") ||
    document.body;
  const buttons = composerRoot?.querySelectorAll?.("button") || [];
  for (const button of buttons) {
    if (isVisibleElement(button) && looksLikeRedCancelButton(button)) {
      return button;
    }
  }
  return null;
}

function hasBusyComposerHint() {
  const bodyText = document.body?.textContent || "";
  if (
    bodyText.includes("Wait for the current response to finish before starting a new chat") ||
    bodyText.includes("Wait for the model to finish responding")
  ) {
    return true;
  }
  // Some sites disable the composer textarea during active streaming
  if (SITE_ADAPTER?.disablesComposerDuringStreaming) {
    const composer = findComposerNow();
    if (composer?.disabled || composer?.getAttribute("disabled") !== null) {
      return true;
    }
  }
  return false;
}

function isConversationStillRunning(
  stopBtn = findStopButton(),
  {
    busyComposer = hasBusyComposerHint(),
    strongTransportCompletion = false,
  } = {},
) {
  // Grace period: treat the conversation as still running if we saw transport
  // activity recently. Bridges gaps between sequential streams — ChatGPT's
  // "text → think → text" and DeepSeek's agentic tool-use phases can have
  // pauses of several seconds between streams. Once transport is done and the
  // site exposes its terminal action bar, that combined signal supersedes the
  // grace period and lets the stable-snapshot verifier finish promptly.
  const recentActivity =
    !strongTransportCompletion &&
    (Date.now() - lastTransportActivityAt) < 8000;
  return (
    Boolean(stopBtn) ||
    activeConversationStreamCount > 0 ||
    busyComposer ||
    recentActivity
  );
}

/**
 * Detect ChatGPT's response action bar (copy, regenerate, thumbs up/down).
 * This bar only appears when the response is truly complete — it's a strong
 * positive completion signal, unlike the stop button which is a negative signal.
 * Returns true if the action bar is visible on the last assistant message.
 */
function hasResponseActionBar() {
  // Get the last visible assistant message container. ChatGPT can leave stale
  // conversation trees mounted while rendering a new-chat shell.
  const assistantMessages = getAssistantMessageNodes();
  if (!assistantMessages.length) return false;
  const lastMsg = assistantMessages[assistantMessages.length - 1];

  // Search within the conversation turn container (action bar can be a sibling
  // of the message node, not a child).
  const turnSel = SITE_ADAPTER?.conversationTurnSelector;
  const searchRoot = (turnSel ? lastMsg.closest(turnSel) : null) || lastMsg.parentElement || lastMsg;

  // --- Primary: known selectors for action buttons ---
  const ACTION_SELECTORS = SITE_ADAPTER?.actionBarSelectors || [];
  for (const sel of ACTION_SELECTORS) {
    const el = searchRoot.querySelector(sel);
    if (el && isVisibleElement(el)) return true;
  }

  // --- Fallback: heuristic detection ---
  // ChatGPT's action bar is a row of small icon-only buttons (no text, just SVGs)
  // that appears below the response content. If the known selectors fail (ChatGPT
  // changed their attributes), look for a cluster of 3+ small visible icon buttons
  // that are NOT inside the prose/markdown content area.
  const contentArea = searchRoot.querySelector(".markdown, [class*='markdown'], .prose, [class*='prose']");
  const allButtons = searchRoot.querySelectorAll('button, [role="button"]');
  let iconButtonCount = 0;
  for (const btn of allButtons) {
    // Skip buttons inside the content area (e.g., code copy buttons)
    if (contentArea && contentArea.contains(btn)) continue;
    if (!isVisibleElement(btn)) continue;
    // Icon buttons: contain an SVG and have very little or no text
    const hasSvg = btn.querySelector("svg") !== null;
    const textLen = (btn.textContent || "").trim().length;
    if (hasSvg && textLen <= 2) {
      iconButtonCount++;
    }
  }
  // The action bar typically has 4-5 buttons; require 3+ to avoid false positives
  // from stray icon buttons (e.g., a single code-block copy button).
  return iconButtonCount >= 3;
}

function getAssistantMessageNodes() {
  const selectors = SITE_ADAPTER?.assistantMessageSelectors || ["[data-message-author-role='assistant']"];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => {
      if (!isVisibleElement(node)) return false;
      const role =
        SITE_ADAPTER?.getMessageRole?.(node) ||
        node.getAttribute?.("data-message-author-role");
      if (role) return role === "assistant";
      return /assistant/i.test(selector);
    });
    if (nodes.length > 0) return nodes;
  }
  return [];
}

function getUserMessageCount() {
  const selector =
    SITE_ADAPTER?.conversationMessageSelector ||
    SITE_ADAPTER?.userMessageSelector ||
    "[data-message-author-role]";
  return Array.from(document.querySelectorAll(selector)).filter((node) => {
    if (!isVisibleElement(node)) return false;
    const role =
      SITE_ADAPTER?.getMessageRole?.(node) ||
      node.getAttribute?.("data-message-author-role");
    return role === "user";
  }).length;
}

function buildAssistantAnchorId(node, index) {
  return (
    SITE_ADAPTER?.getMessageId?.(node) ||
    node.getAttribute?.("data-message-id") ||
    node.id ||
    `assistant-anchor-${index + 1}`
  );
}

function getAssistantMessageInfo() {
  return getAssistantMessageNodes().map((node, index) => {
    const id = buildAssistantAnchorId(node, index);
    const text = shared.normalizeComposerText(extractAssistantAnswerText(node));
    return {
      node,
      id,
      index,
      signature: `${id}::${text.slice(0, 500)}`,
    };
  });
}

function getLatestAssistantSignature() {
  const assistantMessages = getAssistantMessageInfo();
  if (assistantMessages.length === 0) {
    return { count: 0, signature: "" };
  }

  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  return {
    count: assistantMessages.length,
    signature: latestAssistant.signature,
  };
}

function resolveAnchoredAssistantInfo(baselineSnapshot, anchorId = null) {
  const assistants = getAssistantMessageInfo();
  if (!assistants.length) return null;

  if (anchorId) {
    const exact = assistants.find((entry) => entry.id === anchorId);
    if (exact) return exact;
    const fallbackByIndex = assistants[baselineSnapshot?.count || 0];
    if (fallbackByIndex) return fallbackByIndex;
    return assistants[assistants.length - 1] || null;
  }

  const baselineCount = baselineSnapshot?.count || 0;
  if (assistants.length > baselineCount) {
    return assistants[baselineCount] || assistants[assistants.length - 1] || null;
  }

  const latest = assistants[assistants.length - 1];
  if (latest && latest.signature && latest.signature !== (baselineSnapshot?.signature || "")) {
    return latest;
  }

  return null;
}

function getMeaningfulSseText() {
  return shared.hasMeaningfulAssistantText(sseText) ? sseText : "";
}

function getCurrentAnchoredSnapshot(baselineSnapshot, anchorId = null) {
  const anchor = resolveAnchoredAssistantInfo(baselineSnapshot, anchorId);
  const answerText = anchor ? extractAssistantAnswerText(anchor.node) : "";
  const domThinking = anchor ? extractAssistantThinkingText(anchor.node) : "";
  const thinkingText = shared.normalizeComposerText(domThinking || sseThinking || "");
  return {
    anchorId: anchor?.id || null,
    answerText,
    thinkingText,
    answerVisible: shared.hasMeaningfulAssistantText(answerText),
  };
}

async function waitForMeaningfulAssistantResponse(
  baselineSnapshot,
  anchorId = null,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = getCurrentAnchoredSnapshot(baselineSnapshot, anchorId);
    if (snapshot.answerVisible || snapshot.thinkingText) {
      return snapshot;
    }

    const sseAnswer = getMeaningfulSseText();
    if (sseAnswer) {
      return {
        anchorId: snapshot.anchorId,
        answerText: sseAnswer,
        thinkingText: snapshot.thinkingText,
        answerVisible: true,
      };
    }

    await workerSleep(400);
  }
  return {
    anchorId,
    answerText: "",
    thinkingText: shared.normalizeComposerText(sseThinking || ""),
    answerVisible: false,
  };
}

function postSnapshot(port, payload) {
  try {
    port.postMessage({ type: "snapshot", ...payload });
  } catch (_) {}
}

function postTurnState(port, payload) {
  try {
    port.postMessage({ type: "turn_state", ...payload });
  } catch (_) {}
}

function postTerminal(port, payload) {
  try {
    port.postMessage({ type: "terminal", ...payload });
  } catch (_) {}
}

async function streamResponseSnapshots(
  port,
  seq,
  attempt,
  baselineTranscript = null,
  promptText = "",
  attachmentFingerprint = "",
  submissionMeta = null,
  timeoutMs = RESPONSE_TIMEOUT_MS,
  isPipelineCurrent = () => true,
  onTerminalPosted = () => {},
) {
  sseText = "";
  sseThinking = null;
  sseDone = false;
  sseDoneAt = 0;
  resetTurnDebug(seq, attempt);

  const baseline = baselineTranscript || extractConversationTranscript();
  const baselineTranscriptCount = baseline.count;
  const baselineTranscriptHash = baseline.hash;
  const baselineAssistantSnapshot = getLatestAssistantSignature();
  let remoteChatUrl = baseline.chatUrl;
  let remoteChatId = baseline.chatId;
  let userTurnKey = null;
  let assistantTurnKey = null;
  let answerRevision = 0;
  let thinkingRevision = 0;
  let transcriptRevision = 0;
  let lastTranscriptHash = baseline.hash;
  let lastAnswerText = "";
  let lastThinkingText = "";
  let lastRunState = "submitted";
  let lastCompletionReason = null;
  let lastTurnStatus = "submitted";
  let lastUserTurnKey = null;
  let lastAssistantTurnKey = null;
  let lastAnyProgressAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  const userTurnDeadline = Date.now() + 30_000;
  const emitTerminal = (payload) => {
    onTerminalPosted();
    postTerminal(port, payload);
  };
  let reportedUserTurn = false;
  let reportedAssistantTurn = false;
  let reportedDeepSeekRequestCorrelation = false;
  let reportedDeepSeekMissingUserTurn = false;
  let lastActiveRun = null;
  let toolUseDetected = false;
  let completionTracker = shared.createTurnCompletionTracker(Date.now());
  const baselineLastStreamAt = lastStreamAt;
  const baselineTransportCompletedAt = lastTransportCompletedAt;
  const expectedPdfFilename = String(attachmentFingerprint || "")
    .split("|", 1)[0]
    .trim();
  const attachmentRequested = Boolean(expectedPdfFilename);
  let submittedAttachmentVerified = null;
  let submittedAttachmentCount = null;
  let submittedPdfCount = null;
  let attachmentContractVerified = false;
  let attachmentContractMismatchObservedAt = 0;
  const baselineOutboundRequestSerial =
    Number(submissionMeta?.baselineOutboundRequestSerial) || 0;
  let requestContext = submissionMeta?.requestContext || null;
  const getCompletionDetectionMs = () => {
    const completedAt = Math.max(
      sseDoneAt,
      lastTransportCompletedAt > baselineTransportCompletedAt
        ? lastTransportCompletedAt
        : 0,
    );
    return completedAt > 0
      ? Math.max(0, Date.now() - completedAt)
      : null;
  };
  const makeTurnDiagnostic = (phase, overrides = {}) => buildDiagnostic({
    phase,
    composerTextMatched: submissionMeta?.composerTextMatched === true,
    uploadDetected: submissionMeta?.uploadDetected === true,
    clickAttempts: Number(submissionMeta?.clickAttempts) || 0,
    requestObserved: Boolean(requestContext),
    streamObserved:
      activeConversationStreamCount > 0 ||
      lastStreamAt > baselineLastStreamAt ||
      Boolean(sseDoneAt),
    userTurnMatched: Boolean(userTurnKey),
    assistantTurnMatched: Boolean(assistantTurnKey),
    attachmentFilename: expectedPdfFilename || null,
    attachmentMethod:
      submissionMeta?.pdfAttachmentReceipt?.method || null,
    attachmentVerificationMs:
      submissionMeta?.pdfAttachmentReceipt?.totalElapsedMs ?? null,
    attachmentPreviewVerified: expectedPdfFilename
      ? Boolean(submissionMeta?.pdfAttachmentReceipt)
      : null,
    attachmentRequested,
    attachmentFilenameConfirmed: expectedPdfFilename
      ? submissionMeta?.pdfAttachmentReceipt?.filenameConfirmed === true
      : null,
    attachmentReadyVerified: expectedPdfFilename
      ? submissionMeta?.pdfAttachmentReceipt?.readyConfirmed === true
      : null,
    submittedAttachmentVerified,
    submittedAttachmentCount,
    submittedPdfCount,
    attachmentContractVerified,
    completionDetectionMs: getCompletionDetectionMs(),
    ...overrides,
  });

  recordTurnDebug("baseline_transcript", {
    seq,
    attempt,
    baselineTranscriptCount,
    baselineTranscriptHash,
    baselineAssistantCount: baselineAssistantSnapshot.count,
    baselineAssistantSignature: baselineAssistantSnapshot.signature,
    baselineOutboundRequestSerial,
    attachmentFingerprint,
    remoteChatUrl,
    remoteChatId,
  });

  postTurnState(port, {
    seq,
    attempt,
    remoteChatUrl,
    remoteChatId,
    baselineTranscriptCount,
    baselineTranscriptHash,
    turnStatus: "submitted",
    diagnostic: makeTurnDiagnostic("submitted"),
  });

  while (Date.now() < deadline) {
    assertPipelineCurrent(isPipelineCurrent);
    const nowMs = Date.now();
    const stopBtn = findStopButton();
    const busyComposer = hasBusyComposerHint();
    const actionBarVisible = hasResponseActionBar();
    const strongTransportCompletion =
      shared.hasStrongTransportCompletionSignal({
        sseDone,
        transportObserved:
          lastStreamAt > baselineLastStreamAt ||
          lastTransportCompletedAt > baselineTransportCompletedAt,
        activeConversationStreamCount,
        actionBarVisible,
        stopButtonVisible: Boolean(stopBtn),
        busyComposer,
      });
    const activeRun = isConversationStillRunning(stopBtn, {
      busyComposer,
      strongTransportCompletion,
    });
    const terminalEvidence = shared.hasVerifiedTerminalEvidence({
      siteId: SITE_ADAPTER?.siteId,
      sseDone,
      activeConversationStreamCount,
      actionBarVisible,
      stopButtonVisible: Boolean(stopBtn),
      busyComposer,
    });
    if (SITE_ADAPTER?.siteId === "deepseek" && !requestContext) {
      requestContext = findObservedDeepSeekRequestContext(
        baselineOutboundRequestSerial,
        promptText,
      );
    }
    const transcript = extractConversationTranscript();
    remoteChatUrl = transcript.chatUrl || requestContext?.chatUrl || remoteChatUrl;
    remoteChatId = transcript.chatId || requestContext?.chatId || remoteChatId;
    if (transcript.hash !== lastTranscriptHash) {
      lastTranscriptHash = transcript.hash;
      transcriptRevision += 1;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("transcript_revision", {
        seq,
        attempt,
        transcriptRevision,
        transcriptHash: transcript.hash,
      });
    }
    if (lastActiveRun === null || lastActiveRun !== activeRun) {
      lastActiveRun = activeRun;
      recordTurnDebug("active_run_transition", {
        seq,
        attempt,
        activeRun,
      });
    }

    if (
      SITE_ADAPTER?.siteId === "deepseek" &&
      requestContext &&
      !reportedDeepSeekRequestCorrelation
    ) {
      reportedDeepSeekRequestCorrelation = true;
      recordTurnDebug("deepseek_request_correlated", {
        seq,
        attempt,
        requestSerial: requestContext.requestSerial || null,
        remoteChatUrl,
        remoteChatId,
      });
      postTurnState(port, {
        seq,
        attempt,
        remoteChatUrl,
        remoteChatId,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus: "submitted",
        diagnostic: makeTurnDiagnostic("submitted", { requestObserved: true }),
      });
    }

    let matchedUserTurn =
      !userTurnKey || !attachmentContractVerified
        ? findMatchingUserTurn(
          transcript,
          baselineTranscriptCount,
          promptText,
          baseline.messages,
        )
        : null;
    if (!userTurnKey) {
      if (matchedUserTurn) {
        userTurnKey = matchedUserTurn.messageKey;
        if (!reportedUserTurn) {
          reportedUserTurn = true;
          recordTurnDebug("user_turn_matched", {
            seq,
            attempt,
            userTurnKey,
            remoteChatUrl,
            remoteChatId,
          });
          postTurnState(port, {
            seq,
            attempt,
            remoteChatUrl,
            remoteChatId,
            baselineTranscriptCount,
            baselineTranscriptHash,
            userTurnKey,
            turnStatus: "user_turn_matched",
            diagnostic: makeTurnDiagnostic("user_turn_matched", {
              userTurnMatched: true,
            }),
          });
        }
      } else if (Date.now() > userTurnDeadline) {
        // Use strict active-run check (no transport grace period) for the deadline,
        // so SSE activity doesn't keep the deadline from firing indefinitely.
        const strictActiveRun = Boolean(stopBtn) || activeConversationStreamCount > 0 || hasBusyComposerHint();
        const deepseekRequestObserved =
          SITE_ADAPTER?.siteId === "deepseek" && Boolean(requestContext);

        if (!strictActiveRun) {
          // Fallback: take the last user message after baseline (position-based).
          const fallbackCandidates = shared.conversationMessagesAfterBaseline(
            transcript.messages,
            baseline.messages,
            baselineTranscriptCount,
          )
            .filter((m) => m.role === "user");
          if (fallbackCandidates.length > 0 && deepseekRequestObserved) {
            const fallback = fallbackCandidates[fallbackCandidates.length - 1];
            matchedUserTurn = fallback;
            userTurnKey = fallback.messageKey;
            console.warn("[sync-zotero] User turn text match failed — using position-based fallback");
            recordTurnDebug("user_turn_fallback", { seq, attempt, userTurnKey });
            postTurnState(port, {
              seq, attempt, remoteChatUrl, remoteChatId,
              baselineTranscriptCount, baselineTranscriptHash,
              userTurnKey, turnStatus: "user_turn_matched",
              diagnostic: makeTurnDiagnostic("user_turn_matched", {
                reasonCode: "user_turn_position_fallback",
                userTurnMatched: true,
              }),
            });
          } else if (deepseekRequestObserved) {
            if (!reportedDeepSeekMissingUserTurn) {
              reportedDeepSeekMissingUserTurn = true;
              recordTurnDebug("deepseek_request_without_dom_user_turn", {
                seq,
                attempt,
                requestSerial: requestContext?.requestSerial || null,
                remoteChatUrl,
                remoteChatId,
              });
            }
          } else {
            throw new Error(
              "Chat never exposed a user turn matching the submitted prompt, so delivery could not be verified.",
            );
          }
        }
      }
    }

    if (matchedUserTurn && !attachmentContractVerified) {
      const attachments = Array.isArray(matchedUserTurn.attachments)
        ? matchedUserTurn.attachments
        : [];
      const contract = shared.classifySubmittedPdfContract(
        attachments,
        expectedPdfFilename,
      );
      submittedAttachmentVerified = attachmentRequested
        ? contract.filenameMatched === true
        : null;
      submittedAttachmentCount = contract.attachmentCount;
      submittedPdfCount = contract.pdfAttachmentCount;
      attachmentContractVerified = contract.contractVerified === true;
      if (attachmentContractVerified) {
        userTurnKey = matchedUserTurn.messageKey;
        recordTurnDebug("submitted_attachment_contract_verified", {
          seq,
          attempt,
          userTurnKey,
          expectedPdfFilename,
          attachments,
          attachmentRequested,
          submittedAttachmentCount,
          submittedPdfCount,
        });
      } else if (!attachmentContractMismatchObservedAt) {
        attachmentContractMismatchObservedAt = nowMs;
        recordTurnDebug("submitted_attachment_contract_mismatch", {
          seq,
          attempt,
          userTurnKey: matchedUserTurn.messageKey,
          expectedPdfFilename,
          attachments,
          attachmentRequested,
          submittedAttachmentCount,
          submittedPdfCount,
        });
      }
    }
    if (
      !attachmentContractVerified &&
      attachmentContractMismatchObservedAt &&
      nowMs - attachmentContractMismatchObservedAt >=
        SUBMITTED_ATTACHMENT_CONTRACT_TIMEOUT_MS
    ) {
      if (attachmentRequested) {
        throw new Error(
          `The submitted user turn did not contain the requested PDF "${expectedPdfFilename}".`,
        );
      }
      throw new Error(
        "The prompt-only user turn unexpectedly contained a PDF attachment.",
      );
    }

    const previousAssistantTurnKey = assistantTurnKey;
    const assistantTurn = userTurnKey
      ? resolveBoundAssistantTurn(
        transcript,
        userTurnKey,
        assistantTurnKey,
      )
      : (
        SITE_ADAPTER?.siteId === "deepseek" && requestContext
          ? resolveLatestAssistantTurnAfterBaseline(
            transcript,
            baselineTranscriptCount,
            assistantTurnKey,
          )
          : null
      );
    const deepseekAnchoredSnapshot =
      SITE_ADAPTER?.siteId === "deepseek" && requestContext
        ? getCurrentAnchoredSnapshot(baselineAssistantSnapshot)
        : null;
    if (assistantTurn?.messageKey) {
      assistantTurnKey = assistantTurn.messageKey;
      if (!reportedAssistantTurn || assistantTurnKey !== previousAssistantTurnKey) {
        reportedAssistantTurn = true;
        recordTurnDebug(
          assistantTurnKey !== previousAssistantTurnKey
            ? "assistant_turn_rebound"
            : "assistant_turn_matched",
          {
            seq,
            attempt,
            userTurnKey,
            assistantTurnKey,
            remoteChatUrl,
            remoteChatId,
          },
        );
        postTurnState(port, {
          seq,
          attempt,
          remoteChatUrl,
          remoteChatId,
          baselineTranscriptCount,
          baselineTranscriptHash,
          userTurnKey,
          assistantTurnKey,
          turnStatus: "assistant_turn_matched",
          diagnostic: makeTurnDiagnostic("assistant_turn_matched", {
            assistantTurnMatched: true,
          }),
        });
      }
    } else if (
      deepseekAnchoredSnapshot &&
      (deepseekAnchoredSnapshot.answerVisible || deepseekAnchoredSnapshot.thinkingText)
    ) {
      assistantTurnKey = deepseekAnchoredSnapshot.anchorId || assistantTurnKey || "deepseek-visible-assistant";
      if (!reportedAssistantTurn || assistantTurnKey !== previousAssistantTurnKey) {
        reportedAssistantTurn = true;
        recordTurnDebug("assistant_turn_matched", {
          seq,
          attempt,
          userTurnKey,
          assistantTurnKey,
          remoteChatUrl,
          remoteChatId,
          source: "deepseek_visible_dom",
        });
        postTurnState(port, {
          seq,
          attempt,
          remoteChatUrl,
          remoteChatId,
          baselineTranscriptCount,
          baselineTranscriptHash,
          userTurnKey,
          assistantTurnKey,
          turnStatus: "assistant_turn_matched",
          diagnostic: makeTurnDiagnostic("assistant_turn_matched", {
            assistantTurnMatched: true,
          }),
        });
      }
    }

    // Use DOM-extracted answer text, but fall back to SSE-captured text when
    // DOM extraction fails (e.g., thinking model responses where the answer
    // isn't extractable from the DOM during/after the thinking phase).
    const domAnswerText =
      assistantTurn?.text ||
      deepseekAnchoredSnapshot?.answerText ||
      "";
    const answerText = shared.hasMeaningfulAssistantText(domAnswerText)
      ? domAnswerText
      : (shared.hasMeaningfulAssistantText(sseText) ? sseText : domAnswerText);
    const domThinking =
      assistantTurn?.thinking ||
      deepseekAnchoredSnapshot?.thinkingText ||
      "";
    const thinkingText = shared.normalizeComposerText(
      domThinking || sseThinking || "",
    );
    const answerChanged = answerText !== lastAnswerText;
    const thinkingChanged = thinkingText !== lastThinkingText;
    if (answerChanged) {
      answerRevision += 1;
      lastAnswerText = answerText;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("answer_revision", {
        seq,
        attempt,
        answerRevision,
        textLength: lastAnswerText.length,
      });
    }
    if (thinkingChanged) {
      thinkingRevision += 1;
      lastThinkingText = thinkingText;
      lastAnyProgressAt = nowMs;
      recordTurnDebug("thinking_revision", {
        seq,
        attempt,
        thinkingRevision,
        textLength: lastThinkingText.length,
      });
    }

    const answerVisible = shared.hasMeaningfulAssistantText(answerText);
    const thinkingVisible = Boolean(thinkingText);
    const quietSinceMs = nowMs - Math.max(lastAnyProgressAt, lastTransportActivityAt || 0);

    // Detect tool-use patterns in SSE text or DOM content to adapt completion
    // timing. Once detected, stays true for the entire turn. Check both SSE
    // stream text and DOM-rendered content, since DeepSeek's agentic status
    // messages (e.g. "Found N web pages") may only appear in the DOM.
    if (!toolUseDetected) {
      const rawSse = (sseText || "").toLowerCase();
      const rawDom = (answerText || "").toLowerCase();
      const rawThinking = (thinkingText || "").toLowerCase();
      const combinedText = rawSse + " " + rawDom + " " + rawThinking;
      if (
        /reading\s+documents?/i.test(combinedText) ||
        /searching(\s+the\s+web)?/i.test(combinedText) ||
        /analyzing/i.test(combinedText) ||
        /browsing/i.test(combinedText) ||
        /found\s+\d+\s+web\s+pages?/i.test(combinedText) ||
        /read\s+\d+\s+pages?/i.test(combinedText) ||
        activeConversationStreamCount > 1
      ) {
        toolUseDetected = true;
      }
    }

    const {
      quietWindowMs,
      reboundWindowMs,
    } = shared.completionTimingForSignals({
      actionBarVisible,
      answerVisible,
      toolUseDetected,
      sseDone,
      activeConversationStreamCount,
      strongTransportCompletion,
    });

    const completion = shared.advanceTurnCompletionTracker(completionTracker, {
      nowMs,
      answerVisible,
      thinkingVisible,
      activeRun,
      answerRevision,
      thinkingRevision,
      transcriptRevision,
      hasUserTurn: Boolean(userTurnKey),
      hasAssistantTurn: Boolean(assistantTurnKey),
      terminalEvidence,
      quietWindowMs,
      reboundWindowMs,
    });
    const previousPhase = completionTracker.phase;
    completionTracker = completion.tracker;
    const turnStatus = completion.turnStatus;
    const runState = completion.runState;
    if (completion.phaseChanged) {
      recordTurnDebug("completion_phase", {
        seq,
        attempt,
        previousPhase,
        phase: completion.phase,
        quietForMs: completion.quietForMs,
        verificationForMs: completion.verificationForMs,
      });
    }
    if (
      completion.phase === "candidate_done" &&
      !completion.phaseChanged &&
      completion.verificationStartedAt &&
      completion.verificationStartedAt === nowMs
    ) {
      recordTurnDebug("verification_window_start", {
        seq,
        attempt,
        quietForMs: completion.quietForMs,
      });
    }

    const shouldEmitSnapshot =
      answerChanged ||
      thinkingChanged ||
      runState !== lastRunState ||
      turnStatus !== lastTurnStatus ||
      userTurnKey !== lastUserTurnKey ||
      assistantTurnKey !== lastAssistantTurnKey ||
      lastCompletionReason !== null;
    if (shouldEmitSnapshot) {
      postSnapshot(port, {
        seq,
        attempt,
        answerSnapshot: lastAnswerText,
        thinkingSnapshot: lastThinkingText || null,
        text: lastAnswerText,
        thinking: lastThinkingText || null,
        answerAnchorId: assistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState,
        completionReason: null,
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus,
        diagnostic: makeTurnDiagnostic(turnStatus || "streaming"),
      });
      lastRunState = runState;
      lastCompletionReason = null;
      lastTurnStatus = turnStatus;
      lastUserTurnKey = userTurnKey;
      lastAssistantTurnKey = assistantTurnKey;
    }

    if (completion.emitDone && attachmentContractVerified) {
      // Re-read the bound assistant turn after a final rebound delay. ChatGPT
      // can expose a prefix in the DOM long enough to satisfy visual completion
      // heuristics, especially after a discarded-tab reload.
      await workerSleep(strongTransportCompletion ? 250 : 750);
      const confirmedTranscript = extractConversationTranscript();
      const confirmedAssistantTurn = resolveBoundAssistantTurn(
        confirmedTranscript,
        userTurnKey,
        assistantTurnKey,
      );
      const confirmedAnswerText = confirmedAssistantTurn?.text || "";
      const confirmedAssistantTurnKey =
        confirmedAssistantTurn?.messageKey || assistantTurnKey;
      const stableTerminalSnapshot =
        shared.terminalAnswerSnapshotIsStable(
          {
            text: lastAnswerText,
            assistantTurnKey,
          },
          {
            text: confirmedAnswerText,
            assistantTurnKey: confirmedAssistantTurnKey,
          },
        );
      if (!stableTerminalSnapshot) {
        recordTurnDebug("terminal_snapshot_rebounded", {
          seq,
          attempt,
          candidateTextLength: lastAnswerText.length,
          confirmedTextLength: confirmedAnswerText.length,
          candidateAssistantTurnKey: assistantTurnKey,
          confirmedAssistantTurnKey,
        });
        completionTracker = shared.createTurnCompletionTracker(Date.now());
        continue;
      }

      recordTurnDebug("verified_done_emit", {
        seq,
        attempt,
        transcriptHash: confirmedTranscript.hash,
        answerRevision,
        thinkingRevision,
      });
      emitTerminal({
        seq,
        attempt,
        text: confirmedAnswerText,
        thinking: lastThinkingText || null,
        answerAnchorId: confirmedAssistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState: "done",
        completionReason: "settled",
        finalTranscriptHash: confirmedTranscript.hash,
        verifiedAt: Date.now(),
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey: confirmedAssistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus: "done",
        diagnostic: makeTurnDiagnostic("done", {
          reasonCode: "verified_done",
        }),
      });
      return;
    }

    // SSE-based fast completion: when the SSE stream has ended with meaningful
    // answer text AND ChatGPT's stop button is gone, emit the response directly.
    // This bypasses the DOM-based completion tracker which can fail for thinking
    // model responses where DOM answer extraction returns empty.
    // Require a settle period after sseDone to bridge gaps between sequential
    // streams (e.g., ChatGPT "text → think → text" or DeepSeek agentic phases).
    const sseDoneSettleMs = toolUseDetected ? 15_000 : 5_000;
    const sseSettled = sseDoneAt > 0 && (nowMs - sseDoneAt) >= sseDoneSettleMs;
    if (
      sseSettled &&
      activeConversationStreamCount === 0 &&
      shared.hasMeaningfulAssistantText(sseText) &&
      !stopBtn &&
      !hasBusyComposerHint() &&
      terminalEvidence &&
      attachmentContractVerified &&
      completion.phase !== "verified_done"
    ) {
      // Use DOM answer if available, otherwise SSE answer
      const finalText = shared.hasMeaningfulAssistantText(lastAnswerText)
        ? lastAnswerText : sseText;
      const finalThinking = lastThinkingText || sseThinking || null;
      recordTurnDebug("sse_fast_completion", {
        seq,
        attempt,
        sseTextLen: sseText.length,
        domAnswerLen: lastAnswerText.length,
        usedSse: finalText === sseText,
      });
      emitTerminal({
        seq,
        attempt,
        text: finalText,
        thinking: finalThinking,
        answerAnchorId: assistantTurnKey,
        answerRevision,
        thinkingRevision,
        runState: "done",
        completionReason: "settled",
        finalTranscriptHash: transcript.hash,
        verifiedAt: nowMs,
        remoteChatUrl,
        remoteChatId,
        userTurnKey,
        assistantTurnKey,
        baselineTranscriptCount,
        baselineTranscriptHash,
        turnStatus: "done",
        diagnostic: makeTurnDiagnostic("done", {
          reasonCode: "sse_fast_completion",
          streamObserved: true,
        }),
      });
      return;
    }

    // DeepSeek-specific fast completion: require a longer quiet period when
    // tool-use (web search, reading pages) was detected, to bridge gaps
    // between agentic workflow phases.
    const deepseekQuietThresholdMs = toolUseDetected ? 20_000 : 1_500;
    const deepseekIncompleteThresholdMs = toolUseDetected ? 25_000 : 5_000;
    if (shared.canUseDeepSeekQuiescentCompletion({
      siteId: SITE_ADAPTER?.siteId,
      activeRun,
      stopControlVisible: Boolean(stopBtn),
      busyComposer: hasBusyComposerHint(),
      hasRequestContext: Boolean(requestContext),
      hasAssistantTurn: Boolean(assistantTurnKey),
      attachmentContractVerified,
      terminalEvidence,
      quietSinceMs,
      quietThresholdMs: deepseekQuietThresholdMs,
      completionPhase: completion.phase,
    })) {
      const finalText = shared.hasMeaningfulAssistantText(lastAnswerText)
        ? lastAnswerText
        : (shared.hasMeaningfulAssistantText(sseText) ? sseText : "");
      const finalThinking = lastThinkingText || sseThinking || null;

      if (shared.hasMeaningfulAssistantText(finalText)) {
        recordTurnDebug("deepseek_quiescent_fast_completion", {
          seq,
          attempt,
          quietSinceMs,
          toolUseDetected,
          domAnswerLen: lastAnswerText.length,
          sseTextLen: (sseText || "").length,
          usedSse: finalText === sseText && finalText !== lastAnswerText,
        });
        emitTerminal({
          seq,
          attempt,
          text: finalText,
          thinking: finalThinking,
          answerAnchorId: assistantTurnKey,
          answerRevision,
          thinkingRevision,
          runState: "done",
          completionReason: "settled",
          finalTranscriptHash: transcript.hash,
          verifiedAt: nowMs,
          remoteChatUrl,
          remoteChatId,
          userTurnKey,
          assistantTurnKey,
          baselineTranscriptCount,
          baselineTranscriptHash,
          turnStatus: "done",
          diagnostic: makeTurnDiagnostic("done", {
            reasonCode: "deepseek_quiescent_fast_completion",
          }),
        });
        return;
      }

      if (thinkingVisible && quietSinceMs >= deepseekIncompleteThresholdMs) {
        recordTurnDebug("deepseek_quiescent_incomplete", {
          seq,
          attempt,
          quietSinceMs,
          thinkingLen: (finalThinking || "").length,
        });
        emitTerminal({
          seq,
          attempt,
          text: "",
          thinking: finalThinking,
          answerAnchorId: assistantTurnKey,
          answerRevision,
          thinkingRevision,
          runState: "incomplete",
          completionReason: "settled",
          finalTranscriptHash: transcript.hash,
          verifiedAt: nowMs,
          remoteChatUrl,
          remoteChatId,
          userTurnKey,
          assistantTurnKey,
          baselineTranscriptCount,
          baselineTranscriptHash,
          turnStatus: "incomplete",
          diagnostic: makeTurnDiagnostic("incomplete", {
            reasonCode: "deepseek_quiescent_incomplete",
          }),
        });
        return;
      }
    }

    // A visible stop control is authoritative evidence that the provider is
    // still working. PDF analysis and tool use can legitimately pause without
    // changing visible text for well over 12 seconds, so never click Stop from
    // an inactivity heuristic. Keep polling until the provider exposes a
    // verified terminal state or the outer response deadline is reached.

    await workerSleep(500);
  }

  // Use SSE text as fallback if DOM-based answer extraction failed
  assertPipelineCurrent(isPipelineCurrent);
  const timeoutAnswerText = shared.hasMeaningfulAssistantText(lastAnswerText)
    ? lastAnswerText
    : (shared.hasMeaningfulAssistantText(sseText) ? sseText : lastAnswerText);
  const timeoutThinkingText = lastThinkingText || sseThinking || null;

  if (shared.hasMeaningfulAssistantText(timeoutAnswerText)) {
    completionTracker = shared.advanceTurnCompletionTracker(completionTracker, {
      nowMs: Date.now(),
      answerVisible: true,
      thinkingVisible: Boolean(timeoutThinkingText),
      activeRun: false,
      answerRevision,
      thinkingRevision,
      transcriptRevision,
      hasUserTurn: Boolean(userTurnKey),
      hasAssistantTurn: Boolean(assistantTurnKey),
      forceIncomplete: true,
    }).tracker;
    recordTurnDebug("timeout_incomplete", {
      seq,
      attempt,
      answerRevision,
      thinkingRevision,
      usedSseFallback: timeoutAnswerText !== lastAnswerText,
    });
    emitTerminal({
      seq,
      attempt,
      text: timeoutAnswerText,
      thinking: timeoutThinkingText,
      answerAnchorId: assistantTurnKey,
      answerRevision,
      thinkingRevision,
      runState: "incomplete",
      completionReason: "timeout",
      finalTranscriptHash: lastTranscriptHash,
      remoteChatUrl,
      remoteChatId,
      userTurnKey,
      assistantTurnKey,
      baselineTranscriptCount,
      baselineTranscriptHash,
      turnStatus: "incomplete",
      diagnostic: makeTurnDiagnostic("incomplete", {
        reasonCode: "timeout_incomplete",
      }),
    });
    return;
  }

  throw new Error("Chat did not produce a visible assistant turn before timeout.");
}

// ---------------------------------------------------------------------------
// Step 5: Extract response as markdown
// ---------------------------------------------------------------------------

/**
 * Extract the response from the newest assistant message only.
 * @param {number} baselineCount — number of assistant messages that existed
 *   BEFORE the current query was submitted. Only messages after this count
 *   are considered, preventing old responses from leaking into follow-ups.
 */
function getDeepSeekTopLevelMarkdownBlocks(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(".ds-markdown"))
    .filter((el) => el instanceof Element)
    .filter((el) => !el.parentElement?.closest(".ds-markdown"))
    .filter(
      (el) =>
        !el.hasAttribute("hidden") &&
        el.getAttribute("aria-hidden") !== "true",
    );
}

function isDeepSeekReasoningBlock(block) {
  if (!(block instanceof Element)) return false;

  for (
    let current = block.parentElement, depth = 0;
    current && depth < 6;
    current = current.parentElement, depth++
  ) {
    const className = String(current.className || "").toLowerCase();
    if (className.includes("thinking") || className.includes("reasoning")) {
      return true;
    }

    const summary = current.querySelector?.("summary");
    const summaryText = shared.normalizeComposerText(summary?.textContent || "");
    if (/^thought for\b/i.test(summaryText) || /\b(thinking|reason)\b/i.test(summaryText)
        || /已?深?度?思考/.test(summaryText) || /思考了/.test(summaryText)) {
      return true;
    }

    const prev = current.previousElementSibling;
    const prevText = shared.normalizeComposerText(prev?.textContent || "");
    if (/^thought for\b/i.test(prevText) || /\b(thinking|reason)\b/i.test(prevText)
        || /已?深?度?思考/.test(prevText) || /思考了/.test(prevText)) {
      return true;
    }
  }

  return false;
}

function extractDeepSeekAssistantSections(node) {
  if (!node) return null;
  const root = node.cloneNode(true);
  root.querySelectorAll("button, [role='button']").forEach((el) => el.remove());

  const blocks = getDeepSeekTopLevelMarkdownBlocks(root)
    .map((el) => {
      const text = shared.normalizeComposerText(el.textContent || "");
      if (!text) return null;
      return {
        text,
        markdown: htmlToMarkdown(el.innerHTML).trim() || text,
        reasoningLike: isDeepSeekReasoningBlock(el),
      };
    })
    .filter((block) => block && shared.hasMeaningfulAssistantText(block.text));

  if (!blocks.length) return null;

  const rootText = shared.normalizeComposerText(root.textContent || "");
  const rootStartsWithReasoning =
    /^thought for\b/i.test(rootText) || /^\s*(thinking|reason)/i.test(rootText) ||
    /^已?深?度?思考/.test(rootText) || /^思考了/.test(rootText);

  let answerBlock = null;
  let thinkingBlocks = [];
  const explicitReasoningBlocks = blocks.filter((block) => block.reasoningLike);

  if (explicitReasoningBlocks.length > 0) {
    thinkingBlocks = explicitReasoningBlocks;
    const answerBlocks = blocks.filter((block) => !block.reasoningLike);
    if (answerBlocks.length > 1) {
      const combinedMarkdown = answerBlocks.map((b) => b.markdown).filter(Boolean).join("\n\n");
      const combinedText = answerBlocks.map((b) => b.text).filter(Boolean).join(" ");
      answerBlock = { text: combinedText, markdown: combinedMarkdown, reasoningLike: false };
    } else {
      answerBlock = answerBlocks[answerBlocks.length - 1] || null;
    }
    if (!answerBlock && blocks.length > 1) {
      answerBlock = blocks[blocks.length - 1] || null;
      thinkingBlocks = blocks.slice(0, -1);
    }
  } else if (blocks.length > 1 && rootStartsWithReasoning) {
    answerBlock = blocks[blocks.length - 1] || null;
    thinkingBlocks = blocks.slice(0, -1);
  } else if (blocks.length === 1 && rootStartsWithReasoning) {
    thinkingBlocks = [blocks[0]];
  }

  const thinking = Array.from(
    new Set(thinkingBlocks.map((block) => block.markdown).filter(Boolean)),
  ).join("\n\n");

  return {
    answer: answerBlock?.markdown || "",
    thinking: thinking || null,
    hasStructuredSplit:
      Boolean(thinkingBlocks.length) ||
      (Boolean(answerBlock) && blocks.length > 1 && rootStartsWithReasoning),
  };
}

function extractBestAssistantAnswerCandidate(prunedAssistant) {
  const contentSelectors = [
    ".markdown",
    ".ds-markdown",
    ".markdown-container",
    "[class*='markdown']",
    ".prose",
    "[class*='prose']",
    "article",
    ".text-message",
    "div[data-message-content]",
    "p",
  ];
  const candidateMap = new Map();
  for (const sel of contentSelectors) {
    const nodes = prunedAssistant.querySelectorAll(sel);
    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") continue;
      const className = String(el.className || "").toLowerCase();
      if (
        className.includes("sr-only") ||
        className.includes("screen-reader") ||
        className.includes("visually-hidden") ||
        className.includes("radix-visually-hidden") ||
        className.includes("thinking") ||
        className.includes("reasoning")
      ) {
        continue;
      }
      const text = shared.normalizeComposerText(el.textContent || "");
      if (!shared.hasMeaningfulAssistantText(text)) continue;
      const markdown = htmlToMarkdown(el.innerHTML).trim();
      const key = markdown || text;
      const prev = candidateMap.get(key);
      const score = text.length + (sel === ".markdown" || sel === ".prose" ? 1000 : 0);
      if (!prev || score > prev.score) {
        candidateMap.set(key, {
          score,
          markdown: markdown || text,
        });
      }
    }
  }

  const bestCandidate = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score)[0];
  if (bestCandidate?.markdown) {
    return bestCandidate.markdown;
  }

  // Ultimate fallback: use innerText on the entire container
  const text = shared.normalizeComposerText(
    prunedAssistant.innerText || prunedAssistant.textContent || "",
  );
  if (shared.hasMeaningfulAssistantText(text)) return text;

  return "";
}

function extractDeepSeekAssistantAnswerText(node) {
  if (!node) return "";

  const sections = extractDeepSeekAssistantSections(node);
  if (shared.hasMeaningfulAssistantText(sections?.answer || "")) {
    return sections.answer;
  }

  const root = node.cloneNode(true);
  pruneAssistantStatusNodes(root);

  const deepSeekCandidates = [];
  const seenKeys = new Set();
  const selectors = [
    ".ds-markdown",
    "[class*='markdown']",
    ".prose",
    "[class*='prose']",
    "article",
    ".text-message",
    "div[data-message-content]",
    "p",
  ];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((el) => {
      if (!(el instanceof Element)) return;
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return;
      const text = shared.normalizeComposerText(el.textContent || "");
      if (!shared.hasMeaningfulAssistantText(text)) return;
      if (isDeepSeekReasoningBlock(el)) return;
      const markdown = htmlToMarkdown(el.innerHTML).trim() || text;
      const key = `${selector}::${markdown}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      deepSeekCandidates.push({ markdown, text });
    });
  }

  if (deepSeekCandidates.length > 0) {
    return deepSeekCandidates.reduce((best, c) =>
      c.text.length > best.text.length ? c : best
    ).markdown;
  }

  return extractBestAssistantAnswerCandidate(root);
}

function extractAssistantAnswerText(node) {
  if (SITE_ADAPTER?.siteId === "deepseek") {
    return extractDeepSeekAssistantAnswerText(node);
  }

  if (!node) return "";
  const prunedAssistant = node.cloneNode(true);
  pruneAssistantStatusNodes(prunedAssistant);
  return extractBestAssistantAnswerCandidate(prunedAssistant);
}

function extractResponseAfter(baselineCount = 0) {
  const assistantMessages = getAssistantMessageInfo();
  if (assistantMessages.length <= baselineCount) return "";
  return extractAssistantAnswerText(
    assistantMessages[assistantMessages.length - 1].node,
  );
}

/** Extract the last assistant response (used for final extraction after streaming). */
function extractResponse() {
  return extractResponseAfter(0);
}

function pruneAssistantStatusNodes(root) {
  const thinkingPrune = SITE_ADAPTER?.pruneThinkingSelectors || [
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking']",
    "[class*='reasoning']",
  ];
  const selectors = [
    "details",
    "summary",
    "button",
    "[role='button']",
    ...thinkingPrune,
    "[role='status']",
    "progress",
  ];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((node) => node.remove());
  }
}

function extractAssistantThinkingText(node) {
  if (SITE_ADAPTER?.siteId === "deepseek") {
    const sections = extractDeepSeekAssistantSections(node);
    if (sections?.hasStructuredSplit && sections.thinking) {
      return sections.thinking;
    }
  }

  if (!node) return null;
  const root = node.cloneNode(true);
  root.querySelectorAll("button, [role='button']").forEach((el) => el.remove());

  const explicit = SITE_ADAPTER?.thinkingSelectors || [
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking'] .markdown",
    "[class*='reasoning'] .markdown",
  ];
  for (const sel of explicit) {
    const nodes = root.querySelectorAll(sel);
    if (nodes.length > 0) {
      const text = shared.normalizeComposerText(
        nodes[nodes.length - 1].textContent || "",
      );
      if (text.length > 2) return text;
    }
  }

  const allDetails = root.querySelectorAll("details");
  for (let i = allDetails.length - 1; i >= 0; i--) {
    const el = allDetails[i];
    const summary = el.querySelector("summary");
    const summaryText = shared.normalizeComposerText(summary?.textContent || "");
    if (/thought|thinking|reason/i.test(summaryText) || /思考|推理/.test(summaryText)) {
      const full = shared.normalizeComposerText(el.textContent || "");
      const content = full.startsWith(summaryText)
        ? shared.normalizeComposerText(full.slice(summaryText.length))
        : full;
      if (content.length > 2) return content;
    }
  }

  return null;
}

function extractThinking() {
  // ChatGPT renders the thinking/reasoning block in a <details> element
  // ("Thought for X seconds") for o1/o3/o4 models.
  // During streaming it may appear as an open/expanding block before collapsing.

  // Try explicit data-testid selectors first
  const explicit = [
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking'] .markdown",
    "[class*='reasoning'] .markdown",
  ];
  for (const sel of explicit) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      const text = nodes[nodes.length - 1].textContent.trim();
      if (text.length > 2) return text;
    }
  }

  // Fallback: look for a <details> block that contains thinking text.
  // ChatGPT wraps "Thought for X seconds" in <details><summary>…</summary>…</details>
  const allDetails = document.querySelectorAll("details");
  for (let i = allDetails.length - 1; i >= 0; i--) {
    const el      = allDetails[i];
    const summary = el.querySelector("summary");
    const summaryText = summary?.textContent?.trim() ?? "";
    // Only grab details blocks that look like thinking (contain "Thought" or "Thinking")
    if (/thought|thinking|reason/i.test(summaryText) || /思考|推理/.test(summaryText)) {
      // Get text content excluding the summary label
      const full    = el.textContent.trim();
      const content = full.startsWith(summaryText)
        ? full.slice(summaryText.length).trim()
        : full;
      if (content.length > 2) return content;
    }
  }

  return null;
}

function simpleHash(text) {
  let hash = 2166136261;
  const input = String(text || "");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getCurrentChatUrl() {
  return window.location.href;
}

function getCurrentChatId(url = getCurrentChatUrl()) {
  if (SITE_ADAPTER?.getChatIdFromUrl) {
    return SITE_ADAPTER.getChatIdFromUrl(url);
  }
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function normalizeUrl(url) {
  return shared.normalizeConversationUrl
    ? shared.normalizeConversationUrl(url)
    : String(url || "").replace(/\/+$/, "");
}

function cloneRelayMessage(message) {
  if (!message || typeof message !== "object") return null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment) => typeof attachment === "string")
    : undefined;
  return {
    messageKey:
      typeof message.messageKey === "string" ? message.messageKey : undefined,
    role: typeof message.role === "string" ? message.role : "assistant",
    text: typeof message.text === "string" ? message.text : "",
    thinking:
      typeof message.thinking === "string" ? message.thinking : undefined,
    attachments: attachments?.length ? attachments : undefined,
  };
}

let deepSeekTranscriptSnapshots = new Map();
let deepSeekLatestTranscriptKey = null;
let deepSeekHistorySnapshot = null;

function makeDeepSeekTranscriptCacheKey(chatUrl, chatId) {
  return `${normalizeUrl(chatUrl || "")}::${String(chatId || "").trim()}`;
}

function cloneDeepSeekTranscriptSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.map((message) => cloneRelayMessage(message)).filter(Boolean)
    : [];
  return {
    messages,
    chatUrl: typeof snapshot.chatUrl === "string" ? snapshot.chatUrl : null,
    chatId: typeof snapshot.chatId === "string" ? snapshot.chatId : null,
    siteHostname:
      typeof snapshot.siteHostname === "string" ? snapshot.siteHostname : null,
    capturedAt:
      Number.isFinite(snapshot.capturedAt) && Number(snapshot.capturedAt) > 0
        ? Math.floor(Number(snapshot.capturedAt))
        : 0,
    source:
      snapshot.source === "network" || snapshot.source === "dom"
        ? snapshot.source
        : null,
  };
}

function cloneDeepSeekHistorySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const history = Array.isArray(snapshot.history)
    ? snapshot.history
      .filter((entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.title === "string" &&
        typeof entry.chatUrl === "string",
      )
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        chatUrl: entry.chatUrl,
      }))
    : [];
  return {
    history,
    siteHostname:
      typeof snapshot.siteHostname === "string" ? snapshot.siteHostname : null,
    capturedAt:
      Number.isFinite(snapshot.capturedAt) && Number(snapshot.capturedAt) > 0
        ? Math.floor(Number(snapshot.capturedAt))
        : 0,
    source:
      snapshot.source === "network" || snapshot.source === "dom"
        ? snapshot.source
        : null,
    status:
      snapshot.status === "ok" ||
      snapshot.status === "empty" ||
      snapshot.status === "invalid_source" ||
      snapshot.status === "timeout"
        ? snapshot.status
        : "empty",
  };
}

function getDeepSeekTranscriptSnapshotHostname(snapshot) {
  if (!snapshot) return "";
  if (snapshot.siteHostname) {
    return String(snapshot.siteHostname).trim().toLowerCase();
  }
  if (!snapshot.chatUrl) return "";
  try {
    return new URL(snapshot.chatUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function storeDeepSeekTranscriptSnapshot(snapshot) {
  const normalized = cloneDeepSeekTranscriptSnapshot(snapshot);
  if (!normalized) return;
  const key = makeDeepSeekTranscriptCacheKey(normalized.chatUrl, normalized.chatId);
  deepSeekTranscriptSnapshots.set(key, normalized);
  deepSeekLatestTranscriptKey = key;
  if (deepSeekTranscriptSnapshots.size > 6) {
    const keys = Array.from(deepSeekTranscriptSnapshots.keys());
    for (const entryKey of keys.slice(0, Math.max(0, keys.length - 6))) {
      if (entryKey === deepSeekLatestTranscriptKey) continue;
      deepSeekTranscriptSnapshots.delete(entryKey);
    }
  }
}

function storeDeepSeekHistorySnapshot(snapshot) {
  deepSeekHistorySnapshot = cloneDeepSeekHistorySnapshot(snapshot);
}

function clearDeepSeekNetworkCaches(scope = "all") {
  if (!scope || scope === "all" || scope === "transcript") {
    deepSeekTranscriptSnapshots = new Map();
    deepSeekLatestTranscriptKey = null;
  }
  if (!scope || scope === "all" || scope === "history") {
    deepSeekHistorySnapshot = null;
  }
  try {
    window.postMessage(
      { type: "SYNC_ZOTERO_NETWORK_CACHE_CLEAR", scope },
      "*",
    );
  } catch (_) {}
}

function requestDeepSeekNetworkCacheReplay() {
  if (SITE_ADAPTER?.siteId !== "deepseek") return;
  try {
    window.postMessage({ type: "SYNC_ZOTERO_NETWORK_CACHE_REQUEST" }, "*");
  } catch (_) {}
}

function findMatchingDeepSeekTranscriptSnapshot({
  expectedChatUrl = null,
  expectedChatId = null,
  minCapturedAt = 0,
} = {}) {
  const normalizedExpectedUrl = normalizeUrl(expectedChatUrl || "");
  const normalizedExpectedId = String(expectedChatId || "").trim();
  const minimumCapture = Number(minCapturedAt) || 0;
  const snapshotMatches = (snapshot) => {
    if (!snapshot) return false;
    if ((snapshot.capturedAt || 0) < minimumCapture) return false;
    const actualId = String(snapshot.chatId || "").trim();
    if (normalizedExpectedId) {
      if (actualId) {
        return actualId === normalizedExpectedId;
      }
      if (
        normalizedExpectedUrl &&
        normalizeUrl(snapshot.chatUrl || "") !== normalizedExpectedUrl
      ) {
        return false;
      }
      return true;
    }
    if (
      normalizedExpectedUrl &&
      normalizeUrl(snapshot.chatUrl || "") !== normalizedExpectedUrl
    ) {
      return false;
    }
    return true;
  };
  const candidates = Array.from(deepSeekTranscriptSnapshots.values());
  if (deepSeekLatestTranscriptKey && deepSeekTranscriptSnapshots.has(deepSeekLatestTranscriptKey)) {
    const latest = deepSeekTranscriptSnapshots.get(deepSeekLatestTranscriptKey);
    return [latest, ...candidates.filter((snapshot) => snapshot !== latest)].find(snapshotMatches) || null;
  }
  return candidates.find(snapshotMatches) || null;
}

async function waitForDeepSeekTranscriptSnapshot({
  expectedChatUrl = null,
  expectedChatId = null,
  minCapturedAt = 0,
  timeoutMs = 15_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  requestDeepSeekNetworkCacheReplay();

  while (Date.now() < deadline) {
    const snapshot = findMatchingDeepSeekTranscriptSnapshot({
      expectedChatUrl,
      expectedChatId,
      minCapturedAt,
    });
    if (snapshot) return cloneDeepSeekTranscriptSnapshot(snapshot);
    await workerSleep(250);
  }
  return null;
}

async function waitForDeepSeekHistorySnapshot({
  minCapturedAt = 0,
  timeoutMs = 15_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const minimumCapture = Number(minCapturedAt) || 0;
  requestDeepSeekNetworkCacheReplay();

  while (Date.now() < deadline) {
    if (
      deepSeekHistorySnapshot &&
      (deepSeekHistorySnapshot.capturedAt || 0) >= minimumCapture
    ) {
      return cloneDeepSeekHistorySnapshot(deepSeekHistorySnapshot);
    }
    await workerSleep(250);
  }
  return null;
}

function removeTransientMessageNodes(root) {
  if (!root) return;
  const selectors = [
    "button",
    "[role='button']",
    "[role='status']",
    "[aria-live]",
    "[hidden]",
    "[aria-hidden='true']",
    ".sr-only",
    ".screen-reader-only",
    ".visually-hidden",
    "[class*='visually-hidden']",
    "[class*='screen-reader']",
    "[data-testid='reasoning-content']",
    "[data-testid='thinking-content']",
    "[data-testid='thinking']",
    "[class*='thinking']",
    "[class*='reasoning']",
    "progress",
  ];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }
}

function extractAttachmentNames(node) {
  if (!node) return [];
  // File/document attachment selectors
  const fileSelectors = [
    "[data-testid*='file']",
    "[class*='attachment']",
    "[class*='file-pill']",
    "[aria-label*='PDF']",
    "[aria-label*='pdf']",
    "[class*='FileIcon']",
  ];
  const names = [];
  for (const selector of fileSelectors) {
    node.querySelectorAll(selector).forEach((element) => {
      const text = shared.normalizeComposerText(
        element.getAttribute?.("aria-label") ||
          element.textContent ||
          "",
      );
      if (!text || text.length < 2) return;
      if (/^(pdf|papers?)$/i.test(text)) return;
      if (!names.includes(text)) {
        names.push(text);
      }
    });
  }
  // DeepSeek currently renders submitted file cards with generated class names.
  // Recover PDF names only from compact card-like regions that also expose a
  // PDF type/size label, avoiding ordinary prompt text that happens to mention
  // a filename.
  node.querySelectorAll("div, span").forEach((element) => {
    const text = shared.normalizeComposerText(element.textContent || "");
    if (!/\.pdf$/i.test(text) || text.length > 300) return;

    let card = element.parentElement;
    for (let depth = 0; depth < 4 && card; depth++) {
      const cardText = shared.normalizeComposerText(card.textContent || "");
      if (
        shared.attachmentEvidenceMatchesFilename(cardText, text) &&
        (/\bPDF\b/i.test(cardText) ||
          /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i.test(cardText))
      ) {
        if (!names.includes(text)) names.push(text);
        break;
      }
      card = card.parentElement;
    }
  });
  // Image attachment detection — ChatGPT renders uploaded images as <img> elements
  // inside the user message node. Detect these so image-only messages aren't
  // skipped by extractConversationTranscript's filter.
  const imageSelectors = [
    "img[src]",
    "picture",
    "[data-testid*='image']",
    "[class*='image-preview']",
    "[class*='uploaded-image']",
  ];
  let imageCount = 0;
  for (const selector of imageSelectors) {
    const matches = node.querySelectorAll(selector);
    if (matches.length > 0) {
      imageCount += matches.length;
      break; // avoid double-counting
    }
  }
  for (let i = 0; i < imageCount; i++) {
    const name = imageCount === 1 ? "image" : `image_${i + 1}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function extractUserMessageText(node) {
  if (!node) return "";
  const root = node.cloneNode(true);
  removeTransientMessageNodes(root);
  // Remove media elements that inject alt text or empty strings into innerText,
  // corrupting text extraction for image/video messages.
  root.querySelectorAll("img, picture, video, canvas, svg").forEach((el) => el.remove());
  // Use htmlToMarkdown to preserve math delimiters from KaTeX elements
  const markdown = htmlToMarkdown(root.innerHTML).trim();
  if (markdown) return markdown;
  // Fallback to plain text extraction
  const text = shared.normalizeComposerText(
    root.innerText || root.textContent || "",
  );
  return text;
}

function getConversationMessageNodes() {
  const selector = SITE_ADAPTER?.conversationMessageSelector || "[data-message-author-role]";
  const nodes = Array.from(document.querySelectorAll(selector));
  return nodes.filter((node) => {
    if (!isVisibleElement(node)) return false;
    const role = SITE_ADAPTER?.getMessageRole?.(node) || node.getAttribute("data-message-author-role");
    return role === "user" || role === "assistant";
  });
}

function buildTranscriptMessageKey(node, role, index, text, attachments = []) {
  const explicit =
    node.getAttribute?.("data-message-id") ||
    node.id ||
    null;
  if (explicit) return explicit;

  const signature = [
    role,
    index,
    shared.normalizeComposerText(text).slice(0, 240),
    attachments.join("|"),
  ].join("::");
  return `${role}-${index}-${simpleHash(signature)}`;
}

function extractNormalizedMessage(node, index) {
  const role = SITE_ADAPTER?.getMessageRole?.(node) || node.getAttribute("data-message-author-role");
  if (role !== "user" && role !== "assistant") return null;

  const attachments = extractAttachmentNames(node);
  const thinking =
    role === "assistant"
      ? shared.normalizeComposerText(extractAssistantThinkingText(node) || "")
      : "";
  const text = role === "assistant"
    ? shared.normalizeComposerText(extractAssistantAnswerText(node))
    : extractUserMessageText(node);
  const cleanedText =
    role === "assistant" && shared.isPlaceholderAssistantText(text) ? "" : text;

  return {
    messageKey: buildTranscriptMessageKey(
      node,
      role,
      index,
      cleanedText || thinking,
      attachments,
    ),
    role,
    text: cleanedText,
    thinking: thinking || "",
    attachments,
  };
}

function extractConversationTranscript() {
  const nodes = getConversationMessageNodes();
  const messages = [];

  nodes.forEach((node, index) => {
    const message = extractNormalizedMessage(node, index);
    if (!message) return;
    if (
      !message.text &&
      !message.thinking &&
      (!Array.isArray(message.attachments) || message.attachments.length === 0)
    ) {
      return;
    }
    messages.push(message);
  });

  const hash = simpleHash(
    messages.map((message) => JSON.stringify(message)).join("\n"),
  );

  return {
    chatUrl: getCurrentChatUrl(),
    chatId: getCurrentChatId(),
    count: messages.length,
    hash,
    messages,
  };
}

/**
 * For sites with virtual scrolling (e.g., DeepSeek), scroll through the entire
 * conversation to collect all messages that the virtual list renders at each
 * scroll position. Deduplicates by messageKey.
 * Falls back to a single extractConversationTranscript() if no scrollable container.
 */
async function extractFullConversationTranscript(options = {}) {
  const initialWaitMs = Math.max(250, Number(options.initialWaitMs) || 2500);
  const stepWaitMs = Math.max(150, Number(options.stepWaitMs) || 500);
  const maxSteps = Math.max(1, Number(options.maxSteps) || 100);
  const maxDurationMs = Math.max(1000, Number(options.maxDurationMs) || 60_000);
  const startedAt = Date.now();
  // Find the scrollable conversation container.
  // DeepSeek: the .ds-virtual-list itself is the scroll container (overflow: auto).
  // Others: look for a scroll-area parent that contains message nodes.
  let scrollContainer = null;

  // Strategy 1: Check if .ds-virtual-list is scrollable
  const virtualList = document.querySelector('.ds-virtual-list');
  if (virtualList && virtualList.scrollHeight > virtualList.clientHeight + 200) {
    const style = getComputedStyle(virtualList);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      scrollContainer = virtualList;
    }
  }

  // Strategy 2: Walk up from message nodes to find scrollable ancestor
  if (!scrollContainer) {
    const msgSelector = SITE_ADAPTER?.conversationMessageSelector || "[data-message-author-role]";
    const firstMsg = document.querySelector(msgSelector);
    let el = firstMsg?.parentElement;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 200) {
        const style = getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollContainer = el;
          break;
        }
      }
      el = el.parentElement;
    }
  }

  if (!scrollContainer) {
    // No virtual scrolling — single extraction is enough
    return extractConversationTranscript();
  }

  const savedScrollTop = scrollContainer.scrollTop;

  // Use regular setTimeout for scroll waits (workerSleep may fail with CSP on some sites)
  const scrollSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Phase 1: Scroll to top and wait for virtual list to render all earlier messages.
  // DeepSeek's virtual list lazily loads messages — scrolling to top triggers rendering.
  scrollContainer.scrollTop = 0;
  await scrollSleep(initialWaitMs);

  // Phase 2: Scroll through the entire conversation, collecting messages at each position.
  // This ensures we capture items from all parts of the virtual list.
  const collected = new Map(); // messageKey → message
  const scrollStep = Math.max(300, Math.floor(scrollContainer.clientHeight * 0.6));

  const collectVisible = () => {
    const nodes = getConversationMessageNodes();
    nodes.forEach((node, index) => {
      const message = extractNormalizedMessage(node, index);
      if (!message) return;
      if (!message.text && !message.thinking && (!message.attachments || !message.attachments.length)) return;
      if (!collected.has(message.messageKey)) {
        collected.set(message.messageKey, message);
      }
    });
  };

  collectVisible(); // collect at top

  let lastScrollTop = -1;
  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() - startedAt >= maxDurationMs) break;
    scrollContainer.scrollTop += scrollStep;
    await scrollSleep(stepWaitMs);
    collectVisible();
    if (Math.abs(scrollContainer.scrollTop - lastScrollTop) < 5) break;
    lastScrollTop = scrollContainer.scrollTop;
  }

  // Restore scroll position
  scrollContainer.scrollTop = savedScrollTop;

  const messages = Array.from(collected.values());
  const hash = simpleHash(messages.map((m) => JSON.stringify(m)).join("\n"));

  return {
    chatUrl: getCurrentChatUrl(),
    chatId: getCurrentChatId(),
    count: messages.length,
    hash,
    messages,
  };
}

function mapTranscriptToRelayMessages(transcript) {
  return transcript.messages.map((message) => ({
    messageKey: message.messageKey,
    role: message.role,
    text: message.text || "",
    thinking: message.thinking || undefined,
    attachments: message.attachments?.length ? message.attachments : undefined,
  }));
}

function collectVisibleReadinessBlockerText() {
  const evidence = new Set();
  const addEvidence = (element) => {
    if (!isVisibleElement(element)) return;
    const text = String(element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) evidence.add(text.slice(0, 4000));
  };

  for (const element of document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [role="alert"]',
  )) {
    addEvidence(element);
  }

  for (const heading of document.querySelectorAll(
    'h1, h2, h3, [role="heading"]',
  )) {
    const headingText = String(
      heading.innerText || heading.textContent || "",
    ).trim();
    if (
      !/(?:too many requests|verify (?:that )?you are human|checking your browser|captcha)/i.test(
        headingText,
      )
    ) {
      continue;
    }
    let container = heading;
    for (let depth = 0; depth < 4 && container?.parentElement; depth++) {
      container = container.parentElement;
    }
    addEvidence(container || heading);
  }

  const visibleAuthControls = Array.from(
    document.querySelectorAll('button, a, [role="button"]'),
  ).filter((element) => {
    if (!isVisibleElement(element)) return false;
    const text = String(element.innerText || element.textContent || "").trim();
    return /^(?:log in|sign up)$/i.test(text);
  });
  if (visibleAuthControls.length > 0) {
    evidence.add(
      visibleAuthControls
        .map((element) => element.innerText || element.textContent || "")
        .join(" "),
    );
  }

  return Array.from(evidence).join("\n");
}

function buildChatReadinessFailure(transcript, failure) {
  const diagnostic = buildDiagnostic({
    phase: "pre_submit_readiness",
    reasonCode: failure.reasonCode,
    message: failure.message,
  });
  return {
    ok: false,
    ready: false,
    error: failure.message,
    diagnostic,
    chatUrl: transcript.chatUrl,
    chatId: transcript.chatId,
    transcriptHash: transcript.hash,
    transcriptCount: transcript.count,
    messages: mapTranscriptToRelayMessages(transcript),
  };
}

async function waitForChatReady(expectedChatUrl = null, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const normalizedExpected = normalizeUrl(expectedChatUrl);
  let lastSignature = "";
  let stableChecks = 0;
  let lastReadinessSignals = {
    urlMatches: !normalizedExpected,
    composerReady: false,
    activeRun: false,
    domSettled: false,
    transcriptStable: false,
  };

  // MutationObserver tracks DOM activity so we don't falsely stabilize
  // during React hydration when the DOM is being actively rebuilt.
  let lastDomMutationAt = Date.now();
  const DOM_SETTLE_MS = 800;
  let observer = null;
  try {
    const mainEl = document.querySelector("main") || document.querySelector('[role="main"]');
    if (mainEl) {
      observer = new MutationObserver(() => {
        lastDomMutationAt = Date.now();
      });
      observer.observe(mainEl, { childList: true, subtree: true });
    }

    // If navigating to a new conversation, wait briefly for React to start rendering
    if (normalizedExpected && normalizeUrl(getCurrentChatUrl()) !== normalizedExpected) {
      await workerSleep(1000);
    }

    if (SITE_ADAPTER?.siteId === "deepseek") {
      while (Date.now() < deadline) {
        const transcript = extractConversationTranscript();
        const currentUrl = normalizeUrl(transcript.chatUrl || getCurrentChatUrl());
        const urlMatches = !normalizedExpected || currentUrl === normalizedExpected;
        const bodyReady = Boolean(document.body);
        const mainReady = Boolean(
          document.querySelector("main") ||
          document.querySelector('[role="main"]') ||
          document.body,
        );
        const domSettled = (Date.now() - lastDomMutationAt) >= 400;
        const composerReady = Boolean(findComposerNow());
        const blocker = shared.classifyChatReadinessBlocker({
          siteId: SITE_ADAPTER?.siteId,
          composerReady,
          visibleText: collectVisibleReadinessBlockerText(),
        });
        if (blocker) {
          return buildChatReadinessFailure(transcript, blocker);
        }
        lastReadinessSignals = {
          urlMatches,
          composerReady,
          activeRun: false,
          domSettled,
          transcriptStable: false,
        };

        // A blank composer normally keeps its submit control disabled. Its
        // presence is the correct pre-typing readiness signal; submission is
        // verified separately after the prompt is inserted.
        if (shared.hasUsableChatReadinessSignals({
          urlMatches,
          composerReady,
          activeRun: false,
          domSettled,
          bodyReady,
          mainReady,
        })) {
          debugLog("chat_ready", {
            site: "deepseek",
            chatUrl: transcript.chatUrl || currentUrl,
            chatId: transcript.chatId || getCurrentChatId(currentUrl),
            count: transcript.count,
            hash: transcript.hash,
          });
          return {
            ok: true,
            ready: true,
            chatUrl: transcript.chatUrl || currentUrl,
            chatId: transcript.chatId || getCurrentChatId(currentUrl),
            transcriptHash: transcript.hash,
            transcriptCount: transcript.count,
            messages: mapTranscriptToRelayMessages(transcript),
          };
        }

        await workerSleep(250);
      }
    }

    while (Date.now() < deadline) {
      const transcript = extractConversationTranscript();
      const composerReady = Boolean(findComposerNow());
      const urlMatches =
        !normalizedExpected ||
        normalizeUrl(transcript.chatUrl) === normalizedExpected;
      const activeRun = isConversationStillRunning();
      const domSettled = (Date.now() - lastDomMutationAt) >= DOM_SETTLE_MS;
      const signature = `${transcript.hash}:${transcript.count}`;
      const blocker = shared.classifyChatReadinessBlocker({
        siteId: SITE_ADAPTER?.siteId,
        composerReady,
        visibleText: collectVisibleReadinessBlockerText(),
      });
      if (blocker) {
        return buildChatReadinessFailure(transcript, blocker);
      }

      if (shared.hasUsableChatReadinessSignals({
        urlMatches,
        composerReady,
        activeRun,
        domSettled,
      })) {
        stableChecks = signature === lastSignature ? stableChecks + 1 : 1;
        lastSignature = signature;
        if (stableChecks >= 2) {
          debugLog("chat_ready", {
            chatUrl: transcript.chatUrl,
            chatId: transcript.chatId,
            count: transcript.count,
            hash: transcript.hash,
          });
          return {
            ok: true,
            ready: true,
            chatUrl: transcript.chatUrl,
            chatId: transcript.chatId,
            transcriptHash: transcript.hash,
            transcriptCount: transcript.count,
            messages: mapTranscriptToRelayMessages(transcript),
          };
        }
      } else {
        stableChecks = 0;
        lastSignature = signature;
      }
      lastReadinessSignals = {
        urlMatches,
        composerReady,
        activeRun,
        domSettled,
        transcriptStable: stableChecks >= 2,
      };

      await workerSleep(400);
    }
  } finally {
    if (observer) observer.disconnect();
  }

  const transcript = extractConversationTranscript();
  return buildChatReadinessFailure(
    transcript,
    shared.classifyChatReadinessTimeout(lastReadinessSignals),
  );
}

/** Word-level Jaccard similarity for fuzzy text matching. */
function wordJaccardSimilarity(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

function findMatchingUserTurn(
  transcript,
  baselineCount,
  promptText,
  baselineMessages = [],
) {
  const normalizedPrompt = shared.normalizeComposerText(promptText).normalize("NFC").toLowerCase();
  const candidates = shared.conversationMessagesAfterBaseline(
    transcript.messages,
    baselineMessages,
    baselineCount,
  )
    .filter((message) => message.role === "user");
  if (candidates.length === 0) return null;
  if (!normalizedPrompt) {
    return candidates[candidates.length - 1] || null;
  }

  // Tier 1: exact match
  const exactMatches = candidates.filter(
    (message) =>
      shared.normalizeComposerText(message.text).normalize("NFC").toLowerCase() === normalizedPrompt,
  );
  if (exactMatches.length > 0) {
    return exactMatches[exactMatches.length - 1];
  }

  // Tier 2: substring containment
  const containsMatches = candidates.filter((message) => {
    const normalized = shared.normalizeComposerText(message.text).normalize("NFC").toLowerCase();
    return normalized.includes(normalizedPrompt) || normalizedPrompt.includes(normalized);
  });
  if (containsMatches.length > 0) {
    return containsMatches[containsMatches.length - 1];
  }

  // Tier 3: fuzzy match (word-level Jaccard similarity)
  let bestMatch = null;
  let bestScore = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const normalized = shared.normalizeComposerText(candidate.text).normalize("NFC").toLowerCase();
    const score = wordJaccardSimilarity(normalizedPrompt, normalized);
    if (score >= bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }
  if (bestMatch && bestScore >= 0.7) return bestMatch;

  // Tier 4: single candidate fallback
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveBoundAssistantTurn(transcript, userTurnKey, assistantTurnKey = null) {
  if (!userTurnKey) return null;
  const userIndex = transcript.messages.findIndex(
    (message) => message.messageKey === userTurnKey,
  );
  if (userIndex < 0) return null;

  const assistantTurns = [];
  for (let index = userIndex + 1; index < transcript.messages.length; index++) {
    const message = transcript.messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") {
      assistantTurns.push(message);
    }
  }
  if (assistantTurns.length === 0) return null;

  const exact = assistantTurnKey
    ? assistantTurns.find((message) => message.messageKey === assistantTurnKey) || null
    : null;
  const meaningfulTurns = assistantTurns.filter((message) =>
    shared.hasMeaningfulAssistantText(message.text || ""),
  );

  if (meaningfulTurns.length > 0) {
    return meaningfulTurns[meaningfulTurns.length - 1];
  }
  if (exact) return exact;
  return assistantTurns[assistantTurns.length - 1] || null;
}

function resolveLatestAssistantTurnAfterBaseline(
  transcript,
  baselineCount,
  assistantTurnKey = null,
) {
  const assistantTurns = transcript.messages
    .slice(Math.max(0, baselineCount))
    .filter((message) => message.role === "assistant");
  if (assistantTurns.length === 0) return null;

  const exact = assistantTurnKey
    ? assistantTurns.find((message) => message.messageKey === assistantTurnKey) || null
    : null;
  const meaningfulTurns = assistantTurns.filter((message) =>
    shared.hasMeaningfulAssistantText(message.text || ""),
  );

  if (meaningfulTurns.length > 0) {
    return meaningfulTurns[meaningfulTurns.length - 1];
  }
  if (exact) return exact;
  return assistantTurns[assistantTurns.length - 1] || null;
}

/** Extract original LaTeX source from a KaTeX-rendered element. */
function extractLatexFromKatex(el) {
  const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
  if (annotation) return annotation.textContent.trim();
  return null;
}

/** Very lightweight HTML → Markdown converter for ChatGPT's response format. */
function htmlToMarkdown(html) {
  // Use a temporary DOM element
  const div = document.createElement("div");
  div.innerHTML = html;

  function nodeToMd(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;

    const tag = node.tagName?.toLowerCase();
    const children = () => Array.from(node.childNodes).map(nodeToMd).join("");

    // Handle KaTeX math elements before the main switch
    if (tag === "span") {
      const cls = String(node.className || "");

      // Display math: <span class="katex-display">
      if (cls.includes("katex-display")) {
        const latex = extractLatexFromKatex(node);
        if (latex) return `\n$$${latex}$$\n`;
      }

      // Inline math: <span class="katex"> (but not katex-display, katex-mathml, katex-html, etc.)
      if (/\bkatex\b/.test(cls) && !cls.includes("katex-")) {
        const latex = extractLatexFromKatex(node);
        if (latex) return `$${latex}$`;
      }

      // Skip internal KaTeX sub-elements to avoid duplicating content
      if (cls.includes("katex-mathml") || cls.includes("katex-html")) return "";
    }

    switch (tag) {
      case "h1": return `\n# ${children()}\n`;
      case "h2": return `\n## ${children()}\n`;
      case "h3": return `\n### ${children()}\n`;
      case "h4": return `\n#### ${children()}\n`;
      case "h5": return `\n##### ${children()}\n`;
      case "h6": return `\n###### ${children()}\n`;
      case "p": return `\n${children()}\n`;
      case "br": return "\n";
      case "strong":
      case "b": return `**${children()}**`;
      case "em":
      case "i": return `*${children()}*`;
      case "code": {
        const parent = node.parentElement?.tagName?.toLowerCase();
        if (parent === "pre") return children(); // handled by pre
        return `\`${children()}\``;
      }
      case "pre": {
        const codeEl = node.querySelector("code");
        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] ?? "";
        const content = codeEl ? codeEl.textContent : node.textContent;
        return `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
      }
      case "ul": {
        const liContent = (li) => Array.from(li.childNodes).map(nodeToMd).join("").trim();
        return "\n" + Array.from(node.children).map(li => `- ${liContent(li)}`).join("\n") + "\n";
      }
      case "ol": {
        const liContent = (li) => Array.from(li.childNodes).map(nodeToMd).join("").trim();
        return "\n" + Array.from(node.children).map((li, i) => `${i + 1}. ${liContent(li)}`).join("\n") + "\n";
      }
      case "li": return `\n- ${children()}`;
      case "a": return `[${children()}](${node.getAttribute("href") ?? ""})`;
      case "blockquote": return `\n> ${children().trim().replace(/\n/g, "\n> ")}\n`;
      case "hr": return "\n---\n";
      case "table": return `\n${tableToMd(node)}\n`;
      default: return children();
    }
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const lines = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td, th")).map(
        (c) => nodeToMd(c).trim().replace(/\|/g, "\\|")
      );
      return `| ${cells.join(" | ")} |`;
    });
    const header = lines[0];
    const sep = header.replace(/[^|]/g, "-").replace(/--/g, "--");
    return [header, sep, ...lines.slice(1)].join("\n");
  }

  return nodeToMd(div).replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Scrape all messages from the current ChatGPT conversation page
// ---------------------------------------------------------------------------

/**
 * Extract all user and assistant messages from the current ChatGPT page.
 * Returns them in chronological order as { role, text } objects.
 */
async function scrapeAllMessages(options = {}) {
  const expectedChatUrl = options.expectedChatUrl || getCurrentChatUrl();
  const expectedChatId = options.expectedChatId || getCurrentChatId(expectedChatUrl);
  const minCapturedAt = Number(options.minCapturedAt) || 0;
  const timeoutMs = Number(options.timeoutMs) || 15_000;
  const requestedChatUrl = expectedChatUrl || getCurrentChatUrl();
  const isDeepSeek = SITE_ADAPTER?.siteId === "deepseek";
  const readyWaitMs = isDeepSeek ? Math.min(timeoutMs, 5_000) : 15_000;
  const retryDelayMs = isDeepSeek ? 750 : 2_000;
  const scrollBudgetMs = isDeepSeek ? Math.min(timeoutMs, 12_000) : 20_000;
  lastScrapeDebug = {
    startedAt: Date.now(),
    expectedChatUrl,
    expectedChatId,
    currentChatUrl: getCurrentChatUrl(),
    siteId: SITE_ADAPTER?.siteId || null,
    source: null,
    messageCount: 0,
    chatId: null,
    chatUrl: null,
  };

  if (isDeepSeek) {
    const fastNetworkGraceMs = Math.min(timeoutMs, 1_250);
    const fastNetworkSnapshotPromise = waitForDeepSeekTranscriptSnapshot({
      expectedChatUrl,
      expectedChatId,
      minCapturedAt,
      timeoutMs: fastNetworkGraceMs,
    });
    const earlyTranscriptPromise = extractFullConversationTranscript({
      initialWaitMs: 900,
      stepWaitMs: 250,
      maxSteps: 60,
      maxDurationMs: Math.max(2500, scrollBudgetMs),
    });
    const networkSnapshot = await fastNetworkSnapshotPromise;
    if (networkSnapshot) {
      console.log(
        `[sync-zotero] scrapeAllMessages: using DeepSeek network snapshot (${networkSnapshot.messages.length} messages)`,
      );
      lastScrapeDebug = {
        ...lastScrapeDebug,
        finishedAt: Date.now(),
        source: "network",
        messageCount: networkSnapshot.messages.length,
        chatId: networkSnapshot.chatId || null,
        chatUrl: networkSnapshot.chatUrl || null,
      };
      return networkSnapshot;
    }

    try {
      const earlyTranscript = await earlyTranscriptPromise;
      const earlyMapped = mapTranscriptToRelayMessages(earlyTranscript);
      const earlyMessages = earlyMapped.filter((message) => message.text || message.thinking);
      if (earlyMessages.length > 0) {
        const result = {
          messages: earlyMessages,
          chatUrl: earlyTranscript.chatUrl,
          chatId: earlyTranscript.chatId,
          siteHostname: window.location.hostname,
          capturedAt: Date.now(),
          source: "dom",
        };
        lastScrapeDebug = {
          ...lastScrapeDebug,
          finishedAt: Date.now(),
          source: "dom",
          messageCount: earlyMessages.length,
          chatId: result.chatId || null,
          chatUrl: result.chatUrl || null,
          strategy: "deepseek_early_scroll",
          fastNetworkGraceMs,
        };
        return result;
      }
    } catch (err) {
      lastScrapeDebug = {
        ...lastScrapeDebug,
        fastNetworkGraceMs,
        earlyScrollError: err?.message || String(err),
      };
    }
  }

  let ready = await waitForChatReady(requestedChatUrl, readyWaitMs);

  // If first attempt failed or returned empty messages on a conversation page,
  // retry once after a brief delay (handles stale SPA state)
  const isConversationPage =
    requestedChatUrl && SITE_ADAPTER?.getChatIdFromUrl?.(requestedChatUrl) !== null;
  const firstMessages = (ready.messages || []).filter(
    (message) => message.text || message.thinking,
  );

  if (isConversationPage && firstMessages.length === 0) {
    console.warn("[sync-zotero] scrapeAllMessages: no messages on first attempt, retrying…");
    await workerSleep(retryDelayMs);
    ready = await waitForChatReady(requestedChatUrl, readyWaitMs);
  }

  if (!ready.ok && (!ready.messages || ready.messages.length === 0)) {
    console.warn("[sync-zotero] scrapeAllMessages: page never became ready");
    const result = {
      messages: [],
      chatUrl: ready.chatUrl || requestedChatUrl,
      chatId: ready.chatId || getCurrentChatId(requestedChatUrl),
      siteHostname: window.location.hostname,
      capturedAt: Date.now(),
      source: "dom",
    };
    lastScrapeDebug = {
      ...lastScrapeDebug,
      finishedAt: Date.now(),
      source: "dom",
      messageCount: 0,
      chatId: result.chatId || null,
      chatUrl: result.chatUrl || null,
      error: ready.error || "page_never_ready",
    };
    return result;
  }

  const readyMessages = (ready.messages || []).filter(
    (message) => message.text || message.thinking,
  );
  if (!isDeepSeek) {
    const result = {
      messages: readyMessages,
      chatUrl: ready.chatUrl || requestedChatUrl,
      chatId: ready.chatId || getCurrentChatId(requestedChatUrl),
      siteHostname: window.location.hostname,
      capturedAt: Date.now(),
      source: "dom",
    };
    lastScrapeDebug = {
      ...lastScrapeDebug,
      finishedAt: Date.now(),
      source: "dom",
      messageCount: readyMessages.length,
      chatId: result.chatId || null,
      chatUrl: result.chatUrl || null,
      strategy: "ready_transcript",
    };
    return result;
  }

  // Always attempt full scroll-and-collect to capture all messages
  // (critical for sites with virtual scrolling like DeepSeek).
  try {
    const fullTranscript = await extractFullConversationTranscript({
      initialWaitMs: isDeepSeek ? 900 : 2500,
      stepWaitMs: isDeepSeek ? 250 : 500,
      maxSteps: isDeepSeek ? 60 : 100,
      maxDurationMs: scrollBudgetMs,
    });
    const fullMapped = mapTranscriptToRelayMessages(fullTranscript);
    const fullMessages = fullMapped.filter((m) => m.text || m.thinking);
    console.log(`[sync-zotero] scrapeAllMessages: scroll extraction found ${fullMessages.length} messages`);
    if (fullMessages.length > 0) {
      const result = {
        messages: fullMessages,
        chatUrl: fullTranscript.chatUrl,
        chatId: fullTranscript.chatId,
        siteHostname: window.location.hostname,
        capturedAt: Date.now(),
        source: "dom",
      };
      lastScrapeDebug = {
        ...lastScrapeDebug,
        finishedAt: Date.now(),
        source: "dom",
        messageCount: fullMessages.length,
        chatId: result.chatId || null,
        chatUrl: result.chatUrl || null,
      };
      return result;
    }
  } catch (err) {
    console.warn("[sync-zotero] scrapeAllMessages: scroll extraction failed:", err);
    lastScrapeDebug = {
      ...lastScrapeDebug,
      finishedAt: Date.now(),
      source: "dom",
      messageCount: 0,
      error: err?.message || String(err),
    };
  }

  // Fallback: use whatever waitForChatReady returned
  const messages = (ready.messages || []).filter(
    (message) => message.text || message.thinking,
  );
  console.log(`[sync-zotero] scrapeAllMessages: fallback found ${messages.length} messages`);
  const result = {
    messages,
    chatUrl: ready.chatUrl || requestedChatUrl,
    chatId: ready.chatId || getCurrentChatId(requestedChatUrl),
    siteHostname: window.location.hostname,
    capturedAt: Date.now(),
    source: "dom",
  };
  lastScrapeDebug = {
    ...lastScrapeDebug,
    finishedAt: Date.now(),
    source: "dom",
    messageCount: messages.length,
    chatId: result.chatId || null,
    chatUrl: result.chatUrl || null,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Main message listener
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PING handler (used by background to check if content script is alive)
// ---------------------------------------------------------------------------

async function collectHealthStatus() {
  const hookResponded = await requestMainWorldHealth();
  const composer = findComposerNow();
  const sendBtn = findSendButton(composer);
  const uploadControl = document.querySelector('input[type="file"]');
  return {
    ok: true,
    contentScriptAlive: true,
    siteId: SITE_ADAPTER?.siteId || null,
    url: window.location.href,
    mainWorldInjected: mainWorldInjected || hookResponded,
    composerFound: Boolean(composer),
    sendControlState: describeSubmitControl(sendBtn),
    uploadControlFound: Boolean(uploadControl),
    networkHookActive: networkHookActive || hookResponded,
    supportedDeliveryContracts: [...SUPPORTED_DELIVERY_CONTRACTS],
    lastRequestAt: lastRequestAt || null,
    lastStreamAt: lastStreamAt || null,
    lastDiagnostic,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({
      pong: true,
      supportedDeliveryContracts: [...SUPPORTED_DELIVERY_CONTRACTS],
    });
    return false;
  }

  if (msg.type === "HEALTH_CHECK") {
    collectHealthStatus()
      .then((status) => sendResponse(status))
      .catch((err) =>
        sendResponse({
          ok: false,
          contentScriptAlive: true,
          siteId: SITE_ADAPTER?.siteId || null,
          url: window.location.href,
          supportedDeliveryContracts: [...SUPPORTED_DELIVERY_CONTRACTS],
          lastDiagnostic: buildDiagnostic({
            phase: "health_check",
            reasonCode: "health_check_failed",
            message: err?.message || String(err),
          }),
        }),
      );
    return true;
  }

  // [webchat] Trigger immediate sidebar history scrape (force re-send)
  if (msg.type === "SCRAPE_HISTORY_NOW") {
    if (msg.force === true) {
      lastHistoryJson = "";
    }
    scrapeHistory({
      force: msg.force === true,
      minCapturedAt: Number(msg.minCapturedAt) || 0,
      timeoutMs: Number(msg.timeoutMs) || 15_000,
    })
      .then((result) => sendResponse(result || { ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || "Failed to scrape history.",
        }),
      );
    return true;
  }

  if (msg.type === "RESET_NETWORK_CACHE") {
    clearDeepSeekNetworkCaches(msg.scope || "all");
    sendResponse({ ok: true });
    return false;
  }

  // [webchat] Stop ChatGPT generation by clicking the stop button
  if (msg.type === "STOP") {
    const requestedAttemptToken = shared.attemptToken(msg.seq, msg.attempt);
    if (
      !_syncZoteroAttemptToken ||
      requestedAttemptToken !== _syncZoteroAttemptToken
    ) {
      sendResponse({ ok: false, error: "Stale WebChat stop request ignored" });
      return false;
    }
    const stopBtn = findStopButton();
    if (stopBtn) {
      stopBtn.click();
      clearSyncZoteroAttemptToken(requestedAttemptToken);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "Stop button not found" });
    }
    return false;
  }

  // [webchat] Navigate to a URL (forces full page reload for SPA)
  if (msg.type === "NAVIGATE") {
    _lastSetChatGPTMode = null; // Reset mode tracking for new page
    window.location.href = msg.url;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "WAIT_FOR_CHAT_READY") {
    waitForChatReady(msg.expectedChatUrl || null, msg.timeoutMs || 30000)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          ready: false,
          error: err?.message || "Failed to wait for chat readiness.",
        }),
      );
    return true;
  }

  // [webchat] Scrape all messages from the current ChatGPT conversation
  if (msg.type === "SCRAPE_MESSAGES") {
    console.log("[sync-zotero] SCRAPE_MESSAGES received, starting scrape…");
    scrapeAllMessages({
      expectedChatUrl: msg.expectedChatUrl || null,
      expectedChatId: msg.expectedChatId || null,
      minCapturedAt: Number(msg.minCapturedAt) || 0,
      timeoutMs: Number(msg.timeoutMs) || 15_000,
    })
      .then((result) => {
        console.log(`[sync-zotero] SCRAPE_MESSAGES done: ${result.messages.length} messages (${result.source || "unknown"})`);
        sendResponse({ ok: true, ...result });
      })
      .catch((err) => {
        console.warn("[sync-zotero] SCRAPE_MESSAGES error:", err);
        sendResponse({
          ok: false,
          error: err.message,
          messages: [],
          chatUrl: msg.expectedChatUrl || getCurrentChatUrl(),
          chatId: msg.expectedChatId || getCurrentChatId(),
          siteHostname: window.location.hostname,
          capturedAt: Date.now(),
          source: null,
        });
      });
    return true; // async sendResponse
  }

  return false;
});

// ---------------------------------------------------------------------------
// Port-based pipeline handler (streaming)
// ---------------------------------------------------------------------------

// Guard: only register the port listener once per execution context.
// If the content script is re-injected, the old context's listener is orphaned
// and cannot receive new connections, but this prevents same-context duplication.
let _syncZoteroPort = null;
let _syncZoteroAttemptToken = null;

function clearSyncZoteroAttemptToken(attemptToken) {
  if (_syncZoteroAttemptToken === attemptToken) {
    _syncZoteroAttemptToken = null;
  }
}

async function stopDisconnectedSyncZoteroAttempt(attemptToken) {
  try {
    return await shared.stopDisconnectedProviderAttempt({
      attemptToken,
      isAttemptCurrent: (token) =>
        _syncZoteroAttemptToken === token,
      findStopControl: () => findStopButton(),
      clickStopControl: (stopControl) => stopControl.click(),
      wait: workerSleep,
    });
  } finally {
    clearSyncZoteroAttemptToken(attemptToken);
  }
}

if (!window.__syncZoteroListenerRegistered) {
  window.__syncZoteroListenerRegistered = true;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "sync-zotero") return;

    // Disconnect any previous port to prevent parallel pipelines
    if (_syncZoteroPort) {
      try { _syncZoteroPort.disconnect(); } catch (_) {}
    }
    _syncZoteroPort = port;
    let portDisconnected = false;
    let portAttemptToken = null;
    let portProviderMayBeRunning = false;
    let portTerminalPosted = false;
    const isPipelineCurrent = () =>
      !portDisconnected &&
      _syncZoteroPort === port &&
      _syncZoteroAttemptToken === portAttemptToken;

    port.onDisconnect.addListener(() => {
      portDisconnected = true;
      if (_syncZoteroPort === port) _syncZoteroPort = null;
      if (_syncZoteroAttemptToken === portAttemptToken) {
        if (portProviderMayBeRunning && !portTerminalPosted) {
          void stopDisconnectedSyncZoteroAttempt(portAttemptToken);
        } else {
          clearSyncZoteroAttemptToken(portAttemptToken);
        }
      }
    });

    port.onMessage.addListener(async (msg) => {
      if (msg.type !== "START") return;

      const seq = msg.seq; // track seq for end-to-end validation
      const attempt = msg.attempt || 0;
      const pipelineAttemptToken = shared.attemptToken(seq, attempt);
      portAttemptToken = pipelineAttemptToken;
      _syncZoteroAttemptToken = pipelineAttemptToken;
      portProviderMayBeRunning = false;
      portTerminalPosted = false;
      let uploadDetected = false;
      let pdfAttachmentReceipt = null;
      let composerTextMatched = false;
      let clickAttempts = 0;

      try {
        // Defense in depth behind the background gate: a START that
        // reaches a content script without a usable contract version
        // still fails with the update remedy, never a cryptic error.
        const requestedContract = msg.deliveryContractVersion;
        if (
          requestedContract === undefined ||
          requestedContract === null ||
          Number(requestedContract) === 0
        ) {
          throw new Error(shared.WEBCHAT_PLUGIN_OUTDATED_MESSAGE);
        }
        if (
          !shared.supportsDeliveryContract(
            SUPPORTED_DELIVERY_CONTRACTS,
            requestedContract,
          )
        ) {
          throw new Error(
            shared.unsupportedDeliveryContractMessage(
              requestedContract,
              SUPPORTED_DELIVERY_CONTRACTS,
            ),
          );
        }
        const baselineTranscript = extractConversationTranscript();
        const attachmentFingerprint = [
          msg.pdfFilename || "",
          Array.isArray(msg.images) ? msg.images.length : 0,
        ].join("|");

        const pendingPdfEvidence = collectVisibleComposerPdfCardEvidence();
        if (pendingPdfEvidence.length > 0) {
          throw new Error(
            msg.pdfBase64
              ? "PDF send blocked because the web composer already contains a PDF attachment. Remove it or reload the chat tab, then try again."
              : "Prompt-only send blocked because the web composer still contains a PDF attachment. Remove it or reload the chat tab, then try again.",
          );
        }

        // Attach PDF whenever provided — the plugin controls when to send via chip state
        if (msg.pdfBase64) {
          pdfAttachmentReceipt = await attachPDF(
            msg.pdfBase64,
            msg.pdfFilename,
          );
          uploadDetected = true;
        }
        assertPipelineCurrent(isPipelineCurrent);
        if (msg.images && msg.images.length > 0) {
          console.log(`[sync-zotero] Attaching ${msg.images.length} image(s)…`);
          try {
            await attachImages(msg.images);
            uploadDetected = true;
          } catch (imgErr) {
            console.warn("[sync-zotero] Image attachment failed:", imgErr);
          }
        }
        // Mode switching disabled — users control thinking mode directly on chatgpt.com
        await typePromptAndVerify(msg.prompt, {
          requireEnabledSendControl:
            SITE_ADAPTER?.siteId === "chatgpt",
        });
        assertPipelineCurrent(isPipelineCurrent);
        composerTextMatched = true;
        await shared.postPhaseAndWaitForAck(port, {
          seq,
          attempt,
          phase: "prompt_applied",
          diagnostic: buildDiagnostic({
            phase: "prompt_applied",
            composerTextMatched,
            uploadDetected,
            clickAttempts,
            attachmentFilename: msg.pdfFilename || null,
            attachmentMethod: pdfAttachmentReceipt?.method || null,
            attachmentVerificationMs:
              pdfAttachmentReceipt?.totalElapsedMs ?? null,
            attachmentPreviewVerified: Boolean(pdfAttachmentReceipt),
            attachmentRequested: Boolean(msg.pdfBase64),
            attachmentFilenameConfirmed: msg.pdfBase64
              ? pdfAttachmentReceipt?.filenameConfirmed === true
              : null,
            attachmentReadyVerified: msg.pdfBase64
              ? pdfAttachmentReceipt?.readyConfirmed === true
              : null,
            attachmentContractVerified: false,
          }),
        });
        await shared.postPhaseAndWaitForAck(port, {
          seq,
          attempt,
          phase: "submit_started",
          diagnostic: buildDiagnostic({
            phase: "submit_started",
            composerTextMatched,
            uploadDetected,
            clickAttempts,
            attachmentFilename: msg.pdfFilename || null,
            attachmentMethod: pdfAttachmentReceipt?.method || null,
            attachmentVerificationMs:
              pdfAttachmentReceipt?.totalElapsedMs ?? null,
            attachmentPreviewVerified: Boolean(pdfAttachmentReceipt),
            attachmentRequested: Boolean(msg.pdfBase64),
            attachmentFilenameConfirmed: msg.pdfBase64
              ? pdfAttachmentReceipt?.filenameConfirmed === true
              : null,
            attachmentReadyVerified: msg.pdfBase64
              ? pdfAttachmentReceipt?.readyConfirmed === true
              : null,
            attachmentContractVerified: false,
          }),
        });
        assertPipelineCurrent(isPipelineCurrent);

        // The durable submit-start acknowledgement is the boundary after which
        // the website may start generating. An unexpected disconnect must
        // retain this exact attempt long enough to stop that provider run.
        portProviderMayBeRunning = true;
        const submission = await submitMessageAndVerify(
          msg.prompt,
          isPipelineCurrent,
        );
        clickAttempts = Number(submission?.clickAttempts) || clickAttempts;
        port.postMessage({
          type: "phase",
          seq,
          attempt,
          phase: "submitted",
          diagnostic: buildDiagnostic({
            phase: "submitted",
            composerTextMatched,
            uploadDetected,
            clickAttempts,
            requestObserved: Boolean(submission?.requestObserved),
            streamObserved: Boolean(submission?.streamObserved),
            attachmentFilename: msg.pdfFilename || null,
            attachmentMethod: pdfAttachmentReceipt?.method || null,
            attachmentVerificationMs:
              pdfAttachmentReceipt?.totalElapsedMs ?? null,
            attachmentPreviewVerified: Boolean(pdfAttachmentReceipt),
            attachmentRequested: Boolean(msg.pdfBase64),
            attachmentFilenameConfirmed: msg.pdfBase64
              ? pdfAttachmentReceipt?.filenameConfirmed === true
              : null,
            attachmentReadyVerified: msg.pdfBase64
              ? pdfAttachmentReceipt?.readyConfirmed === true
              : null,
            attachmentContractVerified: false,
          }),
        });

        await streamResponseSnapshots(
          port,
          seq,
          attempt,
          baselineTranscript,
          msg.prompt || "",
          attachmentFingerprint,
          {
            ...submission,
            pdfAttachmentReceipt,
            composerTextMatched,
            uploadDetected,
            clickAttempts,
          },
          RESPONSE_TIMEOUT_MS,
          isPipelineCurrent,
          () => {
            portTerminalPosted = true;
            portProviderMayBeRunning = false;
          },
        );

      } catch (err) {
        if (err?.name === "PipelineCancelled") return;
        try {
          port.postMessage({
            type: "error",
            seq,
            attempt,
            error: err.message,
            diagnostic: buildDiagnostic({
              phase: "error",
              reasonCode: "pipeline_error",
              message: err.message,
              composerTextMatched,
              uploadDetected,
              clickAttempts,
              attachmentFilename: msg.pdfFilename || null,
              attachmentMethod: pdfAttachmentReceipt?.method || null,
              attachmentVerificationMs:
                pdfAttachmentReceipt?.totalElapsedMs ?? null,
              attachmentPreviewVerified: Boolean(pdfAttachmentReceipt),
              attachmentRequested: Boolean(msg.pdfBase64),
              attachmentFilenameConfirmed: msg.pdfBase64
                ? pdfAttachmentReceipt?.filenameConfirmed === true
                : null,
              attachmentReadyVerified: msg.pdfBase64
                ? pdfAttachmentReceipt?.readyConfirmed === true
                : null,
              attachmentContractVerified: false,
            }),
          });
        } catch (_) {}
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 3: History Mirroring & Deletion
// ---------------------------------------------------------------------------

let lastHistoryJson = "";

function parseDeepSeekHistoryHref(href) {
  const rawHref = String(href || "").trim();
  if (!rawHref) return null;
  try {
    const parsed = new URL(rawHref, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    const match = parsed.pathname.match(/^\/a\/chat\/s\/([^/?#]+)$/);
    if (!match) return null;
    return {
      id: match[1],
      chatUrl: `https://chat.deepseek.com${parsed.pathname}`,
    };
  } catch (_) {
    return null;
  }
}

function parseDeepSeekHistoryAnchor(anchor) {
  if (!anchor) return null;
  const parsed = parseDeepSeekHistoryHref(anchor.getAttribute("href"));
  if (!parsed?.id || !parsed.chatUrl) return null;
  const title = shared.normalizeComposerText(anchor.textContent || "");
  if (!title || title === parsed.id || title === parsed.chatUrl) return null;
  return {
    id: parsed.id,
    title,
    chatUrl: parsed.chatUrl,
  };
}

function collectDeepSeekHistoryEntriesWithRoot() {
  const selectors = [
    "aside",
    "nav",
    '[role="navigation"]',
    '[class*="sidebar"]',
    '[class*="history"]',
    '[data-testid*="history"]',
    '[data-testid*="sidebar"]',
  ];
  const candidates = [];
  const seen = new Set();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((node) => {
      if (!(node instanceof Element) || seen.has(node)) return;
      seen.add(node);
      candidates.push(node);
    });
  }

  let bestRoot = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const entries = [];
    const seenIds = new Set();
    candidate.querySelectorAll('a[href]').forEach((anchor) => {
      const entry = parseDeepSeekHistoryAnchor(anchor);
      if (!entry || seenIds.has(entry.id)) return;
      entries.push(entry);
      seenIds.add(entry.id);
    });
    const candidateClass = String(candidate.className || "").toLowerCase();
    const isLikelyHistoryRoot =
      entries.length > 0 ||
      candidate.matches("aside") ||
      /(sidebar|history|conversation)/.test(candidateClass) ||
      candidate.matches(
        '[class*="sidebar"], [class*="history"], [data-testid*="history"], [data-testid*="sidebar"]',
      );
    if (!isLikelyHistoryRoot) continue;
    const bonus =
      candidate.matches("aside, nav, [role='navigation']") ? 2 : 0;
    const keywordBonus =
      /(sidebar|history|conversation|nav)/.test(candidateClass) ? 4 : 0;
    const score = entries.length * 20 + bonus + keywordBonus;
    if (score > bestScore) {
      bestScore = score;
      bestRoot = candidate;
    }
  }

  if (!bestRoot) {
    return { root: null, history: [] };
  }

  const history = [];
  const seenIds = new Set();
  bestRoot.querySelectorAll('a[href]').forEach((anchor) => {
    const entry = parseDeepSeekHistoryAnchor(anchor);
    if (!entry || seenIds.has(entry.id)) return;
    history.push(entry);
    seenIds.add(entry.id);
  });
  return { root: bestRoot, history };
}

function collectHistoryEntries() {
  if (SITE_ADAPTER?.siteId === "deepseek") {
    return collectDeepSeekHistoryEntriesWithRoot().history;
  }
  const linkSelector = SITE_ADAPTER?.historyLinkSelector || 'nav a[href^="/c/"]';
  const items = Array.from(document.querySelectorAll(linkSelector));
  const history = [];
  const seenIds = new Set();

  for (const a of items) {
    if (SITE_ADAPTER?.buildHistoryEntry) {
      const entry = SITE_ADAPTER.buildHistoryEntry(a);
      const id = String(entry?.id || "").trim();
      const title = shared.normalizeComposerText(entry?.title || "");
      const chatUrl = String(entry?.chatUrl || "").trim();
      if (
        !id ||
        !title ||
        !chatUrl ||
        title === id ||
        title === chatUrl ||
        seenIds.has(id)
      ) {
        continue;
      }
      history.push({ id, title, chatUrl });
      seenIds.add(id);
      continue;
    }
    const href = a.getAttribute('href');
    if (!href) continue;
    const chatId = href.replace('/c/', '');
    const title = shared.normalizeComposerText(a.textContent || "");
    if (!chatId || !title || title === chatId || title === href || seenIds.has(chatId)) continue;
    history.push({ id: chatId, title, chatUrl: `https://chatgpt.com${href}` });
    seenIds.add(chatId);
  }

  return history;
}

async function scrapeHistory(options = {}) {
  if (historyScrapeInFlight) {
    // Another scrape is running — wait for it instead of silently dropping.
    try { return await historyScrapeInFlight; }
    catch { return { ok: false, error: "concurrent scrape failed" }; }
  }
  const promise = _doScrapeHistory(options);
  historyScrapeInFlight = promise;
  try {
    return await promise;
  } finally {
    if (historyScrapeInFlight === promise) {
      historyScrapeInFlight = null;
    }
  }
}

async function _doScrapeHistory(options = {}) {
  const isDeepSeek = window.location.hostname === "chat.deepseek.com";
  const minCapturedAt = Number(options.minCapturedAt) || 0;
  const timeoutMs = Number(options.timeoutMs) || 15_000;
  let history = null;
  let scrapedAt = Date.now();
  let source = "dom";
  let status = "ok";
  let networkStatus = null;

  if (isDeepSeek) {
    const networkSnapshot = await waitForDeepSeekHistorySnapshot({
      minCapturedAt,
      timeoutMs,
    });
    if (networkSnapshot) {
      networkStatus = networkSnapshot.status || "empty";
      if (networkStatus === "ok" || networkStatus === "empty") {
        history = networkSnapshot.history;
        scrapedAt = networkSnapshot.capturedAt || Date.now();
        source = networkSnapshot.source || "network";
        status = networkStatus;
      }
    }
  }

  if (!Array.isArray(history)) {
    const attempts = isDeepSeek ? 4 : 2;
    const initialDelayMs = isDeepSeek ? 600 : 150;
    const retryDelayMs = isDeepSeek ? 700 : 300;

    await workerSleep(initialDelayMs);

    history = [];
    let deepSeekRootSeen = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (isDeepSeek) {
        const collected = collectDeepSeekHistoryEntriesWithRoot();
        history = collected.history;
        if (collected.root) {
          deepSeekRootSeen = true;
        }
      } else {
        history = collectHistoryEntries();
      }
      if (history.length > 0 || attempt === attempts - 1) {
        break;
      }
      await workerSleep(retryDelayMs);
    }
    scrapedAt = Date.now();
    source = "dom";
    if (isDeepSeek) {
      if (history.length > 0) {
        status = "ok";
      } else if (deepSeekRootSeen) {
        status = "empty";
      } else if (networkStatus === "invalid_source") {
        status = "invalid_source";
        source = "network";
      } else {
        status = "timeout";
      }
    } else {
      status = history.length > 0 ? "ok" : "empty";
    }
  }

  const historyJson = JSON.stringify({
    history,
    status,
    siteHostname: window.location.hostname,
  });
  if (
    historyJson !== lastHistoryJson ||
    options.force === true ||
    minCapturedAt > 0
  ) {
    lastHistoryJson = historyJson;
    // Include siteHostname so the relay can merge per-site
    // (only replace this site's entries, keep other sites intact).
    const siteHostname = window.location.hostname;
    try {
      chrome.runtime.sendMessage(
        {
          type: "HISTORY_UPDATE",
          history,
          siteHostname,
          scrapedAt,
          source,
          status,
        },
        () => {
          // Suppress "Receiving end does not exist" when service worker is inactive
          void chrome.runtime.lastError;
        },
      );
    } catch (e) {
      // Extension context invalidated (extension reloaded while page still open)
    }
  }
  return {
    ok: true,
    history,
    siteHostname: window.location.hostname,
    scrapedAt,
    source,
    status,
  };
}

function shouldAutoScrapeHistory() {
  if (SITE_ADAPTER?.siteId !== "deepseek") return true;
  return !getCurrentChatId();
}

// Scrape every 2 seconds
setInterval(() => {
  if (!shouldAutoScrapeHistory()) return;
  void scrapeHistory();
}, 2000);

async function handleDeleteChat(chatId) {
  // Find the exact link in the sidebar
  const deleteLinkSelector = SITE_ADAPTER?.deleteChatLinkSelector?.(chatId) || `nav a[href="/c/${chatId}"]`;
  const chatLink = document.querySelector(deleteLinkSelector);
  if (!chatLink) return { success: false, error: "Chat not found in sidebar" };

  // Hover or focus to ensure the options button appears
  chatLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(300);

  // The options button is usually a sibling or child button with aria-haspopup="menu"
  // Let's look for a button inside the link or immediately next to it.
  const optionsBtn = chatLink.querySelector('button[aria-haspopup="menu"]') || 
                     chatLink.parentElement.querySelector('button[aria-haspopup="menu"]');
                     
  if (!optionsBtn) return { success: false, error: "Options button not found" };
  
  optionsBtn.click();
  await sleep(300);

  const isDeleteAction = (text) => {
    const normalized = String(text || "").trim().toLowerCase();
    return normalized.includes("delete") ||
      normalized.includes("remove") ||
      normalized.includes("删除");
  };

  // Radix menu opens at the end of the body
  // Find the Delete menu item
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const deleteItem = menuItems.find(item => isDeleteAction(item.textContent));
  
  if (!deleteItem) return { success: false, error: "Delete menu item not found" };
  
  deleteItem.click();
  await sleep(500);

  // Find the red confirmation button in the modal
  const modalButtons = Array.from(document.querySelectorAll('[role="dialog"] button'));
  // Usually the destructive action button has specific styling, or it's the last button containing "Delete"
  const confirmBtn = modalButtons.find(btn => isDeleteAction(btn.textContent));
  
  if (!confirmBtn) return { success: false, error: "Confirmation button not found" };
  
  confirmBtn.click();
  await sleep(1000); // Wait for deletion to process

  // Scrape history immediately to reflect deletion
  if (shouldAutoScrapeHistory()) {
    scrapeHistory();
  }
  return { success: true };
}

// Message listener for the DELETE command
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "DELETE_CHAT") {
    handleDeleteChat(request.chatId)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});
