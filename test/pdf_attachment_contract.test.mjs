import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");

const filename =
  "Panzeri et al. - 2022 - The structures and functions of correlations.pdf";

test("matches exact PDF filename evidence with site status text", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      `${filename}\nParsing...`,
      filename,
    ),
    true,
  );
});

test("does not treat a parsing preview as ready to submit", () => {
  assert.equal(
    shared.attachmentEvidenceIsReady(`${filename}\nParsing...`, filename),
    false,
  );
  assert.equal(
    shared.attachmentEvidenceIsReady(`${filename}\nReady`, filename),
    true,
  );
});

test("treats a parsing preview as accepted but not ready", () => {
  const parsingEvidence = [`${filename}\nParsing...`];

  assert.equal(
    shared.hasNewExpectedAttachmentEvidence({
      baselineEvidence: [],
      currentEvidence: parsingEvidence,
      expectedFilename: filename,
      requireReady: false,
    }),
    true,
  );
  assert.equal(
    shared.hasNewExpectedAttachmentEvidence({
      baselineEvidence: [],
      currentEvidence: parsingEvidence,
      expectedFilename: filename,
      requireReady: true,
    }),
    false,
  );
});

test("accepts ChatGPT's filename plus PDF card when a file control is present", () => {
  assert.equal(
    shared.attachmentEvidenceHasFileCardSignal(
      `${filename}\nPDF\nRemove file 1: ${filename}`,
      true,
    ),
    true,
  );
});

test("does not mistake prompt prose mentioning a PDF for a file card", () => {
  assert.equal(
    shared.attachmentEvidenceHasFileCardSignal(
      `Please discuss ${filename} as a PDF`,
      false,
    ),
    false,
  );
});

test("detects a generic PDF composer card without exposing its filename", () => {
  assert.equal(shared.hasPendingPdfEvidence(["PDF 1.95MB"]), true);
  assert.equal(
    shared.hasPendingPdfEvidence(["Remove file PDF"], true),
    true,
  );
  assert.equal(
    shared.hasPendingPdfEvidence(["Please compare the PDF methods"], false),
    false,
  );
});

test("does not accept unrelated or partial filename evidence", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename("Other paper.pdf", filename),
    false,
  );
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "The structures and functions of correlations.pdf",
      filename,
    ),
    false,
  );
});

test("does not read failure words from an elided filename as upload status", () => {
  const statusWordFilename =
    "Error correction methods for reliable scientific inference and robust systems.pdf";
  const readyEvidence = "Error correction methods… PDF 1.95MB";

  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      readyEvidence,
      statusWordFilename,
    ),
    true,
  );
  assert.equal(
    shared.attachmentEvidenceHasFailure(
      readyEvidence,
      statusWordFilename,
    ),
    false,
  );
  assert.equal(
    shared.attachmentEvidenceIsReady(readyEvidence, statusWordFilename),
    true,
  );
  assert.equal(
    shared.attachmentEvidenceHasFailure(
      "Error correction methods… Upload failed",
      statusWordFilename,
    ),
    true,
  );
});

test("accepts a card whose long filename the site elided", () => {
  const longFilename =
    "Dailis 等 - Aerie A Modern Multi-Mission Planning, Scheduling, " +
    "and Sequencing System.pdf";

  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "Dailis 等 - Aerie A Modern Multi-…\nPDF",
      longFilename,
    ),
    true,
  );
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "Dailis 等 - Aerie A Modern Multi-...\nPDF",
      longFilename,
    ),
    true,
  );
});

test("accepts a card whose filename the site elided in the middle", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      `Panzeri et al. - 2022 - The str…correlations.pdf\nPDF 1.95MB`,
      filename,
    ),
    true,
  );
});

test("does not accept an elided filename from a different file", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "Dailis et al. - 2019 - A completely different paper…\nPDF",
      filename,
    ),
    false,
  );
});

test("does not accept an elision after too little of the filename", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename("Panzeri…\nPDF", filename),
    false,
  );
});

test("does not treat an elided filename as ready while it is parsing", () => {
  assert.equal(
    shared.attachmentEvidenceIsReady(
      `Panzeri et al. - 2022 - The str…\nParsing...`,
      filename,
    ),
    false,
  );
});

test("does not mistake status words inside an exact filename for upload state", () => {
  for (const statusFilename of [
    "Error correction methods.pdf",
    "Unsupported claims in prior work.pdf",
    "Parsing algorithms for documents.pdf",
    "File too large effects in microscopy.pdf",
  ]) {
    assert.equal(
      shared.attachmentEvidenceHasFailure(statusFilename, statusFilename),
      false,
      statusFilename,
    );
    assert.equal(
      shared.attachmentEvidenceIsReady(
        `${statusFilename}\nPDF 1.95MB`,
        statusFilename,
      ),
      true,
      statusFilename,
    );
  }
  const failureFilename = "Error correction methods.pdf";
  assert.equal(
    shared.attachmentEvidenceHasFailure(
      `${failureFilename}\nUpload failed`,
      failureFilename,
    ),
    true,
  );
});

test("accepts ChatGPT's numeric duplicate suffix on a submitted PDF", () => {
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "Panzeri et al. - correlations(3).pdf\nPDF",
      "Panzeri et al. - correlations.pdf",
    ),
    true,
  );
  assert.equal(
    shared.attachmentEvidenceMatchesFilename(
      "Panzeri et al. - correlations revised.pdf",
      "Panzeri et al. - correlations.pdf",
    ),
    false,
  );
});

test("detects a pending PDF without treating the generic upload button as a file", () => {
  assert.equal(
    shared.hasPendingPdfEvidence([
      `${filename}\nPDF 1.95MB`,
    ]),
    true,
  );
  assert.equal(
    shared.hasPendingPdfEvidence(["Upload file", "Attach documents"]),
    false,
  );
});

test("verifies the submitted user turn contains the expected PDF filename", () => {
  assert.equal(
    shared.attachmentListContainsExpectedFilename(
      ["Other paper.pdf", `${filename}\nPDF 1.95MB`],
      filename,
    ),
    true,
  );
  assert.equal(
    shared.attachmentListContainsExpectedFilename(
      ["Other paper.pdf"],
      filename,
    ),
    false,
  );
});

test("finds new turns by stable message key when transcript counts shift", () => {
  const oldUser = {
    messageKey: "user-old",
    role: "user",
    text: "Earlier prompt",
  };
  const oldAssistant = {
    messageKey: "assistant-old",
    role: "assistant",
    text: "Earlier answer",
  };
  const newUser = {
    messageKey: "user-new",
    role: "user",
    text: "Repeated full-text probe",
    attachments: [filename],
  };

  assert.deepEqual(
    shared.conversationMessagesAfterBaseline(
      [oldUser, newUser],
      [oldUser, oldAssistant],
      2,
    ),
    [newUser],
  );
});

test("requires new expected evidence instead of accepting a stale attachment", () => {
  const baseline = [`${filename}\nUploaded`];

  assert.equal(
    shared.hasNewExpectedAttachmentEvidence({
      baselineEvidence: baseline,
      currentEvidence: baseline,
      expectedFilename: filename,
    }),
    false,
  );
  assert.equal(
    shared.hasNewExpectedAttachmentEvidence({
      baselineEvidence: baseline,
      currentEvidence: [...baseline, `${filename}\nReady`],
      expectedFilename: filename,
    }),
    true,
  );
});

test("counts a second identical same-PDF card as new evidence", () => {
  const card = `${filename}\nPDF 1.95MB`;

  assert.equal(
    shared.hasNewExpectedAttachmentEvidence({
      baselineEvidence: [card],
      currentEvidence: [card, card],
      expectedFilename: filename,
    }),
    true,
  );
});

test("waits only until new expected evidence appears", async () => {
  let reads = 0;
  let waits = 0;
  const result = await shared.waitForNewExpectedAttachmentEvidence({
    baselineEvidence: [],
    expectedFilename: filename,
    readEvidence: () => {
      reads += 1;
      return reads < 3 ? [] : [`${filename}\nReady`];
    },
    wait: async () => {
      waits += 1;
    },
    timeoutMs: 1000,
    pollIntervalMs: 100,
  });

  assert.equal(result.evidence, `${filename}\nReady`);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

function confirmWithFakeClock(state, options = {}) {
  let nowMs = 0;
  return shared.confirmAttachmentAcceptedThenReady({
    baselineEvidence: [],
    expectedFilename: filename,
    readState: typeof state === "function" ? state : () => state,
    wait: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    acceptTimeoutMs: 1000,
    readyTimeoutMs: 1000,
    pollIntervalMs: 100,
    ...options,
  });
}

test("confirms an attachment the website marks ready", async () => {
  const card = `${filename}\nReady`;
  const result = await confirmWithFakeClock({
    evidence: [card],
    newCards: [card],
  });

  assert.equal(result.readyConfirmed, true);
  assert.equal(result.filenameConfirmed, true);
  assert.equal(result.evidence, card);
});

test("fails closed when an accepted attachment never reports ready", async () => {
  const card = `${filename}\nParsing...`;
  await assert.rejects(
    confirmWithFakeClock({
      evidence: [card],
      newCards: [card],
    }),
    /did not confirm that .* was ready/,
  );
});

test("rejects a new card when the requested filename cannot be identified", async () => {
  const card = "Aerie — mission planning\nPDF";
  await assert.rejects(
    confirmWithFakeClock({ evidence: [], newCards: [card] }),
    /did not confirm attachment/,
  );
});

test("does not accept an unreadable card after it stops uploading", async () => {
  let reads = 0;
  await assert.rejects(
    confirmWithFakeClock(() => {
      reads += 1;
      return {
        evidence: [],
        newCards: [
          reads < 3
            ? "Aerie — mission planning\nUploading…"
            : "Aerie — mission planning\nPDF",
        ],
      };
    }),
    /did not confirm attachment/,
  );
});

test("requires ready evidence to remain stable for the quiet window", async () => {
  let nowMs = 0;
  let reads = 0;
  const card = `${filename}\nReady`;
  const result = await shared.confirmAttachmentAcceptedThenReady({
    baselineEvidence: [],
    expectedFilename: filename,
    readState: () => {
      reads += 1;
      if (reads === 3) {
        return { evidence: [`${filename}\nUploading…`], newCards: [] };
      }
      return { evidence: [card], newCards: [] };
    },
    wait: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    acceptTimeoutMs: 1000,
    readyTimeoutMs: 2000,
    readyQuietWindowMs: 300,
    pollIntervalMs: 100,
  });

  assert.equal(result.readyConfirmed, true);
  assert.ok(reads >= 6);
  assert.ok(result.elapsedMs >= 400);
});

test("fails immediately when the website reports an upload error", async () => {
  await assert.rejects(
    confirmWithFakeClock({
      evidence: [`${filename}\nUpload failed`],
      newCards: [],
    }),
    /reported that .* failed to upload/,
  );
});

test("fails when no new file card appears at all", async () => {
  await assert.rejects(
    confirmWithFakeClock(
      { evidence: [], newCards: [] },
      { acceptTimeoutMs: 250, readyTimeoutMs: 250 },
    ),
    /did not confirm attachment/,
  );
});

test("does not mistake a pre-existing file card for the new attachment", async () => {
  // The caller diffs against the nodes present before the drop, so a card that
  // was already on screen never reaches newCards.
  await assert.rejects(
    confirmWithFakeClock(
      { evidence: [], newCards: [] },
      { acceptTimeoutMs: 250, readyTimeoutMs: 250 },
    ),
    /did not confirm attachment/,
  );
});

test("treats a byte-sized file card as a real attachment card", () => {
  assert.equal(
    shared.attachmentEvidenceHasFileCardSignal(`${filename}\nPDF 607B`, false),
    true,
  );
});

test("verifies the exact submitted PDF contract", () => {
  assert.deepEqual(
    shared.classifySubmittedPdfContract(
      ["image", `${filename}\nPDF 1.95MB`],
      filename,
    ),
    {
      attachmentRequested: true,
      attachmentCount: 2,
      pdfAttachmentCount: 1,
      filenameMatched: true,
      contractVerified: true,
    },
  );
});

test("rejects an unrelated submitted PDF even though a file is present", () => {
  assert.deepEqual(
    shared.classifySubmittedPdfContract(["Other paper.pdf"], filename),
    {
      attachmentRequested: true,
      attachmentCount: 1,
      pdfAttachmentCount: 1,
      filenameMatched: false,
      contractVerified: false,
    },
  );
});

test("rejects an extra PDF beside the exact requested PDF", () => {
  const contract = shared.classifySubmittedPdfContract(
    [`${filename}\nPDF 1.95MB`, "Other paper.pdf\nPDF 2MB"],
    filename,
  );

  assert.equal(contract.filenameMatched, true);
  assert.equal(contract.pdfAttachmentCount, 2);
  assert.equal(contract.contractVerified, false);
});

test("rejects duplicate cards for the requested PDF", () => {
  const contract = shared.classifySubmittedPdfContract(
    [`${filename}\nPDF 1.95MB`, `${filename}\nPDF 1.95MB`],
    filename,
  );

  assert.equal(contract.pdfAttachmentCount, 2);
  assert.equal(contract.contractVerified, false);
});

test("verifies prompt-only turns only when no PDF is present", () => {
  assert.equal(
    shared.classifySubmittedPdfContract(["image"], "").contractVerified,
    true,
  );
  assert.equal(
    shared.classifySubmittedPdfContract(["Unexpected.pdf"], "")
      .contractVerified,
    false,
  );
  assert.equal(
    shared.classifySubmittedPdfContract(["PDF 1.95MB"], "")
      .contractVerified,
    false,
  );
  assert.equal(
    shared.classifySubmittedPdfContract(["Unidentified document 1.95MB"], "")
      .contractVerified,
    false,
  );
  assert.equal(
    shared.classifySubmittedPdfContract(["image"], "").contractVerified,
    true,
  );
});

test("preflights a clean composer for both PDF and prompt-only sends", () => {
  const contentScript = readFileSync(
    new URL("../extension/content_script.js", import.meta.url),
    "utf8",
  );
  assert.match(
    contentScript,
    /const pendingPdfEvidence = collectVisibleComposerPdfCardEvidence\(\);\s*if \(pendingPdfEvidence\.length > 0\)/,
  );
  assert.match(
    contentScript,
    /This preflight must remain inside the composer ancestry/,
  );
  assert.doesNotMatch(
    contentScript,
    /if \(!msg\.pdfBase64\) \{\s*const pendingPdfEvidence/,
  );
});

test("advertises the strict delivery contract from the active content script", () => {
  const contentScript = readFileSync(
    new URL("../extension/content_script.js", import.meta.url),
    "utf8",
  );
  const background = readFileSync(
    new URL("../extension/background.js", import.meta.url),
    "utf8",
  );
  assert.match(
    contentScript,
    /supportedDeliveryContracts:\s*\[\.\.\.SUPPORTED_DELIVERY_CONTRACTS\]/,
  );
  assert.equal(shared.supportsDeliveryContract([1], 1), true);
  assert.equal(shared.supportsDeliveryContract([], 1), false);
  assert.equal(shared.supportsDeliveryContract([0], 1), false);
  assert.equal(
    shared.contentScriptMeetsDeliveryContractRequirement(
      { pong: true, supportedDeliveryContracts: [1] },
      undefined,
    ),
    true,
  );
  assert.equal(
    shared.contentScriptMeetsDeliveryContractRequirement(
      { pong: true, supportedDeliveryContracts: [] },
      1,
    ),
    false,
  );
  assert.equal(
    shared.contentScriptMeetsDeliveryContractRequirement(
      { pong: true, supportedDeliveryContracts: [1] },
      1,
    ),
    true,
  );
  assert.match(
    background,
    /supportedDeliveryContracts:\s*Array\.isArray/,
  );
  assert.match(
    background,
    /deliveryContractVersion:\s*query\.delivery_contract_version/,
  );
  assert.match(
    background,
    /error\.diagnostic = response\?\.diagnostic \|\| null/,
  );
  const startHandler = contentScript.slice(
    contentScript.indexOf('if (msg.type !== "START") return;'),
    contentScript.indexOf(
      "const baselineTranscript",
      contentScript.indexOf('if (msg.type !== "START") return;'),
    ),
  );
  assert.match(startHandler, /supportsDeliveryContract/);

  // Version-mismatch failures must tell the user which side to update.
  assert.match(
    shared.WEBCHAT_PLUGIN_OUTDATED_MESSAGE,
    /Update the LLM for Zotero plugin/,
  );
  assert.doesNotMatch(shared.WEBCHAT_PLUGIN_OUTDATED_MESSAGE, /Failed to fetch/);
  assert.match(
    shared.unsupportedDeliveryContractMessage(2, [1]),
    /WebChat delivery contract 2/,
  );
  assert.match(
    shared.unsupportedDeliveryContractMessage(2, [1]),
    /only supports version 1/,
  );
  assert.match(
    shared.unsupportedDeliveryContractMessage(2, [1]),
    /Update the Sync for Zotero browser extension/,
  );

  // The background decides contract compatibility once, before any tab
  // work, so the first delivery_contract_version reference in runPipeline
  // must precede the content-script setup call.
  const runPipelineBody = background.slice(
    background.indexOf("async function runPipeline("),
    background.indexOf("async function streamPipeline("),
  );
  const contractGateIndex = runPipelineBody.indexOf("delivery_contract_version");
  assert.notEqual(contractGateIndex, -1);
  assert.ok(
    contractGateIndex < runPipelineBody.indexOf("ensureContentScript("),
    "delivery-contract gate must run before content-script setup",
  );
  assert.match(runPipelineBody, /WEBCHAT_PLUGIN_OUTDATED_MESSAGE/);
  assert.match(runPipelineBody, /unsupportedDeliveryContractMessage\(/);

  // The content-script gate stays as defense in depth with the same
  // actionable messages.
  assert.match(startHandler, /WEBCHAT_PLUGIN_OUTDATED_MESSAGE/);
  assert.match(startHandler, /unsupportedDeliveryContractMessage\(/);

  // The content-script fallback shim must agree with the canonical guard.
  const fallbackGuard = contentScript.slice(
    contentScript.indexOf("supportsDeliveryContract: (supportedVersions"),
    contentScript.indexOf("canUseDeepSeekQuiescentCompletion:"),
  );
  assert.match(fallbackGuard, /Number\.isInteger/);
});

test("keeps a synchronous contract probe authoritative when rich health fails", () => {
  const report = shared.buildExtensionStatusReport({
    chatTabAlive: true,
    chatUrl: "https://chatgpt.com/c/example",
    targetSiteId: "chatgpt",
    capabilityProbe: {
      pong: true,
      supportedDeliveryContracts: [1],
    },
    health: {
      contentScriptAlive: true,
      supportedDeliveryContracts: [],
      lastDiagnostic: {
        reasonCode: "health_check_failed",
      },
    },
  });

  assert.equal(report.chatTabAlive, true);
  assert.equal(report.contentScriptAlive, true);
  assert.deepEqual(report.supportedDeliveryContracts, [1]);
  assert.equal(report.lastDiagnostic.reasonCode, "health_check_failed");
});

test("classifies visible pre-submit chat blockers without false positives", () => {
  const rateLimited = shared.classifyChatReadinessBlocker({
    siteId: "chatgpt",
    composerReady: false,
    visibleText:
      "Too many requests. You are making requests too quickly. We have temporarily limited access.",
  });
  assert.equal(rateLimited.reasonCode, "site_rate_limited");
  assert.match(rateLimited.message, /no prompt or PDF was sent/i);

  const mountedComposerBlocker = shared.classifyChatReadinessBlocker({
    siteId: "chatgpt",
    composerReady: true,
    visibleText:
      "Too many requests. You are making requests too quickly. We have temporarily limited access.",
  });
  assert.equal(mountedComposerBlocker.reasonCode, "site_rate_limited");

  assert.equal(shared.classifyChatReadinessBlocker({
    siteId: "chatgpt",
    visibleText: "Uploading papers can sometimes be rate limited.",
  }), null);

  assert.equal(
    shared.classifyChatReadinessBlocker({
      composerReady: false,
      visibleText: "Log in Sign up",
    }).reasonCode,
    "authentication_required",
  );
});

test("requires a usable composer before declaring a chat ready", () => {
  assert.equal(shared.hasUsableChatReadinessSignals({
    urlMatches: true,
    composerReady: false,
    activeRun: false,
    domSettled: true,
    bodyReady: true,
    mainReady: true,
  }), false);

  assert.equal(shared.hasUsableChatReadinessSignals({
    urlMatches: true,
    composerReady: true,
    activeRun: false,
    domSettled: true,
    bodyReady: true,
    mainReady: true,
  }), true);
});

test("reports the exact readiness condition that prevented submission", () => {
  assert.equal(
    shared.classifyChatReadinessTimeout({
      urlMatches: false,
      composerReady: false,
    }).reasonCode,
    "conversation_url_mismatch",
  );
  assert.equal(
    shared.classifyChatReadinessTimeout({
      urlMatches: true,
      composerReady: false,
    }).reasonCode,
    "composer_not_ready",
  );
  assert.equal(
    shared.classifyChatReadinessTimeout({
      urlMatches: true,
      composerReady: true,
      activeRun: true,
    }).reasonCode,
    "prior_turn_still_running",
  );
});

test("fails closed when the website never exposes expected PDF evidence", async () => {
  let nowMs = 0;

  await assert.rejects(
    shared.waitForNewExpectedAttachmentEvidence({
      baselineEvidence: [],
      expectedFilename: filename,
      readEvidence: () => [],
      wait: async (ms) => {
        nowMs += ms;
      },
      now: () => nowMs,
      timeoutMs: 250,
      pollIntervalMs: 100,
    }),
    /did not confirm/,
  );
});
