document.addEventListener("DOMContentLoaded", async () => {
  try {
    const result = await chrome.storage.local.get("analysis");
    if (result.analysis) {
      let { status, alerts } = result.analysis;
      let display = `Status: ${status.toUpperCase()}\n\n`;
      if (alerts && alerts.length > 0) {
        display += alerts.join("\n");
      } else {
        display += "No issues detected ✅";
      }
      document.getElementById("alerts").innerText = display;
    } else {
      document.getElementById("alerts").innerText = "No analysis yet.";
    }
  } catch (err) {
    console.error("Storage error:", err);
    document.getElementById("alerts").innerText = "Error loading analysis.";
  }
});
