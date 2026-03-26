import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInspectPdfTool } from "../src/agent/tools/read/inspectPdf";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

describe("inspect_pdf tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      attachments: [
        {
          id: "att-1",
          name: "notes.txt",
          mimeType: "text/plain",
          category: "text",
          textContent: "Attached notes",
          storedPath: "/tmp/notes.txt",
        },
      ],
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("retrieves evidence across multiple paper contexts", async function () {
    const tool = createInspectPdfTool(
      {
        getFrontMatterExcerpt: async () => {
          throw new Error("not used");
        },
        getChunkExcerpt: async () => {
          throw new Error("not used");
        },
      } as never,
      {
        searchPages: async () => {
          throw new Error("not used");
        },
      } as never,
      {
        retrieveEvidence: async ({ papers }: { papers: Array<{ itemId: number }> }) =>
          papers.map((paper, index) => ({
            paperContext: {
              itemId: paper.itemId,
              contextItemId: paper.itemId * 100,
              title: `Paper ${paper.itemId}`,
            },
            chunkIndex: index,
            text: `Evidence ${paper.itemId}`,
            score: 0.9 - index * 0.1,
            sourceLabel: `Paper ${paper.itemId}`,
          })),
      } as never,
      {
        listPaperContexts: (request: AgentToolContext["request"]) =>
          request.selectedPaperContexts || [],
      } as never,
    );

    const validated = tool.validate({
      operation: "retrieve_evidence",
      question: "What is the method?",
      targets: [
        { paperContext: { itemId: 1, contextItemId: 101, title: "Paper One" } },
        { paperContext: { itemId: 2, contextItemId: 202, title: "Paper Two" } },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { operation: string }).operation, "retrieve_evidence");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("attaches uploaded text files without requiring PDF-specific services", async function () {
    const tool = createInspectPdfTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const validated = tool.validate({
      operation: "attach_file",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const first = (result as { results: Array<Record<string, unknown>> }).results[0];
    assert.equal(first.name, "notes.txt");
    assert.equal(first.textContent, "Attached notes");
  });

  it("requires confirmation before sending an attached file to the model", async function () {
    const tool = createInspectPdfTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const validated = tool.validate({
      operation: "attach_file",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const shouldConfirm = await tool.shouldRequireConfirmation?.(
      validated.value,
      baseContext,
    );
    assert.isTrue(shouldConfirm);
    const pending = await tool.createPendingAction?.(validated.value, baseContext);
    assert.exists(pending);
    assert.equal(pending?.toolName, "inspect_pdf");
    assert.equal(pending?.confirmLabel, "Send to model");
  });

  it("builds a multimodal follow-up message for capture_active_view", async function () {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-inspect-pdf-"));
    const imagePath = join(tempDir, "capture.png");
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    try {
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = {
        read: async (path: string) => new Uint8Array(readFileSync(path)),
      };
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = (value: string) => Buffer.from(value, "binary").toString("base64");

      const tool = createInspectPdfTool(
        {} as never,
        {
          getActivePageIndex: () => 3,
          captureActiveView: async () => ({
            target: {
              source: "library" as const,
              title: "Paper One",
              contextItemId: 101,
              itemId: 1,
              paperContext: { itemId: 1, contextItemId: 101, title: "Paper One" },
            },
            capturedPage: {
              pageIndex: 3,
              pageLabel: "4",
              imagePath,
              contentHash: "hash-1",
            },
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: imagePath,
                pageIndex: 3,
                pageLabel: "4",
              },
            ],
            pageText: "Visible equation text",
          }),
        } as never,
        {} as never,
        {
          listPaperContexts: () => [],
        } as never,
      );

      const validated = tool.validate({ operation: "capture_active_view" });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const execution = (await tool.execute(validated.value, baseContext)) as {
        content: Record<string, unknown>;
        artifacts: AgentToolResult["artifacts"];
      };
      const followup = await tool.buildFollowupMessage?.(
        {
          callId: "call-1",
          name: "inspect_pdf",
          ok: true,
          content: execution.content,
          artifacts: execution.artifacts,
        },
        baseContext,
      );
      assert.exists(followup);
      assert.isArray(followup?.content);
      const parts = followup?.content as Array<{ type: string }>;
      assert.deepEqual(
        parts.map((part) => part.type),
        ["text", "image_url"],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
    }
  });

  it("uses operation-specific presentation summaries", function () {
    const tool = createInspectPdfTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const onCall = tool.presentation?.summaries?.onCall;
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.equal(
      typeof onCall === "function" ? onCall({ args: { operation: "retrieve_evidence" } as never }) : "",
      "Inspecting PDF (retrieve evidence)",
    );
    assert.equal(
      typeof onSuccess === "function"
        ? onSuccess({
            content: {
              operation: "retrieve_evidence",
              results: [{}, {}],
            },
          } as never)
        : "",
      "Retrieved 2 evidence passages",
    );
    assert.equal(
      typeof onSuccess === "function"
        ? onSuccess({
            content: {
              operation: "search_pages",
              results: [{}],
            },
          } as never)
        : "",
      "Found 1 relevant PDF page",
    );
  });
});
