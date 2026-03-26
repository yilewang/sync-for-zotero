import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import { callTool } from "./executor";

type AutoTagInput = {
  scope?: "all" | "collection";
  collectionId?: number;
  limit?: number;
};

type AutoTagOutput = {
  untagged: number;
  tagged: number;
  skipped: number;
};

/**
 * Finds all papers without tags and opens a batch tag-assignment HITL card,
 * letting the user assign tags to each paper before applying.
 *
 * Note: Tag suggestions are not AI-generated in this version — the user fills
 * in tags manually in the HITL tag-assignment table.
 */
export const autoTagAction: AgentAction<AutoTagInput, AutoTagOutput> = {
  name: "auto_tag",
  description:
    "Find all Zotero papers without any tags and open a batch tag-assignment dialog. " +
    "The user reviews each paper and assigns tags before they are applied to the library.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to check. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
      limit: {
        type: "number",
        description: "Max number of untagged items to process per run.",
      },
    },
  },

  async execute(
    input: AutoTagInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AutoTagOutput>> {
    const STEPS = 2;
    let step = 0;

    // Step 1: find untagged items
    ctx.onProgress({
      type: "step_start",
      step: "Finding untagged items",
      index: ++step,
      total: STEPS,
    });

    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      filters: { untagged: true },
      include: ["metadata"],
    };
    if (input.scope === "collection" && input.collectionId) {
      queryArgs.filters = { untagged: true, collectionId: input.collectionId };
    }
    if (input.limit) queryArgs.limit = input.limit;

    const queryResult = await callTool("query_library", queryArgs, ctx, "Finding untagged items");
    if (!queryResult.ok) {
      return {
        ok: false,
        error: `Failed to query library: ${JSON.stringify(queryResult.content)}`,
      };
    }

    const queryContent = queryResult.content as Record<string, unknown>;
    const untaggedItems = Array.isArray(queryContent.results) ? queryContent.results : [];

    ctx.onProgress({
      type: "step_done",
      step: "Finding untagged items",
      summary: `${untaggedItems.length} untagged item${untaggedItems.length === 1 ? "" : "s"}`,
    });

    if (!untaggedItems.length) {
      return { ok: true, output: { untagged: 0, tagged: 0, skipped: 0 } };
    }

    // Step 2: apply tags via apply_tags (HITL tag_assignment_table)
    ctx.onProgress({
      type: "step_start",
      step: "Assigning tags to items",
      index: ++step,
      total: STEPS,
    });

    const itemIds = untaggedItems
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        return typeof record.itemId === "number" ? record.itemId : null;
      })
      .filter((id): id is number => id !== null);

    const mutateResult = await callTool(
      "apply_tags",
      {
        action: "add",
        // No tags pre-specified — the HITL tag_assignment_table collects them per item
        assignments: itemIds.map((itemId) => ({ itemId, tags: [] })),
      },
      ctx,
      "Assigning tags",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const resultObj = mutateContent.result as Record<string, unknown> | undefined;
    const taggedCount = mutateResult.ok && resultObj
      ? Number(resultObj.updatedCount || 0)
      : 0;

    ctx.onProgress({
      type: "step_done",
      step: "Assigning tags to items",
      summary: mutateResult.ok
        ? `Tagged ${taggedCount} item${taggedCount === 1 ? "" : "s"}`
        : "Tag assignment was denied or failed",
    });

    return {
      ok: true,
      output: {
        untagged: untaggedItems.length,
        tagged: taggedCount,
        skipped: untaggedItems.length - taggedCount,
      },
    };
  },
};
