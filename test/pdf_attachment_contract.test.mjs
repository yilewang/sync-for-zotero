import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

test("confirms an attachment the website marks ready", async () => {
  const result = await shared.confirmAttachmentAcceptedThenReady({
    baselineEvidence: [],
    expectedFilename: filename,
    readEvidence: () => [`${filename}\nReady`],
    wait: async () => {},
    acceptTimeoutMs: 1000,
    readyTimeoutMs: 1000,
  });

  assert.equal(result.readyConfirmed, true);
  assert.equal(result.evidence, `${filename}\nReady`);
});

test("keeps an accepted attachment that never reports ready", async () => {
  let nowMs = 0;
  const result = await shared.confirmAttachmentAcceptedThenReady({
    baselineEvidence: [],
    expectedFilename: filename,
    readEvidence: () => [`${filename}\nParsing...`],
    wait: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    acceptTimeoutMs: 1000,
    readyTimeoutMs: 1000,
    pollIntervalMs: 100,
  });

  assert.equal(result.readyConfirmed, false);
  assert.equal(result.evidence, `${filename}\nParsing...`);
});

test("fails when the website never accepts the attachment at all", async () => {
  let nowMs = 0;

  await assert.rejects(
    shared.confirmAttachmentAcceptedThenReady({
      baselineEvidence: [],
      expectedFilename: filename,
      readEvidence: () => [],
      wait: async (ms) => {
        nowMs += ms;
      },
      now: () => nowMs,
      acceptTimeoutMs: 250,
      readyTimeoutMs: 250,
      pollIntervalMs: 100,
    }),
    /did not confirm attachment/,
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
