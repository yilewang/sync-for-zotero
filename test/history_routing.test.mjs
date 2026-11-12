import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const historyCode = source.slice(
  source.indexOf("async function scrapeChatGPTHistory("),
  source.indexOf("// History Mirroring Logic"),
);

for (const siteId of ["gemini", "chatgpt", "deepseek", "yuanbao"]) {
  test(`${siteId} history uses its intended refresh policy and forwards the scrape request`, async () => {
    const events = [];
    const config = { siteId, urlPattern: `https://${siteId}.example/*`, homeUrl: `https://${siteId}.example/` };
    const context = vm.createContext({
      pipelineRunning: false, zoteroConnected: true, activeTarget: siteId,
      SERVER: "http://relay", SITE_CONFIGS: { [siteId]: config },
      getSiteConfig: () => config,
      relayFetch: async () => ({ json: async () => ({ command: { type: "SCRAPE_HISTORY" } }) }),
      chrome: { tabs: {
        query: async ({ url }) => { assert.equal(url, config.urlPattern); return [{ id: 7, url: config.homeUrl }]; },
        create: async () => { events.push("create"); return { id: 8 }; },
        update: async () => { events.push("navigate"); },
      } },
      findSiteHomeTab: (tabs) => tabs[0],
      resetNetworkCacheInTab: async () => { events.push("reset"); },
      reloadTab: async () => { events.push("reload"); },
      waitForTabLoad: async () => { events.push("load"); },
      ensureContentScript: async () => { events.push("ensure"); },
      sendToContentScript: async (id, message) => {
        assert.equal(id, 7);
        assert.equal(message.type, "SCRAPE_HISTORY_NOW");
        assert.equal(message.force, true);
        assert.ok(message.minCapturedAt > 0);
        events.push("scrape");
        return { ok: true };
      },
      serverPost: async () => { events.push("error"); },
      hostnameFromUrl: (url) => new URL(url).hostname,
    });
    vm.runInContext(historyCode, context);
    await vm.runInContext("pollForCommand()", context);
    assert.deepEqual(events, siteId === "deepseek"
      ? ["reset", "reload", "load", "ensure", "scrape"]
      : ["ensure", "scrape"]);
  });
}
