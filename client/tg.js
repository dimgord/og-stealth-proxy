// Telegram post embeds for the itmtank forum (forumotion → JavaScript codes management, all pages).
// Forumotion does not embed t.me itself. History and rationale: PROGRESS.md (Rev 2).
$(function () {
  const TAG = '[TelegramEmbed]';
  const TG_HOST = /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)$/i;

  console.log(TAG, 'scanning posts for t.me links…');

  // t.me/<channel>/<id>, t.me/s/<channel>/<id> → {channel, id, single}; t.me/c/… (private) → null
  function parsePost(u) {
    let x;
    try { x = new URL(u, location.href); } catch (e) { return null; }
    if (!TG_HOST.test(x.hostname)) return null;
    const m = /^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,})\/(\d+)\/?$/.exec(x.pathname);
    if (!m || m[1].toLowerCase() === 'c') return null;
    return { channel: m[1], id: m[2], single: x.searchParams.has('single') };
  }

  // the embed page posts {"event":"resize","height":N} to its parent; size each frame to its post
  const frames = new Map(); // contentWindow → iframe
  window.addEventListener('message', function (e) {
    if (!/^https:\/\/t\.me$/.test(e.origin)) return;
    const f = frames.get(e.source);
    if (!f) return;
    let d;
    try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (d && d.event === 'resize' && d.height > 0) f.style.height = Math.ceil(d.height) + 'px';
  });

  function embed(slot, p) {
    const f = document.createElement('iframe');
    f.src = 'https://t.me/' + p.channel + '/' + p.id + '?embed=1' + (p.single ? '&single=1' : '');
    f.loading = 'lazy';
    f.setAttribute('scrolling', 'no');
    f.style.cssText = 'display:block;width:100%;max-width:550px;height:500px;border:0;overflow:hidden;color-scheme:light;';
    slot.appendChild(f);
    frames.set(f.contentWindow, f);
    // lazy frames get their window on load; register again then
    f.addEventListener('load', function () { frames.set(f.contentWindow, f); });
  }

  // Runs on jQuery ready, before forumotion's FA_Embed collects '.link_embed a' (see CLAUDE.md):
  // an [embed] link replaced here never reaches FA_Embed.
  $('div.postbody').each(function () {
    const block = this;
    // some [embed] blocks hold the URL as bare text: make it a link first
    block.querySelectorAll('.link_embed').forEach(function (le) {
      const t = le.textContent.trim();
      if (le.querySelector('a') || !parsePost(t)) return;
      const a = document.createElement('a');
      a.href = t;
      a.textContent = t;
      le.replaceChildren(a);
    });
    block.querySelectorAll('a[href*="t.me/"], a[href*="telegram.me/"], a[href*="telegram.dog/"]').forEach(function (a) {
      if (a.dataset.tgEmbedded) return;
      a.dataset.tgEmbedded = '1';
      const p = parsePost(a.getAttribute('href') || '');
      if (!p) return; // channel, private or invite link: keep as a plain link
      const slot = document.createElement('div');
      slot.className = 'tg_embed_slot';
      slot.style.margin = '10px 0';
      if (a.closest('.link_embed')) a.replaceWith(slot); // [embed] block: the embed replaces the URL
      else a.after(slot); // a link inside text: keep it, embed below
      embed(slot, p);
      console.log(TAG, 'embedded', p.channel + '/' + p.id);
    });
  });
});
