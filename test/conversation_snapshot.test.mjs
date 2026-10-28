import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";

function setup(markup, extra = {}) {
  const { document, window } = parseHTML(
    "<html><head></head><body>" + markup + "</body></html>",
  );
  const context = vm.createContext({ URL, TextEncoder, setTimeout, console });
  vm.runInContext(
    readFileSync(
      new URL("../extension/conversation_snapshot.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const api = context.SyncZoteroSnapshot;
  const env = {
    document,
    window: { location: { href: "https://chatgpt.com/c/test-123" } },
    createDocument: () =>
      parseHTML("<html><head></head><body></body></html>").document,
    getComputedStyle: (el) => ({
      getPropertyValue: (key) =>
        key === "color"
          ? "rgb(12, 30, 90)"
          : key === "border-radius"
            ? "12px"
            : "",
    }),
    fetchImage: async () => "data:image/png;base64,aGVsbG8=",
    ...extra,
  };
  return {
    api,
    env,
    document,
    capture: () => api.capture(env.window.location.href, env),
  };
}

test("DIL snapshot preserves cards, tables, SVG paths and images without sidebar or executable content", async () => {
  const s = setup(
    `<aside>Private account/sidebar</aside><div data-content-search-unit-key="fallback-turn-0:0:user">Explain this paper</div><div data-content-search-unit-key="fallback-turn-0:2:assistant"><section style="border-radius:12px"><h2>Result</h2><table><tr><td>42</td></tr></table><svg viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg><img src="https://example.com/image.png" onerror="evil()"><script>secret()</script><button>Share</button><iframe src="https://example.com"></iframe><a href="javascript:evil()">bad</a></section></div>`,
  );
  const result = await s.capture();
  assert.equal(result.messageCount, 2);
  assert.match(result.html, /border-radius:12px/);
  assert.match(result.html, /<table/);
  assert.match(result.html, /<path/);
  assert.match(result.html, /data:image\/png;base64/);
  assert.match(result.html, /Content-Security-Policy/);
  assert.doesNotMatch(
    result.html,
    /Private account|secret\(\)|<script|<iframe|onerror|javascript:|>Share</,
  );
});

test("legacy markup works and nested role containers are not duplicated", async () => {
  const s = setup(
    '<div data-message-author-role="user">Question</div><div data-message-author-role="assistant"><p>Answer</p><div data-message-author-role="assistant">nested</div></div>',
  );
  assert.equal((await s.capture()).messageCount, 2);
});

test("mismatched URL, missing messages, and active generation fail explicitly", async () => {
  const s = setup('<div data-message-author-role="user">Q</div>');
  await assert.rejects(
    s.api.capture("https://chatgpt.com/c/other", s.env),
    /changed/,
  );
  await assert.rejects(
    setup("<aside>Sidebar only</aside>").capture(),
    /No conversation/,
  );
  await assert.rejects(
    setup('<button data-testid="stop-button"></button>').capture(),
    /finish/,
  );
});

test("failed images reject incomplete snapshots", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><img src="https://private.example/image"></div>',
    {
      fetchImage: async () => {
        throw new Error("CORS");
      },
    },
  );
  await assert.rejects(s.capture(), /No incomplete snapshot/);
});

test("preserves inline references and SVG HTML labels, without interactive handlers", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><p>Journal <button onclick="evil()">Decision Support Systems</button><span role="button">main 1.pdf</span></p><svg viewBox="0 0 752 340"><foreignObject x="55" y="315" width="164" height="24"><div>前 1 个</div></foreignObject></svg></div>',
  );
  const result = await s.capture();
  assert.match(result.html, /Decision Support Systems/);
  assert.match(result.html, /main 1.pdf/);
  assert.match(result.html, /foreignobject/i);
  assert.match(result.html, /前 1 个/);
  assert.doesNotMatch(result.html, /onclick|<button|role="button"/);
});

test("exports one native formula instead of both KaTeX representations", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><span class="katex"><span class="katex-mathml"><math><mover accent="true"><mi>Y</mi><mo stretchy="true">^</mo></mover></math></span><span class="katex-html">DUPLICATE</span></span></div>',
  );
  const result = await s.capture();
  assert.equal((result.html.match(/<math/g) || []).length, 1);
  assert.match(result.html, /accent="true"/);
  assert.doesNotMatch(result.html, /DUPLICATE/);
});

test("navigation during image capture rejects rather than saving the wrong conversation", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><img src="https://example.com/image"></div>',
  );
  s.env.fetchImage = async () => {
    s.env.window.location.href = "https://chatgpt.com/c/other";
    return "data:image/png;base64,aGVsbG8=";
  };
  await assert.rejects(s.capture(), /changed while saving/);
});

test("does not archive a ChatGPT response loading failure as a complete conversation", async () => {
  const s = setup(
    '<div data-message-author-role="user">Question</div><div data-message-author-role="assistant"><div role="status">无法加载此回复</div></div>',
  );
  await assert.rejects(s.capture(), /could not load this response/);
});
