import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");

test("canonicalizes ChatGPT conversation URLs without transient query or hash", () => {
  const canonical = shared.normalizeConversationUrl(
    "https://chatgpt.com/c/6a3dadf5-c2d8-83ea-847e-54de494aefcc?mweb_fallback=1#debug",
  );

  assert.equal(
    canonical,
    "https://chatgpt.com/c/6a3dadf5-c2d8-83ea-847e-54de494aefcc",
  );
});

test("matches ChatGPT history URLs after ChatGPT appends mweb_fallback", () => {
  assert.equal(
    shared.conversationUrlsMatch(
      "https://chatgpt.com/c/6a3dadf5-c2d8-83ea-847e-54de494aefcc?mweb_fallback=1",
      "https://chatgpt.com/c/6a3dadf5-c2d8-83ea-847e-54de494aefcc",
    ),
    true,
  );
});

test("keeps non-conversation URL matching strict apart from trailing slashes", () => {
  assert.equal(
    shared.conversationUrlsMatch(
      "https://chatgpt.com/?mweb_fallback=1",
      "https://chatgpt.com/",
    ),
    false,
  );
});

test("reuses non-empty ChatGPT ready transcripts instead of scraping twice", () => {
  assert.equal(
    shared.canReuseReadyTranscriptForScrape("chatgpt", {
      messages: [{ role: "assistant", text: "Loaded answer" }],
    }),
    true,
  );
});

test("keeps DeepSeek and empty ready transcripts on the full scrape path", () => {
  assert.equal(
    shared.canReuseReadyTranscriptForScrape("deepseek", {
      messages: [{ role: "assistant", text: "Loaded answer" }],
    }),
    false,
  );
  assert.equal(
    shared.canReuseReadyTranscriptForScrape("chatgpt", { messages: [] }),
    false,
  );
});
