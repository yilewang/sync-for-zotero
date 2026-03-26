import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import { callTool } from "./executor";

type OrganizeUnfiledInput = {
  /** Maximum number of unfiled items to process. Default: no limit. */
  limit?: number;
};

type OrganizeUnfiledOutput = {
  unfiled: number;
  moved: number;
  remaining: number;
};

/**
 * Finds all unfiled papers and presents them in a collection-assignment HITL card,
 * letting the user assign each paper to a target collection before batch-moving them.
 *
 * Note: Collection suggestions are not AI-generated in this version — the user
 * fills in assignments manually in the HITL assignment table.
 */
export const organizeUnfiledAction: AgentAction<OrganizeUnfiledInput, OrganizeUnfiledOutput> = {
  name: "organize_unfiled",
  description:
    "Find all unfiled Zotero papers and open a batch-assignment dialog to move them into collections. " +
    "Shows each unfiled paper alongside a collection picker for the user to assign destinations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description: "Max number of unfiled items to process per run. Default: no limit.",
      },
    },
  },

  async execute(
    input: OrganizeUnfiledInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<OrganizeUnfiledOutput>> {
    const STEPS = 3;
    let step = 0;

    // Step 1: get unfiled items
    ctx.onProgress({
      type: "step_start",
      step: "Finding unfiled items",
      index: ++step,
      total: STEPS,
    });

    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      filters: { unfiled: true },
      include: ["metadata"],
    };
    if (input.limit) queryArgs.limit = input.limit;

    const queryResult = await callTool("query_library", queryArgs, ctx, "Finding unfiled items");
    if (!queryResult.ok) {
      return { ok: false, error: `Failed to query library: ${JSON.stringify(queryResult.content)}` };
    }

    const queryContent = queryResult.content as Record<string, unknown>;
    const unfiledItems = Array.isArray(queryContent.results) ? queryContent.results : [];

    ctx.onProgress({
      type: "step_done",
      step: "Finding unfiled items",
      summary: `${unfiledItems.length} unfiled item${unfiledItems.length === 1 ? "" : "s"}`,
    });

    if (!unfiledItems.length) {
      return { ok: true, output: { unfiled: 0, moved: 0, remaining: 0 } };
    }

    // Step 2: get collection options for the assignment table
    ctx.onProgress({
      type: "step_start",
      step: "Loading collections",
      index: ++step,
      total: STEPS,
    });

    const collectionsResult = await callTool(
      "query_library",
      { entity: "collections", mode: "list" },
      ctx,
      "Loading collections",
    );

    type Collection = { id: number | string; name: string };
    const collections: Collection[] = [];
    if (collectionsResult.ok) {
      const colContent = collectionsResult.content as Record<string, unknown>;
      const colResults = Array.isArray(colContent.results) ? colContent.results : [];
      for (const col of colResults) {
        if (col && typeof col === "object") {
          const c = col as Record<string, unknown>;
          const collectionId =
            (typeof c.collectionId === "number" ? c.collectionId : null) ??
            (typeof c.id === "number" ? c.id : null) ??
            (typeof c.collectionID === "number" ? c.collectionID : null);
          if (collectionId) {
            collections.push({
              id: collectionId,
              name: typeof c.name === "string" ? c.name : String(collectionId),
            });
          }
        }
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Loading collections",
      summary: `${collections.length} collection${collections.length === 1 ? "" : "s"} available`,
    });

    // Step 3: batch move via move_to_collection (HITL assignment_table)
    ctx.onProgress({
      type: "step_start",
      step: "Assigning items to collections",
      index: ++step,
      total: STEPS,
    });

    const itemIds = unfiledItems
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        return typeof record.itemId === "number" ? record.itemId : null;
      })
      .filter((id): id is number => id !== null);

    const mutateResult = await callTool(
      "move_to_collection",
      {
        action: "add",
        itemIds,
        // No collectionId — the HITL assignment_table will collect per-item destinations
      },
      ctx,
      "Assigning unfiled items to collections",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const resultObj = mutateContent.result as Record<string, unknown> | undefined;
    const movedCount = mutateResult.ok && resultObj
      ? Number(resultObj.movedCount || 0)
      : 0;

    ctx.onProgress({
      type: "step_done",
      step: "Assigning items to collections",
      summary: mutateResult.ok
        ? `Moved ${movedCount} item${movedCount === 1 ? "" : "s"}`
        : "Assignment was denied or failed",
    });

    return {
      ok: true,
      output: {
        unfiled: unfiledItems.length,
        moved: movedCount,
        remaining: unfiledItems.length - movedCount,
      },
    };
  },
};
