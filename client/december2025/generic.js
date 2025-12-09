//OG Preview Generic (поки що тільки  CENSOR.NET)
(function () {
  const proxyUrl = 'https://www.dimgord.cc/og-proxy?';
  const processedLinks = new Set();

  async function processLink(link) {
    const url = link.getAttribute("href");

    // if (!url.includes('censor.net')) return;
    //
    // if (processedLinks.has(url)) return; // Не обробляй двічі!

    console.log("[OGPreview] Link: ", url);

    let container = link.closest(".link_embed");

    console.log("Container: ", container);
    if (!container) {
      console.log("[OGPreview] Empty container, DOM is not ready yet.");
      return;
    }

    try {
      const response = await fetch(`${proxyUrl}url=${encodeURIComponent(url)}`);
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok || !contentType.includes("application/json")) {
        console.warn("[OGPreview] Invalid response for:", url, await response.text());
        return;
      }

      const data = await response.json();
      if (!data.title) {
        console.log("[OGPreview] No data from dimgord.cc");
        return;
      }

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

      if (container && !container.querySelector('.og_preview')) {
        container.appendChild(preview);
        console.log("[OGPreview] Appended preview to:", container);
        processedLinks.add(url); // Adding processed url to avoid multiple processing
      }
    } catch (err) {
      console.warn("[OGPreview] Failed for:", url, err);
    }
  }

  function scanAndProcessLinks() {
    document.querySelectorAll('.link_embed').forEach(processNewLinkEmbed);
  }

  function observeDomChanges() {
    // ДЛЯ ДІАГНОСТИКИ: підписуємось на все тіло сторінки
    const target = document.body;
    if (!target) {
      console.warn("[OGPreview] No body found!");
      return;
    }
    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        for (const node of mutation.addedNodes) {
          // Може бути не тільки елемент
          if (!(node instanceof HTMLElement)) continue;
          // Якщо сам node — .link_embed
          if (node.classList && node.classList.contains('link_embed')) {
            processNewLinkEmbed(node);
          }
          // Або шукаємо вкладені .link_embed
          node.querySelectorAll && node.querySelectorAll('.link_embed').forEach(processNewLinkEmbed);
        }
      }
    });

    observer.observe(document.body, {childList: true, subtree: true});

    console.log("[OGPreview] MutationObserver started. Watching body...");
  }

  function processNewLinkEmbed(container) {
    const link = container.querySelector('a[href*="censor.net"]');
    if (!link) return;
    const url = link.getAttribute("href");
    if (processedLinks.has(url)) return;
    processLink(link); // твоя асинхронна функція
  }

  document.addEventListener("DOMContentLoaded", () => {
    console.log("[OGPreview] Initial DOMContentLoaded triggered.");
    scanAndProcessLinks();
    observeDomChanges();
  });
})();
