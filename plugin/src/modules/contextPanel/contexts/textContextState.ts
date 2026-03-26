/**
 * Text selection context state — pure state operations with no DOM dependencies.
 */

import {
  clearPinnedContextOwner,
  retainPinnedSelectedTextContexts,
} from "../setupHandlers/controllers/pinnedContextController";
import {
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  setSelectedTextExpandedIndex,
  setNoteContextExpanded,
} from "../contextResolution";

export function clearSelectedTextState(
  pinnedSelectedTextKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  setSelectedTextContextEntries(itemId, []);
  setSelectedTextExpandedIndex(itemId, null);
  setNoteContextExpanded(itemId, null);
  clearPinnedContextOwner(pinnedSelectedTextKeys, itemId);
}

export function retainPinnedTextState(
  pinnedSelectedTextKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const retained = retainPinnedSelectedTextContexts(
    pinnedSelectedTextKeys,
    itemId,
    getSelectedTextContextEntries(itemId),
  );
  setSelectedTextContextEntries(itemId, retained);
  setSelectedTextExpandedIndex(itemId, null);
  setNoteContextExpanded(itemId, null);
}
