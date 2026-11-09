import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = fs.readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);

const FUNCTION_START = "async function ensureContentScript(";
const FUNCTION_END = "// Status broadcasting";

function ensureContentScriptSource() {
  const start = backgroundSource.indexOf(FUNCTION_START);
  const end = backgroundSource.indexOf(FUNCTION_END, start);
  assert.ok(start >= 0, "ensureContentScript not found");
  assert.ok(end > start, "ensureContentScript end marker not found");
  return backgroundSource.slice(start, end);
}

function createHarness({ globalsPresent, answersAfterReload = true }) {
  const calls = { contentInjection: 0, mainWorldInjection: 0, probes: 0, reloads: 0 };
  let pong = false;

  const context = vm.createContext({
    console,
    setTimeout,
    CONTENT_SCRIPT_RECOVERY_TIMEOUT_MS: 20,
    getSiteConfigByUrl: () => ({ siteId: "chatgpt" }),
    shared: {
      contentScriptMeetsDeliveryContractRequirement: () => pong,
    },
    reloadTab: async () => {
      calls.reloads += 1;
      if (answersAfterReload) pong = true;
    },
    waitForTabLoad: async () => {},
    chrome: {
      runtime: {},
      tabs: {
        get: async () => ({ id: 7, url: "https://chatgpt.com/c/123" }),
        sendMessage: (_tabId, _message, callback) =>
          callback(pong ? { pong: true, supportedTargets: ["chatgpt"] } : undefined),
      },
      scripting: {
        executeScript: async (options) => {
          if (options.world === "MAIN") {
            calls.mainWorldInjection += 1;
            return [];
          }
          if (options.func) {
            calls.probes += 1;
            return [{ result: globalsPresent }];
          }
          calls.contentInjection += 1;
          pong = true;
          return [];
        },
      },
    },
  });

  vm.runInContext(ensureContentScriptSource(), context);
  return {
    calls,
    run: () => vm.runInContext("ensureContentScript(7, 1)", context),
  };
}

test("reloads a tab whose isolated world still holds a stale content script", async () => {
  const harness = createHarness({ globalsPresent: true });

  const health = await harness.run();

  assert.equal(health.pong, true);
  assert.equal(harness.calls.contentInjection, 0);
  assert.equal(harness.calls.reloads, 1);
});

test("never re-declares the content script when a reload cannot revive it", async () => {
  const harness = createHarness({ globalsPresent: true, answersAfterReload: false });

  await assert.rejects(harness.run(), /did not advertise WebChat delivery contract/);
  assert.equal(harness.calls.contentInjection, 0);
  assert.equal(harness.calls.reloads, 1);
});

test("injects the content script when the isolated world is empty", async () => {
  const harness = createHarness({ globalsPresent: false });

  const health = await harness.run();

  assert.equal(health.pong, true);
  assert.equal(harness.calls.contentInjection, 1);
  assert.equal(harness.calls.reloads, 0);
});
