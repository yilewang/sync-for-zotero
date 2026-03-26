/**
 * Focused facade tool for creating and deleting Zotero collections (folders).
 * Provides a self-describing schema for managing Zotero collections.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type CreateCollectionOperation,
  type DeleteCollectionOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type ManageCollectionsInput = {
  operation: CreateCollectionOperation | DeleteCollectionOperation;
};

export function createManageCollectionsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ManageCollectionsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "manage_collections",
      description: "Create or delete Zotero collections (folders).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["create", "delete"],
            description: "Whether to create or delete a collection.",
          },
          name: {
            type: "string",
            description: "Collection name (required for 'create').",
          },
          parentCollectionId: {
            type: "number",
            description: "Parent collection for nested creation.",
          },
          collectionId: {
            type: "number",
            description: "Collection ID to delete (required for 'delete').",
          },
          libraryID: {
            type: "number",
            description: "Library ID (for group libraries).",
          },
        },
        required: ["action"],
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Manage Collections",
      summaries: {
        onCall: "Preparing collection changes",
        onPending: "Waiting for confirmation on collection changes",
        onApproved: "Applying collection changes",
        onDenied: "Collection changes cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const resultInner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const name = String(resultInner.name || result.name || "");
          return name ? `Collection "${name}" updated` : "Collection updated";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with an action. Example: { action: "create", name: "My Collection" }',
        );
      }

      const action = args.action;

      if (action === "create") {
        const name =
          typeof args.name === "string" && args.name.trim()
            ? args.name.trim()
            : "";
        if (!name) {
          return fail(
            'action "create" requires a name. Example: { action: "create", name: "Machine Learning" }',
          );
        }
        const operation: CreateCollectionOperation = {
          type: "create_collection",
          name,
          parentCollectionId: normalizePositiveInt(args.parentCollectionId),
          libraryID: normalizePositiveInt(args.libraryID),
        };
        return ok({ operation });
      }

      if (action === "delete") {
        const collectionId = normalizePositiveInt(args.collectionId);
        if (!collectionId) {
          return fail(
            'action "delete" requires a collectionId. Example: { action: "delete", collectionId: 42 }',
          );
        }
        const operation: DeleteCollectionOperation = {
          type: "delete_collection",
          collectionId,
        };
        return ok({ operation });
      }

      return fail(
        'action must be "create" or "delete". Example: { action: "create", name: "My Folder" }',
      );
    },

    createPendingAction(input) {
      const operation = input.operation;

      if (operation.type === "create_collection") {
        const parentSummary = operation.parentCollectionId
          ? zoteroGateway.getCollectionSummary(operation.parentCollectionId)
          : null;
        const parentLabel = parentSummary
          ? parentSummary.path || parentSummary.name
          : null;
        const description = parentLabel
          ? `Create collection "${operation.name}" inside "${parentLabel}".`
          : `Create top-level collection "${operation.name}".`;

        return {
          toolName: "manage_collections",
          title: "Create collection",
          description,
          confirmLabel: "Create",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "description",
              label: "Action",
              value: description,
            },
          ],
        };
      }

      // delete_collection
      const collection = zoteroGateway.getCollectionSummary(
        operation.collectionId,
      );
      const collectionLabel = collection
        ? collection.path || collection.name
        : `Collection ${operation.collectionId}`;
      const description = `Delete collection "${collectionLabel}". Items in the collection will not be deleted.`;

      return {
        toolName: "manage_collections",
        title: "Delete collection",
        description,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Action",
            value: description,
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      // Text fields are read-only; pass through unchanged
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "manage_collections",
      );
    },
  };
}
