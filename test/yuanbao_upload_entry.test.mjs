import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../extension/content_script.js", import.meta.url),
  "utf8",
);
const helperCode = source.slice(
  source.indexOf("/** Yuanbao labels its composer attach control"),
  source.indexOf("/** Wait for the lazily created file input"),
);

function makeButton(attrs = {}, { text = "" } = {}) {
  return {
    textContent: text,
    visible: true,
    clicks: 0,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    click() {
      this.clicks += 1;
    },
  };
}

function createHarness({
  composerButtons = [],
  fallbackButtons = [],
  menuItems = [],
} = {}) {
  const composer = { querySelectorAll: () => composerButtons };
  const document = {
    querySelector(selector) {
      return selector === ".chat-command-editor-specail" ? composer : null;
    },
    querySelectorAll(selector) {
      return selector.includes("menuitem") ? menuItems : fallbackButtons;
    },
  };
  const context = vm.createContext({
    document,
    isVisibleElement: (element) => element.visible !== false,
    sleep: async () => {},
  });
  vm.runInContext(helperCode, context);
  return {
    find: () => vm.runInContext("findYuanbaoAttachButton()", context),
    menu: (labels, timeoutMs = 5000) =>
      vm.runInContext(
        `waitForYuanbaoMenuItem(${JSON.stringify(labels)}, ${timeoutMs})`,
        context,
      ),
  };
}

test("finds the attach button and menu item by their Chinese labels", async () => {
  const attach = makeButton({ "aria-label": "添加" });
  const localFiles = makeButton({}, { text: "本地文件" });
  const page = createHarness({
    composerButtons: [attach],
    menuItems: [localFiles],
  });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(["本地文件", "Local Files"]), localFiles);
});

test("finds the attach button and menu item in Yuanbao's English UI", async () => {
  const attach = makeButton({ "aria-label": "Add" });
  const localFiles = makeButton({}, { text: "Local Files" });
  const page = createHarness({
    composerButtons: [attach],
    menuItems: [localFiles],
  });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(["本地文件", "Local Files"]), localFiles);
});

test("falls back to a page-wide scan and accepts menu aria-labels", async () => {
  const attach = makeButton({ "aria-label": "Add" });
  const localFiles = makeButton({ "aria-label": "Local Files" });
  const page = createHarness({
    composerButtons: [],
    fallbackButtons: [attach],
    menuItems: [localFiles],
  });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(["本地文件", "Local Files"]), localFiles);
});

test("ignores hidden and unrelated attach controls", () => {
  const hidden = makeButton({ "aria-label": "Add" });
  hidden.visible = false;
  const unrelated = makeButton({ "aria-label": "Search" });
  const page = createHarness({ composerButtons: [hidden, unrelated] });

  assert.equal(page.find(), null);
});
