import { resolvePaperContextRefFromAttachment } from "./paperAttribution";
import type { PaperContextRef } from "./types";

export function resolveReaderPopupPaperContext(
  readerItem: Zotero.Item | null | undefined,
  activeAttachment: Zotero.Item | null | undefined,
): PaperContextRef | null {
  const fromReaderItem = resolvePaperContextRefFromAttachment(readerItem);
  if (fromReaderItem) {
    return fromReaderItem;
  }
  return resolvePaperContextRefFromAttachment(activeAttachment);
}
