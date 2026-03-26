/**
 * Base interface for all context type modules (paper, image, file, text).
 *
 * Each module encapsulates:
 * - State management (items, expanded state, overrides)
 * - Pin/retention logic
 * - Preview rendering
 * - Send flow integration
 *
 * Modules are created per-panel instance via factory functions that receive
 * shared dependencies (DOM refs, item getter, status setter, etc.).
 */

export type PreviewRenderParams = {
  ownerId: number;
  ownerDoc: Document;
  container: HTMLElement;
  list: HTMLElement;
};

/**
 * Minimal interface that all context modules implement.
 * TItem is the context item type (PaperContextRef, string, ChatAttachment, SelectedTextContext).
 */
export interface ContextModule<TItem> {
  /** Unique type identifier ("paper" | "image" | "file" | "text") */
  readonly type: string;

  // ── State queries ──
  getItems(ownerId: number): TItem[];
  hasItems(ownerId: number): boolean;

  // ── State mutations ──
  setItems(ownerId: number, items: TItem[]): void;
  addItem(ownerId: number, item: TItem): void;
  removeItem(ownerId: number, index: number): void;
  clearState(ownerId: number): void;

  // ── Pin/Retain ──
  isPinned(ownerId: number, item: TItem): boolean;
  togglePin(ownerId: number, item: TItem): boolean;
  retainPinned(ownerId: number): TItem[];

  // ── Preview ──
  isExpanded(ownerId: number): boolean;
  setExpanded(ownerId: number, expanded: boolean): void;
  updatePreview(params: PreviewRenderParams): void;

  // ── Send flow ──
  collectForSend(ownerId: number): TItem[];
  postSendRetain(ownerId: number): void;
}

/**
 * Registry that holds all context modules for a panel instance.
 * Provides batch operations across all context types.
 */
export interface ContextRegistry {
  readonly paper: ContextModule<unknown>;
  readonly image: ContextModule<unknown>;
  readonly file: ContextModule<unknown>;
  readonly text: ContextModule<unknown>;

  /** Clear all transient compose state for the given owner. */
  clearAllTransient(ownerId: number): void;

  /** Retain only pinned items across all context types after send. */
  retainAllPinned(ownerId: number): void;
}
