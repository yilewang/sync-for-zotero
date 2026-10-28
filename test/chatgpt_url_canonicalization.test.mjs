import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");
const chatId = "6a3dadf5-c2d8-83ea-847e-54de494aefcc";
const chatUrl = `https://chatgpt.com/c/${chatId}`;
const projectUrl = `https://chatgpt.com/g/g-p-1234567890-research/c/${chatId}`;

test("matches a Project chat to its original URL by conversation identity", () => {
  assert.equal(shared.normalizeConversationUrl(`${projectUrl}/?model=auto#reply`), chatUrl);
  assert.equal(shared.conversationUrlsMatch(projectUrl, chatUrl), true);
  assert.equal(shared.conversationUrlsMatch(chatUrl, projectUrl), true);
  assert.equal(shared.conversationUrlsMatch(projectUrl.replace("research", "renamed"), projectUrl), true);
  assert.equal(shared.conversationUrlsMatch(projectUrl.replace(chatId, "other-id"), chatUrl), false);
});

test("resolves Project bindings while preserving the navigation route", () => {
  assert.deepEqual(shared.resolveExpectedConversationBinding({
    expected_chat_url: `${projectUrl}/?model=auto#reply`, expected_chat_id: chatId,
  }, "chatgpt"), { chatUrl: projectUrl, chatId });
  assert.deepEqual(shared.resolveExpectedConversationBinding({ expected_chat_id: chatId }, "chatgpt"), { chatUrl, chatId });
  assert.throws(() => shared.resolveExpectedConversationBinding({
    expected_chat_url: projectUrl, expected_chat_id: "other-id",
  }, "chatgpt"), /ID does not match/);
});

test("Project matching rejects other origins, landing pages, and malformed conversation paths", () => {
  for (const invalid of [
    projectUrl.replace("https:", "http:"),
    projectUrl.replace("chatgpt.com", "example.com"),
    projectUrl.replace("chatgpt.com", "chatgpt.com.example.com"),
    projectUrl.replace("https://", "https://user:password@"),
    projectUrl.replace(`/c/${chatId}`, "/project"),
    projectUrl.replace("/g/g-p-1234567890-research/", "/unrelated/"),
    `${projectUrl}/extra`, `${chatUrl}/extra`,
  ]) {
    assert.equal(shared.conversationUrlsMatch(invalid, chatUrl), false, invalid);
    assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: invalid }, "chatgpt"), /Invalid.*URL/, invalid);
  }
});

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
