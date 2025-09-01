chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "analyzeText") {
    fetch("http://127.0.0.1:8000/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message.text })
    })
      .then(res => res.json())
      .then(data => {
        chrome.storage.local.set({ analysis: data });
      })
      .catch(err => console.error("Backend error:", err));
  }
});
