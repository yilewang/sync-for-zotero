import type { ZoteroGateway } from "../../services/zoteroGateway";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { pushUndoEntry } from "../../store/undoStore";
import type { AgentToolDefinition } from "../../types";
import { normalizeNoteSourceText } from "../../../modules/contextPanel/notes";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

/**
 * Scan note content for local file image references (![alt](file:///path) or
 * <img src="file:///path" />) and import them as Zotero embedded note images.
 * Returns the content with references replaced by data-attachment-key img tags.
 */
async function importLocalImages(
  content: string,
  noteItemId: number,
  zoteroGateway: ZoteroGateway,
): Promise<string> {
  // Match both markdown ![alt](file:///path) and HTML <img src="file:///path" />
  const markdownPattern = /!\[([^\]]*)\]\(file:\/\/\/([^)]+)\)/g;
  const htmlPattern = /<img\s+[^>]*src\s*=\s*"file:\/\/\/([^"]+)"[^>]*\/?>/gi;

  let result = content;

  // Process markdown images
  const mdMatches = [...content.matchAll(markdownPattern)];
  for (const match of mdMatches) {
    const fullMatch = match[0];
    const alt = match[1];
    const filePath = "/" + match[2]; // restore leading /
    try {
      const imported = await zoteroGateway.importNoteImage({
        imagePath: filePath,
        noteItemId,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${imported.key}" alt="${alt}" />`,
        );
      }
    } catch {
      // Leave original reference if import fails
    }
  }

  // Process HTML img tags with file:// src
  const htmlMatches = [...result.matchAll(htmlPattern)];
  for (const match of htmlMatches) {
    const fullMatch = match[0];
    const filePath = "/" + match[1];
    const altMatch = fullMatch.match(/alt\s*=\s*"([^"]*)"/i);
    const alt = altMatch?.[1] || "";
    try {
      const imported = await zoteroGateway.importNoteImage({
        imagePath: filePath,
        noteItemId,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${imported.key}" alt="${alt}" />`,
        );
      }
    } catch {
      // Leave original reference if import fails
    }
  }

  return result;
}

type NotePatch = { find: string; replace: string };

type EditCurrentNoteInput = {
  mode: "edit" | "create";
  content: string;
  expectedOriginalHtml?: string;
  noteId?: number;
  noteTitle?: string;
  target?: "item" | "standalone";
  targetItemId?: number;
};

/**
 * Apply find-and-replace patches to a base text.
 * Each patch replaces the first occurrence of `find` with `replace`.
 * Returns the patched text.
 */
function applyPatches(base: string, patches: NotePatch[]): string {
  let result = base;
  for (const patch of patches) {
    const index = result.indexOf(patch.find);
    if (index >= 0) {
      result =
        result.slice(0, index) +
        patch.replace +
        result.slice(index + patch.find.length);
    }
  }
  return result;
}

export function createEditCurrentNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<EditCurrentNoteInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  return {
    spec: {
      name: "edit_current_note",
      description:
        "Edit the current open Zotero note, or create a new note attached to a paper or as a standalone note. Pass plain text or Markdown only; do not send raw HTML tags.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["edit", "create"],
            description:
              "Use 'edit' to replace the current open note (default), or 'create' to create a new note.",
          },
          content: {
            type: "string",
            description:
              "The full note body as plain text or Markdown. Use this OR patches, not both. Required for mode 'create'.",
          },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "The exact text in the current note to find (must match verbatim).",
                },
                replace: {
                  type: "string",
                  description: "The replacement text.",
                },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
            description:
              "For mode 'edit': find-and-replace patches applied to the current note. Much faster than rewriting the full content. Each patch replaces the first occurrence of 'find' with 'replace'.",
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            description:
              "For mode 'create': attach to a paper ('item', default) or create standalone ('standalone').",
          },
          targetItemId: {
            type: "number",
            description:
              "For mode 'create': attach note to this specific item ID. If omitted, attaches to the active item.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => Boolean(request.activeNoteContext),
      instruction:
        "MANDATORY: When a note is open and the user asks to edit, rewrite, revise, polish, or update ANY text, you MUST call `edit_current_note` with mode 'edit'. NEVER output rewritten or edited text directly in chat — always use the tool so the user sees a diff review card. " +
        "For edits, PREFER using `patches` (find-and-replace pairs) instead of `content` (full rewrite) — patches are much faster because you only send the changed parts. " +
        "When the user asks to create a new note for a paper, call `edit_current_note` with mode 'create' with `content`. Always pass plain text or Markdown, never raw HTML.",
    },
    presentation: {
      label: "Edit / Create Note",
      summaries: {
        onCall: "Preparing note changes",
        onPending: "Waiting for confirmation on note changes",
        onApproved: "Applying note changes",
        onDenied: "Note changes cancelled",
        onSuccess: ({ content }) => {
          const title =
            content && typeof content === "object"
              ? String((content as { title?: unknown }).title || "")
              : "";
          return title ? `Note saved: ${title}` : "Note saved";
        },
      },
    },
    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from search_literature_online review cards
      // that chain a save_note operation
      return (
        approval.sourceMode === "review" &&
        (approval.sourceActionId === "save_metadata_note" ||
          approval.sourceActionId === "save_paper_note")
      );
    },

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with a 'content' string or 'patches' array");
      }
      const mode =
        args.mode === "create" ? ("create" as const) : ("edit" as const);

      // Parse patches if provided
      const hasPatches = Array.isArray(args.patches) && args.patches.length > 0;
      const hasContent = typeof args.content === "string" && args.content.trim();

      if (mode === "create") {
        if (!hasContent) {
          return fail(
            "content is required for mode 'create': provide the note body as a string",
          );
        }
      } else if (!hasContent && !hasPatches) {
        return fail(
          "Either 'content' (full note text) or 'patches' (find-and-replace pairs) is required for mode 'edit'",
        );
      }

      // Validate patches structure
      let patches: NotePatch[] | undefined;
      if (hasPatches) {
        patches = [];
        for (const entry of args.patches as unknown[]) {
          if (!validateObject<Record<string, unknown>>(entry)) {
            return fail("Each patch must be an object with { find: string, replace: string }");
          }
          if (typeof entry.find !== "string" || !entry.find) {
            return fail("Each patch must include a non-empty 'find' string");
          }
          if (typeof entry.replace !== "string") {
            return fail("Each patch must include a 'replace' string");
          }
          patches.push({ find: entry.find, replace: entry.replace });
        }
      }

      const target =
        args.target === "standalone"
          ? ("standalone" as const)
          : ("item" as const);

      // For patches mode, content will be resolved in createPendingAction
      // using the current note snapshot + patches
      const content = hasContent
        ? normalizeNoteSourceText(args.content as string)
        : "";

      return ok<EditCurrentNoteInput & { _patches?: NotePatch[] }>({
        mode,
        content,
        _patches: patches,
        target: mode === "create" ? target : undefined,
        targetItemId:
          mode === "create"
            ? normalizePositiveInt(args.targetItemId)
            : undefined,
      } as EditCurrentNoteInput);
    },
    createPendingAction: (input, context) => {
      // Resolve patches into full content if needed
      const inputWithPatches = input as EditCurrentNoteInput & { _patches?: NotePatch[] };
      if (inputWithPatches._patches && input.mode === "edit") {
        const snapshot = zoteroGateway.getActiveNoteSnapshot({
          request: context.request,
          item: context.item,
        });
        if (!snapshot) {
          throw new Error("No active note is available to edit");
        }
        const patched = applyPatches(snapshot.text, inputWithPatches._patches);
        input.content = normalizeNoteSourceText(patched);
        delete inputWithPatches._patches;
      }

      const normalizedContent = normalizeNoteSourceText(input.content);
      input.content = normalizedContent;

      if (input.mode === "create") {
        return {
          toolName: "edit_current_note",
          mode: "review",
          title: "Review new note",
          description:
            input.target === "standalone"
              ? "Review the note content before creating a standalone note."
              : "Review the note content before attaching it to the paper.",
          confirmLabel: "Create note",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "textarea",
              id: "content",
              label: "Final note content",
              value: normalizedContent,
            },
          ],
        };
      }

      const snapshot = zoteroGateway.getActiveNoteSnapshot({
        request: context.request,
        item: context.item,
      });
      if (!snapshot) {
        throw new Error("No active note is available to edit");
      }
      input.expectedOriginalHtml = snapshot.html;
      input.noteId = snapshot.noteId;
      input.noteTitle = snapshot.title || "Untitled note";
      return {
        toolName: "edit_current_note",
        mode: "review",
        title: `Review note update`,
        description: `Review the proposed note changes for "${input.noteTitle}" and edit the final note text before applying it.`,
        confirmLabel: "Apply edit",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "diff_preview",
            id: "noteDiff",
            label: "Note changes",
            before: snapshot.text,
            after: normalizedContent,
            sourceFieldId: "content",
            contextLines: 0,
            emptyMessage: "No note changes yet.",
          },
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value: normalizedContent,
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      return ok({
        ...input,
        content:
          typeof resolutionData.content === "string"
            ? normalizeNoteSourceText(resolutionData.content)
            : input.content,
      });
    },
    execute: async (input, context) => {
      const hasLocalImages = /!\[[^\]]*\]\(file:\/\/\/|<img\s+[^>]*src\s*=\s*"file:\/\/\//i.test(
        input.content,
      );

      if (input.mode === "create") {
        if (!hasLocalImages) {
          // No images — use the standard mutation service path
          const { result } = await executeAndRecordUndo(
            mutationService,
            {
              type: "save_note",
              content: input.content,
              target: input.target,
              targetItemId: input.targetItemId,
            },
            context,
            "edit_current_note",
          );
          return result;
        }

        // Has local images — create note manually to get the note ID,
        // then import images and update note HTML
        const parentItem = input.targetItemId
          ? zoteroGateway.getItem(input.targetItemId)
          : zoteroGateway.getItem(context.request.activeItemId) || context.item;
        const parentId = parentItem?.isRegularItem?.()
          ? parentItem.id
          : parentItem?.parentID || parentItem?.id;
        const libraryID = parentItem?.libraryID || context.request.libraryID || 1;

        // Create a blank note first
        const note = new Zotero.Item("note");
        note.libraryID = libraryID;
        if (parentId && input.target !== "standalone") {
          note.parentID = parentId;
        }
        note.setNote("<p>Importing images...</p>");
        await note.saveTx();
        const noteId = note.id;

        // Import images into this note
        let finalContent = input.content;
        try {
          finalContent = await importLocalImages(input.content, noteId, zoteroGateway);
        } catch (e) {
          Zotero.debug?.(`[llm-for-zotero] Image import failed: ${e}`);
        }

        // Now set the final note HTML with data-attachment-key img tags
        const { renderRawNoteHtml } = await import("../../../modules/contextPanel/notes");
        note.setNote(renderRawNoteHtml(finalContent));
        await note.saveTx();

        // Register undo
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-edit-current-note-create-${noteId}-${Date.now()}`,
          toolName: "edit_current_note",
          description: `Trash created note`,
          revert: async () => {
            const n = zoteroGateway.getItem(noteId);
            if (n) {
              n.deleted = true;
              await n.saveTx();
            }
          },
        });

        return {
          status: "created",
          noteId,
          title: String(note.getField?.("title") || ""),
        };
      }

      // For edit mode, import images before saving
      let contentToSave = input.content;
      if (hasLocalImages && input.noteId) {
        try {
          contentToSave = await importLocalImages(
            input.content,
            input.noteId,
            zoteroGateway,
          );
        } catch (e) {
          Zotero.debug?.(`[llm-for-zotero] Image import failed: ${e}`);
        }
      }

      const result = await zoteroGateway.replaceCurrentNote({
        request: context.request,
        item: context.item,
        content: contentToSave,
        expectedOriginalHtml: input.expectedOriginalHtml,
      });
      pushUndoEntry(context.request.conversationKey, {
        id: `undo-edit-current-note-${result.noteId}-${Date.now()}`,
        toolName: "edit_current_note",
        description: `Revert note edit: ${result.title}`,
        revert: async () => {
          await zoteroGateway.restoreNoteHtml({
            noteId: result.noteId,
            html: result.previousHtml,
          });
        },
      });
      return {
        status: "updated",
        noteId: result.noteId,
        title: result.title,
        noteText: result.nextText,
      };
    },
  };
}
