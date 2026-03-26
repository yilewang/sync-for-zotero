/**
 * File attachment context state — pure state operations with no DOM dependencies.
 */

import {
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
} from "../state";
import {
  clearPinnedContextOwner,
  retainPinnedFiles,
} from "../setupHandlers/controllers/pinnedContextController";

export function clearSelectedFileState(
  pinnedFileKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  selectedFileAttachmentCache.delete(itemId);
  selectedFilePreviewExpandedCache.delete(itemId);
  clearPinnedContextOwner(pinnedFileKeys, itemId);
}

export function retainPinnedFileState(
  pinnedFileKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const retained = retainPinnedFiles(
    pinnedFileKeys,
    itemId,
    selectedFileAttachmentCache.get(itemId) || [],
  );
  if (retained.length) {
    selectedFileAttachmentCache.set(itemId, retained);
    return;
  }
  selectedFileAttachmentCache.delete(itemId);
  selectedFilePreviewExpandedCache.delete(itemId);
}
