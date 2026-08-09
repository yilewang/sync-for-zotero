#!/usr/bin/env node

import crypto from "node:crypto";

const DELIVERY_CONTRACT_VERSION = 1;
const PORT_MIN = 23119;
const PORT_MAX = 23128;
const POLL_INTERVAL_MS = 500;
const TURN_TIMEOUT_MS = 6 * 60_000;
const allowedHeaders = {
  "Content-Type": "application/json",
  "Zotero-Allowed-Request": "1",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildProofPdf(text) {
  const stream = [
    "BT",
    "/F1 12 Tf",
    "50 740 Td",
    `(${escapePdfText(text)}) Tj`,
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function readJson(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Relay returned non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`,
    );
  }
  if (!response.ok || data.error) {
    throw new Error(
      data.error || data.reason || `Relay returned HTTP ${response.status}`,
    );
  }
  return data;
}

async function relayGet(baseUrl, path) {
  return readJson(
    await fetch(`${baseUrl}${path}`, {
      headers: { "Zotero-Allowed-Request": "1" },
    }),
  );
}

async function relayPost(baseUrl, path, body) {
  return readJson(
    await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: allowedHeaders,
      body: JSON.stringify(body),
    }),
  );
}

async function discoverRelay() {
  const explicit = process.env.SYNC_ZOTERO_RELAY_URL?.trim();
  if (explicit) {
    await relayGet(explicit.replace(/\/+$/, ""), "/debug");
    return explicit.replace(/\/+$/, "");
  }
  for (const hostname of ["127.0.0.1", "localhost"]) {
    for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
      const candidate =
        `http://${hostname}:${port}/llm-for-zotero/webchat`;
      try {
        const status = await relayGet(candidate, "/debug");
        if (typeof status.status === "string") return candidate;
      } catch {
        // Try the next Zotero HTTP port.
      }
    }
  }
  throw new Error(
    "Could not find the Zotero WebChat relay on ports 23119-23128.",
  );
}

function normalizeExactAnswer(text) {
  return String(text || "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/[.!]$/, "");
}

async function waitForTurn(baseUrl, seq, title) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const state = await relayGet(baseUrl, "/poll_response?since=0");
    const progress = [
      state.status,
      state.turn_status || "",
      state.diagnostic?.phase || "",
      state.diagnostic?.reasonCode || "",
    ].join("|");
    if (progress !== lastProgress) {
      lastProgress = progress;
      console.log(`[${title}] ${progress}`);
    }
    const terminal = (state.responses || []).find(
      (response) => response.seq === seq,
    );
    if (terminal) {
      if (terminal.error) throw new Error(terminal.error);
      return terminal;
    }
    if (state.status === "error" && state.current_seq === seq) {
      throw new Error(
        state.diagnostic?.message || "WebChat relay entered an error state.",
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${title} timed out after ${TURN_TIMEOUT_MS / 1000}s.`);
}

function assertCommonReceipt(diagnostic, title) {
  const required = [
    "composerTextMatched",
    "userTurnMatched",
    "assistantTurnMatched",
    "attachmentContractVerified",
  ];
  for (const field of required) {
    if (diagnostic?.[field] !== true) {
      throw new Error(`${title} receipt did not verify ${field}.`);
    }
  }
}

function assertPdfReceipt(diagnostic, filename) {
  assertCommonReceipt(diagnostic, "PDF turn");
  const required = [
    "uploadDetected",
    "attachmentPreviewVerified",
    "attachmentRequested",
    "attachmentFilenameConfirmed",
    "attachmentReadyVerified",
    "submittedAttachmentVerified",
  ];
  for (const field of required) {
    if (diagnostic?.[field] !== true) {
      throw new Error(`PDF turn receipt did not verify ${field}.`);
    }
  }
  if (diagnostic.attachmentFilename !== filename) {
    throw new Error("PDF turn receipt identified the wrong filename.");
  }
  if (Number(diagnostic.submittedPdfCount) !== 1) {
    throw new Error(
      "PDF turn receipt did not prove exactly one PDF on the submitted user turn.",
    );
  }
}

function assertPromptOnlyReceipt(diagnostic) {
  assertCommonReceipt(diagnostic, "Prompt-only turn");
  if (diagnostic?.attachmentRequested !== false) {
    throw new Error("Prompt-only receipt did not preserve prompt-only mode.");
  }
  if (diagnostic.submittedPdfCount !== 0) {
    throw new Error("Prompt-only receipt found an unexpected submitted PDF.");
  }
}

async function submitTurn(baseUrl, payload) {
  const state = await relayGet(baseUrl, "/poll_response?since=0");
  if (state.status === "pending" || state.status === "running") {
    throw new Error(`WebChat pipeline is already ${state.status}.`);
  }
  return relayPost(baseUrl, "/submit_query", {
    ...payload,
    delivery_contract_version: DELIVERY_CONTRACT_VERSION,
    target: "chatgpt",
  });
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const supportedFlags = new Set(["--pdf-only", "--prompt-only"]);
  const unknownFlag = [...flags].find((flag) => !supportedFlags.has(flag));
  if (unknownFlag) {
    throw new Error(`Unknown live-gate option: ${unknownFlag}`);
  }
  if (flags.has("--pdf-only") && flags.has("--prompt-only")) {
    throw new Error("Choose at most one live-gate scenario filter.");
  }
  const runPdfScenario = !flags.has("--prompt-only");
  const runPromptOnlyScenario = !flags.has("--pdf-only");
  const baseUrl = await discoverRelay();
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const documentSentinel = `ZPDF_${runId.toUpperCase()}`;
  const promptOnlyMarker = `ZPROMPT_${runId.toUpperCase()}`;
  const filename = `sync-zotero-live-proof-${runId}.pdf`;
  const pdfBytes = buildProofPdf(`DOCUMENT_SENTINEL: ${documentSentinel}`);

  console.log(`Relay: ${baseUrl}`);
  if (runPdfScenario) {
    console.log("PDF scenario: bytes, prompt, submission, and response");
    const pdfSubmit = await submitTurn(baseUrl, {
      prompt:
        "Read the attached PDF. Return only the value printed after DOCUMENT_SENTINEL:. Do not add punctuation or formatting.",
      pdf_base64: pdfBytes.toString("base64"),
      pdf_filename: filename,
      force_new_chat: true,
    });
    const pdfTurn = await waitForTurn(baseUrl, pdfSubmit.seq, "PDF turn");
    assertPdfReceipt(pdfTurn.diagnostic, filename);
    if (normalizeExactAnswer(pdfTurn.text) !== documentSentinel) {
      throw new Error(
        `PDF byte proof failed: expected ${documentSentinel}, received ${JSON.stringify(pdfTurn.text || "")}.`,
      );
    }
    console.log(
      "PASS: ChatGPT returned the hidden PDF sentinel with an exact receipt.",
    );
  }

  if (runPromptOnlyScenario) {
    console.log("Prompt-only scenario: submission with zero PDFs");
    const promptOnlySubmit = await submitTurn(baseUrl, {
      prompt:
        `Return exactly ${promptOnlyMarker}. Do not use any earlier document.`,
      pdf_base64: null,
      pdf_filename: null,
      force_new_chat: !runPdfScenario,
    });
    const promptOnlyTurn = await waitForTurn(
      baseUrl,
      promptOnlySubmit.seq,
      "Prompt-only turn",
    );
    assertPromptOnlyReceipt(promptOnlyTurn.diagnostic);
    if (normalizeExactAnswer(promptOnlyTurn.text) !== promptOnlyMarker) {
      throw new Error(
        `Prompt-only response proof failed: expected ${promptOnlyMarker}, received ${JSON.stringify(promptOnlyTurn.text || "")}.`,
      );
    }
    console.log(
      "PASS: prompt-only mode returned the marker with zero submitted PDFs.",
    );
  }
  console.log(
    "PASS: relay-level Zotero relay → Chrome extension → ChatGPT gate completed.",
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
