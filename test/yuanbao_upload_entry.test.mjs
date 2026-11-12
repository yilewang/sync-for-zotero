import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../extension/content_script.js", import.meta.url),
  "utf8",
);
const helperCode = source.slice(
  source.indexOf("const YUANBAO_ATTACH_LABEL_RE"),
  source.indexOf("/** Wait for the lazily created file input"),
);

function makeButton(attrs = {}, { text = "" } = {}) {
  return {
    textContent: text,
    visible: true,
    clicks: 0,
    querySelector: () => null,
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

function makeMenuItem({ text = "", textNode = null } = {}) {
  return {
    textContent: text,
    visible: true,
    clicks: 0,
    querySelector(selector) {
      return textNode && selector.includes("item-text") ? textNode : null;
    },
    getAttribute: () => null,
    click() {
      this.clicks += 1;
    },
  };
}

function createHarness({
  composerIcon = null,
  composerButtons = [],
  fallbackIcon = null,
  fallbackButtons = [],
  menuItems = [],
  scopes = [".chat-input-editor"],
} = {}) {
  const composer = {
    querySelector(selector) {
      return selector.includes("UploadFileSelector_iconButton") ? composerIcon : null;
    },
    querySelectorAll: () => composerButtons,
  };
  const body = {
    querySelector(selector) {
      return selector.includes("UploadFileSelector_iconButton") ? fallbackIcon : null;
    },
    querySelectorAll: () => fallbackButtons,
  };
  const document = {
    body,
    querySelector(selector) {
      return scopes.includes(selector) ? composer : null;
    },
    querySelectorAll(selector) {
      return selector.includes("menuitem") || selector.includes("dropdown__item")
        ? menuItems
        : [];
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

const MENU_LABELS = ["本地文件", "Local Files"];

test("finds the labelled attach control and menu row in the Chinese UI", async () => {
  const attach = makeButton({ "aria-label": "添加" });
  const localFiles = makeMenuItem({ text: "本地文件" });
  const page = createHarness({ composerButtons: [attach], menuItems: [localFiles] });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(MENU_LABELS), localFiles);
});

test("finds the labelled attach control and menu row in the English UI", async () => {
  const attach = makeButton({ "aria-label": "Add" });
  const localFiles = makeMenuItem({ text: "Local Files" });
  const page = createHarness({ composerButtons: [attach], menuItems: [localFiles] });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(MENU_LABELS), localFiles);
});

test("finds the unlabelled UploadFileSelector icon and the TDesign dropdown row", async () => {
  const attach = makeButton({ class: "UploadFileSelector_iconButton__LEwqk" });
  const rowText = { textContent: "Local Files" };
  const localFiles = makeMenuItem({ text: "Local Files", textNode: rowText });
  const page = createHarness({ composerIcon: attach, menuItems: [localFiles] });

  assert.equal(page.find(), attach);
  assert.equal(await page.menu(MENU_LABELS), localFiles);
});

test("falls back to a page-wide icon scan when the composer scope changed", async () => {
  const attach = makeButton({ class: "UploadFileSelector_iconButton__LEwqk" });
  const page = createHarness({
    fallbackIcon: attach,
    menuItems: [makeMenuItem({ text: "Local Files" })],
    scopes: [],
  });

  assert.equal(page.find(), attach);
});

test("ignores hidden and unrelated attach controls", () => {
  const hidden = makeButton({ "aria-label": "Add" });
  hidden.visible = false;
  const unrelated = makeButton({ "aria-label": "Search" });
  const page = createHarness({ composerButtons: [hidden, unrelated] });

  assert.equal(page.find(), null);
});

test("stays quiet when the site renames the sent attachment", () => {
  assert.match(
    source,
    /if \(SITE_ADAPTER\?\.submittedAttachmentEvidenceOptional !== true\) \{[\s\S]{0,240}site names differently/,
  );
});
