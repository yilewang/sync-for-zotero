import { assert } from "chai";
import { resolveRenderablePdfPage } from "../src/agent/services/pdfPageService";

describe("pdfPageService", function () {
  it("unwraps nested PDF page proxies from Zotero/Firefox wrappers", function () {
    const renderable = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
      }),
      render: () => ({ promise: Promise.resolve() }),
    };

    assert.equal(resolveRenderablePdfPage(renderable), renderable);
    assert.equal(resolveRenderablePdfPage({ pdfPage: renderable }), renderable);
    assert.equal(
      resolveRenderablePdfPage({
        wrappedJSObject: { pdfPage: renderable },
      }),
      renderable,
    );
  });
});
