import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { conversationFollowup } from "./helpers/conversation_workflow.mjs";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");
const providers = [
  { target: "chatgpt", url: "https://chatgpt.com/c/6a3dadf5-c2d8-83ea-847e-54de494aefcc" },
  { target: "deepseek", url: "https://chat.deepseek.com/a/chat/s/6a3dadf5-c2d8-83ea-847e-54de494aefcc" },
  { target: "gemini", url: "https://gemini.google.com/app/d11114e59cd9e350" },
];

test("unknown provider bindings never fall through to another provider", () => {
  for (const target of ["unknown", "toString", "__proto__"]) {
    assert.throws(() => shared.resolveExpectedConversationBinding({}, target), /Unsupported WebChat target/);
    assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: providers[1].url }, target), /Unsupported WebChat target/);
  }
});

for (const { target, url } of providers) {
  const id = url.split("/").pop();
  const home = target === "gemini" ? "https://gemini.google.com/app" : new URL(url).origin + "/";
  const variant = `${url}/?view=compact#reply`;
  const wrongUrl = url.replace(id, "aaaaaaaaaaaaaaaa");

  test(`${target}: valid URL variants resolve and match the same conversation`, () => {
    for (const actual of [url, `${url}/`, `${url}?view=compact`, `${url}#reply`, variant]) {
      assert.equal(shared.normalizeConversationUrl(actual), url);
      assert.equal(shared.conversationUrlsMatch(actual, url), true);
      assert.equal(shared.conversationUrlsMatch(url, actual), true);
      assert.deepEqual(shared.resolveExpectedConversationBinding({ expected_chat_url: actual, expected_chat_id: id }, target), { chatUrl: url, chatId: id });
    }
    assert.deepEqual(shared.resolveExpectedConversationBinding({ expected_chat_id: id }, target), { chatUrl: url, chatId: id });
    assert.deepEqual(shared.resolveExpectedConversationBinding({ force_new_chat: true, expected_chat_url: url }, target), { chatUrl: null, chatId: null });
    assert.deepEqual(shared.resolveExpectedConversationBinding({}, target), { chatUrl: null, chatId: null });
    assert.equal(shared.conversationUrlsMatch(`${home}?view=compact`, home), false);
  });

  test(`${target}: rejects wrong conversations, providers, and malformed routes`, () => {
    assert.equal(shared.conversationUrlsMatch(wrongUrl, url), false);
    assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: url, expected_chat_id: "aaaaaaaaaaaaaaaa" }, target), /ID does not match/);
    for (const other of providers.filter((provider) => provider.target !== target)) {
      assert.equal(shared.conversationUrlsMatch(other.url, url), false);
      assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: other.url }, target), /Invalid.*URL/);
    }
    for (const invalid of [home, `${url}/extra`, url.replace("https:", "http:"),
      url.replace("https://", "https://user:password@"),
      url.replace(new URL(url).hostname, `${new URL(url).hostname}.example.com`),
    ]) {
      assert.equal(shared.conversationUrlsMatch(invalid, url), false);
      assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_url: invalid }, target), /Invalid.*URL/);
    }
    for (const invalidId of ["", " ", "id/extra", "id?query", "id#fragment", 42]) {
      assert.throws(() => shared.resolveExpectedConversationBinding({ expected_chat_id: invalidId }, target), /ID does not match/);
    }
  });

  test(`${target}: follow-up readiness and submission accept a decorated current URL without reloading`, async () => {
    const h = conversationFollowup({ target, expectedUrl: url, initialUrl: variant });
    await h.run();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.navigations, []);
    assert.equal(h.sent.length, 1);
    assert.equal(h.reports[0].remote_chat_id, id);
  });

  test(`${target}: restored binding tolerates a navigation that adds query and fragment`, async () => {
    const h = conversationFollowup({ target, expectedUrl: variant, initialUrl: home, redirectUrl: variant });
    await h.run({ pdf_base64: "synthetic-pdf", pdf_filename: "test.pdf" });
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.navigations, [url]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].pdfFilename, "test.pdf");
  });

  test(`${target}: readiness and submission still block a different conversation`, async () => {
    for (const options of [
      { initialUrl: wrongUrl, redirectUrl: wrongUrl },
      { initialUrl: variant, beforeSend: (page) => { page.window.location = new URL(wrongUrl); } },
    ]) {
      const h = conversationFollowup({ target, expectedUrl: url, ...options });
      await h.run();
      assert.equal(h.sent.length, 0);
      assert.equal(h.errors.length, 1);
      assert.match(h.errors[0], /conversation/);
    }
  });
}
