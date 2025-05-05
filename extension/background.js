chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "message-log") {
    console.log(`[MessageLogger] From ${message.from}:`, message.content);
  }
});

