// Facebook embeds for the itmtank forum (forumotion → JavaScript codes management, all pages).
// Forumotion's own FA_Embed already embeds the forms in FA_HANDLES; this script does the rest.
// History and rationale: PROGRESS.md (Rev 1).
$(function () {
  const TAG = '[FacebookEmbed]';
  const PROXY = 'https://www.dimgord.cc';
  const RESOLVE_API = PROXY + '/resolve?url=';
  const OG_API = PROXY + '/og-proxy?url=';
  const CAN_EMB_API = PROXY + '/can-embed-fb?href=';

  const FB_HOST = /^(?:www\.|m\.|web\.|mbasic\.|touch\.)?facebook\.com$/i;
  const SHORT_HOST = /^(?:fb\.me|fb\.watch|l\.facebook\.com)$/i;
  const SHARE_PATH = /^\/share\/(?:[a-z]\/)?[A-Za-z0-9]+\/?$/i;
  const TRACKING = /^(?:mibextid|rdid|share_url|sfnsn|__cft__.*|__tn__|ref|refsrc|fs|s|paipv|eav|_rdr|_fb_noscript|m|extid|app)$/i;
  // what forumotion embeds by itself (as typed, www host): leave those links alone
  const FA_HANDLES = [
    /^https:\/\/www\.facebook\.com\/[^\/?#]+\/posts\//i,
    /^https:\/\/www\.facebook\.com\/groups\/[^\/?#]+\/posts\//i,
    /^https:\/\/www\.facebook\.com\/(?:permalink|story|photo)\.php\?/i,
    /^https:\/\/www\.facebook\.com\/[^\/?#]+\/videos\//i,
  ];

  console.log(TAG, 'scanning posts for facebook.com / fb.me / fb.watch links…');

  // ---------- URL helpers ----------
  function parse(u) {
    try { return new URL(u, location.href); } catch (e) { return null; }
  }

  // www host, no tracking params, no hash; l.facebook.com/l.php?u=… is unwrapped
  function cleanFb(u) {
    const x = parse(u);
    if (!x) return u;
    if (/^l\.facebook\.com$/i.test(x.hostname) && x.searchParams.get('u')) return cleanFb(x.searchParams.get('u'));
    if (!FB_HOST.test(x.hostname)) return x.href;
    x.protocol = 'https:';
    x.hostname = 'www.facebook.com';
    x.hash = '';
    [...x.searchParams.keys()].filter((k) => TRACKING.test(k)).forEach((k) => x.searchParams.delete(k));
    return x.href.replace(/\?$/, '');
  }

  function needsResolve(u) {
    const x = parse(u);
    return !!x && (SHORT_HOST.test(x.hostname) || (FB_HOST.test(x.hostname) && SHARE_PATH.test(x.pathname)));
  }

  // → {kind:'video', dataHref} | {kind:'post'} | {kind:'event'} | null
  function classify(u) {
    const x = parse(u);
    if (!x || !FB_HOST.test(x.hostname)) return null;
    const p = x.pathname;
    let m;
    if ((m = /^\/reel\/(\d+)/i.exec(p))) return { kind: 'video', dataHref: 'https://www.facebook.com/reel/' + m[1] };
    if (/^\/watch\/?$/i.test(p) && x.searchParams.get('v')) return { kind: 'video', dataHref: 'https://www.facebook.com/watch/?v=' + x.searchParams.get('v') };
    if ((m = /^\/videos\/(\d+)/i.exec(p))) return { kind: 'video', dataHref: 'https://www.facebook.com/videos/' + m[1] };
    if ((m = /^\/([^\/]+)\/videos\/(?:[^\/]+\/)?(\d+)/i.exec(p))) return { kind: 'video', dataHref: 'https://www.facebook.com/' + m[1] + '/videos/' + m[2] };
    if (/^\/events\/\d+/i.test(p)) return { kind: 'event' };
    if (/^\/photo(?:\.php)?\/?$/i.test(p) && x.searchParams.get('fbid')) return { kind: 'post' };
    if (/^\/[^\/]+\/photos\//i.test(p)) return { kind: 'post' };
    if (/^\/(?:permalink|story)\.php$/i.test(p) && x.searchParams.get('story_fbid')) return { kind: 'post' };
    if (/^\/(?:groups\/)?[^\/]+\/posts\//i.test(p)) return { kind: 'post' };
    if (/^\/[^\/]+\/(?:[^\/]+\/)?posts\//i.test(p)) return { kind: 'post' };
    return null;
  }

  async function resolveUrl(u) {
    try {
      const r = await fetch(RESOLVE_API + encodeURIComponent(u));
      if (!r.ok) throw new Error('resolve http ' + r.status);
      const d = await r.json();
      return d.finalUrl && !needsResolve(d.finalUrl) ? d.finalUrl : null;
    } catch (e) {
      console.warn(TAG, 'resolve failed for', u, e);
      return null;
    }
  }

  async function fetchOG(u) {
    try {
      const r = await fetch(OG_API + encodeURIComponent(u));
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('application/json')) return null;
      const d = await r.json();
      // FB's login wall is not a preview
      return d && d.title && !/log in or sign up|^facebook$/i.test(d.title + ' ' + (d.description || '')) ? d : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- rendering ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // og fields arrive HTML-escaped already (&amp; in image URLs): decode once, then escape for our markup
  function unesc(s) {
    const t = document.createElement('textarea');
    t.innerHTML = String(s == null ? '' : s);
    return t.value;
  }

  function card(href, og, note) {
    const el = document.createElement('div');
    el.className = 'og_preview fb_card';
    el.style.cssText = 'border:1px solid #ccc;border-radius:8px;padding:12px;margin:10px 0;max-width:500px;background:#0f111a;color:#fff;';
    const title = og && og.title ? unesc(og.title) : 'View on Facebook';
    el.innerHTML =
      '<div style="font-size:13px;opacity:.75;margin-bottom:6px;">' +
      '<img src="https://static.xx.fbcdn.net/rsrc.php/yd/r/hlvibnBVrEb.svg" alt="" style="height:18px;vertical-align:middle;margin-right:8px;">' +
      esc(note || 'Facebook') + '</div>' +
      '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="font-weight:700;font-size:16px;color:#b1a4e8;text-decoration:none;">' + esc(title) + '</a>' +
      (og && og.description ? '<p style="margin:8px 0 0;line-height:1.4;font-size:14px;">' + esc(unesc(og.description)) + '</p>' : '') +
      (og && og.image ? '<img src="' + esc(unesc(og.image)) + '" loading="lazy" alt="" style="width:100%;max-height:300px;object-fit:cover;border-radius:6px;margin-top:10px;">' : '');
    return el;
  }

  async function showCard(slot, href, note) {
    const og = await fetchOG(href);
    slot.replaceChildren(card((og && og.url) || href, og, note));
  }

  function ensureFbSdk(el) {
    if (!window.fbAsyncInit) {
      window.fbAsyncInit = function () {
        FB.init({ xfbml: true, version: 'v19.0' });
        FB.Event.subscribe('xfbml.render', checkVideoEmbedFailures);
      };
      if (!document.getElementById('facebook-jssdk')) {
        const js = document.createElement('script');
        js.id = 'facebook-jssdk';
        js.src = 'https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0';
        document.body.appendChild(js);
      }
    } else if (window.FB && FB.XFBML && FB.XFBML.parse) {
      FB.XFBML.parse(el, checkVideoEmbedFailures);
    }
  }

  // FB renders a ~124px "video unavailable" stub for videos that refuse embedding: swap in a card
  function checkVideoEmbedFailures() {
    document.querySelectorAll('.fb-video').forEach(function (w) {
      if (w.dataset.fallbackChecked) return;
      w.dataset.fallbackChecked = '1';
      setTimeout(function () {
        const f = w.querySelector('iframe');
        const h = f ? f.getBoundingClientRect().height : 0;
        if (!f || (h > 0 && h < 250)) {
          console.log(TAG, 'video blocked (height=' + h + '), card for', w.dataset.href);
          showCard(w.parentNode, w.dataset.href, 'Video (embedding restricted)');
        }
      }, 2000);
    });
  }

  function embedVideo(slot, dataHref, block) {
    slot.innerHTML = '<div class="fb-video" data-href="' + esc(dataHref) + '" data-width="500"></div>';
    ensureFbSdk(block);
  }

  async function embedPost(slot, href) {
    const r = await fetch(CAN_EMB_API + encodeURIComponent(href) + '&origin=' + encodeURIComponent(location.origin))
      .then((x) => x.json())
      .catch(() => ({ ok: false }));
    if (r.ok && r.src) {
      slot.innerHTML = '<iframe src="' + esc(r.src) + '" width="500" height="680" style="border:none;overflow:hidden;max-width:100%" ' +
        'scrolling="no" frameborder="0" allow="encrypted-media; picture-in-picture; web-share; clipboard-write"></iframe>';
    } else {
      await showCard(slot, href);
    }
  }

  // ---------- one link ----------
  async function handle(slot, href, block) {
    let url = href;
    if (needsResolve(url)) {
      const fin = await resolveUrl(url);
      if (!fin) {
        console.log(TAG, 'could not resolve, card for', href);
        return showCard(slot, href);
      }
      url = cleanFb(fin);
      console.log(TAG, 'resolved', href, '→', url);
    }
    const c = classify(url);
    if (!c) return showCard(slot, url);
    console.log(TAG, 'matched', c.kind, url);
    if (c.kind === 'video') return embedVideo(slot, c.dataHref, block);
    if (c.kind === 'post') return embedPost(slot, url);
    return showCard(slot, url);
  }

  // ---------- scan ----------
  // Runs on jQuery ready, i.e. before FA_Embed's DOMContentLoaded handler collects '.link_embed a'.
  // So a link replaced by our slot here is never fetched by FA_Embed, and the slot survives it.
  $('div.postbody').each(function () {
    const block = this;
    // some [embed] blocks hold the URL as bare text (no <a>): make it a link first
    block.querySelectorAll('.link_embed').forEach(function (le) {
      const t = le.textContent.trim();
      if (le.querySelector('a') || !/^https?:\/\/(?:[a-z]+\.)?(?:facebook\.com|fb\.me|fb\.watch)\/\S+$/i.test(t)) return;
      const a = document.createElement('a');
      a.href = t;
      a.textContent = t;
      le.replaceChildren(a);
    });
    block.querySelectorAll('a[href*="facebook.com/"], a[href*="fb.me/"], a[href*="fb.watch/"]').forEach(function (a) {
      if (a.dataset.fbEmbedded) return;
      a.dataset.fbEmbedded = '1';
      const raw = a.getAttribute('href') || '';
      if (FA_HANDLES.some((re) => re.test(raw))) return; // forumotion embeds it
      const href = cleanFb(raw);
      if (!needsResolve(href) && !classify(href)) return; // a profile/page link etc.: keep as a plain link

      const slot = document.createElement('div');
      slot.className = 'fb_embed_slot';
      slot.style.margin = '10px 0';
      if (a.closest('.link_embed')) a.replaceWith(slot); // [embed] block: the embed replaces the URL
      else a.after(slot); // a link inside text: keep it, embed below

      handle(slot, href, block).catch(function (e) {
        console.warn(TAG, 'failed for', href, e);
        slot.replaceChildren(card(href, null));
      });
    });
  });
});
