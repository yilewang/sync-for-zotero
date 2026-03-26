import { assert } from "chai";
import { formatSelectedTextContextPageLabel } from "../src/modules/contextPanel/contextResolution";

describe("contextResolution selected text page labels", function () {
  it("formats stored page metadata as a lower-case page label", function () {
    assert.equal(
      formatSelectedTextContextPageLabel({
        text: "alpha",
        source: "pdf",
        pageIndex: 23,
        pageLabel: "24",
      }),
      "page 24",
    );
  });

  it("falls back to pageIndex when pageLabel is missing", function () {
    assert.equal(
      formatSelectedTextContextPageLabel({
        text: "beta",
        source: "pdf",
        pageIndex: 4,
      }),
      "page 5",
    );
  });

  it("returns null when no page is available", function () {
    assert.isNull(
      formatSelectedTextContextPageLabel({
        text: "gamma",
        source: "model",
      }),
    );
  });
});
