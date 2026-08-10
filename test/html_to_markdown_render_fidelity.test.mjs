import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");

const testDir = path.dirname(fileURLToPath(import.meta.url));
const contentScriptSource = fs.readFileSync(
  path.resolve(testDir, "../extension/content_script.js"),
  "utf8",
);

// Extract the DOM→Markdown converter verbatim from the content script so the
// tests always exercise the shipped implementation.
const startMarker =
  "/** Extract original LaTeX source from a KaTeX-rendered element. */";
const endMarker =
  "// Scrape all messages from the current ChatGPT conversation page";
const startIdx = contentScriptSource.indexOf(startMarker);
const endMarkerIdx = contentScriptSource.indexOf(endMarker);
assert.ok(startIdx >= 0, "start marker found in content_script.js");
assert.ok(endMarkerIdx > startIdx, "end marker found in content_script.js");
const dividerIdx = contentScriptSource.lastIndexOf(
  "// ---------------------------------------------------------------------------",
  endMarkerIdx,
);
const converterSource = contentScriptSource.slice(
  startIdx,
  dividerIdx > startIdx ? dividerIdx : endMarkerIdx,
);

function createConverter() {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const context = {
    document,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  };
  vm.createContext(context);
  return vm.runInContext(
    `${converterSource}\n({ htmlToMarkdown, extractLatexFromKatex })`,
    context,
  );
}

function convert(html) {
  return createConverter().htmlToMarkdown(html);
}

// ---------------------------------------------------------------------------
// Regression pins: behaviors that already work and must stay byte-identical.
// ---------------------------------------------------------------------------

const OLD_KATEX_DISPLAY =
  '<span class="katex-display"><span class="katex">' +
  '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' +
  "<semantics><mrow><mi>x</mi></mrow>" +
  '<annotation encoding="application/x-tex">dx_t = f(x_t,t)dt</annotation>' +
  "</semantics></math></span>" +
  '<span class="katex-html" aria-hidden="true"><span class="base">dxt=f(xt,t)dt</span></span>' +
  "</span></span>";

const OLD_KATEX_INLINE =
  '<span class="katex">' +
  '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML">' +
  "<semantics><mrow><mi>t</mi></mrow>" +
  '<annotation encoding="application/x-tex">t</annotation>' +
  "</semantics></math></span>" +
  '<span class="katex-html" aria-hidden="true"><span class="base">t</span></span>' +
  "</span>";

test("pin: legacy KaTeX markup with MathML annotation still converts unchanged", () => {
  assert.equal(
    convert(`<p>普通：</p>${OLD_KATEX_DISPLAY}<p>之后。</p>`),
    "普通：\n\n$$dx_t = f(x_t,t)dt$$\n\n之后。",
  );
  assert.equal(
    convert(`<p>这里的 ${OLD_KATEX_INLINE} 是时间。</p>`),
    "这里的 $t$ 是时间。",
  );
});

test("pin: flat lists convert unchanged", () => {
  assert.equal(
    convert("<ul><li>甲</li><li>乙</li></ul>"),
    "- 甲\n- 乙",
  );
  assert.equal(
    convert("<ol><li>甲</li><li>乙</li></ol>"),
    "1. 甲\n2. 乙",
  );
});

test("pin: emphasis, code, links, blockquote, hr, headings convert unchanged", () => {
  assert.equal(convert("<p><strong>粗</strong> 和 <em>斜</em></p>"), "**粗** 和 *斜*");
  assert.equal(convert("<p>行内 <code>x=1</code> 代码</p>"), "行内 `x=1` 代码");
  assert.equal(
    convert('<pre><code class="language-js">const a = 1;</code></pre>'),
    "```js\nconst a = 1;\n```",
  );
  assert.equal(
    convert('<p><a href="https://example.com">链接</a></p>'),
    "[链接](https://example.com)",
  );
  assert.equal(convert("<blockquote><p>引文</p></blockquote>"), "> 引文");
  assert.equal(convert("<hr>"), "---");
  assert.equal(convert("<h3>标题</h3>"), "### 标题");
});

test("pin: table converts unchanged", () => {
  assert.equal(
    convert(
      "<table><tr><th>甲</th><th>乙</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ),
    "| 甲 | 乙 |\n|---|---|\n| 1 | 2 |",
  );
});

test("pin: orphan katex internal spans stay suppressed", () => {
  assert.equal(
    convert('<p>前<span class="katex-mathml">dup</span>后</p>'),
    "前后",
  );
});

// ---------------------------------------------------------------------------
// New behavior: current chatgpt.com markup (KaTeX html-only output).
// The LaTeX source lives on a wrapper span's data-math-source attribute;
// there is no MathML annotation anywhere.
// ---------------------------------------------------------------------------

const CHATGPT_DISPLAY_WRAPPER =
  '<span data-start="10" data-end="40" role="math" aria-label="dS_t = \\mu_t S_t dt" ' +
  'data-math-source="dS_t = \\mu_t S_t dt" data-client-katex-layout="display">' +
  '<span class="katex-display"><span class="katex">' +
  '<span class="katex-html" aria-hidden="true"><span class="base">dSt=μtStdt</span></span>' +
  "</span></span></span>";

const CHATGPT_INLINE_WRAPPER =
  '<span data-start="5" data-end="6" role="math" aria-label="t" ' +
  'data-math-source="t" data-client-katex-layout="inline">' +
  '<span class="katex">' +
  '<span class="katex-html" aria-hidden="true"><span class="base">t</span></span>' +
  "</span></span>";

test("recovers display math from a data-math-source wrapper", () => {
  assert.equal(
    convert(`<p>普通：</p>${CHATGPT_DISPLAY_WRAPPER}<p>之后。</p>`),
    "普通：\n\n$$dS_t = \\mu_t S_t dt$$\n\n之后。",
  );
});

test("recovers inline math from a data-math-source wrapper", () => {
  assert.equal(
    convert(`<p>这里的 ${CHATGPT_INLINE_WRAPPER} 是 diffusion time。</p>`),
    "这里的 $t$ 是 diffusion time。",
  );
});

test("annotation-less KaTeX without any wrapper degrades to visible text, not deletion", () => {
  const html =
    '<p>结果 <span class="katex">' +
    '<span class="katex-html" aria-hidden="true"><span class="base">x+1</span></span>' +
    "</span> 成立</p>";
  assert.equal(convert(html), "结果 x+1 成立");
});

test("bare MathML with annotation converts without duplicated glyphs", () => {
  const inline =
    '<p>值 <math xmlns="http://www.w3.org/1998/Math/MathML">' +
    "<semantics><mrow><mi>y</mi></mrow>" +
    '<annotation encoding="application/x-tex">y_i</annotation>' +
    "</semantics></math> 已知</p>";
  assert.equal(convert(inline), "值 $y_i$ 已知");
  const display =
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' +
    "<semantics><mrow><mi>y</mi></mrow>" +
    '<annotation encoding="application/x-tex">y_i = x_i</annotation>' +
    "</semantics></math>";
  assert.equal(convert(display), "$$y_i = x_i$$");
});

// ---------------------------------------------------------------------------
// New behavior: task-list checkboxes.
// ---------------------------------------------------------------------------

test("task-list checkboxes convert to [x] / [ ] markers", () => {
  const html =
    '<ul class="contains-task-list">' +
    '<li class="task-list-item"><input disabled="" type="checkbox" checked=""> 已完成项</li>' +
    '<li class="task-list-item"><input disabled="" type="checkbox"> 未完成项</li>' +
    "</ul>";
  assert.equal(convert(html), "- [x] 已完成项\n- [ ] 未完成项");
});

test("checkbox markers keep a separating space when the label has none", () => {
  const html =
    '<ul><li><input type="checkbox" checked="">已完成项</li></ul>';
  assert.equal(convert(html), "- [x] 已完成项");
});

test("non-checkbox inputs stay suppressed", () => {
  assert.equal(convert('<p>前<input type="text" value="x">后</p>'), "前后");
});

// ---------------------------------------------------------------------------
// New behavior: nested lists keep their hierarchy via indentation.
// ---------------------------------------------------------------------------

test("nested unordered lists are indented two spaces per level", () => {
  const html =
    "<ul>" +
    "<li><p>第一层 A</p><ul>" +
    "<li><p>第二层 A1</p><ul><li>第三层 A1a</li><li>第三层 A1b</li></ul></li>" +
    "<li>第二层 A2</li>" +
    "</ul></li>" +
    "<li>第一层 B</li>" +
    "</ul>";
  assert.equal(
    convert(html),
    [
      "- 第一层 A",
      "  - 第二层 A1",
      "    - 第三层 A1a",
      "    - 第三层 A1b",
      "  - 第二层 A2",
      "- 第一层 B",
    ].join("\n"),
  );
});

test("lists nested under ordered items are indented three spaces", () => {
  const html =
    "<ol>" +
    "<li><p>第一项</p><ul><li>子项甲</li><li>子项乙</li></ul></li>" +
    "<li>第二项</li>" +
    "</ol>";
  assert.equal(
    convert(html),
    ["1. 第一项", "   - 子项甲", "   - 子项乙", "2. 第二项"].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// New behavior: inline images and labeled SVG icons degrade to their text.
// ---------------------------------------------------------------------------

test("inline images degrade to their alt text", () => {
  assert.equal(
    convert('<p>看 <img src="blob:x" alt="示意图"> 即可</p>'),
    "看 示意图 即可",
  );
  assert.equal(convert('<p>前<img src="blob:x">后</p>'), "前后");
});

test("labeled svg icons degrade to their label; decorative svg stays silent", () => {
  assert.equal(
    convert('<p>注意 <svg aria-label="警告图标"><path d="M0 0"></path></svg> 这里</p>'),
    "注意 警告图标 这里",
  );
  assert.equal(
    convert('<p>注意 <svg><title>提示</title><path d="M0 0"></path></svg> 这里</p>'),
    "注意 提示 这里",
  );
  assert.equal(convert('<p>前<svg><path d="M0 0"></path></svg>后</p>'), "前后");
});
