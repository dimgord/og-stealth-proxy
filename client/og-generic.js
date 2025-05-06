(function () {
  const proxyUrl = 'https://www.dimgord.cc/og-proxy?';
  const processedLinks = new Set();

  async function processLink(link) {
    const url = link.getAttribute("href");
    /*if (processedLinks.has(url)) return;
    processedLinks.add(url);*/

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

  function observeDomChanges() {
    const target = document.querySelector(".post-entry");
    if (!target) {
      console.warn("[OGPreview] No .post-entry container found.");
      return;
    }

    const observer = new MutationObserver(() => {
      scanAndProcessLinks();
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });

    console.log("[OGPreview] MutationObserver started. Watching for .link_embed links...");
  }

  document.addEventListener("DOMContentLoaded", () => {
    console.log("[OGPreview] Initial DOMContentLoaded triggered.");
    scanAndProcessLinks();
    observeDomChanges();
  });
})();
