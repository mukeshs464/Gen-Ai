// content.js (improved safe version)
console.log("✅ Sentinel content script loaded!");

// safe send wrapper
function safeSendMessage(obj) {
  try {
    if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      console.warn("chrome.runtime not available, skipping sendMessage");
      return;
    }
    chrome.runtime.sendMessage(obj, (resp) => {
      if (chrome.runtime.lastError) {
        // This commonly happens if the extension was just reloaded or the service worker restarted.
        console.warn("sendMessage failed:", chrome.runtime.lastError.message);
      } else {
        // optional: console.log("message response", resp);
      }
    });
  } catch (e) {
    console.error("safeSendMessage error:", e);
  }
}

// send first 4k chars (or less) of page text for analysis
function sendPageText() {
  try {
    const text = document.body ? document.body.innerText || "" : "";
    safeSendMessage({ type: "analyzeText", text: text.slice(0, 4000) });
    console.log("Sent text to background for analysis (len):", text.length);
  } catch (e) {
    console.error("content script error:", e);
  }
}

// initial send (but only if document ready)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sendPageText);
} else {
  sendPageText();
}

// Re-run on significant DOM change (simple debounce)
let timer = null;
const obs = new MutationObserver(() => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { sendPageText(); }, 1500);
});
const root = document.body || document.documentElement;
if (root) {
  try { obs.observe(root, { childList: true, subtree: true }); } catch (e) { console.warn("observer failed to attach", e); }
}

// Disconnect observer when page unloads to avoid sending messages during teardown
function cleanupObserver() {
  try { obs.disconnect(); } catch (e) {}
}
window.addEventListener("beforeunload", cleanupObserver);
window.addEventListener("unload", cleanupObserver);
