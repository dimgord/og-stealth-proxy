# Progress Log

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
  `client/live/99578.min.js` (the forum's combined JS as of today).
- **Deploy:** the owner replaces the FB code in forumotion admin with `client/fb.js`.

Files modified: `client/fb.js`, `index.js`, `README.md`; new `CLAUDE.md`, `PROGRESS.md`,
`Taskfile.yml`, `client/live/99578.min.js`.

Version: no version files in this repo.
