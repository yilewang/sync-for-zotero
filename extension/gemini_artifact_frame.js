// This isolated script runs at document_start in Gemini-created srcdoc frames.
// Read only the source Gemini delivers to its own renderer. No page code runs
// in the extension, and no extension or Zotero commands are accepted here.
(() => {
  if (window.parent === window || window.location.href !== "about:srcdoc") return;
  let source = "";
  const publish = () => {
    if (source) window.parent.postMessage({ type: "SYNC_ZOTERO_GEMINI_ARTIFACT", html: source }, "https://gemini.google.com");
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== "https://gemini.google.com") return;
    if (event.data?.type === "genui-morph" && typeof event.data.html === "string" && event.data.html.length <= 1_000_000) {
      source = event.data.html;
      publish();
    } else if (event.data?.type === "SYNC_ZOTERO_GEMINI_ARTIFACT_REQUEST") publish();
  });
})();
