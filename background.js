// background.js - fully defensive copy/paste version (final patch)
// Project Sentinel - background service worker
/* global chrome */
"use strict";

const DEFAULT_BACKEND = "http://127.0.0.1:8000";

let BIAS_DATA = {};
let NUDGES = {};
let MANIPULATION_TECHNIQUES = {};
let USER_SETTINGS = {
  shieldEnabled: true,
  genesisEnabled: true,
  echoEnabled: true,
  alertVolume: "high",
};

function log(...args) { console.log("[Sentinel]", ...args); }
function warn(...args) { console.warn("[Sentinel]", ...args); }
function error(...args) { console.error("[Sentinel]", ...args); }

// storage helpers
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          warn("storageGet lastError:", chrome.runtime.lastError);
        }
        resolve(result || {});
      });
    } catch (e) {
      warn("storageGet exception:", e);
      resolve({});
    }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) warn("storageSet lastError:", chrome.runtime.lastError);
        resolve();
      });
    } catch (e) {
      warn("storageSet exception:", e);
      resolve();
    }
  });
}

// safe fetch with timeout
async function safeFetch(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// static data loader
async function loadStaticData() {
  try {
    const url = chrome.runtime.getURL("bias.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load bias.json: " + res.status);
    const json = await res.json();
    BIAS_DATA = (json && json.domains) ? json.domains : (json || {});
    NUDGES = json && json.nudges ? json.nudges : {};
    MANIPULATION_TECHNIQUES = json && json.manipulation_techniques ? json.manipulation_techniques : {};
    log("Static data loaded:", { domains: Object.keys(BIAS_DATA).length, nudges: Object.keys(NUDGES).length });
  } catch (err) {
    warn("loadStaticData failed:", err);
    BIAS_DATA = {}; NUDGES = {}; MANIPULATION_TECHNIQUES = {};
  }
}

// user settings
async function loadUserSettings() {
  try {
    const kv = await storageGet(["userSettings"]);
    const saved = kv.userSettings || {};
    USER_SETTINGS = Object.assign({}, USER_SETTINGS, saved);
    log("User settings loaded:", USER_SETTINGS);
  } catch (err) {
    warn("loadUserSettings error:", err);
  }
}

async function getCurrentTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (Array.isArray(tabs) && tabs.length) ? tabs[0] : null;
  } catch (err) {
    warn("getCurrentTab error:", err);
    return null;
  }
}

// verifyMedia: defensive
async function verifyMedia(mediaUrl, mediaType = "image") {
  try {
    if (!mediaUrl || typeof mediaUrl !== "string") {
      return { status: "yellow", message: "Missing or invalid mediaUrl argument" };
    }

    const kv = await storageGet(["backendUrl"]);
    const backendUrl = (kv && kv.backendUrl) ? kv.backendUrl : DEFAULT_BACKEND;
    const apiUrl = `${backendUrl.replace(/\/+$/, "")}/api/v1/verify_media`;

    const payload = { media_url: mediaUrl, media_type: mediaType || "image" };

    // safe stringify
    let bodyStr = "{}";
    try {
      bodyStr = JSON.stringify(payload);
    } catch (e) {
      warn("verifyMedia JSON.stringify failed, payload:", payload, e);
      bodyStr = "{}";
    }

    try {
      const res = await safeFetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      }, 30000);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        warn("verifyMedia backend non-ok:", res.status, txt);
        return { status: "yellow", message: "Backend verification failed", backend_status: res.status, raw: txt };
      }
      const json = await res.json().catch(() => ({}));
      log("verifyMedia backend returned:", json);
      return {
        status: json.status || "yellow",
        message: json.message || "",
        meta: json.meta || {},
        confidence: typeof json.confidence === "number" ? json.confidence : 0.5,
        hash: json.hash || null
      };
    } catch (err) {
      warn("verifyMedia backend call failed:", err);
      const heuristic = /synthid|c2pa|ai-generated|dalle|midjourney/i.test(mediaUrl) ? "blue" : "yellow";
      return { status: heuristic, message: "Fallback heuristic used (backend unavailable)", confidence: 0.5 };
    }
  } catch (err) {
    error("verifyMedia top-level error:", err);
    return { status: "yellow", message: "Internal error verifying media", error: String(err) };
  }
}

// analyzePageText: defensive
async function analyzePageText(text, pageUrl = null) {
  try {
    if (!text || typeof text !== "string" || text.trim().length < 10) {
      return { alerts: [], summary: "Text too short to analyze", emotional_score: 0.5, manipulation_score: 0.0 };
    }

    const kv = await storageGet(["backendUrl"]);
    const backendUrl = (kv && kv.backendUrl) ? kv.backendUrl : DEFAULT_BACKEND;
    const apiUrl = `${backendUrl.replace(/\/+$/, "")}/api/v1/analyze_text`;

    const payload = { text, url: pageUrl, source: "extension" };

    let bodyStr = "{}";
    try {
      bodyStr = JSON.stringify(payload);
    } catch (e) {
      warn("analyzePageText JSON.stringify failed, payload:", payload, e);
      bodyStr = "{}";
    }

    try {
      const res = await safeFetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      }, 30000);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        warn("analyzePageText backend non-OK:", res.status, txt);
        return { error: "Backend error", backend_status: res.status, raw: txt };
      }
      const json = await res.json().catch(() => ({}));
      log("analyzePageText result:", json);
      return json;
    } catch (err) {
      warn("analyzePageText fetch failed:", err);
      return { alerts: [], summary: "Fallback: backend unavailable", emotional_score: 0.5, manipulation_score: 0.0 };
    }
  } catch (err) {
    error("analyzePageText top-level error:", err);
    return { alerts: [], summary: "Internal error", emotional_score: 0.5, manipulation_score: 0.0, error: String(err) };
  }
}

// echo chamber
async function getEchoChamberData() {
  try {
    const kv = await storageGet(["visitedHistory"]);
    const history = Array.isArray(kv.visitedHistory) ? kv.visitedHistory : [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = history.filter(h => h && (h.timestamp || h.t) && ( (h.timestamp || h.t) > cutoff ));
    const byDomain = recent.reduce((acc, item) => {
      try {
        const domain = item.domain || item.d || (item.url ? (new URL(item.url)).hostname.replace(/^www\./i,"") : null);
        if (!domain) return acc;
        acc[domain] = (acc[domain] || 0) + 1;
        return acc;
      } catch (e) {
        return acc;
      }
    }, {});
    return { total: recent.length, byDomain, sample: recent.slice(-20) };
  } catch (err) {
    warn("getEchoChamberData error:", err);
    return { total: 0, byDomain: {}, sample: [] };
  }
}

// video analysis websocket
async function startVideoAnalysis(websocketUrl) {
  try {
    if (!websocketUrl || typeof websocketUrl !== "string") throw new Error("Missing websocketUrl");
    const ws = new WebSocket(websocketUrl);
    ws.onopen = () => log("Video WS opened:", websocketUrl);
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        (async () => {
          const tab = await getCurrentTab();
          if (tab && typeof tab.id === "number") {
            chrome.tabs.sendMessage(tab.id, { action: "update_video_analysis", data: parsed }, () => {
              if (chrome.runtime.lastError) warn("sendMessage(update_video_analysis) lastError:", chrome.runtime.lastError);
            });
          } else {
            warn("startVideoAnalysis: no active tab to forward message to", parsed);
          }
        })();
      } catch (e) {
        warn("WS message parse failed:", e, ev && ev.data);
      }
    };
    ws.onerror = (ev) => warn("Video WS error:", ev);
    ws.onclose = () => log("Video WS closed");
    return { ok: true, message: "WebSocket started" };
  } catch (err) {
    error("startVideoAnalysis error:", err);
    return { ok: false, error: String(err) };
  }
}

// open popup safely
async function openPopupSafely() {
  try {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup(() => {
        if (chrome.runtime.lastError) warn("openPopup failed:", chrome.runtime.lastError);
      });
    } else {
      const url = chrome.runtime.getURL("popup.html");
      await chrome.tabs.create({ url });
    }
  } catch (err) {
    warn("openPopupSafely failed:", err);
  }
}

// onInstalled
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    log("onInstalled:", details);
    await loadStaticData();
    await loadUserSettings();

    const stored = await storageGet(["visitedHistory","genesisManifests","lastNarrativeAnalysis","narrativeClusters"]);
    const toInit = {};
    if (!Array.isArray(stored.visitedHistory)) toInit.visitedHistory = [];
    if (typeof stored.genesisManifests !== "object" || stored.genesisManifests === null) toInit.genesisManifests = {};
    if (typeof stored.lastNarrativeAnalysis !== "number") toInit.lastNarrativeAnalysis = 0;
    if (typeof stored.narrativeClusters !== "object" || stored.narrativeClusters === null) toInit.narrativeClusters = {};
    if (Object.keys(toInit).length) await storageSet(toInit);

    try {
      chrome.contextMenus.removeAll(() => {
        try { chrome.contextMenus.create({ id: "sentinel-verify-image", title: "🔍 Verify Authenticity", contexts: ["image"] }); } catch(e) { warn(e); }
        try { chrome.contextMenus.create({ id: "sentinel-analyze-page", title: "🧠 Full Cognitive Analysis", contexts: ["page"] }); } catch(e) { warn(e); }
      });
    } catch (e) { warn("context menu init failed:", e); }

    log("onInstalled done");
  } catch (err) {
    error("onInstalled top-level error:", err);
  }
});

// context menu handling
chrome.contextMenus.onClicked.addListener((info, tab) => {
  (async () => {
    try {
      if (!info || !info.menuItemId) return;
      if (info.menuItemId === "sentinel-verify-image") {
        if (info.srcUrl) await storageSet({ lastRightClickImage: info.srcUrl });
        await openPopupSafely();
      } else if (info.menuItemId === "sentinel-analyze-page") {
        if (tab && typeof tab.id === "number") {
          chrome.tabs.sendMessage(tab.id, { action: "trigger_full_analysis" }, () => {
            if (chrome.runtime.lastError) warn("sendMessage(trigger_full_analysis) lastError:", chrome.runtime.lastError);
          });
        } else {
          await openPopupSafely();
        }
      }
    } catch (err) {
      error("contextMenus.onClicked error:", err);
    }
  })();
});

// webNavigation tracking
chrome.webNavigation.onCompleted.addListener(async (details) => {
  try {
    if (!details || details.frameId !== 0) return;
    if (!details.url || typeof details.url !== "string" || !details.url.startsWith("http")) return;
    const urlObj = new URL(details.url);
    const domain = urlObj.hostname.replace(/^www\./i, "");
    const timestamp = Date.now();
    const kv = await storageGet(["visitedHistory"]);
    const history = Array.isArray(kv.visitedHistory) ? kv.visitedHistory : [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const newHistory = (history.filter(item => item && (item.timestamp || item.t) && ((item.timestamp || item.t) > cutoff)) || []).slice(-999);
    newHistory.push({ domain, timestamp, url: details.url });
    await storageSet({ visitedHistory: newHistory });
    log("Recorded visit:", domain, "history length:", newHistory.length);
  } catch (err) {
    warn("webNavigation onCompleted handler error:", err);
  }
});

// message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      try { log("onMessage received:", { request, sender }); } catch (e) {}
      if (!request || typeof request !== "object" || !request.action) {
        sendResponse({ success: false, error: "Missing or invalid action" });
        return;
      }
      switch (request.action) {
        case "getEchoChamberData": {
          const data = await getEchoChamberData();
          sendResponse({ success: true, data });
          break;
        }
        case "verifyMedia": {
          const { mediaUrl, mediaType } = request;
          const result = await verifyMedia(mediaUrl, mediaType || "image");
          sendResponse({ success: true, result });
          break;
        }
        case "analyzePageText": {
          const { text } = request;
          const pageUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : null;
          const result = await analyzePageText(text, pageUrl);
          sendResponse({ success: true, result });
          break;
        }
        case "start_video_analysis": {
          const { websocketUrl } = request;
          const resp = await startVideoAnalysis(websocketUrl);
          sendResponse({ success: resp.ok === true, resp });
          break;
        }
        case "update_video_analysis": {
          const toSend = request && request.data ? request.data : null;
          let tabs = [];
          try { tabs = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { warn("tabs.query failed:", e); }
          if (Array.isArray(tabs) && tabs.length) {
            tabs.forEach(t => {
              try {
                if (t && typeof t.id === "number") {
                  chrome.tabs.sendMessage(t.id, { action: "update_video_analysis", data: toSend }, () => {
                    if (chrome.runtime.lastError) warn("sendMessage(update_video_analysis) lastError:", chrome.runtime.lastError);
                  });
                }
              } catch (e) { warn("forward update_video_analysis error:", e); }
            });
          } else {
            warn("update_video_analysis: no active tab to forward to");
          }
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      error("onMessage handler top-level error:", err);
      sendResponse({ success: false, error: String(err) });
    }
  })();
  return true;
});
