// popup.js — merged + improved with auto-update and charts

// --- Sentinel (text analysis) ---
function renderSentinel(result) {
  const statusEl = document.getElementById("status");
  const catsEl = document.getElementById("cats");
  const alertsEl = document.getElementById("alerts");

  if (!result) {
    statusEl.textContent = "No analysis yet";
    statusEl.className = "badge";
    alertsEl.textContent = "Open a news page — Sentinel will analyze.";
    catsEl.textContent = "";
    return;
  }

  const s = (result.status || "green").toLowerCase();
  statusEl.textContent = `Status: ${s.toUpperCase()}`;
  statusEl.className = `badge ${s}`;

  if (Array.isArray(result.categories) && result.categories.length) {
    catsEl.textContent = "Detected: " + result.categories.join(", ");
  } else {
    catsEl.textContent = "";
  }

  if (Array.isArray(result.alerts) && result.alerts.length) {
    alertsEl.textContent = result.alerts.join("\n");
  } else {
    alertsEl.textContent = "No issues detected ✅";
  }
}

// --- Genesis (image verification) ---
function renderGenesis(data) {
  const genContainer = document.getElementById("genesis");
  genContainer.innerHTML = "";

  if (!data) {
    genContainer.textContent = "";
    return;
  }

  const div = document.createElement("div");
  const s = (data.status || "red").toLowerCase();
  div.className = `alert ${s}`;
  div.textContent = `Genesis: ${data.status ? data.status.toUpperCase() : "UNKNOWN"} — ${data.reason || data.error || ""}`;
  genContainer.appendChild(div);
}

// --- Echo Chamber (visit log + diversity) ---
async function renderEchoChamber() {
  try {
    const kv = await chrome.storage.local.get("visitLog");
    const visitLog = kv.visitLog || [];

    const res = await fetch(chrome.runtime.getURL("bias.json"));
    const biasMap = await res.json();

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const counts = {};
    for (const v of visitLog) {
      if (v.t < cutoff) continue;
      const cat = biasMap[v.d] || "unknown";
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 0;

    const chartEl = document.getElementById("chart");
    chartEl.innerHTML = "";

    if (total > 0) {
      const maxCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (maxCat && maxCat[1] / total >= 0.7 && maxCat[0] !== "unknown") {
        const nudge = document.createElement("div");
        nudge.className = "alert yellow";
        nudge.textContent = `Nudge: ${Math.round(100 * maxCat[1] / total)}% of your sources are ${maxCat[0]}. Try broadening your mix.`;
        document.body.appendChild(nudge);
      }

      // draw small pie chart using d3
      const data = Object.entries(counts).map(([k, v]) => ({ label: k, value: v }));
      const w = 300, h = 160, r = Math.min(w, h) / 2 - 10;
      const svg = d3.select("#chart").append("svg").attr("width", w).attr("height", h)
        .append("g").attr("transform", `translate(${w / 2},${h / 2})`);
      const pie = d3.pie().value(d => d.value);
      const arc = d3.arc().outerRadius(r).innerRadius(40);

      svg.selectAll("path")
        .data(pie(data))
        .enter().append("path")
        .attr("d", arc);

      svg.selectAll("text")
        .data(pie(data))
        .enter().append("text")
        .attr("transform", d => `translate(${arc.centroid(d)})`)
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .text(d => `${d.data.label} (${d.data.value})`);
    } else {
      chartEl.textContent = "No browsing data yet.";
    }
  } catch (err) {
    console.warn("Could not load bias.json or draw chart", err);
    document.getElementById("chart").textContent = "Error loading diversity data.";
  }
}

// --- Load all ---
async function loadAndRenderAll() {
  try {
    const kv1 = await chrome.storage.local.get("sentinel_result");
    renderSentinel(kv1.sentinel_result);

    const kv2 = await chrome.storage.local.get("genesis_result");
    renderGenesis(kv2.genesis_result);

    await renderEchoChamber();
  } catch (e) {
    console.error("popup load error", e);
    document.getElementById("alerts").innerText = "Error loading analysis.";
  }
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
  loadAndRenderAll();

  // Live updates: re-render when background updates storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.sentinel_result) renderSentinel(changes.sentinel_result.newValue);
    if (changes.genesis_result) renderGenesis(changes.genesis_result.newValue);
    if (changes.visitLog) renderEchoChamber();
  });
});
