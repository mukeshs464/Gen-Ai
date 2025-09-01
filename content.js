console.log("✅ Sentinel content script loaded!");

// Extract page text
const textContent = document.body.innerText;
console.log("Extracted text:", textContent.slice(0, 200));

// Send to background for analysis
chrome.runtime.sendMessage({
  type: "analyzeText",
  text: textContent
});
