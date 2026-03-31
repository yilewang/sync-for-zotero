# Sync for Zotero

A Chrome extension that works as the **webchat bridge** for the [LLM for Zotero](https://github.com/yat-lok/llm-for-zotero) plugin. It connects Zotero to ChatGPT via the browser: uploading PDFs, running prompts, and returning markdown results back to Zotero.

> **This extension is not a standalone tool.** It requires the LLM for Zotero plugin (v3.7.17 or later) with **webchat mode** selected in the plugin preferences.

## How It Works

1. LLM for Zotero starts a local relay server and queues PDF + prompt requests
2. This extension discovers the relay server and polls for pending queries
3. When a query arrives, the extension uploads the PDF to ChatGPT, submits the prompt, and waits for the response
4. The response is extracted as markdown and sent back to Zotero through the relay

## Prerequisites

- [Zotero](https://www.zotero.org/) with the **[LLM for Zotero](https://github.com/yat-lok/llm-for-zotero) plugin v3.7.17+** installed
- In LLM for Zotero preferences, set the mode to **webchat**
- A ChatGPT account (you must keep a tab open at chatgpt.com while using the extension)

## Installation

### Chrome (load as unpacked extension)

1. Download the `extension.zip` or clone this repository
2. Unzip the file to your local machine
3. Open Chrome and go to `chrome://extensions/`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked**
6. Select the `extension/` folder from the unzipped file
7. The "Sync for Zotero" icon should appear in your toolbar

### Updating

When a new version is available:

1. Pull the latest changes (`git pull`) or download the new release
2. Go to `chrome://extensions/`
3. Click the reload icon on the "Sync for Zotero" card

## Usage

1. Make sure Zotero is running with LLM for Zotero active (webchat mode)
2. Open ChatGPT in a Chrome tab
3. Click the extension icon to verify connection status
4. Send queries from Zotero — the extension handles the rest

## License

See [LICENSE](LICENSE) for details.
