const dotHost     = document.getElementById("dot-host");
const dotTab      = document.getElementById("dot-tab");
const dotPipeline = document.getElementById("dot-pipeline");
const valHost     = document.getElementById("val-host");
const valTab      = document.getElementById("val-tab");
const valPipeline = document.getElementById("val-pipeline");
const badge       = document.getElementById("status-badge");
const info        = document.getElementById("info");

function setIndicator(dot, val, alive, label) {
  dot.className = `dot ${alive ? "green" : "red"}`;
  val.className = `indicator-value ${alive ? "ok" : "error"}`;
  val.textContent = label;
}

function setPipelineIndicator(state, message) {
  const dotClass = { idle: "gray", running: "blue", done: "green", error: "red" }[state] || "gray";
  const valClass = { idle: "idle", running: "running", done: "ok", error: "error" }[state] || "idle";
  dotPipeline.className = `dot ${dotClass}`;
  valPipeline.className = `indicator-value ${valClass}`;
  valPipeline.textContent = state.charAt(0).toUpperCase() + state.slice(1);

  badge.className = `status-badge status-${state}`;
  badge.textContent = message || state;
}

// Request full status from background
const labelTab = document.getElementById("label-tab");

chrome.runtime.sendMessage({ type: "GET_FULL_STATUS" }, (status) => {
  if (!status) return;

  // Update the tab label to show which site is active
  if (labelTab && status.activeSiteLabel) {
    labelTab.textContent = status.activeSiteLabel;
  }

  setIndicator(dotHost, valHost, status.relayAlive, status.relayAlive ? "Connected" : "Offline");
  setIndicator(dotTab, valTab, status.chatTabAlive, status.chatTabAlive ? "Tab active" : "No tab");
  setPipelineIndicator(status.pipelineState || "idle", status.pipelineMessage || "Idle");

  // Show conversation URL if available
  if (status.chatUrl) {
    try {
      const urlObj = new URL(status.chatUrl);
      const shortPath = urlObj.pathname.slice(0, 20) + "…";
      info.textContent = "🔗 ";
      const link = document.createElement("a");
      link.href = urlObj.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${urlObj.hostname}${shortPath}`;
      info.appendChild(link);
    } catch {
      info.textContent = "";
    }
  } else {
    info.textContent = "";
  }
});

// Live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    if (typeof msg.relayAlive === "boolean") {
      setIndicator(
        dotHost,
        valHost,
        msg.relayAlive,
        msg.relayAlive ? "Connected" : "Offline",
      );
    }
    setPipelineIndicator(msg.state, msg.message);
  }
});
