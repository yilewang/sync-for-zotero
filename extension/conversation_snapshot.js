/* Passive, self-contained ChatGPT conversation snapshots. No account/sidebar DOM. */
(() => {
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_NODES = 12000;
  const PROPERTIES =
    `display visibility opacity color background-color background-image
    font-family font-size font-weight font-style line-height letter-spacing text-align
    text-decoration white-space word-break overflow-wrap vertical-align
    margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left
    border-top-width border-right-width border-bottom-width border-left-width border-style border-color
    border-radius box-shadow box-sizing max-width min-width width height
    flex-direction flex-wrap align-items justify-content gap row-gap column-gap flex-grow flex-shrink flex-basis
    grid-template-columns grid-template-rows grid-column grid-row list-style-type
    border-collapse border-spacing table-layout fill stroke stroke-width stroke-linecap stroke-linejoin text-anchor dominant-baseline transform position top right bottom left overflow overflow-x overflow-y object-fit object-position aspect-ratio clip clip-path`.split(
      /\s+/,
    );
  const ALLOWED = new Set(
    "div span p section article header footer main h1 h2 h3 h4 h5 h6 strong b em i u s del small sub sup br hr blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col a img figure figcaption details summary svg foreignObject g path circle ellipse line polyline polygon rect text tspan defs marker clipPath use math semantics annotation mrow mi mn mo ms mtext mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd"
      .toLowerCase()
      .split(" "),
  );
  const ATTRS = new Set(
    "colspan rowspan scope start reversed value open title alt dir lang viewbox d fill stroke stroke-width x y x1 x2 y1 y2 cx cy r rx ry points width height transform xmlns display encoding accent stretchy mathvariant mathsize movablelimits columnalign rowalign columnspacing rowspacing text-anchor dominant-baseline dx dy stroke-linecap stroke-linejoin preserveaspectratio".split(
      " ",
    ),
  );
  function canonicalUrl(value) {
    const u = new URL(value);
    if (
      u.origin !== "https://chatgpt.com" ||
      !/^\/c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname)
    )
      throw new Error("Open a saved ChatGPT conversation first.");
    return u.origin + u.pathname.replace(/\/$/, "");
  }
  function messageRoots(doc) {
    const modern = [
      ...doc.querySelectorAll("[data-content-search-unit-key]"),
    ].filter((el) =>
      /:(user|assistant)$/.test(
        el.getAttribute("data-content-search-unit-key") || "",
      ),
    );
    const roots = modern.length
      ? modern
      : [
          ...doc.querySelectorAll(
            '[data-message-author-role="user"], [data-message-author-role="assistant"]',
          ),
        ];
    return roots.filter(
      (el) => !roots.some((parent) => parent !== el && parent.contains(el)),
    );
  }
  async function capture(expectedUrl, env = {}) {
    const doc = env.document || document;
    const win = env.window || window;
    const url = canonicalUrl(win.location.href);
    if (url !== canonicalUrl(expectedUrl))
      throw new Error(
        "The browser conversation changed. Open the matching conversation and retry.",
      );
    if (
      doc.querySelector(
        '[data-testid="stop-button"], [data-is-streaming="true"]',
      )
    )
      throw new Error("Wait for the answer to finish before saving.");
    if (
      [...doc.querySelectorAll('[role="status"]')].some((el) =>
        /无法加载此回复|Unable to load this response/i.test(
          el.textContent || "",
        ),
      )
    )
      throw new Error(
        "ChatGPT could not load this response. Reload the conversation before saving.",
      );
    const roots = messageRoots(doc);
    if (!roots.length)
      throw new Error(
        "No conversation messages found. Scroll through the conversation to load it first.",
      );
    const transcriptBefore = roots.map((el) => el.textContent).join("\n");
    const deadline = Date.now() + 45000;
    const out = doc.implementation
      ? doc.implementation.createHTMLDocument("ChatGPT conversation snapshot")
      : env.createDocument();
    const styles = new Map();
    const warnings = new Set();
    const imageCache = new Map();
    let nodes = 0;
    let imageBytes = 0;
    const getStyle = env.getComputedStyle || win.getComputedStyle.bind(win);
    const fetchImage =
      env.fetchImage ||
      (async (src) => {
        if (
          env.images &&
          Object.prototype.hasOwnProperty.call(env.images, src)
        ) {
          if (!env.images[src]) throw new Error("Image unavailable");
          return env.images[src];
        }
        const response = await fetch(src, {
          signal: AbortSignal.timeout(10000),
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("Image unavailable");
        const blob = await response.blob();
        if (
          !/^image\/(png|jpeg|gif|webp|avif)$/.test(blob.type) ||
          blob.size > MAX_BYTES / 2
        )
          throw new Error("Unsupported or oversized image");
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      });
    async function embedImage(src) {
      if (!imageCache.has(src))
        imageCache.set(
          src,
          (async () => {
            const absolute = new URL(src, url);
            if (!["https:", "data:", "blob:"].includes(absolute.protocol))
              throw new Error("Unsupported image");
            const data = await fetchImage(absolute.href);
            if (
              !/^data:image\/(png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/=\s]+$/.test(
                data,
              )
            )
              throw new Error("Unsupported image");
            imageBytes += data.length;
            if (imageBytes > MAX_BYTES)
              throw new Error("Snapshot images exceed the size limit");
            return data;
          })(),
        );
      return imageCache.get(src);
    }
    async function copy(node) {
      if (Date.now() > deadline) throw new Error("Snapshot capture timed out.");
      if (++nodes > MAX_NODES)
        throw new Error("Conversation is too large to save in one snapshot.");
      if (node.nodeType === 3)
        return out.createTextNode(node.textContent || "");
      if (node.nodeType !== 1) return null;
      const tag = node.localName.toLowerCase();
      // KaTeX renders two representations. Retain only native MathML, avoiding
      // duplicate formulas and dependencies on KaTeX web fonts/positioning.
      if (node.classList?.contains("katex")) {
        const math = node.querySelector("math");
        if (math) return copy(math);
      }
      if (tag === "annotation" || tag === "annotation-xml") return null;
      const passiveControl =
        tag === "button" || node.getAttribute("role") === "button";
      const label =
        node.getAttribute("aria-label") || node.textContent?.trim() || "";
      if (
        passiveControl &&
        /^(Share|Copy|Open |共享$|分享$|复制$|添加到收藏夹$|图表选项$)/i.test(
          label,
        )
      )
        return null;
      if ((!ALLOWED.has(tag) && !passiveControl) || node.hidden) return null;
      const computed = getStyle(node);
      if (
        computed.getPropertyValue("display") === "none" ||
        computed.getPropertyValue("visibility") === "hidden"
      )
        return null;
      // SVG external <use> references require remote sprite sheets. Keep only rendered paths.
      if (tag === "use") return null;
      const target =
        !passiveControl &&
        node.namespaceURI &&
        node.namespaceURI !== "http://www.w3.org/1999/xhtml"
          ? out.createElementNS(node.namespaceURI, node.localName)
          : out.createElement(passiveControl ? "span" : tag);
      for (const attr of [...node.attributes])
        if (ATTRS.has(attr.name.toLowerCase()) && !/url\s*\(/i.test(attr.value))
          target.setAttribute(attr.name, attr.value);
      if (tag === "a") {
        try {
          const href = new URL(node.getAttribute("href"), url);
          if (["http:", "https:"].includes(href.protocol)) {
            target.setAttribute("href", href.href);
            target.setAttribute("rel", "noreferrer noopener");
          }
        } catch (_) {}
      }
      const declarations = PROPERTIES.map((property) => {
        // MathML supplies its own layout; CSS copied from the hidden KaTeX
        // accessibility representation must not override native math layout.
        if (node.namespaceURI === "http://www.w3.org/1998/Math/MathML")
          return "";
        let value = computed.getPropertyValue(property);
        if (property === "position" && ["fixed", "sticky"].includes(value))
          value = "static";
        if (!value || /url\s*\(|[<>]/i.test(value)) return "";
        // Do not pin text containers to the source viewport's measured pixel height/width.
        if (
          ["height", "width"].includes(property) &&
          !(
            ["svg", "img", "table"].includes(tag) ||
            node.namespaceURI === "http://www.w3.org/2000/svg" ||
            computed.getPropertyValue("position") === "absolute"
          )
        )
          return "";
        return `${property}:${value}`;
      })
        .filter(Boolean)
        .join(";");
      if (!styles.has(declarations))
        styles.set(declarations, `s${styles.size}`);
      target.setAttribute("class", styles.get(declarations));
      if (tag === "img") {
        try {
          target.setAttribute(
            "src",
            await embedImage(node.currentSrc || node.getAttribute("src")),
          );
        } catch (_) {
          throw new Error(
            "An image could not be saved offline. No incomplete snapshot was saved. Keep the conversation open and retry.",
          );
        }
      }
      for (const child of [...node.childNodes]) {
        const cloned = await copy(child);
        if (cloned) target.appendChild(cloned);
      }
      return target;
    }
    const foreground =
      getStyle(roots[0]).getPropertyValue("color") || "#171717";
    let background = "white";
    for (let ancestor = roots[0]; ancestor; ancestor = ancestor.parentElement) {
      const color = getStyle(ancestor).getPropertyValue("background-color");
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
        background = color;
        break;
      }
    }
    out.body.setAttribute(
      "style",
      `background-color:${background};color:${foreground}`,
    );
    const header = out.createElement("header");
    const title = out.createElement("h1");
    title.textContent = "ChatGPT · Conversation snapshot";
    header.appendChild(title);
    const source = out.createElement("a");
    source.textContent = "Original conversation";
    source.setAttribute("href", url);
    header.appendChild(source);
    const timestamp = out.createElement("p");
    timestamp.textContent = new Date().toISOString();
    header.appendChild(timestamp);
    out.body.appendChild(header);
    for (const root of roots) {
      const section = out.createElement("section");
      section.setAttribute("class", "snapshot-message");
      const label = out.createElement("h2");
      label.textContent =
        (root.getAttribute("data-message-author-role") ||
          root
            .getAttribute("data-content-search-unit-key")
            .split(":")
            .pop()) === "user"
          ? "You"
          : "ChatGPT";
      section.appendChild(label);
      const content = await copy(root);
      if (content) section.appendChild(content);
      out.body.appendChild(section);
    }
    if (canonicalUrl(win.location.href) !== url)
      throw new Error("The conversation changed while saving. Please retry.");
    if (
      messageRoots(doc)
        .map((el) => el.textContent)
        .join("\n") !== transcriptBefore
    )
      throw new Error(
        "The conversation changed while saving. Please retry after generation finishes.",
      );
    const notice = out.createElement("p");
    notice.setAttribute("class", "snapshot-notice");
    notice.textContent =
      "Static snapshot of the messages loaded in the browser. Charts and references are static; original uploaded files are not embedded. " +
      [...warnings].join(" ");
    out.body.appendChild(notice);
    const meta = out.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    out.head.appendChild(meta);
    const csp = out.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute(
      "content",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
    );
    out.head.appendChild(csp);
    const style = out.createElement("style");
    style.textContent =
      `body{margin:24px auto;padding:0 24px;max-width:900px;font:16px/1.6 system-ui;background:white;color:#171717}header{border-bottom:1px solid #ddd;margin-bottom:30px}header h1{font-size:20px}.snapshot-message{margin:28px 0}.snapshot-message>h2{font:600 14px system-ui;color:#666}img,svg{max-width:100%}.snapshot-notice{font:12px/1.5 system-ui;color:#666}pre{white-space:pre-wrap}table{max-width:100%}` +
      [...styles].map(([css, name]) => `.${name}{${css}}`).join("\n");
    out.head.appendChild(style);
    const html = "<!doctype html>\n" + out.documentElement.outerHTML;
    if (new TextEncoder().encode(html).length > MAX_BYTES)
      throw new Error("Snapshot exceeds the 16 MiB limit.");
    return {
      version: 1,
      url,
      html,
      messageCount: roots.length,
      warnings: [...warnings],
    };
  }
  globalThis.SyncZoteroSnapshot = {
    capture,
    canonicalUrl,
    messageRoots,
    MAX_BYTES,
  };
})();
