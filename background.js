// background.js (MV3 service worker)
console.log("Background service worker starting...");

// --------- small helpers (promisify chrome.storage) ----------
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(result);
      });
    } catch (e) { reject(e); }
  });
}
function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve();
      });
    } catch (e) { reject(e); }
  });
}

// deterministic small hash for caching
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "verify-image",
    title: "Sentinel: Verify Image (Genesis)",
    contexts: ["image"]
  });
});

// Utility to safely create a notification only if icon is present
async function safeNotify(opts) {
  // opts: {title, message, iconRelativePath}
  try {
    const iconRel = opts.iconRelativePath || "icons/128.png";
    const iconUrl = chrome.runtime.getURL(iconRel);

    // Attempt to fetch the resource to ensure it exists. If it fails, skip notification.
    try {
      const resp = await fetch(iconUrl, { method: "HEAD" });
      if (!resp.ok) throw new Error("icon fetch failed");
    } catch (err) {
      console.warn("Notification icon not available, skipping notification:", iconUrl, err);
      return;
    }

    chrome.notifications.create({
      type: "basic",
      iconUrl,
      title: opts.title || "Notification",
      message: opts.message || ""
    });
  } catch (e) {
    console.warn("safeNotify failed:", e);
  }
}

// Handle context menu click for image verification (Genesis)
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "verify-image") {
    try {
      if (!info.srcUrl) {
        console.warn("No image srcUrl available for context menu click.");
        return;
      }

      console.log("Genesis check requested for:", info.srcUrl);

      // Call backend (adjust host/port if needed)
      const resp = await fetch("http://127.0.0.1:8000/image/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: info.srcUrl })
      });

      let data;
      try {
        data = await resp.json();
      } catch (err) {
        data = { status: "error", reason: "Invalid JSON from backend" };
      }

      // store the result so popup can show it
      await storageSet({ genesis_result: data });

      // show notification (safe)
      await safeNotify({
        title: "Genesis Check",
        message: `${(data.status || "RESULT").toString().toUpperCase()} — ${data.reason || ""}`,
        iconRelativePath: "icons/128.png"
      });

      console.log("Genesis result stored:", data);
    } catch (err) {
      console.error("Genesis error:", err);
      // Save error to storage so popup can show an error if needed
      try { await storageSet({ genesis_result: { status: "error", error: String(err) } }); } catch (_) {}
    }
  }
});

// Receive messages from content script (analyzeText)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "analyzeText") {
    (async () => {
      try {
        const text = (message.text || "").slice(0, 4000);
        const cacheKey = "sentinel_cache_" + djb2(text);
        const now = Date.now();

        // check cache
        let cacheObj = {};
        try { cacheObj = await storageGet(cacheKey); } catch (e) { console.warn("cache get failed", e); }

        if (cacheObj && cacheObj[cacheKey] && (now - cacheObj[cacheKey].t < 5 * 60 * 1000)) {
          // store sentinel_result as shortcut
          try { await storageSet({ sentinel_result: cacheObj[cacheKey].v }); } catch (e) {}
          return;
        }

        // call backend
        const resp = await fetch("http://127.0.0.1:8000/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });

        let data;
        try { data = await resp.json(); } catch (err) { data = { status: "error", error: "Invalid JSON" }; }

        try { await storageSet({ sentinel_result: data }); } catch (e) { console.warn("storage set failed", e); }

        // update cache
        const toStore = {};
        toStore[cacheKey] = { v: data, t: now };
        try { await storageSet(toStore); } catch (e) { console.warn("cache store failed", e); }
      } catch (err) {
        console.error("Backend error:", err);
      }
    })();
  }
  return false; // no sendResponse
});

// Echo Chamber: visit logging
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return null; }
}

async function logVisit(url) {
  const domain = getDomain(url);
  if (!domain) return;
  const now = Date.now();
  let kv = {};
  try { kv = await storageGet("visitLog"); } catch (e) { kv = {}; }
  const visitLog = kv.visitLog || [];
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const pruned = visitLog.filter(v => v.t >= cutoff);
  pruned.push({ d: domain, t: now });
  try { await storageSet({ visitLog: pruned }); } catch (e) { console.warn("visitLog set failed", e); }
}

chrome.webNavigation.onCommitted.addListener(({ url, frameId }) => {
  if (frameId === 0 && url && url.startsWith("http")) {
    logVisit(url);
  }
});
