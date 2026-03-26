import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import { callTool } from "./executor";
import { getMetadataField } from "./metadataSnapshot";

type DiscoverRelatedInput = {
  itemId: number;
  mode?: "recommendations" | "references" | "citations";
  source?: "openalex" | "arxiv" | "europepmc";
  limit?: number;
};

type DiscoverRelatedOutput = {
  seedTitle: string;
  discovered: number;
  imported: number;
};

/**
 * Finds papers related to a given Zotero item (via recommendations, references,
 * or citations), presents the results for review, and imports selected papers.
 */
export const discoverRelatedAction: AgentAction<DiscoverRelatedInput, DiscoverRelatedOutput> = {
  name: "discover_related",
  description:
    "Find papers related to a specific Zotero item using OpenAlex recommendations, " +
    "references, or citations. Presents results for review and imports the selected papers.",
  inputSchema: {
    type: "object",
    required: ["itemId"],
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "The Zotero item ID of the seed paper.",
      },
      mode: {
        type: "string",
        enum: ["recommendations", "references", "citations"],
        description: "Discovery mode. Default: 'recommendations'.",
      },
      source: {
        type: "string",
        enum: ["openalex"],
        description: "Search source. Only OpenAlex supports recommendations, references, and citations.",
      },
      limit: {
        type: "number",
        description: "Max number of related papers to retrieve. Default: 10.",
      },
    },
  },

  async execute(
    input: DiscoverRelatedInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<DiscoverRelatedOutput>> {
    const STEPS = 3;
    let step = 0;
    const mode = input.mode || "recommendations";

    // Step 1: get seed item metadata
    ctx.onProgress({
      type: "step_start",
      step: "Reading seed paper",
      index: ++step,
      total: STEPS,
    });

    const readResult = await callTool(
      "read_library",
      { itemIds: [input.itemId], sections: ["metadata"] },
      ctx,
      `Reading metadata for item ${input.itemId}`,
    );

    const readContent = readResult.ok
      ? (readResult.content as Record<string, unknown>)
      : {};
    const readResults =
      readContent.results &&
      typeof readContent.results === "object" &&
      !Array.isArray(readContent.results)
        ? (readContent.results as Record<string, Record<string, unknown>>)
        : {};
    const seedEntry = readResults[String(input.itemId)] as Record<string, unknown> | undefined;
    const seedMeta = seedEntry?.metadata;
    const seedTitle =
      getMetadataField(seedMeta, "title") || `Item ${input.itemId}`;
    const seedDoi = getMetadataField(seedMeta, "DOI");

    ctx.onProgress({
      type: "step_done",
      step: "Reading seed paper",
      summary: seedTitle,
    });

    // Step 2: search for related papers online
    ctx.onProgress({
      type: "step_start",
      step: `Finding ${mode}`,
      index: ++step,
      total: STEPS,
    });

    const searchResult = await callTool(
      "search_literature_online",
      {
        mode,
        itemId: input.itemId,
        doi: seedDoi,
        source: input.source || "openalex",
        limit: input.limit || 10,
        libraryID: ctx.libraryID,
      },
      ctx,
      `Finding ${mode} for "${seedTitle}"`,
    );

    if (!searchResult.ok) {
      return {
        ok: false,
        error: `Search failed: ${JSON.stringify(searchResult.content)}`,
      };
    }

    const searchContent = searchResult.content as Record<string, unknown>;
    const rawResults = Array.isArray(searchContent.results) ? searchContent.results : [];

    type PaperRow = {
      id: string;
      title: string;
      subtitle?: string;
      badges?: string[];
      href?: string;
      importIdentifier?: string;
    };

    const paperRows: PaperRow[] = rawResults
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r, i) => {
        const title = typeof r.title === "string" ? r.title : `Result ${i + 1}`;
        const authors = Array.isArray(r.authors)
          ? r.authors.filter((a): a is string => typeof a === "string").slice(0, 3).join(", ")
          : "";
        const year = r.year ? String(r.year) : "";
        const subtitle = [year, authors].filter(Boolean).join(" · ") || undefined;
        const doi =
          typeof r.doi === "string" && r.doi.trim()
            ? r.doi.trim().replace(/^https?:\/\/doi\.org\//i, "")
            : null;
        const arxivMatch =
          typeof r.sourceUrl === "string"
            ? /arxiv\.org\/abs\/([\d.]+)/i.exec(r.sourceUrl)?.[1]
            : null;
        const importIdentifier = doi?.startsWith("10.")
          ? doi
          : arxivMatch
            ? `arxiv:${arxivMatch}`
            : undefined;
        const badges: string[] = [];
        if (typeof r.citationCount === "number") badges.push(`${r.citationCount} citations`);
        if (doi) badges.push(`DOI: ${doi}`);
        return {
          id: `paper-${i + 1}`,
          title,
          subtitle,
          badges: badges.length ? badges : undefined,
          href: typeof r.openAccessUrl === "string" ? r.openAccessUrl : undefined,
          importIdentifier,
        };
      });

    ctx.onProgress({
      type: "step_done",
      step: `Finding ${mode}`,
      summary: `Found ${paperRows.length} result${paperRows.length === 1 ? "" : "s"}`,
    });

    if (!paperRows.length) {
      return { ok: true, output: { seedTitle, discovered: 0, imported: 0 } };
    }

    // Step 3: HITL paper selection + import
    ctx.onProgress({
      type: "step_start",
      step: "Reviewing and importing papers",
      index: ++step,
      total: STEPS,
    });

    const requestId = `discover-related-${Date.now()}`;
    const modeLabel =
      mode === "recommendations"
        ? "Recommended papers"
        : mode === "references"
          ? "References"
          : "Citing papers";

    const reviewCard = {
      toolName: "discover_related",
      mode: "review" as const,
      title: `${modeLabel} for "${seedTitle}"`,
      description: "Select the papers you want to import into your Zotero library.",
      confirmLabel: "Import selected",
      cancelLabel: "Cancel",
      actions: [
        { id: "import", label: "Import selected", style: "primary" as const },
        { id: "cancel", label: "Cancel", style: "secondary" as const },
      ],
      defaultActionId: "import",
      cancelActionId: "cancel",
      fields: [
        {
          type: "paper_result_list" as const,
          id: "selectedPaperIds",
          label: modeLabel,
          rows: paperRows.map((p) => ({ ...p, checked: true })),
          minSelectedByAction: [{ actionId: "import", min: 1 }],
        },
      ],
    };

    const resolution = await ctx.requestConfirmation(requestId, reviewCard);

    if (!resolution.approved || resolution.actionId === "cancel") {
      return { ok: true, output: { seedTitle, discovered: paperRows.length, imported: 0 } };
    }

    const data = (resolution.data || {}) as Record<string, unknown>;
    const selectedIds = Array.isArray(data.selectedPaperIds)
      ? (data.selectedPaperIds as string[])
      : paperRows.map((p) => p.id);

    const selectedPapers = paperRows.filter((p) => selectedIds.includes(p.id));
    const identifiers = Array.from(
      new Set(
        selectedPapers
          .map((p) => p.importIdentifier)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (!identifiers.length) {
      return { ok: true, output: { seedTitle, discovered: paperRows.length, imported: 0 } };
    }

    const importResult = await callTool(
      "import_identifiers",
      {
        identifiers,
        libraryID: ctx.libraryID,
      },
      ctx,
      "Importing selected papers",
    );

    const importContent = importResult.content as Record<string, unknown>;
    const resultObj = importContent.result as Record<string, unknown> | undefined;
    const importedCount = importResult.ok && resultObj
      ? Number(resultObj.succeeded || resultObj.importedCount || 0)
      : 0;

    ctx.onProgress({
      type: "step_done",
      step: "Reviewing and importing papers",
      summary: importResult.ok
        ? `Imported ${importedCount} paper${importedCount === 1 ? "" : "s"}`
        : "Import was denied or failed",
    });

    return {
      ok: true,
      output: {
        seedTitle,
        discovered: paperRows.length,
        imported: importedCount,
      },
    };
  },
};
