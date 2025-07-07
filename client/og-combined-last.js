(function () {
  const proxyUrl = 'https://www.dimgord.cc/og-proxy?';
  const processedLinks = new Set();

  async function processLink(link) {
    const url = link.getAttribute("href");

    // Виключення для Telegram і X/Twitter
    if (/^https?:\/\/t\.me\//.test(url)) return;
    if (/^https?:\/\/(x\.com|twitter\.com)\//.test(url)) return;

    console.log("[OGPreview] Link: ", url);

    try {
      const response = await fetch(`${proxyUrl}url=${encodeURIComponent(url)}`);
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok || !contentType.includes("application/json")) {
        console.warn("[OGPreview] Invalid response for:", url, await response.text());
        return;
      }

      const data = await response.json();
      if (!data.title) return;

      const preview = document.createElement("div");
      preview.className = "og_preview";
      preview.style = `
        border: 1px solid #ccc;
        border-radius: 6px;
        margin-top: 10px;
        padding: 10px;
        max-width: 700px;
        width: 100%;
        display: block;
        margin-left: auto;
        margin-right: auto;
      `;
      preview.innerHTML = `
        <a href="${data.url}" target="_blank" style="font-weight:bold; color:#0088cc; text-decoration:none; font-size:18px;">
          ${data.title}
        </a>
        <p style="margin:5px 0;">${data.description}</p>
        ${data.image ? `<img src="${data.image}" alt="preview" style="width:100%; max-height:300px; object-fit:cover; margin-top:10px;">` : ''}
      `;

      const container = link.closest(".link_embed");
      if (container && !container.querySelector(".og_preview")) {
        container.appendChild(preview);
        console.log("[OGPreview] Appended preview to:", container);
      } else {
        console.warn("[OGPreview] Container not found or already has preview for:", url);
      }
    } catch (err) {
      console.warn("[OGPreview] Failed for:", url, err);
    }
  }

  function scanAndProcessLinks() {
    const links = Array.from(document.querySelectorAll(".post-entry .link_embed a[href^='http']"));
    links.forEach(link => processLink(link));
  }

  function scanTelegramEmbeds() {
    console.log("[TelegramEmbed] Scanning posts for t.me links (iframe version)...");

    const posts = $('div.postbody:contains("t.me/")');

    posts.each(function () {
      const contentBlock = $(this);
      const matches = contentBlock.text().matchAll(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/g);

      for (const match of matches) {
        const channel = match[1];
        const messageId = match[2];
        const widgetId = "telegram-iframe-" + channel + "-" + messageId;
        const iframeURL = "https://t.me/" + channel + "/" + messageId + "?embed=1";

        console.log("[TelegramEmbed] Trying iframe for " + channel + "/" + messageId);

        if (contentBlock.find("#" + widgetId).length > 0) continue;

        const iframeHTML = `
          <iframe id="${widgetId}" src="${iframeURL}"
            width="100%" height="600" frameborder="0" scrolling="yes"
            style="border: 1px solid #ccc; border-radius: 6px; margin-top: 10px; max-width: 700px; width: 100%; display: block; margin-left: auto; margin-right: auto;">
          </iframe>`;

        contentBlock.append(iframeHTML);

        setTimeout(function () {
          const iframe = document.getElementById(widgetId);
          const iframeVisible = !!iframe;

          if (!iframeVisible) {
            console.warn("[TelegramEmbed] iframe missing. Showing fallback for " + channel + "/" + messageId);
            const fallback = `
              <div style="margin-top:10px; padding:10px; border:1px solid #ccc; background:#f5f8fa;">
                <img src="https://telegram.org/img/t_logo.svg" alt="Telegram" style="height:20px; vertical-align:middle; margin-right:10px;" />
                <a href="https://t.me/${channel}/${messageId}" target="_blank" style="font-weight:bold; color:#0088cc; text-decoration:none;">
                  View Telegram Post</a>
              </div>`;
            contentBlock.append(fallback);
          } else {
            console.log("[TelegramEmbed] iframe embed visible for " + channel + "/" + messageId);
            const height = iframe.clientHeight;
            if (height < 600) {
              iframe.style.height = "600px";
              console.log("[TelegramEmbed] Iframe too short — applying fallback height = 600px");
            }
          }
        }, 2000);
      }
    });
  }

  function scanTwitterEmbeds() {

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
  }

  function observeDomChanges() {
    const target = document.querySelector(".post-entry");
    if (!target) {
      console.warn("[OGPreview] No .post-entry container found.");
      return;
    }

    const observer = new MutationObserver(() => {
      scanAndProcessLinks();
      scanTelegramEmbeds();
      scanTwitterEmbeds();
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });

    console.log("[OGPreview] MutationObserver started. Watching for .link_embed and t.me...");
  }

  document.addEventListener("DOMContentLoaded", () => {
    console.log("[OGPreview] Initial DOMContentLoaded triggered.");
    scanAndProcessLinks();
    scanTelegramEmbeds();
    observeDomChanges();
  });
})();
