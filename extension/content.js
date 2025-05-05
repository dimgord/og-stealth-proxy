(function () {
  function safeLogMessage(data) {
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        type: "message-log",
        from: location.hostname,
        content: data
      });
    }
  }

  // Example usage: intercept postMessage or log DOM events
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    safeLogMessage(`Intercepted window message: ${JSON.stringify(event.data)}`);
  });

  // Log every 5s to show it's alive (optional)
  let pingInterval = setInterval(() => {
    safeLogMessage("Message Logger content.js still alive");
  }, 5000);

  window.addEventListener("unload", () => {
    clearInterval(pingInterval);
  });

  console.log("[MessageLogger] content.js injected and active");
})();

