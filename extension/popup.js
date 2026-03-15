const badge = document.getElementById("status-badge");
const hint  = document.getElementById("hint");

function showStatus(state, message) {
  badge.className = `status-badge ${state}`;
  badge.textContent = message;
  if (state !== "idle") hint.textContent = "";
}

// Load last known status
chrome.runtime.sendMessage({ type: "GET_STATUS" }, (status) => {
  if (status) showStatus(status.state, status.message);
});

// Live updates from background service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    showStatus(msg.state, msg.message);
  }
});
