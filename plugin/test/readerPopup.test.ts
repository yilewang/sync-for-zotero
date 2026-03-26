import { assert } from "chai";
import { resolveReaderPopupPaperContext } from "../src/modules/contextPanel/readerPopup";

type MockItem = Zotero.Item & {
  parentID?: number;
  attachmentContentType?: string;
};

function makeRegularItem(id: number, title: string): MockItem {
  return {
    id,
    key: `ITEM-${id}`,
    libraryID: 1,
    isAttachment: () => false,
    isRegularItem: () => true,
    getField: (field: string) => (field === "title" ? title : ""),
  } as unknown as MockItem;
}

function makePdfAttachment(
  id: number,
  parentID: number,
  title: string,
): MockItem {
  return {
    id,
    key: `ATTACH-${id}`,
    libraryID: 1,
    parentID,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field: string) => (field === "title" ? title : ""),
  } as unknown as MockItem;
}

describe("readerPopup", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("falls back to the active pdf attachment when the popup item is a regular item", function () {
    const paper = makeRegularItem(11, "Current Paper");
    const attachment = makePdfAttachment(12, paper.id, "Current Paper PDF");

    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => (id === paper.id ? paper : null),
      },
    } as typeof Zotero;

    const result = resolveReaderPopupPaperContext(paper, attachment);

    assert.deepInclude(result, {
      itemId: paper.id,
      contextItemId: attachment.id,
      title: "Current Paper",
    });
  });

  it("prefers the popup attachment when it is already a pdf attachment", function () {
    const paper = makeRegularItem(21, "Popup Paper");
    const popupAttachment = makePdfAttachment(22, paper.id, "Popup PDF");
    const fallbackPaper = makeRegularItem(31, "Other Paper");
    const fallbackAttachment = makePdfAttachment(
      32,
      fallbackPaper.id,
      "Other PDF",
    );

    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => {
          if (id === paper.id) return paper;
          if (id === fallbackPaper.id) return fallbackPaper;
          return null;
        },
      },
    } as typeof Zotero;

    const result = resolveReaderPopupPaperContext(
      popupAttachment,
      fallbackAttachment,
    );

    assert.deepInclude(result, {
      itemId: paper.id,
      contextItemId: popupAttachment.id,
      title: "Popup Paper",
    });
  });
});
