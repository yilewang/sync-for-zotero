import { assert } from "chai";
import { buildTextDiffPreview } from "../src/modules/contextPanel/agentTrace/diffPreview";

describe("agentTrace diff preview", function () {
  it("highlights local edits within a changed line", function () {
    const lines = buildTextDiffPreview(
      "Title\nhippocampal drift is stable\nTake-home",
      "Title\nhippocampal drift remains stable\nTake-home",
    );

    assert.lengthOf(lines, 4);
    assert.deepInclude(lines[0], {
      kind: "context",
      oldLineNumber: 1,
      newLineNumber: 1,
    });
    assert.deepInclude(lines[1], {
      kind: "remove",
      oldLineNumber: 2,
      newLineNumber: null,
    });
    assert.deepInclude(lines[2], {
      kind: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const removed = lines[1];
    const added = lines[2];
    if (removed.kind === "gap" || added.kind === "gap") {
      assert.fail("Expected changed lines, received a gap");
    }
    assert.deepInclude(removed.segments, {
      kind: "remove",
      text: "is",
    });
    assert.deepInclude(added.segments, {
      kind: "add",
      text: "remains",
    });
  });

  it("collapses large unchanged regions into gap rows", function () {
    const lines = buildTextDiffPreview(
      "a\nb\nc\nd\ne\nf\ng",
      "a\nb\nc\nchanged\ne\nf\ng",
      { contextLines: 1 },
    );

    assert.deepEqual(
      lines.map((line) => line.kind),
      ["gap", "context", "remove", "add", "context", "gap"],
    );
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first.kind !== "gap" || last.kind !== "gap") {
      assert.fail("Expected leading and trailing gap rows");
    }
    assert.equal(first.omittedCount, 2);
    assert.equal(last.omittedCount, 2);
  });
});
