# Sync for Zotero

[中文说明](README_CN.md)

A Chromium extension that works as the **webchat bridge** for the [LLM for Zotero](https://github.com/yilewang/llm-for-zotero) plugin. It connects Zotero to ChatGPT or DeepSeek via the browser: uploading PDFs and images, running prompts, syncing chat actions, and returning markdown results back to Zotero.

> **This extension is not a standalone tool.** It requires the LLM for Zotero plugin (v3.7.17 or later) with **webchat mode** selected in the plugin preferences.

## How It Works

1. LLM for Zotero starts a local relay server and queues PDF + prompt requests
2. This extension discovers the relay server and polls for pending queries
3. When a query arrives, the extension opens the selected web chat target, uploads attachments, submits the prompt, and waits for the response
4. The response is extracted as markdown and sent back to Zotero through the relay

## Prerequisites

- [Zotero](https://www.zotero.org/) with the **[LLM for Zotero](https://github.com/yilewang/llm-for-zotero) plugin v3.7.17+** installed
- In LLM for Zotero preferences, set the mode to **webchat**
- A ChatGPT or DeepSeek account, depending on the webchat target selected in LLM for Zotero

## Installation

### Chrome / Edge / Chromium (load as unpacked extension)

1. Download the `extension.zip` or clone this repository
2. Unzip the file to your local machine
3. Open your browser's extensions page:
   - Chrome: `chrome://extensions/`
   - Microsoft Edge: `edge://extensions/`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked**
6. Select the `extension/` folder from the unzipped file
7. The "Sync for Zotero" icon should appear in your toolbar

### Updating

When a new version is available, choose one of the following methods depending on how you installed the extension:

#### Option A: Git (if you cloned the repository)

1. Open a terminal and navigate to the cloned repository folder
2. Run `git pull` to fetch the latest changes
3. Open your browser's extensions page (`chrome://extensions/` or `edge://extensions/`)
4. Find the "Sync for Zotero" card and click the **reload** (↻) icon
5. Done — the extension is now updated

#### Option B: ZIP download (if you downloaded the release)

1. Download the latest `extension.zip` from the [Releases](https://github.com/yilewang/sync-for-zotero/releases) page
2. Unzip the file and **replace** the old `extension/` folder with the new one
3. Open your browser's extensions page (`chrome://extensions/` or `edge://extensions/`)
4. Find the "Sync for Zotero" card and click the **reload** (↻) icon
5. Done — the extension is now updated

> **Tip:** Do not delete the old folder from the browser and re-load it. Simply replacing the files and clicking reload preserves your extension settings.

## Usage

1. Make sure Zotero is running with LLM for Zotero active (webchat mode)
2. Open ChatGPT or DeepSeek in a browser tab
3. Click the extension icon to verify connection status
4. Send queries from Zotero — the extension handles the rest

## Releasing (maintainers)

Run one of the following commands from a clean `main` branch:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

The release command validates the repository, runs the automated checks, requires you to confirm the live Zotero-to-WebChat smoke test, updates the extension version when needed, creates and pushes the release tag, prepares release notes, creates a draft GitHub release, and dispatches the packaging workflow.
GitHub Actions validates the tag, runs the tests again, creates `extension.zip`, and uploads it to the draft.
The command publishes the release only after the workflow succeeds and the ZIP asset is present.

Preview a patch release without creating a commit, tag, workflow run, or release:

```bash
npm run release:patch -- --dry-run
```

Generated release notes come from commit subjects since the latest published tag.
Use `--edit-notes` to edit them before release, or `--notes-file <path>` to supply a prepared Markdown file.
If a network or workflow failure interrupts a release, fix the reported problem and rerun the same command; the command resumes the matching draft or tag instead of incrementing the version again.

## Browser Compatibility

This extension targets modern Chromium browsers with Manifest V3 support, including Google Chrome and Microsoft Edge. It uses Chrome extension APIs such as `chrome.storage.session`, service workers, and `MAIN` world content scripts, so older Chromium builds are not supported.

On Windows, make sure Windows Defender Firewall or third-party security software allows Zotero to accept loopback connections from the browser. The extension discovers the LLM for Zotero webchat relay on `127.0.0.1` or `localhost`, ports `23119`-`23128`.

## License

See [LICENSE](LICENSE) for details.
