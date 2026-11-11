import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");

const contentScript = readFileSync(
  new URL("../extension/content_script.js", import.meta.url),
  "utf8",
);

test("prefers the streamed Markdown for sites that opt in", () => {
  assert.equal(
    shared.chooseAnswerText({
      domText: "n2+n+41",
      sseText: "$n^2+n+41$",
      preferNetwork: true,
    }),
    "$n^2+n+41$",
  );
});

test("keeps the DOM answer for every other site", () => {
  assert.equal(
    shared.chooseAnswerText({ domText: "from the DOM", sseText: "from SSE" }),
    "from the DOM",
  );
});

test("falls back to whichever answer is meaningful", () => {
  assert.equal(shared.chooseAnswerText({ domText: "", sseText: "from SSE" }), "from SSE");
  assert.equal(shared.chooseAnswerText({ domText: "from the DOM", sseText: "" }), "from the DOM");
  assert.equal(
    shared.chooseAnswerText({ domText: "from the DOM", sseText: "", preferNetwork: true }),
    "from the DOM",
  );
});

test("the Yuanbao adapter opts in and drops the source-list chrome", () => {
  const adapterStart = contentScript.indexOf('"yuanbao.tencent.com": {');
  const adapter = contentScript.slice(
    adapterStart,
    contentScript.indexOf("\n  },\n", adapterStart),
  );

  assert.match(adapter, /preferNetworkAnswer: true/);
  assert.match(adapter, /\.hyc-common-markdown__ref-list/);
  assert.match(adapter, /\.replace\(\/\\u200b\/g, ""\)/);
});
