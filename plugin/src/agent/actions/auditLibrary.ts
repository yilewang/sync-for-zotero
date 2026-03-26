import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import { callTool } from "./executor";
import {
  getMetadataField,
  getMetadataTitle,
} from "./metadataSnapshot";

type AuditScope = "all" | "collection";

type AuditLibraryInput = {
  scope?: AuditScope;
  collectionId?: number;
  /** If true, saves an audit report note to the library (or collection's root note). */
  saveNote?: boolean;
};

export type AuditIssue = {
  itemId: number;
  title: string;
  missingFields: string[];
};

type AuditLibraryOutput = {
  total: number;
  itemsWithIssues: number;
  issues: AuditIssue[];
  noteId?: number;
};

export const auditLibraryAction: AgentAction<AuditLibraryInput, AuditLibraryOutput> = {
  name: "audit_library",
  description:
    "Scan the Zotero library (or a specific collection) for items with incomplete metadata: " +
    "missing abstract, DOI, tags, or PDF attachment. Returns a structured report and optionally " +
    "saves it as a Zotero note.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to audit. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
      saveNote: {
        type: "boolean",
        description: "If true, saves the audit report as a Zotero note. Default: false.",
      },
    },
  },

  async execute(
    input: AuditLibraryInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AuditLibraryOutput>> {
    const STEPS = 2 + (input.saveNote ? 1 : 0);
    let step = 0;

    // Step 1: query items
    ctx.onProgress({ type: "step_start", step: "Querying library items", index: ++step, total: STEPS });
    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      include: ["metadata", "tags", "attachments"],
    };
    if (input.scope === "collection" && input.collectionId) {
      (queryArgs as { filters?: unknown }).filters = { collectionId: input.collectionId };
    }

    const queryResult = await callTool("query_library", queryArgs, ctx, "Querying library items");
    if (!queryResult.ok) {
      return { ok: false, error: `Failed to query library: ${JSON.stringify(queryResult.content)}` };
    }

    const content = queryResult.content as Record<string, unknown>;
    const items = Array.isArray(content.results) ? content.results : [];
    ctx.onProgress({
      type: "step_done",
      step: "Querying library items",
      summary: `Found ${items.length} item${items.length === 1 ? "" : "s"}`,
    });

    // Step 2: analyze metadata gaps
    ctx.onProgress({ type: "step_start", step: "Analyzing metadata", index: ++step, total: STEPS });
    const issues: AuditIssue[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const itemId = typeof record.itemId === "number" ? record.itemId : null;
      if (!itemId) continue;

      const meta = record.metadata;
      const title = getMetadataTitle(meta) || record.title || `Item ${itemId}`;
      const missingFields: string[] = [];

      if (!getMetadataField(meta, "abstractNote")) missingFields.push("abstract");
      if (!getMetadataField(meta, "DOI") && !getMetadataField(meta, "url")) {
        missingFields.push("DOI/URL");
      }

      const tags = Array.isArray(record.tags) ? record.tags : [];
      if (tags.length === 0) missingFields.push("tags");

      const attachments = Array.isArray(record.attachments) ? record.attachments : [];
      const hasPdf = attachments.some(
        (att: unknown) =>
          att &&
          typeof att === "object" &&
          (att as Record<string, unknown>).contentType === "application/pdf",
      );
      if (!hasPdf) missingFields.push("PDF");

      if (missingFields.length > 0) {
        issues.push({ itemId, title: String(title), missingFields });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Analyzing metadata",
      summary: `${issues.length} item${issues.length === 1 ? "" : "s"} with issues`,
    });

    let noteId: number | undefined;

    if (input.saveNote) {
      ctx.onProgress({ type: "step_start", step: "Saving audit note", index: ++step, total: STEPS });
      const reportLines = [
        `## Library Audit Report`,
        ``,
        `Total items scanned: ${items.length}`,
        `Items with issues: ${issues.length}`,
        ``,
        `### Issues`,
        ...issues.map((issue) =>
          `- **${issue.title}** (ID: ${issue.itemId}): missing ${issue.missingFields.join(", ")}`,
        ),
      ];

      const saveResult = await callTool(
        "edit_current_note",
        {
          mode: "create",
          content: reportLines.join("\n"),
          target: "standalone",
        },
        ctx,
        "Saving audit report",
      );

      if (saveResult.ok) {
        const saveContent = saveResult.content as Record<string, unknown>;
        const resultObj = saveContent.result as Record<string, unknown> | undefined;
        noteId = typeof resultObj?.noteId === "number" ? resultObj.noteId : undefined;
      }
      ctx.onProgress({ type: "step_done", step: "Saving audit note" });
    }

    return {
      ok: true,
      output: {
        total: items.length,
        itemsWithIssues: issues.length,
        issues,
        noteId,
      },
    };
  },
};
