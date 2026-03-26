import { assert } from "chai";
import {
  normalizeNoteContextRef,
  normalizeAttachmentContentHash,
  normalizePaperContextRefs,
  normalizePositiveInt,
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizeSelectedTextSources,
} from "../src/modules/contextPanel/normalizers";

describe("contextPanel normalizers", function () {
  it("normalizePositiveInt should return null for invalid values", function () {
    assert.isNull(normalizePositiveInt(undefined));
    assert.isNull(normalizePositiveInt("abc"));
    assert.isNull(normalizePositiveInt(0));
    assert.isNull(normalizePositiveInt(-1));
  });

  it("normalizePositiveInt should floor positive finite values", function () {
    assert.equal(normalizePositiveInt("12"), 12);
    assert.equal(normalizePositiveInt(9.9), 9);
  });

  it("normalizeSelectedTextSource(s) should normalize unknown entries to pdf", function () {
    assert.equal(normalizeSelectedTextSource("model"), "model");
    assert.equal(normalizeSelectedTextSource("note"), "note");
    assert.equal(normalizeSelectedTextSource("pdf"), "pdf");
    assert.equal(normalizeSelectedTextSource("note-edit"), "note-edit");
    assert.equal(normalizeSelectedTextSource("other"), "pdf");

    assert.deepEqual(
      normalizeSelectedTextSources(["model", "note", "note-edit", "x"], 4),
      ["model", "note", "note-edit", "pdf"],
    );
    assert.deepEqual(normalizeSelectedTextSources(undefined, 2), [
      "pdf",
      "pdf",
    ]);
  });

  it("normalizeAttachmentContentHash should normalize valid hashes only", function () {
    const hash = "a".repeat(64);
    assert.equal(normalizeAttachmentContentHash(hash), hash);
    assert.equal(normalizeAttachmentContentHash(hash.toUpperCase()), hash);
    assert.isUndefined(normalizeAttachmentContentHash("not-a-hash"));
  });

  it("normalizePaperContextRefs should filter invalid entries and dedupe", function () {
    const rows = normalizePaperContextRefs([
      {
        itemId: 1.9,
        contextItemId: "2",
        title: "  Paper A  ",
        citationKey: " KeyA ",
      },
      {
        itemId: 1,
        contextItemId: 2,
        title: "Paper A duplicate",
      },
      {
        itemId: -1,
        contextItemId: 3,
        title: "Invalid",
      },
      {
        itemId: 4,
        contextItemId: 5,
        title: "",
      },
    ]);

    assert.lengthOf(rows, 1);
    assert.deepEqual(rows[0], {
      itemId: 1,
      contextItemId: 2,
      title: "Paper A",
      attachmentTitle: undefined,
      citationKey: "KeyA",
      firstCreator: undefined,
      year: undefined,
    });
  });

  it("normalizePaperContextRefs should support custom sanitizer", function () {
    const rows = normalizePaperContextRefs(
      [{ itemId: 2, contextItemId: 3, title: "A\u0007B" }],
      { sanitizeText: (value) => value.replace(/\u0007/g, "") },
    );
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].title, "AB");
  });

  it("normalizeSelectedTextPaperContexts should preserve index alignment", function () {
    const rows = normalizeSelectedTextPaperContexts(
      [
        { itemId: 1, contextItemId: 2, title: " Paper A " },
        { itemId: "bad", contextItemId: 3, title: "Broken" },
        { itemId: 4, contextItemId: 5, title: "Paper C", year: "2020-11-12" },
      ],
      4,
    );
    assert.lengthOf(rows, 4);
    assert.deepEqual(rows[0], {
      itemId: 1,
      contextItemId: 2,
      title: "Paper A",
      attachmentTitle: undefined,
      citationKey: undefined,
      firstCreator: undefined,
      year: undefined,
    });
    assert.isUndefined(rows[1]);
    assert.deepEqual(rows[2], {
      itemId: 4,
      contextItemId: 5,
      title: "Paper C",
      attachmentTitle: undefined,
      citationKey: undefined,
      firstCreator: undefined,
      year: "2020-11-12",
    });
    assert.isUndefined(rows[3]);
  });

  it("normalizeNoteContextRef should preserve stable library identity", function () {
    const row = normalizeNoteContextRef({
      libraryID: 3,
      noteItemKey: " abcd1234 ",
      noteItemId: 88,
      parentItemKey: " efgh5678 ",
      noteKind: "item",
      title: " Geometry notes ",
    });

    assert.deepEqual(row, {
      libraryID: 3,
      noteItemKey: "ABCD1234",
      noteItemId: 88,
      parentItemId: undefined,
      parentItemKey: "EFGH5678",
      noteKind: "item",
      title: "Geometry notes",
    });
  });

  it("normalizeSelectedTextNoteContexts should preserve index alignment", function () {
    const rows = normalizeSelectedTextNoteContexts(
      [
        {
          libraryID: 1,
          noteItemKey: "AAAA1111",
          noteKind: "standalone",
          title: "Note A",
        },
        { noteItemId: "bad" },
        {
          libraryID: 2,
          noteItemKey: "BBBB2222",
          noteKind: "item",
          title: "Note B",
        },
      ],
      4,
    );
    assert.lengthOf(rows, 4);
    assert.deepEqual(rows[0], {
      libraryID: 1,
      noteItemKey: "AAAA1111",
      noteItemId: undefined,
      parentItemId: undefined,
      parentItemKey: undefined,
      noteKind: "standalone",
      title: "Note A",
    });
    assert.isUndefined(rows[1]);
    assert.deepEqual(rows[2], {
      libraryID: 2,
      noteItemKey: "BBBB2222",
      noteItemId: undefined,
      parentItemId: undefined,
      parentItemKey: undefined,
      noteKind: "item",
      title: "Note B",
    });
    assert.isUndefined(rows[3]);
  });
});
