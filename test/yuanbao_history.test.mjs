import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(source, /const hrefMatch = href\.match\(\/\\\/chat\\\//);
});

test("deletes a conversation by id instead of by anchor only", () => {
  assert.match(
    source,
    /deleteChatLinkSelector\(chatId\)[\s\S]{0,80}\[data-conversation-id="\$\{chatId\}"\]/,
  );
});
