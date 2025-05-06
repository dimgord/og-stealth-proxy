console.log("[TwitterEmbedOverride] Initializing...");

// 1. Підставляємо фейковий twttr, щоб Forumotion не завантажив оригінал
window.twttr = {
  _e: [],
  ready: function (f) {
    console.log("[TwitterEmbedOverride] twttr.ready() intercepted");
    this._e.push(f);
  },
  widgets: {
    load: function () {
      console.log("[TwitterEmbedOverride] twttr.widgets.load() called (FA_Embed likely fired)");
    }
  }
};

console.log("[TwitterEmbedOverride] Fake twttr injected");

// 2. Після паузи вставляємо справжній скрипт (дзеркало)
setTimeout(() => {
  console.log("[TwitterEmbedOverride] Injecting mirror widgets.js...");

  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/gh/dimgord/twitter-widget-mirror/widgets.js";
  s.async = true;

  // лог, коли завантажиться
  s.onload = () => {
    console.log("[TwitterEmbedOverride] Mirror widgets.js loaded ✅");

    // після завантаження — запускаємо twttr.ready чергу
    if (window.twttr && Array.isArray(window.twttr._e)) {
      console.log(`[TwitterEmbedOverride] Running ${window.twttr._e.length} queued twttr.ready() functions`);
      window.twttr._e.forEach(f => {
        try {
          f();
        } catch (err) {
          console.error("[TwitterEmbedOverride] Error running twttr.ready() callback", err);
        }
      });
      window.twttr._e = []; // очистити чергу
    }
  };

  s.onerror = () => {
    console.error("[TwitterEmbedOverride] Failed to load mirror widgets.js ❌");
  };

  document.head.appendChild(s);
}, 1000);
