// ig.js — Instagram embeder (vanilla JS, з логгінгом)
// Підключення:
//   <script>window.OG_PROXY_BASE = 'https://www.dimgord.cc';</script>
//   <script src="/static/js/ig.js"></script>

$(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const PROXY_BASE = (window.OG_PROXY_BASE || 'https://www.dimgord.cc').replace(/\/+$/, '');
  const RESOLVE_API = PROXY_BASE + '/resolve?url=';
  const OG_API = PROXY_BASE + '/og-proxy?url=';

  console.log('[InstagramEmbed] init with proxy', PROXY_BASE);

  // --- helpers ---
  const isIg = (u) => /^https?:\/\/(?:www\.)?instagram\.com\//i.test(u);
  const isIgPost = (u) => /https?:\/\/(?:www\.)?instagram\.com\/p\/([A-Za-z0-9_-]+)/i.exec(u);
  const isIgReel = (u) => /https?:\/\/(?:www\.)?instagram\.com\/reel\/([A-Za-z0-9_-]+)/i.exec(u);
  const isIgTv   = (u) => /https?:\/\/(?:www\.)?instagram\.com\/tv\/([A-Za-z0-9_-]+)/i.exec(u);

  function stripIgQuery(u) {
    try {
      const url = new URL(u);
      if (/^l\.instagram\.com$/i.test(url.hostname)) {
        const orig = url.searchParams.get('u');
        if (orig) {
          console.log('[InstagramEmbed] expanded l.instagram.com →', orig);
          return stripIgQuery(orig);
        }
      }
      url.searchParams.delete('igshid');
      for (const k of Array.from(url.searchParams.keys())) {
        if (/^utm_/i.test(k)) url.searchParams.delete(k);
      }
      return url.toString();
    } catch {
      return u;
    }
  }

  async function fetchJSON(url) {
    console.log('[InstagramEmbed] fetchJSON', url);
    const r = await fetch(url);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!ct.includes('application/json')) throw new Error(`Bad CT: ${ct}`);
    return r.json();
  }

  async function resolveUrl(u) {
    try {
      const j = await fetchJSON(RESOLVE_API + encodeURIComponent(u));
      console.log('[InstagramEmbed] resolved', u, '→', j.finalUrl);
      return j.finalUrl || u;
    } catch (e) {
      console.warn('[InstagramEmbed] resolve failed for', u, e);
      return u;
    }
  }

  async function fetchOG(u) {
    try {
      const d = await fetchJSON(OG_API + encodeURIComponent(u));
      console.log('[InstagramEmbed] OG for', u, d);
      return d;
    } catch (e) {
      console.warn('[InstagramEmbed] OG fetch failed for', u, e);
      return null;
    }
  }

  function ensureIgSdk(rootEl) {
    const IG_ID = 'instagram-embed-js';
    const load = () => {
      try {
        if (window.instgrm && window.instgrm.Embeds && window.instgrm.Embeds.process) {
          console.log('[InstagramEmbed] processing embeds…');
          rootEl ? window.instgrm.Embeds.process(rootEl) : window.instgrm.Embeds.process();
        }
      } catch (e) {
        console.warn('[InstagramEmbed] instgrm.Embeds.process failed', e);
      }
    };
    if (!document.getElementById(IG_ID)) {
      console.log('[InstagramEmbed] injecting embed.js…');
      const js = document.createElement('script');
      js.id = IG_ID;
      js.src = 'https://www.instagram.com/embed.js';
      js.onload = load;
      document.body.appendChild(js);
    } else {
      load();
    }
  }

  function renderIGCard(data, href) {
    console.log('[InstagramEmbed] render fallback card for', href);
    const wrap = document.createElement('div');
    wrap.className = 'og_preview ig_fallback';
    wrap.style.cssText = 'border:1px solid #ccc;border-radius:8px;padding:12px;margin-top:10px;max-width:500px;background:#111;color:#fff;';
    const title = (data && data.title) || 'View on Instagram';
    const link  = (data && data.url) || href || '#';
    const desc  = (data && data.description) ? `<p style="margin:8px 0 0;line-height:1.4;">${data.description}</p>` : '';
    const img   = (data && data.image) ? `<img src="${data.image}" loading="lazy" alt="preview" style="width:100%;max-height:320px;object-fit:cover;border-radius:6px;margin-top:10px;">` : '';
    wrap.innerHTML =
      `<div class="og_brand" style="font-size:13px;opacity:.75;margin-bottom:6px;">Instagram</div>` +
      `<a href="${link}" target="_blank" style="font-weight:700;font-size:16px;color:#b1a4e8;text-decoration:none;">${title}</a>` +
      desc + img;
    return wrap;
  }

  function embedInstagramLink(linkEl, contentBlock) {
    const origHref = linkEl.getAttribute('href') || '';
    if (!origHref) return;

    if (linkEl.dataset.igEmbedded === '1') return;

    (async () => {
      let href = stripIgQuery(origHref);
      if (/^https?:\/\/l\.instagram\.com/i.test(href)) {
        href = await resolveUrl(href);
        href = stripIgQuery(href);
      }
      if (!isIg(href)) return;

      console.log('[InstagramEmbed] processing link', href);

      const igPost = isIgPost(href);
      const igReel = isIgReel(href);
      const igTv   = isIgTv(href);
      const kind   = igPost ? 'post' : igReel ? 'reel' : igTv ? 'tv' : null;

      if (kind) {
        const idPart = (igPost && igPost[1]) || (igReel && igReel[1]) || (igTv && igTv[1]);
        const widgetId = `instagram-${kind}-${idPart}`;
        if (!contentBlock.querySelector('#' + CSS.escape(widgetId))) {
          console.log('[InstagramEmbed] inserting official embed for', kind, idPart);
          const html =
            `<blockquote id="${widgetId}" class="instagram-media" ` +
            `data-instgrm-captioned data-instgrm-permalink="${href}" ` +
            `style="margin:10px 0; max-width:540px; min-width:326px;"></blockquote>` +
            `<a href="${href}" target="_blank" rel="noopener" style="display:none">.</a>`;
          linkEl.insertAdjacentHTML('afterend', html);
          ensureIgSdk(contentBlock);
        }
        linkEl.dataset.igEmbedded = '1';
        return;
      }

      const og = await fetchOG(href);
      const card = renderIGCard(og || { url: href, title: 'View on Instagram' }, href);
      linkEl.insertAdjacentElement('afterend', card);
      linkEl.dataset.igEmbedded = '1';
    })();
  }

  function scanOnce() {
    console.log('[InstagramEmbed] scanning for instagram.com links…');
    const posts = document.querySelectorAll('div.postbody');
    posts.forEach((contentBlock) => {
      const links = contentBlock.querySelectorAll('a[href*="instagram.com/"], a[href*="l.instagram.com/"]');
      links.forEach((a) => embedInstagramLink(a, contentBlock));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanOnce);
  } else {
    scanOnce();
  }
});
