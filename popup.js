// popup.js (defensive, no-d3 version)
// Replaces previous popup code with stronger null checks and content-script injection.
// Assumes manifest v3 (use chrome.scripting.executeScript) or that content.js is listed in manifest content_scripts.

"use strict";

/* Storage + messaging helpers */
const storageGet = (keys) =>
  new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res)));
const storageSet = (obj) =>
  new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));

const queryActiveTab = () =>
  new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve((tabs && tabs[0]) || null);
    });
  });

/* Send message to background (safe) */
const sendBg = (msg) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      resolve(resp);
    });
  });

/* Send message to content script in tab (safe). If content script isn't present, try to inject it (MV3) */
async function sendToTab(tabId, message) {
  return new Promise(async (resolve, reject) => {
    // First try direct sendMessage
    chrome.tabs.sendMessage(tabId, message, async (resp) => {
      if (!chrome.runtime.lastError) {
        return resolve(resp);
      }

      // If runtime.lastError indicates "Receiving end does not exist", try to inject content script (MV3)
      const msg = String(chrome.runtime.lastError.message || "");
      if (msg.includes("Receiving end does not exist") || msg.includes("Could not establish connection")) {
        try {
          if (chrome.scripting && chrome.scripting.executeScript) {
            // Try to inject content.js into the tab; ensure file path matches your extension root
            await new Promise((r, rej) => {
              chrome.scripting.executeScript(
                { target: { tabId }, files: ["content.js"] },
                (injectionResult) => {
                  if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
                  return r(injectionResult);
                }
              );
            });

            // After injection, try sending again
            chrome.tabs.sendMessage(tabId, message, (resp2) => {
              if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
              return resolve(resp2);
            });
            return;
          } else {
            // If chrome.scripting isn't available (older manifest), we cannot inject here
            return reject(new Error("No content script and cannot inject (chrome.scripting not available)"));
          }
        } catch (injErr) {
          return reject(injErr);
        }
      } else {
        // Some other lastError - return it
        return reject(new Error(msg));
      }
    });
  });
}

/* UI helpers */
const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = (text === null || text === undefined) ? "" : String(text);
};

const setInner = (id, html) => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html || "";
};

const showAlert = (title, message) => {
  const card = document.getElementById("alert-card");
  if (!card) return;
  setText("alert-title", title || "");
  setText("alert-message", message || "");
  card.style.display = "block";
};
const hideAlert = () => {
  const card = document.getElementById("alert-card");
  if (!card) return;
  card.style.display = "none";
};

const setProgress = (id, fraction) => {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  el.style.width = `${pct}%`;
};

/* Update dashboard UI safely (defensive checks) */
function updateDashboardUI(data = {}) {
  // If data isn't an object, use defaults
  if (!data || typeof data !== "object") {
    data = {};
  }

  try {
    setText("alerts-this-week", data.alerts_this_week ?? "--");
    setText("critical-flags", data.critical_flags ?? "--");
    setText("diversity-score", (data.diversity_score === null || data.diversity_score === undefined) ? "--" : data.diversity_score);
    setText("reliability-avg", (data.reliability_avg === null || data.reliability_avg === undefined) ? "--" : data.reliability_avg);
    setText("info-summary", data.summary || "No summary available.");

    // progress bar (reliability progress)
    const reli = Number(data.reliability_avg);
    if (!Number.isNaN(reli)) {
      setProgress("reliability-bar", reli);
    } else {
      setProgress("reliability-bar", 0);
    }

    // hide/show genesis alert if present
    if (data.genesis && data.genesis.status) {
      const s = (data.genesis.status || "").toLowerCase();
      showAlert(`Genesis Verification: ${String(data.genesis.status).toUpperCase()}`, data.genesis.message || "");
      // optionally style alert card based on status (success/warning/danger)
      const card = document.getElementById("alert-card");
      if (card) {
        card.className = (s === "green") ? "alert-success" : (s === "red") ? "alert-danger" : "alert-warning";
      }
    } else {
      hideAlert();
    }
  } catch (e) {
    console.error("updateDashboardUI error (defensive)", e);
  }
}

/* Refresh dashboard data: ask background safely */
async function refreshDashboardData() {
  try {
    const resp = await sendBg({ action: "getDashboardSummary" }).catch((e) => {
      console.warn("sendBg getDashboardSummary failed:", e);
      return null;
    });

    // Defensive checks: resp must be object and resp.data should be object
    if (!resp || typeof resp !== "object") {
      console.warn("Invalid dashboard response, using fallback.");
      updateDashboardUI({
        alerts_this_week: 0,
        critical_flags: 0,
        diversity_score: "--",
        reliability_avg: 0,
        summary: "Backend unavailable - showing cached/local values."
      });
      return;
    }

    if (resp.success && resp.data && typeof resp.data === "object") {
      updateDashboardUI(resp.data);
    } else if (resp.data && typeof resp.data === "object") {
      // some backends might return { data: {...} } without success flag
      updateDashboardUI(resp.data);
    } else {
      // fallback
      updateDashboardUI({
        alerts_this_week: resp.alerts_this_week ?? 0,
        critical_flags: resp.critical_flags ?? 0,
        diversity_score: resp.diversity_score ?? "--",
        reliability_avg: resp.reliability_avg ?? 0,
        summary: resp.summary || "Partial data returned."
      });
    }
  } catch (e) {
    console.error("Failed to refresh dashboard:", e);
    updateDashboardUI({
      alerts_this_week: 0,
      critical_flags: 0,
      diversity_score: "--",
      reliability_avg: 0,
      summary: "Could not load dashboard data."
    });
  }
}

/* Analyze current page: collect page via content script, then ask background to analyze */
async function analyzeCurrentPage() {
  try {
    const tab = await queryActiveTab();
    if (!tab) {
      showAlert("No tab", "No active tab found.");
      return;
    }

    // Collect page info via content script (safe)
    let collectResp;
    try {
      collectResp = await sendToTab(tab.id, { action: "collect_page" });
    } catch (err) {
      console.warn("collect_page failed:", err);
      showAlert("Analysis failed", "Could not collect page content (content script missing or blocked). Try reloading the page.");
      return;
    }

    if (!collectResp || !collectResp.payload) {
      console.warn("collect_page returned empty payload:", collectResp);
      showAlert("Analysis failed", "Page content not available for analysis.");
      return;
    }

    // Ask background to analyze (background will call backend or fallback)
    let analyzeResp;
    try {
      analyzeResp = await sendBg({ action: "analyze_page", payload: collectResp.payload });
    } catch (err) {
      console.warn("Background analysis call failed:", err);
      // Fallback UI message.
      showAlert("Analysis error", "Could not reach analysis service (backend or background error).");
      return;
    }

    if (analyzeResp && analyzeResp.success && analyzeResp.data) {
      updateDashboardUI(analyzeResp.data);
    } else if (analyzeResp && typeof analyzeResp === "object") {
      // maybe backend returns raw data
      updateDashboardUI(analyzeResp.data || analyzeResp);
    } else {
      showAlert("No result", "Analysis returned no result.");
    }
  } catch (err) {
    console.error("analyzeCurrentPage unexpected error:", err);
    showAlert("Error", "Unexpected error while analyzing page.");
  }
}

/* Clear local visited history */
async function clearHistory() {
  if (!confirm("Are you sure you want to clear browsing history for analytics?")) return;
  await storageSet({ visitedHistory: [] });
  await refreshDashboardData();
  alert("History cleared.");
}

/* Wiring on DOM loaded */
document.addEventListener("DOMContentLoaded", () => {
  const analyzeBtn = document.getElementById("action-analyze-current");
  const clearBtn = document.getElementById("action-clear-history");
  const refreshBtn = document.getElementById("action-refresh");

  if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeCurrentPage);
  if (clearBtn) clearBtn.addEventListener("click", clearHistory);
  if (refreshBtn) refreshBtn.addEventListener("click", refreshDashboardData);

  // initial refresh
  refreshDashboardData();
});
