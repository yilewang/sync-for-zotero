/**
 * [webchat] Auto-start the relay server if it isn't already running.
 *
 * Uses Mozilla's Subprocess module (Gecko/Zotero runtime) to spawn
 * `node server.mjs` in the background.  Falls back to nsIProcess if
 * Subprocess is not available.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let serverProcess: any = null;
let serverRunning = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

/** Check if the relay server is reachable. */
export async function isServerAlive(host: string): Promise<boolean> {
  try {
    const fetchFn = getFetch();
    const url = `${host.replace(/\/+$/, "")}/poll_response?since=0`;
    ztoolkit.log(`[webchat] Health check: ${url}`);
    const res = await fetchFn(url);
    ztoolkit.log(`[webchat] Health check response: ${res.status}`);
    return res.ok;
  } catch (err) {
    ztoolkit.log(`[webchat] Health check failed: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server path resolution
// ---------------------------------------------------------------------------

/**
 * Locate server.mjs relative to the plugin's installation directory.
 * The repo layout is:
 *   sync-for-zotero/
 *     plugin/          ← plugin source
 *     web_host/
 *       server.mjs     ← standalone server
 *
 * At runtime the plugin's root dir can be derived from the extension's
 * install path.  We also support an explicit preference override.
 */
function resolveServerScript(): string | null {
  // 1. Check explicit preference
  try {
    const pref = Zotero.Prefs.get("extensions.zotero.llmForZotero.webhost.serverPath", true) as string | undefined;
    if (pref && typeof pref === "string" && pref.length > 0) {
      return pref;
    }
  } catch { /* no pref set */ }

  // 2. Try common locations relative to the profile / data directory
  const candidates: string[] = [];

  // Zotero data directory (where extensions are installed)
  try {
    const dataDir = Zotero.DataDirectory?.dir;
    if (dataDir) {
      // Go up from data dir and look for the repo checkout
      const parent = dataDir.split(/[\\/]/).slice(0, -1).join("/");
      candidates.push(`${parent}/sync-for-zotero/web_host/server.mjs`);
    }
  } catch { /* ignore */ }

  // Home directory common locations
  try {
    const home = (Components as any).classes["@mozilla.org/file/directory_service;1"]
      ?.getService((Components as any).interfaces.nsIProperties)
      ?.get("Home", (Components as any).interfaces.nsIFile)?.path;
    if (home) {
      candidates.push(`${home}/workspace/sync-for-zotero/web_host/server.mjs`);
      candidates.push(`${home}/sync-for-zotero/web_host/server.mjs`);
      candidates.push(`${home}/Desktop/sync-for-zotero/web_host/server.mjs`);
      candidates.push(`${home}/Documents/sync-for-zotero/web_host/server.mjs`);
    }
  } catch { /* ignore */ }

  for (const p of candidates) {
    try {
      const file = (Components as any).classes["@mozilla.org/file/local;1"]
        .createInstance((Components as any).interfaces.nsIFile);
      file.initWithPath(p);
      if (file.exists()) return p;
    } catch { /* skip */ }
  }

  return null;
}

/** Find the `node` executable. */
function resolveNodePath(): string {
  // 1. Check explicit preference
  try {
    const pref = Zotero.Prefs.get("extensions.zotero.llmForZotero.webhost.nodePath", true) as string | undefined;
    if (pref && typeof pref === "string" && pref.length > 0) {
      return pref;
    }
  } catch { /* no pref set */ }

  const isWin = (Zotero as any).isWin ||
    (typeof navigator !== "undefined" && /win/i.test(navigator.platform || ""));
  if (isWin) return "C:\\Program Files\\nodejs\\node.exe";

  // macOS / Linux: try common paths including nvm, fnm, volta, asdf
  const home = getHomePath();
  const paths = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
  ];

  // Add nvm paths (scan for any installed version)
  if (home) {
    try {
      const nvmDir = `${home}/.nvm/versions/node`;
      const file = (Components as any).classes["@mozilla.org/file/local;1"]
        .createInstance((Components as any).interfaces.nsIFile);
      file.initWithPath(nvmDir);
      if (file.exists() && file.isDirectory()) {
        const entries = file.directoryEntries;
        const versions: string[] = [];
        while (entries.hasMoreElements()) {
          const entry = entries.getNext().QueryInterface((Components as any).interfaces.nsIFile);
          if (entry.isDirectory()) versions.push(entry.leafName);
        }
        // Sort versions descending so we pick the latest
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions) {
          paths.unshift(`${nvmDir}/${v}/bin/node`);
        }
      }
    } catch { /* nvm not installed */ }

    // fnm
    paths.push(`${home}/.fnm/node-versions/default/installation/bin/node`);
    paths.push(`${home}/Library/Application Support/fnm/node-versions/default/installation/bin/node`);
    // volta
    paths.push(`${home}/.volta/bin/node`);
  }

  for (const p of paths) {
    try {
      const f = (Components as any).classes["@mozilla.org/file/local;1"]
        .createInstance((Components as any).interfaces.nsIFile);
      f.initWithPath(p);
      if (f.exists()) return p;
    } catch { /* skip */ }
  }

  throw new Error(
    "Cannot find Node.js. Install Node.js or set the preference " +
    "extensions.zotero.llmForZotero.webhost.nodePath to the full path of the node executable."
  );
}

function getHomePath(): string | null {
  try {
    return (Components as any).classes["@mozilla.org/file/directory_service;1"]
      ?.getService((Components as any).interfaces.nsIProperties)
      ?.get("Home", (Components as any).interfaces.nsIFile)?.path ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

async function launchServer(host: string): Promise<void> {
  const serverScript = resolveServerScript();
  if (!serverScript) {
    ztoolkit.log("[webchat] Cannot find server.mjs — please set webhost.serverPath preference");
    throw new Error(
      "Cannot auto-start relay server: server.mjs not found.\n" +
      "Set the preference extensions.zotero.llmForZotero.webhost.serverPath to the full path of web_host/server.mjs"
    );
  }

  const nodePath = resolveNodePath();
  const port = new URL(host).port || "7878";

  ztoolkit.log(`[webchat] Auto-starting relay: ${nodePath} ${serverScript} --port ${port}`);

  // Try Mozilla Subprocess.call (Zotero 7+) — non-blocking
  try {
    let Subprocess: any;
    const CU = (globalThis as any).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        Subprocess = mod.Subprocess || mod.default || mod;
      } catch { /* fallback below */ }
    }
    if (!Subprocess && CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        Subprocess = mod.Subprocess || mod;
      } catch { /* fallback below */ }
    }

    if (Subprocess?.call) {
      serverProcess = await Subprocess.call({
        command: nodePath,
        arguments: [serverScript, "--port", port],
        environment: {},
      });
      serverRunning = true;

      // Drain stdout/stderr in background to prevent pipe buffer deadlock
      (async () => {
        try { while (await serverProcess.stdout?.readString()) { /* discard */ } } catch { /* done */ }
      })();
      (async () => {
        try { while (await serverProcess.stderr?.readString()) { /* discard */ } } catch { /* done */ }
      })();

      return;
    }
  } catch (err) {
    ztoolkit.log(`[webchat] Subprocess.call failed: ${err}`);
  }

  // Fallback: nsIProcess (fire-and-forget, no stdout)
  try {
    const Cc = (Components as any).classes;
    const Ci = (Components as any).interfaces;
    const nodeFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    nodeFile.initWithPath(nodePath);
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(nodeFile);
    proc.run(false, [serverScript, "--port", port], 3); // non-blocking
    serverRunning = true;
  } catch (err) {
    throw new Error(`Failed to start relay server: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the relay server is running. If not, start it and wait until ready.
 * Call this before any webchat HTTP request.
 */
export async function ensureServer(host: string): Promise<void> {
  // Quick check: already reachable?
  if (await isServerAlive(host)) {
    ztoolkit.log("[webchat] Relay server already running");
    return;
  }

  ztoolkit.log("[webchat] Relay server not reachable, attempting to start...");

  // Not running — try to start (may fail if port is taken, that's OK)
  if (!serverRunning) {
    try {
      await launchServer(host);
    } catch (err) {
      ztoolkit.log(`[webchat] Launch attempt failed: ${err}`);
      // Don't throw yet — the server might already be running but our
      // initial health check was too early. Keep polling below.
    }
  }

  // Wait up to 15s for the server to become ready
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => (ztoolkit.getGlobal("setTimeout") as typeof setTimeout)(r, 1000));
    if (await isServerAlive(host)) {
      ztoolkit.log("[webchat] Relay server is now reachable");
      return;
    }
  }

  throw new Error(
    "Relay server not reachable at " + host + ".\n" +
    "Please start it manually: node web_host/server.mjs"
  );
}

/** Stop the relay server if we started it. Called on plugin shutdown. */
export function stopServer(): void {
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* ignore */ }
    serverProcess = null;
  }
  serverRunning = false;
}
