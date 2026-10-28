// Gemini has no verified network capture contract. Keep all site DOM knowledge
// here; the existing delivery/turn tracker owns sequencing and acknowledgements.
(function (root) {
  root.SyncZoteroGemini = {
    createAdapter({ document, isVisibleElement, htmlToMarkdown, cloneAssistantOutput, shared }) {
      const composerSelector = '.ql-editor[role="textbox"][contenteditable="true"]';
      const inputRoot = () => document.querySelector(composerSelector)?.closest("input-container") || document.querySelector("input-container");
      const iconButton = (icon) => {
        const button = inputRoot()?.querySelector(`mat-icon[fonticon="${icon}"]`)?.closest("button");
        return button && isVisibleElement(button) ? button : null;
      };
      const messageRole = (node) => node?.localName === "user-query" ? "user" : node?.localName === "model-response" ? "assistant" : null;
      const turnIdentities = new WeakMap();
      const permanentTurnIdentities = new Map();
      let provisionalTurnSerial = 0;
      const messageId = (node) => {
        const turn = node?.closest(".conversation-container");
        const role = messageRole(node);
        if (!turn || !role) return null;
        // Gemini exposes a user turn before assigning its permanent ID. Keep
        // the first node identity for that turn, then remember its eventual ID
        // so replacing the DOM node cannot invalidate an in-flight binding.
        let identity = turnIdentities.get(turn);
        if (!identity) {
          identity = permanentTurnIdentities.get(turn.id) || turn.id ||
            `gemini-provisional-turn-${++provisionalTurnSerial}`;
          turnIdentities.set(turn, identity);
        }
        if (turn.id) permanentTurnIdentities.set(turn.id, identity);
        return `${identity}:${role}`;
      };
      // Source is relayed from Gemini's opaque sandbox, never read from its
      // bootstrap srcdoc. Bind every message to an actual SVG frame in a turn.
      const artifacts = new WeakMap();
      const artifactFrames = (node) => Array.from(node.querySelectorAll('svg-code-block iframe'));
      window.addEventListener('message', (event) => {
        if (event.data?.type !== 'SYNC_ZOTERO_GEMINI_ARTIFACT' || typeof event.data.html !== 'string' || event.data.html.length > 1_000_000) return;
        const frame = artifactFrames(document).find((candidate) => candidate.contentWindow === event.source);
        if (!frame || !frame.closest('model-response')) return;
        const source = event.data.html.trim();
        // Gemini sends the generated SVG as genui-morph HTML. Require an SVG
        // document here; ordinary provider bootstrap HTML is never an artifact.
        if (!/^<svg[\s>]/i.test(source) || !/<\/svg>\s*$/i.test(source)) return;
        const state = artifacts.get(frame) || {};
        state.source = source;
        artifacts.set(frame, state);
        state.resolve?.();
      });
      const artifactState = (frame) => {
        let state = artifacts.get(frame);
        if (!state) {
          state = { requestedAt: Date.now(), source: '' };
          artifacts.set(frame, state);
        }
        if (!state.source) frame.contentWindow?.postMessage({ type: 'SYNC_ZOTERO_GEMINI_ARTIFACT_REQUEST' }, '*');
        return state;
      };
      const clean = (node) => {
        const clone = cloneAssistantOutput(node);
        const frames = Array.from(node.querySelectorAll('svg-code-block'), (block) => block.querySelector('iframe'));
        clone.querySelectorAll('svg-code-block').forEach((block, index) => {
          const frame = frames[index];
          if (!frame) return;
          const state = artifactState(frame);
          if (state.source) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-svg';
            code.textContent = state.source;
            pre.appendChild(code);
            block.replaceWith(pre);
          } else {
            block.replaceWith(document.createTextNode(Date.now() - state.requestedAt >= 10000
              ? '\nSVG source could not be transferred. Open the original web chat to view it.\n'
              : '\nSVG source is being transferred.\n'));
          }
        });
        // Gemini's HTML-only KaTeX keeps the source on data-math; preserve it
        // before removing aria-hidden rendering trees. Work on the clone only.
        clone.querySelectorAll('[data-math]').forEach((el) => {
          const latex = el.getAttribute('data-math')?.trim();
          if (!latex) return;
          const display = el.classList.contains('math-block') ||
            el.classList.contains('katex-display') || Boolean(el.querySelector('.katex-display'));
          el.replaceWith(document.createTextNode(display ? `\n$$${latex}$$\n` : `$${latex}$`));
        });
        // Keep web source links, but omit other badges and their UI labels
        // from captured answers. Ordinary answer text is left untouched.
        clone.querySelectorAll('source-inline-chip, .source-inline-chip-container').forEach((chip) => {
          if (!clone.contains(chip)) return; // already replaced an outer chip
          const links = Array.from(chip.querySelectorAll('a[href]')).filter((a) => /^https?:\/\//i.test(a.getAttribute('href') || ''));
          if (!links.length) {
            chip.remove();
            return;
          }
          const replacement = document.createElement('span');
          replacement.appendChild(document.createTextNode(' ['));
          links.forEach((a, index) => {
            if (index) replacement.appendChild(document.createTextNode('; '));
            const link = document.createElement('a');
            link.setAttribute('href', a.getAttribute('href'));
            link.textContent = a.getAttribute('aria-label') || a.textContent.trim() || a.getAttribute('href');
            replacement.appendChild(link);
          });
          replacement.appendChild(document.createTextNode(']'));
          chip.replaceWith(replacement);
        });
        clone.querySelectorAll('button, [role="button"], [hidden], [aria-hidden="true"], .cdk-visually-hidden').forEach((el) => el.remove());
        return clone;
      };
      const withExtension = (stem, extension) => {
        if (!stem) return "";
        const suffix = String(extension || "").trim().toLowerCase();
        return suffix && !stem.toLowerCase().endsWith(`.${suffix}`) ? `${stem}.${suffix}` : stem;
      };
      const normalizePdfFilename = (name) => String(name || "")
        .normalize("NFC").trim().replace(/\.pdf$/i, ".pdf");
      const composerFilenameMatches = (label, filename) => {
        const actual = normalizePdfFilename(label);
        const expected = normalizePdfFilename(filename);
        if (actual === expected) return true;
        // Gemini puts a middle elision in the DOM, not just CSS overflow.
        // Use both retained ends of the basename, only for the new upload card.
        // The submitted user turn must still expose the complete filename.
        if (!actual.endsWith(".pdf") || !expected.endsWith(".pdf")) return false;
        const parts = actual.slice(0, -4).split(/…|\.\.\./);
        if (parts.length !== 2) return false;
        const [prefix, suffix] = parts;
        const basename = expected.slice(0, -4);
        return prefix.length >= 4 && suffix.length >= 4 &&
          prefix.length + suffix.length >= 16 &&
          prefix.length + suffix.length < basename.length &&
          basename.startsWith(prefix) && basename.endsWith(suffix);
      };
      const getComposerAttachments = () => Array.from(inputRoot()?.querySelectorAll("uploader-file-preview") || [])
        .filter(isVisibleElement)
        .map((node) => {
          const filename = withExtension(node.querySelector(".gem-attachment-text")?.textContent.trim(), node.querySelector(".gem-attachment-extension-label")?.textContent);
          const image = Boolean(node.querySelector('gem-media-attachment img'));
          const closeButton = node.querySelector('mat-icon[fonticon="close"]')?.closest("button") || node.querySelector('button[aria-label^="close"]');
          const busy = node.querySelector('mat-progress-spinner, mat-spinner, progress, [role="progressbar"], [aria-busy="true"]');
          const failed = node.querySelector('[role="alert"], .upload-error') || /upload failed|上传失败/i.test(node.textContent);
          return { node, filename: filename || (image ? "image" : (busy || closeButton ? "pending attachment" : "")), kind: image ? "image" : "file", ready: Boolean((filename || image) && closeButton && !closeButton.disabled && closeButton.getAttribute("aria-disabled") !== "true" && !busy && !failed) };
        }).filter((card) => card.filename);
      return {
        async prepareRichOutput(node) {
          await Promise.all(artifactFrames(node).map((frame) => {
            const state = artifactState(frame);
            if (state.source || Date.now() - state.requestedAt >= 10000) return;
            if (!state.pending) state.pending = new Promise((resolve) => {
              const timer = setTimeout(resolve, Math.max(0, 10000 - (Date.now() - state.requestedAt)));
              state.resolve = () => { clearTimeout(timer); resolve(); };
            });
            return state.pending;
          }));
        },
        siteId: "gemini", homeUrl: "https://gemini.google.com/app", answerCapture: "dom",
        composerSelectors: [composerSelector],
        sendButtonSelectors: () => iconButton("arrow_upward"),
        findStopButton: () => iconButton("stop"),
        findUploadControl: () => iconButton("plus"),
        stopButtonSelectors: [],
        userMessageSelector: ".conversation-container user-query",
        assistantMessageSelectors: [".conversation-container model-response"],
        conversationMessageSelector: ".conversation-container user-query, .conversation-container model-response",
        conversationTurnSelector: ".conversation-container",
        getMessageRole: messageRole, getMessageId: messageId,
        extractUserMessageText(node) {
          return Array.from(node.querySelectorAll(".query-text-line")).map((line) => htmlToMarkdown(clean(line).innerHTML).trim()).join("\n").trim();
        },
        extractAssistantAnswerText(node) {
          const markdown = node?.querySelector("message-content .markdown");
          if (!markdown) return "";
          const answer = htmlToMarkdown(clean(markdown).innerHTML).trim();
          // Some sources are rendered in the response footer, outside the
          // Markdown owner. Export actual web links, not the surrounding UI.
          const sources = document.createElement('div');
          const seen = new Set();
          node.querySelectorAll('sources-list a[href], .sources-list a[href]').forEach((anchor) => {
            const href = anchor.getAttribute('href') || '';
            if (markdown.contains(anchor) || !/^https?:\/\//i.test(href) || seen.has(href)) return;
            seen.add(href);
            const paragraph = document.createElement('p');
            const link = document.createElement('a');
            link.setAttribute('href', href);
            link.textContent = anchor.textContent.trim() || anchor.getAttribute('aria-label') || href;
            paragraph.appendChild(link);
            sources.appendChild(paragraph);
          });
          const sourceText = htmlToMarkdown(sources.innerHTML).trim();
          return sourceText ? `${answer}\n\n${sourceText}`.trim() : answer;
        },
        extractAssistantThinkingText: () => "",
        extractAttachmentNames(node) {
          if (messageRole(node) !== "user") return [];
          const names = Array.from(node.querySelectorAll('user-query-file-preview [data-test-id="uploaded-file"]')).map((card) => withExtension(card.querySelector('[data-test-id="filename-label"]')?.textContent.trim(), card.querySelector(".extension-label")?.textContent)).filter(Boolean);
          const images = node.querySelectorAll('user-query-file-preview img, user-query-media img');
          images.forEach((_, index) => names.push(images.length === 1 ? "image" : `image_${index + 1}`));
          return names;
        },
        isResponseComplete(assistantTurnKey) {
          if (!assistantTurnKey) return false;
          const node = Array.from(document.querySelectorAll(".conversation-container model-response")).find((candidate) => messageId(candidate) === assistantTurnKey);
          return Boolean(node && artifactFrames(node).every((frame) => {
            const state = artifactState(frame);
            return state.source || Date.now() - state.requestedAt >= 10000;
          }) && isVisibleElement(node) && node.querySelector('message-content .markdown[aria-busy="false"]') && node.querySelector(".response-footer.complete"));
        },
        getComposerAttachments,
        classifySubmittedAttachments(attachments, expectedFilename, expectedImageCount = 0) {
          const contract = shared.classifySubmittedPdfContract(attachments, expectedFilename);
          // Gemini exposes the complete filename stem and extension separately.
          // Its receipt must not inherit legacy substring/elision/rename matches.
          const filenameMatched = expectedFilename
            ? attachments.some((name) => normalizePdfFilename(name) === normalizePdfFilename(expectedFilename))
            : null;
          const imageCount = attachments.filter((name) => /^image(?:_\d+)?$/.test(name)).length;
          const pdfVerified = expectedFilename
            ? contract.pdfAttachmentCount === 1 && filenameMatched === true
            : contract.pdfAttachmentCount === 0;
          return { ...contract, filenameMatched, contractVerified: pdfVerified &&
            imageCount === expectedImageCount &&
            attachments.length === (expectedFilename ? 1 : 0) + expectedImageCount };
        },
        resolveReplacementUserTurn({ transcript, baseline, expectedChatUrl, promptText, expectedPdfFilename, expectedImageCount }) {
          const conversationUrl = shared.normalizeGeminiConversationUrl(expectedChatUrl || baseline.chatUrl);
          if (!conversationUrl || shared.normalizeGeminiConversationUrl(transcript.chatUrl) !== conversationUrl) return null;
          // A replaced provisional node has no observable link to its new ID.
          // Rebind only while the entire pre-send baseline remains identifiable
          // in order, with exactly one subsequent user carrying this request.
          let boundary = -1;
          for (const message of baseline.messages) {
            const index = transcript.messages.findIndex((candidate) => candidate.messageKey === message.messageKey);
            if (index <= boundary) return null;
            boundary = index;
          }
          const users = transcript.messages.slice(boundary + 1).filter((message) => message.role === "user");
          if (users.length !== 1) return null;
          const candidate = users[0];
          const normalizePrompt = (text) => String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
          if (normalizePrompt(candidate.text) !== normalizePrompt(promptText)) return null;
          const attachments = Array.isArray(candidate.attachments) ? candidate.attachments : [];
          const contract = this.classifySubmittedAttachments(attachments, expectedPdfFilename, expectedImageCount);
          return contract.contractVerified ? candidate : null;
        },
        async uploadFile(file, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 45000 } = {}) {
          const startedAt = now();
          const baseline = new Set(getComposerAttachments().map((card) => card.node));
          let input = document.querySelector('images-files-uploader input[type="file"]');
          if (!input) {
            const upload = iconButton("plus");
            if (!upload) throw new Error("Gemini upload control was not found.");
            upload.click();
            while (!input && now() - startedAt < Math.min(timeoutMs, 10000)) {
              input = document.querySelector('images-files-uploader input[type="file"]');
              if (!input) await wait(100);
            }
          }
          if (!input) throw new Error("Gemini upload file input was not found.");
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          let readySince = null;
          while (now() - startedAt <= timeoutMs) {
            const cards = getComposerAttachments().filter((card) => !baseline.has(card.node));
            const matching = cards.filter((card) => file.type.startsWith("image/")
              ? card.kind === "image"
              : card.kind === "file" && composerFilenameMatches(card.filename, file.name));
            if (matching.length === 1 && cards.length === 1 && matching[0].ready) {
              if (readySince === null) readySince = now();
              if (now() - readySince >= 750) {
                return { method: "file_input", filenameConfirmed: !file.type.startsWith("image/"), readyConfirmed: true, evidence: matching[0].filename, totalElapsedMs: now() - startedAt };
              }
            } else {
              readySince = null;
            }
            if (now() - startedAt >= timeoutMs) break;
            await wait(100);
          }
          throw new Error(`Gemini did not confirm a ready attachment for "${file.name}".`);
        },
        getChatIdFromUrl(url) { return shared.normalizeGeminiConversationUrl(url)?.split("/").pop() || null; },
        historyLinkSelector: 'bard-sidenav a[href^="/app/"], bard-sidenav a[href^="https://gemini.google.com/app/"]',
        async prepareHistory({ wait, now = Date.now, timeoutMs = 15_000 } = {}) {
          const startedAt = now();
          let opened = false;
          while (true) {
            if (document.querySelector(this.historyLinkSelector)) return true;
            if (!opened) {
              const button = Array.from(document.querySelectorAll('button[aria-label="Open sidebar"]'))
                .find((node) => !node.disabled && isVisibleElement(node));
              if (button) {
                button.click();
                opened = true;
              }
            }
            const remaining = timeoutMs - (now() - startedAt);
            if (remaining <= 0) return false;
            await wait(Math.min(100, remaining));
          }
        },
        buildHistoryEntry(anchor) {
          const url = new URL(anchor.getAttribute("href"), "https://gemini.google.com").href;
          const chatUrl = shared.normalizeGeminiConversationUrl(url);
          return chatUrl ? { id: chatUrl.split("/").pop(), title: anchor.textContent.trim(), chatUrl } : null;
        },
        supportsFileUpload: true, supportsModelSelector: false, hasFormWrapper: false,
      };
    },
  };
})(globalThis);
