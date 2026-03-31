# Sync for Zotero

Automatically bridge the connections between Zotero and ChatGPT. Send PDFs from Zotero to ChatGPT, run a prompt, and get markdown results back.

## How It Works

1. The extension discovers your local Zotero relay server
2. It polls for pending queries (PDFs + prompts)
3. When a query arrives, it uploads the PDF to ChatGPT, submits your prompt, and waits for the response
4. The response is extracted as markdown and synced back to Zotero

## Installation

### Chrome (load as unpacked extension)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repository
6. The "Sync for Zotero" icon should appear in your toolbar

### Updating

When a new version is available:

1. Pull the latest changes (`git pull`) or download the new release
2. Go to `chrome://extensions/`
3. Click the reload icon on the "Sync for Zotero" card

## Prerequisites

- [Zotero](https://www.zotero.org/) with the relay plugin configured
- A ChatGPT account (keep a tab open at chatgpt.com)

## Usage

1. Make sure Zotero is running with the relay plugin active
2. Open ChatGPT in a Chrome tab
3. Click the extension icon to check connection status
4. Send queries from Zotero — the extension handles the rest

## License

See [LICENSE](LICENSE) for details.
