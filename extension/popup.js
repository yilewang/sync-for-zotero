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
chrome.runtime.sendMessage({ type: "GET_FULL_STATUS" }, (status) => {
  if (!status) return;

  setIndicator(dotHost, valHost, status.relayAlive, status.relayAlive ? "Connected" : "Offline");
  setIndicator(dotTab, valTab, status.chatTabAlive, status.chatTabAlive ? "Tab active" : "No tab");
  setPipelineIndicator(status.pipelineState || "idle", status.pipelineMessage || "Idle");

  // Show conversation URL if available
  if (status.chatUrl) {
    const short = status.chatUrl.replace("https://chatgpt.com/c/", "").slice(0, 12) + "…";
    info.innerHTML = `🔗 <a href="${status.chatUrl}" target="_blank">chatgpt.com/c/${short}</a>`;
  }
});

// Live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    setPipelineIndicator(msg.state, msg.message);
  }
});
