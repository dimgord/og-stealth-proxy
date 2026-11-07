# Progress Log

## Rev 2 — 2026-11-07

**Telegram and Instagram embeds reworked; Facebook Rev 1 confirmed live**

- **Facebook:** the owner pasted the Rev 1 `fb.js` into forumotion. Checked on the live forum (headless,
  member markup): the share link `/share/p/19ZUAf5XQr`, `photo?fbid=…` and a `/reel/` all embed.
- **Telegram, problems in the live script:**
  - the iframe height was forced to 400 px ("too short" check on a fixed 500 px frame), so long posts were
    cut and scrolled inside the frame;
  - `t.me/s/<channel>/<id>` links (the web-preview form) did not match the regex, so no embed.
- **Telegram, `client/tg.js` rewritten:**
  - `t.me`, `telegram.me`, `telegram.dog`; `/<channel>/<id>` and `/s/<channel>/<id>`; `?single` kept;
    private `t.me/c/…` and invite/channel links stay plain links;
  - height follows the post: the embed page (`widget-frame.js`) posts `{"event":"resize","height":N}`
    to its parent, a `message` listener sizes the matching iframe;
  - same slot pattern as `fb.js` (replace the `[embed]` link before FA_Embed; keep links in text).
- **Instagram, problems in the live script:**
  - a `/p/` post was embedded **three times**: forumotion's FA_Embed returns its own
    `blockquote.instagram-media` for `/p/`, our script added a second, embed.js rendered both (plus a
    duplicate frame);
  - the URL text stayed visible above a reel embed; `?igsh=` was not stripped (only `igshid`).
- **Instagram, `client/ig.js` rewritten:**
  - `/p/`, `/reel/`, `/reels/`, `/tv/`, `/<user>/p/…` → one `instagram-media` blockquote with the canonical
    permalink, one embed.js load for the page;
  - `/share/…` links via `/resolve`; `l.instagram.com` unwrapped; `igsh`, `igshid`, `utm_*` dropped;
  - other IG links in an `[embed]` block (profile, …) → OG card; the login wall is not used as a preview;
  - the slot replaces the `[embed]` link before FA_Embed, so forumotion no longer embeds `/p/` a second time.
- **Server, `/resolve`:** Instagram `/share/…` links are followed too, and a result that is still an IG
  share URL does not count as resolved. `ogproxy` restarted.
- **Forum JS file name:** forumotion gives the combined JS a new name on every edit (`/99578.js` →
  `/99729.js` after the FB paste). `task live` now reads the name from the home page and saves to
  `client/live/forum.min.js` (renamed from `99578.min.js`, now today's live file with the Rev 1 FB code).
- **Verified** (headless, member markup, live JS with the TG+IG parts swapped for the new files):
  - TG `voynareal/130099` → 1282 px frame, whole post visible; `t.me/s/ButusovPlus/19500` → embedded,
    398 px; `exilenova_plus/1297?single` → embedded with `&single=1` (500 px: lazy frame below the fold,
    resizes once loaded);
  - IG `/p/DfaHkFJDFJW/` → 1 frame (was 3), caption shown; `/reel/DfaclLuMMv8/?igsh=abc` → 1 frame, no URL
    text, no `igsh`; profile `zelenskyy_official` → OG card.
  - A real IG share link: not tested (none at hand).
- **Deploy:** the owner replaces the Telegram and Instagram codes in forumotion admin with `client/tg.js`
  and `client/ig.js`.

Files modified: `client/tg.js`, `client/ig.js`, `index.js`, `Taskfile.yml`, `CLAUDE.md`, `README.md`,
`PROGRESS.md`; `client/live/99578.min.js` → `client/live/forum.min.js`.

Version: no version files in this repo.

## Rev 1 — 2026-11-07

**Facebook embeds on the itmtank forum: share links, photo links, m.facebook links**

- **Report:** "fb embedding doesn't work in posts". Later a `/reel/` link the owner posted did embed;
  the earlier failure there was most likely Facebook's player refusing the video (the script then shows
  the "embedding restricted" card).
- **Investigation:** a headless browser on a topic page, with the guest HTML rewritten to the member
  markup (see CLAUDE.md). Results with the old live script:
  - `/reel/…`: embedded (FB SDK).
  - `/<id>/posts/…`, X statuses: embedded, by forumotion's own FA_Embed.
  - `photo?fbid=…&set=pcb…` (seen in the forum RSS): nothing. The regex wanted `photo/?fbid` with a
    slash.
  - `/share/r|p|v/…` (what the FB app's "Copy link" gives): nothing. That branch was disabled
    (`if (0/*share*/) // switched off until better times`).
  - `m.facebook.com`, `fb.watch`: nothing.
- **Client, `client/fb.js` rewritten** (the live code was the base, not the older repo file):
  - one `classify()` for reel / watch / videos / photo (all forms) / posts / permalink / story / events;
  - share, `fb.me`, `fb.watch`, `l.facebook.com` go through `/resolve` first; unresolved → a
    "View on Facebook" card;
  - `cleanFb()`: www host, tracking params dropped (`mibextid`, `rdid`, `__cft__`, …);
  - posts/photos not handled by forumotion → `/can-embed-fb` iframe (`plugins/post.php`), else an OG card;
  - forms forumotion embeds itself (`FA_HANDLES`) are skipped, so no double embeds;
  - the link inside an `[embed]` block is replaced by a slot synchronously, before FA_Embed runs (the old
    code set `href=null`, which made FA_Embed request `embed_link.php?url=null`);
  - a link inside running text is kept and the embed goes below it;
  - a bare-text URL in `.link_embed` is turned into a link first;
  - the blocked-video fallback (FB's ~124 px stub → OG card) is kept;
  - OG cards escape their fields; FB's login wall ("Log in or sign up") is not used as a preview.
- **Server, `/resolve`:** redirects are now followed for every short-link host (before: only FB share
  links; `fb.me`, `t.co`, etc. fell through unchanged), `fb.watch` added to the list, the letterless
  `/share/<id>` form recognised, and a result that is still a share URL is not reported as resolved.
  `ogproxy` restarted.
- **Verified** (headless, live script with the FB part swapped for the new `fb.js`): photo `?fbid` →
  `plugins/post.php` iframe with the post rendered; `/posts/` → forumotion's `fb_frame_embed.php`, no
  duplicate; `m.facebook.com/reel/…?mibextid=…` and a reel link inside text → FB video player; a fake
  share link and a fake `fb.watch` → "View on Facebook" card. A real share link from the owner,
  `/share/p/19ZUAf5XQr`: `/resolve` → `/<page>/posts/pfbid…` in 2.8 s (method `auto`) → `plugins/post.php`
  iframe, post text and photos rendered.
- **Added:** `CLAUDE.md`, `PROGRESS.md`, `Taskfile.yml` (`check`, `restart`, `logs`, `probe`, `live`),
  `client/live/99578.min.js` (the forum's combined JS as of today; `forum.min.js` since Rev 2).
- **Deploy:** the owner replaces the FB code in forumotion admin with `client/fb.js`.

Files modified: `client/fb.js`, `index.js`, `README.md`; new `CLAUDE.md`, `PROGRESS.md`,
`Taskfile.yml`, `client/live/99578.min.js`.

Version: no version files in this repo.
