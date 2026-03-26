import type { PaperContextRef } from "../../../shared/types";
import {
  formatPageSelectionValue,
  parsePageSelectionValue,
  type ParsedPageSelection,
  type PdfVisualMode,
} from "../../services/pdfPageService";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import type { AgentToolInputValidation } from "../../types";

export type PdfTargetToolInput = {
  paperContext?: PaperContextRef;
  itemId?: number;
  contextItemId?: number;
  attachmentId?: string;
  name?: string;
};

export type PdfTargetArgs = PdfTargetToolInput & {
  question?: string;
  reason?: string;
  mode?: PdfVisualMode;
  topK?: number;
  neighborPages?: number;
  pages?: number[];
  scope?: "whole_document";
};

export function buildPdfToolSchemaProperties(): Record<string, unknown> {
  return {
    paperContext: {
      type: "object",
      additionalProperties: true,
    },
    itemId: { type: "integer" },
    contextItemId: { type: "integer" },
    attachmentId: { type: "string" },
    name: { type: "string" },
    question: { type: "string" },
    reason: { type: "string" },
    mode: {
      type: "string",
      enum: ["general", "figure", "equation"],
    },
    topK: { type: "integer" },
    neighborPages: { type: "integer" },
    pages: {
      anyOf: [
        { type: "string" },
        { type: "integer" },
        {
          type: "array",
          items: { type: "integer" },
        },
      ],
    },
    scope: {
      type: "string",
      enum: ["whole_document"],
    },
  };
}

export function parsePdfTargetArgs(
  args: unknown,
): AgentToolInputValidation<PdfTargetArgs> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("Expected an object");
  }
  const paperContext = validateObject<Record<string, unknown>>(args.paperContext)
    ? normalizeToolPaperContext(args.paperContext) || undefined
    : undefined;
  const pagesSelection = parsePageSelectionValue(args.pages);
  const question =
    typeof args.question === "string" && args.question.trim()
      ? args.question.trim()
      : undefined;
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : undefined;
  return ok({
    paperContext,
    itemId: normalizePositiveInt(args.itemId),
    contextItemId: normalizePositiveInt(args.contextItemId),
    attachmentId:
      typeof args.attachmentId === "string" && args.attachmentId.trim()
        ? args.attachmentId.trim()
        : undefined,
    name:
      typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : undefined,
    question,
    reason,
    mode:
      args.mode === "figure" || args.mode === "equation" || args.mode === "general"
        ? args.mode
        : undefined,
    topK: normalizePositiveInt(args.topK),
    neighborPages: normalizePositiveInt(args.neighborPages),
    pages: pagesSelection?.pageIndexes,
    scope: args.scope === "whole_document" ? "whole_document" : undefined,
  });
}

export function requireQuestionOrPages(
  value: PdfTargetArgs,
): AgentToolInputValidation<PdfTargetArgs> {
  if (!value.question && !value.pages?.length && !value.reason) {
    return fail("question, reason, or pages is required");
  }
  return ok(value);
}

export function getUserEditablePageSelection(
  pages: number[] | undefined,
): string {
  return formatPageSelectionValue(pages || []);
}

export function resolvePageSelectionFromResolution(
  resolutionData: unknown,
  fallbackPages: number[] | undefined,
): ParsedPageSelection | null {
  if (!validateObject<Record<string, unknown>>(resolutionData)) {
    return parsePageSelectionValue(fallbackPages || []);
  }
  if (Object.prototype.hasOwnProperty.call(resolutionData, "pages")) {
    return parsePageSelectionValue(resolutionData.pages);
  }
  if (Object.prototype.hasOwnProperty.call(resolutionData, "pageSelection")) {
    return parsePageSelectionValue(
      (resolutionData as Record<string, unknown>).pageSelection,
    );
  }
  return parsePageSelectionValue(fallbackPages || []);
}
