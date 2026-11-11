import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../extension/webchat_shared.js");
const source = readFileSync(
  new URL("../extension/content_script.js", import.meta.url),
  "utf8",
);

test("collects Yuanbao history rows that carry data-conversation-id", () => {
  assert.match(source, /\.yb-recent-conv-list__item/);
  assert.match(source, /historyLinkSelector:[\s\S]{0,120}\[data-conversation-id\]/);
  assert.match(
    source,
    /String\(row\.getAttribute\?\.\("data-conversation-id"\) \|\| ""\)\.trim\(\)/,
  );
});

test("keeps supporting the legacy conversation anchors", () => {
  assert.match(source, /a\[href\*='\/chat\/'\]/);
  assert.match(
    source,
    /const hrefMatch = href\.match\([\s\S]{0,40}\/\\\/chat\\\//,
  );
});

test("deletes a conversation by id instead of by anchor only", () => {
  assert.match(
    source,
    /deleteChatLinkSelector\(chatId\)[\s\S]{0,80}\[data-conversation-id="\$\{chatId\}"\]/,
  );
});

test("builds history URLs as /chat/<agentId>/<conversationId>", () => {
  assert.match(source, /getAttribute\?\.\("dt-agent-id"\)/);
  assert.match(
    source,
    /chatUrl: `https:\/\/yuanbao\.tencent\.com\/chat\/\$\{agentId\}\/\$\{id\}`/,
  );
});

test("reads the Yuanbao conversation id from the last URL segment", () => {
  assert.equal(
    shared.normalizeConversationUrl(
      "https://yuanbao.tencent.com/chat/naQivTmsDa/0Rz183UAjJ2",
    ),
    "https://yuanbao.tencent.com/chat/0Rz183UAjJ2",
  );
  assert.deepEqual(
    shared.resolveExpectedConversationBinding(
      {
        expected_chat_url:
          "https://yuanbao.tencent.com/chat/naQivTmsDa/0Rz183UAjJ2",
      },
      "yuanbao",
    ),
    {
      chatUrl: "https://yuanbao.tencent.com/chat/naQivTmsDa/0Rz183UAjJ2",
      chatId: "0Rz183UAjJ2",
    },
  );
});
