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

  function composerBridgeAllowsSynchronousFallback(result) {
    return Boolean(
      result?.handled === true &&
        result?.applied !== true &&
        result?.pasteAccepted !== true,
    );
  }

  function composerBridgeWriteTransition(result) {
    const allowSynchronousFallback =
      composerBridgeAllowsSynchronousFallback(result);
    return {
      allowSynchronousFallback,
      pendingBridgeCommit: !allowSynchronousFallback,
    };
  }

  function composerPromptVerificationPolicy(pendingBridgeCommit) {
    const pending = pendingBridgeCommit === true;
    return {
      matchTimeoutMs: pending ? 10000 : 300,
      allowRetry: !pending,
    };
  }

  function normalizeAttachmentEvidence(text) {
    return String(text || "")
      .normalize("NFC")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Chat sites elide long file names in the composer card ("Long paper na…"),
  // so the full name never appears in the DOM. Accept an elision only when
  // enough of the expected name precedes it to identify the file.
  const MIN_ELIDED_FILENAME_PREFIX_LENGTH = 16;

  function evidenceMatchesElidedFilename(
    normalizedEvidence,
    normalizedFilename,
  ) {
    if (normalizedFilename.length <= MIN_ELIDED_FILENAME_PREFIX_LENGTH) {
      return false;
    }
    const elisions = /…|\.\.\./g;
    let elision;
    while ((elision = elisions.exec(normalizedEvidence))) {
      const beforeElision = normalizedEvidence.slice(0, elision.index);
      for (
        let prefixLength = Math.min(
          beforeElision.length,
          normalizedFilename.length,
        );
        prefixLength >= MIN_ELIDED_FILENAME_PREFIX_LENGTH;
        prefixLength--
      ) {
        if (beforeElision.endsWith(normalizedFilename.slice(0, prefixLength))) {
          return true;
        }
      }
    }
    return false;
  }

  function stripElidedFilenameEvidence(
    normalizedEvidence,
    normalizedFilename,
  ) {
    let remaining = normalizedEvidence;
    if (normalizedFilename.length <= MIN_ELIDED_FILENAME_PREFIX_LENGTH) {
      return remaining;
    }

    let searchFrom = 0;
    for (;;) {
      const elisions = /…|\.\.\./g;
      elisions.lastIndex = searchFrom;
      const match = elisions.exec(remaining);
      if (!match) return remaining;
      const beforeElision = remaining.slice(0, match.index);
      let matchedPrefixLength = 0;
      for (
        let prefixLength = Math.min(
          beforeElision.length,
          normalizedFilename.length,
        );
        prefixLength >= MIN_ELIDED_FILENAME_PREFIX_LENGTH;
        prefixLength--
      ) {
        if (beforeElision.endsWith(normalizedFilename.slice(0, prefixLength))) {
          matchedPrefixLength = prefixLength;
          break;
        }
      }
      if (matchedPrefixLength === 0) {
        searchFrom = match.index + match[0].length;
        continue;
      }
      const filenameStart = match.index - matchedPrefixLength;
      remaining = `${remaining.slice(0, filenameStart)} ${remaining.slice(
        match.index + match[0].length,
      )}`;
      searchFrom = 0;
    }
  }

  function attachmentEvidenceMatchesFilename(evidence, expectedFilename) {
    const normalizedEvidence = normalizeAttachmentEvidence(evidence);
    const normalizedFilename = normalizeAttachmentEvidence(expectedFilename);
    if (!normalizedFilename || !normalizedEvidence) return false;
    if (normalizedEvidence.includes(normalizedFilename)) return true;
    if (evidenceMatchesElidedFilename(normalizedEvidence, normalizedFilename)) {
      return true;
    }

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

  function attachmentStatusEvidence(evidence, expectedFilename = "") {
    let normalizedEvidence = normalizeAttachmentEvidence(evidence);
    const normalizedFilename = normalizeAttachmentEvidence(expectedFilename);
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
    normalizedEvidence = stripElidedFilenameEvidence(
      normalizedEvidence,
      normalizedFilename,
    );
    return normalizedEvidence.replace(/\s+/g, " ").trim();
  }

  function attachmentEvidenceIsReady(evidence, expectedFilename) {
    if (!attachmentEvidenceMatchesFilename(evidence, expectedFilename)) {
      return false;
    }
    const normalizedEvidence = attachmentStatusEvidence(
      evidence,
      expectedFilename,
    );
    return !(
      /\b(?:parsing|uploading|processing|scanning|reading)\b/.test(
        normalizedEvidence,
      ) ||
      /(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
        normalizedEvidence,
      ) ||
      attachmentEvidenceHasFailure(evidence, expectedFilename)
    );
  }

  function attachmentEvidenceHasFailure(evidence, expectedFilename = "") {
    if (
      expectedFilename &&
      !attachmentEvidenceMatchesFilename(evidence, expectedFilename)
    ) {
      return false;
    }
    const normalizedEvidence = attachmentStatusEvidence(
      evidence,
      expectedFilename,
    );
    return (
      /\b(?:upload\s+failed|failed\s+to\s+upload|could\s+not\s+upload|couldn't\s+upload|unsupported|file\s+too\s+large|error)\b/.test(
        normalizedEvidence,
      ) ||
      /(?:上传失败|无法上传|不支持|文件过大|错误)/.test(
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
      /\b\d+(?:\.\d+)?\s*(?:b|kb|mb|gb)\b/.test(normalizedEvidence) ||
        /\b(?:parsing|uploading|processing|scanning|reading|ready)\b/.test(
          normalizedEvidence,
        ) ||
        /(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(
          normalizedEvidence,
        ) ||
        (hasExplicitFileControl && /\bpdf\b/.test(normalizedEvidence)),
    );
  }

  function hasPendingPdfEvidence(
    evidenceList,
    hasExplicitFileControl = false,
  ) {
    return (Array.isArray(evidenceList) ? evidenceList : []).some((evidence) => {
      const normalizedEvidence = normalizeAttachmentEvidence(evidence);
      if (/\.pdf(?:\b|$)/i.test(normalizedEvidence)) return true;
      return Boolean(
        /\bpdf\b/i.test(normalizedEvidence) &&
          attachmentEvidenceHasFileCardSignal(
            normalizedEvidence,
            hasExplicitFileControl,
          ),
      );
    });
  }

  function supportsDeliveryContract(supportedVersions, requiredVersion) {
    const required = Number(requiredVersion);
    if (!Number.isInteger(required) || required <= 0) return false;
    return (Array.isArray(supportedVersions) ? supportedVersions : []).some(
      (version) => Number(version) === required,
    );
  }

  // Mismatch errors must name the side to update: these strings travel to
  // the Zotero chat surface via /submit_response, which every released
  // plugin understands, so even the oldest pairing shows the remedy.
  const WEBCHAT_PLUGIN_OUTDATED_MESSAGE =
    "The installed LLM for Zotero plugin is too old for this version of " +
    "the Sync for Zotero extension. Update the LLM for Zotero plugin in " +
    "Zotero (Tools → Plugins and Themes), then try again. " +
    "No prompt or PDF was sent.";

  function unsupportedDeliveryContractMessage(
    requestedVersion,
    supportedVersions,
  ) {
    const supported = (
      Array.isArray(supportedVersions) ? supportedVersions : []
    )
      .map((version) => Number(version))
      .filter((version) => Number.isInteger(version) && version > 0);
    return (
      `This Zotero request uses WebChat delivery contract ` +
      `${Number(requestedVersion)}, but the installed Sync for Zotero ` +
      `extension only supports version ${supported.join(", ") || "none"}. ` +
      "Update the Sync for Zotero browser extension, then try again. " +
      "No prompt or PDF was sent."
    );
  }

  function contentScriptMeetsDeliveryContractRequirement(
    capabilityProbe,
    requiredVersion,
  ) {
    if (capabilityProbe?.pong !== true) return false;
    if (
      requiredVersion === undefined ||
      requiredVersion === null ||
      Number(requiredVersion) === 0
    ) {
      return true;
    }
    return supportsDeliveryContract(
      capabilityProbe.supportedDeliveryContracts,
      requiredVersion,
    );
  }

  function buildExtensionStatusReport({
    chatTabAlive = false,
    chatUrl = null,
    targetSiteId = null,
    capabilityProbe = null,
    health = null,
  } = {}) {
    const probeAlive = capabilityProbe?.pong === true;
    const healthAlive = health?.contentScriptAlive === true;
    const supportedDeliveryContracts = probeAlive
      ? capabilityProbe.supportedDeliveryContracts
      : health?.supportedDeliveryContracts;
    return {
      chatTabAlive: Boolean(chatTabAlive),
      chatUrl: chatUrl || null,
      siteId: health?.siteId || targetSiteId || null,
      url: health?.url || chatUrl || null,
      contentScriptAlive: probeAlive || healthAlive,
      mainWorldInjected: health?.mainWorldInjected === true,
      composerFound: health?.composerFound === true,
      sendControlState: health?.sendControlState || null,
      uploadControlFound: health?.uploadControlFound === true,
      networkHookActive: health?.networkHookActive === true,
      supportedDeliveryContracts: Array.isArray(
        supportedDeliveryContracts,
      )
        ? supportedDeliveryContracts
        : [],
      lastRequestAt: health?.lastRequestAt || null,
      lastStreamAt: health?.lastStreamAt || null,
      lastDiagnostic: health?.lastDiagnostic || null,
    };
  }

  function classifyChatReadinessBlocker({
    siteId = null,
    visibleText = "",
  } = {}) {
    const normalized = String(visibleText || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!normalized) return null;
    const siteLabel = String(siteId || "chat site").toLowerCase() === "chatgpt"
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
    if (
      /\blog in\b/.test(normalized) &&
      /\bsign up\b/.test(normalized)
    ) {
      return {
        reasonCode: "authentication_required",
        message: `${siteLabel} requires sign-in; no prompt or PDF was sent.`,
      };
    }
    return null;
  }

  function hasUsableChatReadinessSignals({
    urlMatches = true,
    composerReady = false,
    activeRun = false,
    domSettled = false,
    bodyReady = true,
    mainReady = true,
  } = {}) {
    return Boolean(
      urlMatches &&
        composerReady &&
        !activeRun &&
        domSettled &&
        bodyReady &&
        mainReady
    );
  }

  function classifyChatReadinessTimeout({
    urlMatches = true,
    composerReady = false,
    activeRun = false,
    domSettled = false,
    transcriptStable = false,
  } = {}) {
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
  }

  function canUseDeepSeekQuiescentCompletion(input) {
    return Boolean(
      input?.siteId === "deepseek" &&
        input?.activeRun !== true &&
        input?.stopControlVisible !== true &&
        input?.busyComposer !== true &&
        (input?.hasRequestContext === true ||
          input?.hasAssistantTurn === true) &&
        input?.attachmentContractVerified === true &&
        input?.terminalEvidence === true &&
        Number(input?.quietSinceMs) >= Number(input?.quietThresholdMs) &&
        input?.completionPhase !== "verified_done",
    );
  }

  async function stopSubmittedProviderAttempt({
    submitted,
    seq,
    attempt,
    sendStop,
    timeoutMs = 2000,
  }) {
    if (submitted !== true) {
      return { requested: false, acknowledged: false };
    }
    const message = {
      type: "STOP",
      seq: Number(seq) || 0,
      attempt: Number(attempt) || 0,
    };
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const finish = (acknowledged) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        resolve({ requested: true, acknowledged: acknowledged === true });
      };
      timeoutId = setTimeout(
        () => finish(false),
        Math.max(1, Number(timeoutMs) || 2000),
      );
      try {
        sendStop(message, (response) => finish(response?.ok === true));
      } catch (_) {
        finish(false);
      }
    });
  }

  async function stopDisconnectedProviderAttempt({
    attemptToken,
    isAttemptCurrent,
    findStopControl,
    clickStopControl,
    wait,
    now = () => Date.now(),
    timeoutMs = 5000,
    pollIntervalMs = 100,
  }) {
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
  }

  function attachmentListContainsExpectedFilename(
    attachments,
    expectedFilename,
  ) {
    return (Array.isArray(attachments) ? attachments : []).some((attachment) =>
      attachmentEvidenceMatchesFilename(attachment, expectedFilename),
    );
  }

  function classifySubmittedPdfContract(
    attachments,
    expectedFilename = "",
  ) {
    const normalizedAttachments = (Array.isArray(attachments)
      ? attachments
      : [])
      .map((attachment) => String(attachment || "").trim())
      .filter(Boolean);
    const attachmentRequested = Boolean(String(expectedFilename || "").trim());
    const isPdfAttachment = (attachment) =>
      /\.pdf(?:\b|$)/i.test(normalizeAttachmentEvidence(attachment)) ||
      /\bpdf\b/i.test(normalizeAttachmentEvidence(attachment)) ||
      (attachmentRequested &&
        attachmentEvidenceMatchesFilename(attachment, expectedFilename));
    const isImageAttachment = (attachment) =>
      /^(?:image(?:_\d+)?|.+\.(?:png|jpe?g|gif|webp|heic))$/i.test(
        normalizeAttachmentEvidence(attachment),
      );
    const pdfAttachments = normalizedAttachments.filter(isPdfAttachment);
    const unidentifiedAttachments = normalizedAttachments.filter(
      (attachment) =>
        !isPdfAttachment(attachment) && !isImageAttachment(attachment),
    );
    const filenameMatched = attachmentRequested
      ? attachmentListContainsExpectedFilename(
        pdfAttachments,
        expectedFilename,
      )
      : null;

    return {
      attachmentRequested,
      attachmentCount: normalizedAttachments.length,
      pdfAttachmentCount: pdfAttachments.length,
      filenameMatched,
      // We drop exactly one file into a preflighted-clean composer, so a
      // turn carrying any PDF or unidentifiable attachment is a sent PDF —
      // the name the site renders is not something we can insist on
      // without rejecting successful sends. Image-only turns are
      // affirmatively missing the PDF and still fail.
      contractVerified: attachmentRequested
        ? pdfAttachments.length + unidentifiedAttachments.length > 0
        : pdfAttachments.length === 0 &&
          unidentifiedAttachments.length === 0,
    };
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

  function attachmentCardIsSettled(card) {
    const normalized = normalizeAttachmentEvidence(card);
    return !(
      /\b(?:parsing|uploading|processing|scanning|reading)\b/.test(normalized) ||
      /(?:解析中|上传中|处理中|正在解析|正在上传|正在处理)/.test(normalized)
    );
  }

  /**
   * Confirm one specific attachment before submission, by tiered evidence.
   *
   * The question that matters is "did the file reach the composer?", not
   * "is it labelled the way we expect" — sites shorten, translate, and
   * re-render file names. Evidence matching the expected filename (with
   * elision and duplicate-name forms) upgrades the receipt to
   * filenameConfirmed and must reach a sustained ready state; any new card
   * since the pre-drop node-identity baseline is otherwise accepted on its
   * own with the name unconfirmed and quiescence as best-effort readiness.
   * Only affirmative contradictions fail: reported upload failure, a named
   * card stuck mid-processing, or no new card at all.
   */
  async function confirmAttachmentAcceptedThenReady({
    baselineEvidence = [],
    expectedFilename = "",
    readState,
    wait,
    now = () => Date.now(),
    acceptTimeoutMs = 15000,
    readyTimeoutMs = 30000,
    pollIntervalMs = 100,
    readyQuietWindowMs = 750,
  } = {}) {
    if (!String(expectedFilename || "").trim()) {
      throw new TypeError("expectedFilename is required");
    }
    if (typeof readState !== "function") {
      throw new TypeError("readState must be a function");
    }
    if (typeof wait !== "function") {
      throw new TypeError("wait must be a function");
    }

    const boundedPollIntervalMs = Math.max(10, Number(pollIntervalMs) || 100);
    const startedAt = now();

    const poll = async (deadline, isSatisfied) => {
      while (true) {
        const state = (await readState()) || {};
        const evidence = Array.isArray(state.evidence) ? state.evidence : [];
        const newCards = Array.isArray(state.newCards) ? state.newCards : [];
        const failedEvidence =
          evidence.find((entry) =>
            attachmentEvidenceHasFailure(entry, expectedFilename),
          ) ??
          newCards.find((card) =>
            attachmentEvidenceHasFailure(
              attachmentStatusEvidence(card, expectedFilename),
            ),
          );
        if (failedEvidence) {
          throw new Error(
            `The website reported that "${expectedFilename}" failed to upload.`,
          );
        }
        const satisfied = isSatisfied(evidence, newCards);
        if (satisfied) return satisfied;
        const currentTime = now();
        if (currentTime >= deadline) return null;
        await wait(
          Math.min(boundedPollIntervalMs, Math.max(0, deadline - currentTime)),
        );
      }
    };

    const acceptance = await poll(
      startedAt + Math.max(0, Number(acceptTimeoutMs) || 0),
      (evidence, newCards) => {
        if (
          hasNewExpectedAttachmentEvidence({
            baselineEvidence,
            currentEvidence: evidence,
            expectedFilename,
            requireReady: false,
          })
        ) {
          const matched = evidence.find((entry) =>
            attachmentEvidenceMatchesFilename(entry, expectedFilename),
          );
          return {
            evidence: matched || expectedFilename,
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
      now() + Math.max(0, Number(readyTimeoutMs) || 0),
      acceptance.filenameConfirmed
        ? (evidence) => {
            const ready = hasNewExpectedAttachmentEvidence({
              baselineEvidence,
              currentEvidence: evidence,
              expectedFilename,
              requireReady: true,
            });
            if (!ready) {
              readySince = null;
              return null;
            }
            if (readySince === null) readySince = now();
            if (now() - readySince < quietWindowMs) return null;
            return {
              evidence:
                evidence.find((entry) =>
                  attachmentEvidenceIsReady(entry, expectedFilename),
                ) || acceptance.evidence,
            };
          }
        : (evidence, newCards) => {
            // Nothing here identifies the file, so the best available
            // signal that the upload finished is that no card is still
            // reporting progress.
            const settled =
              newCards.length > 0 && newCards.every(attachmentCardIsSettled);
            if (!settled) {
              readySince = null;
              return null;
            }
            if (readySince === null) readySince = now();
            if (now() - readySince < quietWindowMs) return null;
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
      elapsedMs: Math.max(0, now() - startedAt),
    };
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

  function hasVerifiedTerminalEvidence(signals = {}) {
    if (
      Number(signals.activeConversationStreamCount || 0) > 0 ||
      signals.stopButtonVisible === true ||
      signals.busyComposer === true
    ) {
      return false;
    }

    // ChatGPT's per-turn action bar belongs to the rendered assistant turn and
    // appears only after generation finishes. Transport silence or an SSE
    // terminator alone is insufficient because the app can navigate or
    // re-render while a stale answer prefix remains in the DOM.
    if (String(signals.siteId || "").toLowerCase() === "chatgpt") {
      return signals.actionBarVisible === true;
    }

    return signals.actionBarVisible === true || signals.sseDone === true;
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

  // A relay that predates per-attempt stop routing answers /poll_stop with
  // a bare {stop} — missing or zero seq/attempt are wildcards so the click
  // still reaches the active attempt instead of being silently dropped.
  function stopSignalMatchesActiveAttempt(stopData, { seq, attempt } = {}) {
    const stopSeq = Number(stopData?.seq) || 0;
    const stopAttempt = Number(stopData?.attempt) || 0;
    return (
      (stopSeq === 0 || stopSeq === Number(seq)) &&
      (stopAttempt === 0 || stopAttempt === Number(attempt))
    );
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

  function classifyRelayAttemptState(state, { seq, attempt } = {}) {
    const expectedSeq = Math.max(0, Math.floor(Number(seq) || 0));
    const expectedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
    const currentSeq = Math.max(
      0,
      Math.floor(Number(state?.current_seq) || 0),
    );
    const currentAttempt = Math.max(
      0,
      Math.floor(Number(state?.current_attempt) || 0),
    );
    const matchingResponse = Array.isArray(state?.responses)
      ? state.responses.find((response) => {
          if (Number(response?.seq) !== expectedSeq) return false;
          const responseAttempt = Math.max(
            0,
            Math.floor(Number(response?.attempt) || 0),
          );
          return (
            expectedAttempt === 0 ||
            responseAttempt === 0 ||
            responseAttempt === expectedAttempt
          );
        }) || null
      : null;

    if (matchingResponse) {
      return {
        active: false,
        reason: "terminal_response",
        error:
          typeof matchingResponse.error === "string"
            ? matchingResponse.error
            : null,
        completionReason: matchingResponse.completion_reason || null,
      };
    }
    if (currentSeq !== expectedSeq) {
      return {
        active: false,
        reason: "seq_mismatch",
        error: null,
        completionReason: null,
      };
    }
    if (
      expectedAttempt > 0 &&
      currentAttempt > 0 &&
      currentAttempt !== expectedAttempt
    ) {
      return {
        active: false,
        reason: "attempt_mismatch",
        error: null,
        completionReason: null,
      };
    }
    if (state?.status === "running") {
      return {
        active: true,
        reason: null,
        error: null,
        completionReason: null,
      };
    }
    return {
      active: false,
      reason: `relay_${String(state?.status || "unknown")}`,
      error: null,
      completionReason: state?.completion_reason || null,
    };
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
    attachmentEvidenceHasFailure,
    attachmentEvidenceIsReady,
    attachmentCardIsSettled,
    attemptToken,
    canReuseReadyTranscriptForScrape,
    buildExtensionStatusReport,
    classifyChatReadinessBlocker,
    hasUsableChatReadinessSignals,
    classifyChatReadinessTimeout,
    classifyRelayAttemptState,
    classifyContentScriptMessageError,
    classifySubmittedPdfContract,
    canUseDeepSeekQuiescentCompletion,
    completionTimingForSignals,
    composerTextMatchesPrompt,
    composerBridgeAllowsSynchronousFallback,
    composerBridgeWriteTransition,
    composerPromptVerificationPolicy,
    contentScriptMeetsDeliveryContractRequirement,
    conversationMessagesAfterBaseline,
    contentScriptMessageRetryDelayMs,
    conversationUrlsMatch,
    createTurnCompletionTracker,
    hasMeaningfulAssistantText,
    hasNewExpectedAttachmentEvidence,
    hasPendingPdfEvidence,
    hasDeliverySignal,
    hasStrongTransportCompletionSignal,
    hasVerifiedTerminalEvidence,
    isPlaceholderAssistantText,
    isRecoverableContentScriptMessageError,
    isRetrySafeContentScriptMessage,
    normalizeComposerText,
    normalizeConversationUrl,
    postPhaseAndWaitForAck,
    retryRecoverableContentScriptMessage,
    stopDisconnectedProviderAttempt,
    stopSignalMatchesActiveAttempt,
    stopSubmittedProviderAttempt,
    supportsDeliveryContract,
    unsupportedDeliveryContractMessage,
    WEBCHAT_PLUGIN_OUTDATED_MESSAGE,
    tabNeedsActivation,
    tabNeedsLifecycleReload,
    terminalAnswerSnapshotIsStable,
    waitForNewExpectedAttachmentEvidence,
    confirmAttachmentAcceptedThenReady,
  };
});
