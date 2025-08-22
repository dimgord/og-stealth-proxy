// ig.js — Instagram embeder (reels / p / tv) з фолбеком на OG-проксі
// Залежності: jQuery 1.9+
//
// Мінімальна інтеграція:
//   <script src="/path/to/jquery.js"></script>
//   <script src="/path/to/ig.js"></script>

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // --- налаштування ---
  // Можеш глобально задати window.OG_PROXY_BASE = 'https://www.dimgord.cc'
  // щоб не хардкодити тут.
  const PROXY_BASE = (window.OG_PROXY_BASE || 'https://www.dimgord.cc').replace(/\/+$/, '');
  const RESOLVE_API = PROXY_BASE + '/resolve?url=';
  const OG_API = PROXY_BASE + '/og-proxy?url=';

  // --- helpers ---
  const isIg = (u) => /https?:\/\/(www\.)?instagram\.com\//i.test(u);

  const stripIgQuery = (u) => {
    try {
      const url = new URL(u);
      // l.instagram.com/?u=... → дістаємо оригінал
      if (/^l\.instagram\.com$/i.test(url.hostname)) {
        const orig = url.searchParams.get('u');
        if (orig) return stripIgQuery(orig);
      }
      // чистимо сміття
      url.searchParams.delete('igshid');
      Array.from(url.searchParams.keys()).forEach((k) => {
        if (/^utm_/i.test(k)) url.searchParams.delete(k);
      });
      return url.toString();
    } catch {
      return u;
    }
  };

  const isIgPost = (u) => /https?:\/\/(?:www\.)?instagram\.com\/p\/([A-Za-z0-9_-]+)/i.exec(u);
  const isIgReel = (u) => /https?:\/\/(?:www\.)?instagram\.com\/reel\/([A-Za-z0-9_-]+)/i.exec(u);
  const isIgTv   = (u)   => /https?:\/\/(?:www\.)?instagram\.com\/tv\/([A-Za-z0-9_-]+)/i.exec(u);

  async function fetchJSON(url) {
    const r = await fetch(url);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!ct.includes('application/json')) throw new Error(`Bad CT: ${ct}`);
    return r.json();
  }

  async function resolveUrl(u) {
    try {
      const j = await fetchJSON(RESOLVE_API + encodeURIComponent(u));
      return j.finalUrl || u;
    } catch {
      return u;
    }
  }

  async function fetchOG(u) {
    try {
      return await fetchJSON(OG_API + encodeURIComponent(u)); // {title, description, image, url}
    } catch {
      return null;
    }
  }

  function ensureIgSdk(rootEl) {
    const IG_ID = 'instagram-embed-js';
    const load = () => {
      try {
        if (window.instgrm && window.instgrm.Embeds && window.instgrm.Embeds.process) {
          // якщо передали корінь — процесимо вибірково
          if (rootEl) window.instgrm.Embeds.process(rootEl);
          else window.instgrm.Embeds.process();
        }
      } catch {}
    };
    if (!document.getElementById(IG_ID)) {
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

  function embedInstagramLink($link, contentBlock) {
    const origHref = $link.attr('href') || '';
    if (!origHref) return;

    // не дублюємо роботу
    if ($link.data('ig-embedded')) return;

    (async () => {
      let href = stripIgQuery(origHref);
      if (/^https?:\/\/l\.instagram\.com/i.test(href)) {
        href = await resolveUrl(href);
        href = stripIgQuery(href);
      }

      if (!isIg(href)) return;

      const igPost = isIgPost(href);
      const igReel = isIgReel(href);
      const igTv   = isIgTv(href);
      const kind   = igPost ? 'post' : igReel ? 'reel' : igTv ? 'tv' : null;

      if (kind) {
        const idPart = (igPost && igPost[1]) || (igReel && igReel[1]) || (igTv && igTv[1]);
        const widgetId = 'instagram-' + kind + '-' + idPart;
        if (contentBlock.find('#' + widgetId).length === 0) {
          // офіційний інста-ембед: blockquote + link
          $link.after(
            '<blockquote id="' + widgetId + '" class="instagram-media" ' +
            'data-instgrm-captioned data-instgrm-permalink="' + href + '" ' +
            'style="margin:10px 0; max-width:540px; min-width:326px;"></blockquote>' +
            '<a href="' + href + '" target="_blank" rel="noopener" style="display:none">.</a>'
          );
          ensureIgSdk(contentBlock[0]);
        }
        $link.data('ig-embedded', true);
        return;
      }

      // Фолбек: красива OG‑картка
      const og = await fetchOG(href);
      const card = renderIGCard(og || { url: href, title: 'View on Instagram' }, href);
      $link.after(card);
      $link.data('ig-embedded', true);
    })();
  }

  function scanRoot($root) {
    // ті ж самі пост-блоки, що й у fb.js (підлаштовуємось під твою розмітку)
    const $posts = $root
      ? $root.find('div.postbody:contains("instagram.com/")')
      : $('div.postbody:contains("instagram.com/")');

    $posts.each(function () {
      const $contentBlock = $(this);
      const $links = $contentBlock.find('a[href*="instagram.com/"], a[href*="l.instagram.com/"]');
      $links.each(function () {
        embedInstagramLink($(this), $contentBlock);
      });
    });
  }

  // --- запуск після готовності DOM ---
  if (window.jQuery) {
    $(function () {
      console.log('[InstagramEmbed] scanning for instagram.com links…');
      scanRoot(null);
    });
  } else {
    // Якщо раптом без jQuery — базова ініціалізація (опційно)
    document.addEventListener('DOMContentLoaded', function () {
      if (!window.jQuery) return;
      $(function () {
        console.log('[InstagramEmbed] scanning for instagram.com links…');
        scanRoot(null);
      });
    });
  }

  // Експорт локального API (за бажанням)
  window._IG_EMBED = { scanRoot, ensureIgSdk };

})();

