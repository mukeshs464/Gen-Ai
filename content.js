// content.js
// In-page UI & analysis runner for Project Sentinel
// - collects page text and visible media
// - sends requests to background for analysis/verification
// - displays in-page banners and badges

const DEFAULT_BACKEND = "http://127.0.0.1:8000";
let analysisMutex = false;
let isFullAnalysis = false;

// utility: wrap chrome.runtime.sendMessage as Promise
function sendBgMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // sometimes background unavailable or context invalidated
          return resolve({ success: false, error: String(err) });
        }
        resolve(resp || { success: false, error: "No response" });
      });
    } catch (e) {
      resolve({ success: false, error: String(e) });
    }
  });
}

// run when DOM ready
(async function () {
  if (document.readyState !== "loading") {
    runAnalysis().catch(e => console.error("[Sentinel] runAnalysis error:", e));
  } else {
    document.addEventListener("DOMContentLoaded", () => runAnalysis().catch(e => console.error("[Sentinel] runAnalysis error:", e)));
  }

  // observe for dynamic content - debounce to avoid spam
  const observer = new MutationObserver(debounce(() => {
    if (!analysisMutex) runAnalysis().catch(e => console.error("[Sentinel] runAnalysis error:", e));
  }, 2000));
  observer.observe(document.body, { childList: true, subtree: true });
})();

async function runAnalysis() {
  if (analysisMutex) return;
  analysisMutex = true;
  try {
    // get settings (best-effort)
    const settingsResp = await new Promise(resolve => {
      chrome.storage.local.get(['userSettings'], res => resolve(res.userSettings || { shieldEnabled: true, genesisEnabled: true }));
    });
    const settings = settingsResp || { shieldEnabled: true, genesisEnabled: true };

    if (settings.shieldEnabled) {
      await analyzePageText();
    }
    if (settings.genesisEnabled) {
      await analyzeMedia();
    }
  } catch (err) {
    console.error("[Sentinel] Content analysis failed:", err);
  } finally {
    analysisMutex = false;
    isFullAnalysis = false;
  }
}

// ---------------- Text Analysis ----------------
async function analyzePageText() {
  try {
    // crude page text extractor (may be large)
    const text = (document.body && document.body.innerText) ? document.body.innerText : "";
    if (!text || text.trim().length < 30) {
      return;
    }

    const resp = await sendBgMessage({ action: "analyzePageText", text });
    if (!resp || !resp.success) {
      // background returned failure or no backend
      // optionally show a small banner indicating analysis unavailable
      return;
    }
    const result = resp.result || {};
    if (result.alerts && Array.isArray(result.alerts) && result.alerts.length) {
      displayTextAlerts(result);
    }
  } catch (err) {
    console.error("[Sentinel] Text analysis failed:", err);
  }
}

function displayTextAlerts(analysisResult) {
  try {
    (analysisResult.alerts || []).forEach(alert => {
      try {
        const alertId = `sentinel-alert-${btoa((alert.message || "").slice(0,80)).replace(/=/g,"")}`;
        if (document.getElementById(alertId)) return;

        const banner = document.createElement('div');
        banner.id = alertId;
        banner.className = `sentinel-alert-banner sentinel-alert--${alert.type || "suspicious"}`;
        banner.style.zIndex = 2147483647;
        banner.innerHTML = `
          <div style="font-size:20px; margin-right:12px;">${getIconForAlert(alert)}</div>
          <div style="flex:1;">
            <div style="font-weight:700; margin-bottom:6px;">${escapeHtml(alert.message || "Potential manipulation")}</div>
            <div style="font-size:13px; opacity:0.9;">${escapeHtml(alert.explanation || "")}</div>
            <div style="font-size:11px; color:#666; margin-top:8px;">Processed in ${analysisResult.processing_time_ms || '--'}ms</div>
          </div>
          <button class="sentinel-alert-close" style="margin-left:12px; border:none; background:transparent; font-size:18px; cursor:pointer;">&times;</button>
        `;
        const closeBtn = banner.querySelector('.sentinel-alert-close');
        closeBtn.addEventListener('click', () => banner.remove());
        // Insert to document body top
        document.body.prepend(banner);
        // auto-dismiss low severity
        if (alert.severity === 'low') {
          setTimeout(() => banner.remove(), 8000);
        }
      } catch (e) { console.warn("displayTextAlerts item error:", e); }
    });
  } catch (err) { console.warn("displayTextAlerts error:", err); }
}

function getIconForAlert(alert) {
  if (!alert || !alert.type) return '🛡️';
  if (alert.type === 'emotional') return '⚠️';
  if (alert.type === 'fallacy') return '🧩';
  if (alert.type === 'suspicious') return '🔍';
  return '🛡️';
}

// ---------------- Media Analysis ----------------
async function analyzeMedia() {
  try {
    // images
    const images = Array.from(document.querySelectorAll('img')).filter(img => img && img.src && img.naturalWidth >= 50);
    for (let img of images) {
      try {
        // skip if already annotated
        if (img.dataset.sentinelAnnotated === "1") continue;

        const resp = await sendBgMessage({ action: "verifyMedia", mediaUrl: img.src, mediaType: "image" });
        if (resp && resp.success && resp.result) {
          displayMediaBadge(img, resp.result);
        }
        img.dataset.sentinelAnnotated = "1";
      } catch (e) { console.warn("analyzeMedia image error:", e); }
    }

    // videos
    const videos = Array.from(document.querySelectorAll('video')).filter(v => v && (v.currentSrc || v.src));
    for (let v of videos) {
      try {
        if (v.dataset.sentinelAnnotated === "1") continue;
        const url = v.currentSrc || v.src;
        const resp = await sendBgMessage({ action: "verifyMedia", mediaUrl: url, mediaType: "video" });
        if (resp && resp.success && resp.result) {
          displayMediaBadge(v, resp.result);
          if (resp.result.websocket_url) {
            // ask background to start websocket forwarding
            await sendBgMessage({ action: "start_video_analysis", websocketUrl: resp.result.websocket_url });
          }
        }
        v.dataset.sentinelAnnotated = "1";
      } catch (e) { console.warn("analyzeMedia video error:", e); }
    }
  } catch (err) {
    console.error("[Sentinel] analyzeMedia top-level error:", err);
  }
}

function displayMediaBadge(element, result) {
  try {
    const badgeId = `sentinel-badge-${(result.hash || Math.random().toString(36).substr(2,9))}`;
    if (document.getElementById(badgeId)) return;

    const wrapper = element.parentElement || document.body;
    if (getComputedStyle(wrapper).position === "static") {
      wrapper.style.position = "relative";
    }

    const badge = document.createElement('div');
    badge.id = badgeId;
    badge.className = `sentinel-media-badge sentinel-media-badge--${result.status || "yellow"}`;
    // minimal inline style to avoid missing CSS
    badge.style.position = "absolute";
    badge.style.top = "8px";
    badge.style.right = "8px";
    badge.style.background = (result.status === "green" ? "rgba(40,167,69,0.9)" : result.status === "red" ? "rgba(220,53,69,0.92)" : "rgba(0,122,204,0.9)");
    badge.style.color = "white";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "14px";
    badge.style.fontSize = "12px";
    badge.style.zIndex = 2147483647;
    badge.style.cursor = "pointer";
    badge.title = result.message || "";

    badge.innerText = `${(result.status || "unknown").toUpperCase()}`;

    badge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // show a quick popup or alert with details
      const details = `Status: ${result.status}\nConfidence: ${result.confidence || "--"}\nMessage: ${result.message || "--"}`;
      try { alert(`Genesis Verification\n\n${details}`); } catch (e) { console.log(details); }
    });

    // append badge into wrapper (positioned)
    wrapper.appendChild(badge);
  } catch (err) {
    console.warn("displayMediaBadge error:", err);
  }
}

// ---------------- Real-time video update listener ----------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (!request || !request.action) return;
    if (request.action === "update_video_analysis") {
      const data = request.data || {};
      // place an overlay badge near the first video element (simple mapping)
      const video = document.querySelector('video');
      if (video) {
        let overlay = video.parentNode.querySelector('.sentinel-video-analysis-badge');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'sentinel-video-analysis-badge';
          overlay.style.position = 'absolute';
          overlay.style.top = '10px';
          overlay.style.left = '10px';
          overlay.style.padding = '6px 10px';
          overlay.style.borderRadius = '14px';
          overlay.style.zIndex = 2147483647;
          overlay.style.fontSize = '12px';
          overlay.style.fontWeight = '700';
          overlay.style.color = 'white';
          video.parentNode.style.position = video.parentNode.style.position === 'static' ? 'relative' : video.parentNode.style.position;
          video.parentNode.appendChild(overlay);
        }
        const status = data.status || 'unknown';
        overlay.style.background = status === 'green' ? 'rgba(40,167,69,0.9)' : 'rgba(220,53,69,0.9)';
        overlay.textContent = `${status.toUpperCase()}: ${data.message || ""}`;
      }
    }
  } catch (err) { console.warn("onMessage in content error:", err); }
});

// ---------------- Utilities ----------------
function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
