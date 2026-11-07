// Instagram embeds for the itmtank forum (forumotion → JavaScript codes management, all pages).
// Forumotion's FA_Embed embeds /p/ links itself; replacing the [embed] link here keeps it from doing so,
// so each post is embedded once. History and rationale: PROGRESS.md (Rev 2).
$(function () {
  const TAG = '[InstagramEmbed]';
  const PROXY = 'https://www.dimgord.cc';
  const RESOLVE_API = PROXY + '/resolve?url=';
  const OG_API = PROXY + '/og-proxy?url=';
  const IG_HOST = /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)$/i;

  console.log(TAG, 'scanning posts for instagram.com links…');

  function parse(u) {
    try { return new URL(u, location.href); } catch (e) { return null; }
  }

  // l.instagram.com/?u=… unwrapped; www host; tracking params dropped
  function cleanIg(u) {
    const x = parse(u);
    if (!x) return u;
    if (/^l\.instagram\.com$/i.test(x.hostname) && x.searchParams.get('u')) return cleanIg(x.searchParams.get('u'));
    if (!IG_HOST.test(x.hostname)) return x.href;
    x.protocol = 'https:';
    x.hostname = 'www.instagram.com';
    x.hash = '';
    [...x.searchParams.keys()].filter((k) => /^(?:igsh|igshid|utm_.*|ig_rid|ig_mid)$/i.test(k)).forEach((k) => x.searchParams.delete(k));
    return x.href.replace(/\?$/, '');
  }

  const isIg = (u) => { const x = parse(u); return !!x && IG_HOST.test(x.hostname); };
  const isShare = (u) => { const x = parse(u); return !!x && IG_HOST.test(x.hostname) && /^\/share\//i.test(x.pathname); };

  // /p/<id>, /reel/<id>, /reels/<id>, /tv/<id>, also /<user>/p/<id> → canonical permalink
  function permalink(u) {
    const x = parse(u);
    if (!x || !IG_HOST.test(x.hostname)) return null;
    const m = /^\/(?:[A-Za-z0-9_.]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]+)/i.exec(x.pathname);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return 'https://www.instagram.com/' + kind + '/' + m[2] + '/';
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('application/json')) throw new Error('http ' + r.status);
    return r.json();
  }

  async function resolveUrl(u) {
    try {
      const d = await getJSON(RESOLVE_API + encodeURIComponent(u));
      return d.finalUrl && !isShare(d.finalUrl) ? d.finalUrl : null;
    } catch (e) {
      console.warn(TAG, 'resolve failed for', u, e);
      return null;
    }
  }

  async function fetchOG(u) {
    try {
      const d = await getJSON(OG_API + encodeURIComponent(u));
      // the login wall is not a preview
      return d && d.title && !/^(?:instagram|log ?in • instagram)$/i.test(d.title.trim()) ? d : null;
    } catch (e) {
      return null;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // og fields arrive HTML-escaped already: decode once, then escape for our markup
  function unesc(s) {
    const t = document.createElement('textarea');
    t.innerHTML = String(s == null ? '' : s);
    return t.value;
  }

  function card(href, og) {
    const el = document.createElement('div');
    el.className = 'og_preview ig_card';
    el.style.cssText = 'border:1px solid #ccc;border-radius:8px;padding:12px;margin:10px 0;max-width:500px;background:#111;color:#fff;';
    el.innerHTML =
      '<div style="font-size:13px;opacity:.75;margin-bottom:6px;">Instagram</div>' +
      '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="font-weight:700;font-size:16px;color:#b1a4e8;text-decoration:none;">' +
      esc(og && og.title ? unesc(og.title) : 'View on Instagram') + '</a>' +
      (og && og.description ? '<p style="margin:8px 0 0;line-height:1.4;font-size:14px;">' + esc(unesc(og.description)) + '</p>' : '') +
      (og && og.image ? '<img src="' + esc(unesc(og.image)) + '" loading="lazy" alt="" style="width:100%;max-height:320px;object-fit:cover;border-radius:6px;margin-top:10px;">' : '');
    return el;
  }

  async function showCard(slot, href) {
    const og = await fetchOG(href);
    slot.replaceChildren(card(href, og));
  }

  // one embed.js for the page; process() again for slots filled after it loaded
  let sdk = null;
  function processEmbeds() {
    if (!sdk) {
      sdk = new Promise(function (ok) {
        const js = document.createElement('script');
        js.src = 'https://www.instagram.com/embed.js';
        js.async = true;
        js.onload = ok;
        document.body.appendChild(js);
      });
    }
    sdk.then(function () {
      if (window.instgrm && instgrm.Embeds) instgrm.Embeds.process();
    });
  }

  function embed(slot, link) {
    slot.innerHTML =
      '<blockquote class="instagram-media" data-instgrm-captioned data-instgrm-version="14" data-instgrm-permalink="' + esc(link) + '" ' +
      'style="margin:0;max-width:540px;min-width:326px;width:calc(100% - 2px);"><a href="' + esc(link) + '" target="_blank" rel="noopener">' +
      esc(link) + '</a></blockquote>';
    processEmbeds();
  }

  async function handle(slot, href) {
    let url = href;
    if (isShare(url)) {
      const fin = await resolveUrl(url);
      if (!fin) return showCard(slot, href);
      url = cleanIg(fin);
      console.log(TAG, 'resolved', href, '→', url);
    }
    const link = permalink(url);
    if (link) {
      console.log(TAG, 'embedded', link);
      return embed(slot, link);
    }
    return showCard(slot, url); // profile, story, …: preview card
  }

  // Runs on jQuery ready, before FA_Embed's DOMContentLoaded handler (see CLAUDE.md).
  $('div.postbody').each(function () {
    const block = this;
    // some [embed] blocks hold the URL as bare text: make it a link first
    block.querySelectorAll('.link_embed').forEach(function (le) {
      const t = le.textContent.trim();
      if (le.querySelector('a') || !/^https?:\/\/\S+$/.test(t) || !isIg(cleanIg(t))) return;
      const a = document.createElement('a');
      a.href = t;
      a.textContent = t;
      le.replaceChildren(a);
    });
    block.querySelectorAll('a[href*="instagram.com/"], a[href*="instagr.am/"]').forEach(function (a) {
      if (a.dataset.igEmbedded) return;
      a.dataset.igEmbedded = '1';
      const href = cleanIg(a.getAttribute('href') || '');
      if (!isIg(href)) return;
      const inEmbed = !!a.closest('.link_embed');
      // a bare profile link in running text stays a link; anything in an [embed] block gets an embed or a card
      if (!inEmbed && !permalink(href) && !isShare(href)) return;
      const slot = document.createElement('div');
      slot.className = 'ig_embed_slot';
      slot.style.margin = '10px 0';
      if (inEmbed) a.replaceWith(slot);
      else a.after(slot);
      handle(slot, href).catch(function (e) {
        console.warn(TAG, 'failed for', href, e);
        slot.replaceChildren(card(href, null));
      });
    });
  });
});
