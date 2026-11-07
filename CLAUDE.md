# CLAUDE.md

Working context for og-stealth-proxy. History: `PROGRESS.md`.

## What this is

Two halves:

- **Server** (`index.js`, Express on :3000, Puppeteer + stealth, Redis cache): `/og-proxy`, `/resolve`,
  `/can-embed-fb`, `/render`. Runs on **dvg-one** as the system service `ogproxy`
  (`.nixfiles/hosts/dvg-one/ogproxy.nix`) **straight from this checkout** — `WorkingDirectory` and
  `ExecStart` point here. So an edit to `index.js` goes live with `task restart`, no deploy step.
  Caddy serves it as `https://www.dimgord.cc/{og-proxy,resolve,…}`.
- **Client scripts** (`client/*.js`) for the itmtank forum (forumotion,
  https://2021-itmtank.forumgamers.net). They are **pasted by the owner** into forumotion's admin
  (JavaScript codes management, "all pages"); nothing here deploys them. Forumotion joins all codes into
  one file, `/99578.js`. `task live` saves that file to `client/live/99578.min.js`, the reference for
  what is actually running.

## Which client file is live

Live = FB (`fb.js`), Telegram, Instagram, the censor.net OG preview, and the `{itmvid}` bunny embed
(that one lives in the `bunny-uploader` repo). The repo files drifted from the live code before Rev 1
(the live FB code had a blocked-video fallback the repo lacked): **before editing a client file, diff it
against `client/live/99578.min.js`** (prettier it first), and treat the live code as the truth.

## Forumotion facts the scripts depend on

- `[embed]URL[/embed]` renders as `<div class="link_embed"><a href=URL>URL</a></div>` for members.
  Guests get `[You must be registered and logged in to see this link.]` instead, and in some sections a
  bare-text URL with no `<a>`. So a guest view does not show what members see: test by rewriting the
  page HTML (Playwright `route`) to the member markup. The forum RSS (`/rss`) carries the member markup.
- Forumotion's `FA_Embed.js` (illipro.net) on `DOMContentLoaded` takes every `.link_embed a`, asks
  `/ajax/embed_link.php?url=…`, and **replaces the `<a>` node** with the answer. It embeds YouTube, X,
  and FB `/<page>/posts/`, `groups/…/posts/`, `permalink.php`, `story.php`, `photo.php`, `/<page>/videos/`
  (via its `fb_frame_embed.php`). For everything else it returns a plain `<a>`.
- Our scripts run on **jQuery ready**, which fires **before** FA_Embed's handler (jQuery 1.7 binds
  `DOMContentLoaded` first). `fb.js` relies on this: it replaces the `<a>` with its own slot, so FA_Embed
  never sees the link, and async work fills a node FA_Embed does not touch. Inserting after a link and
  filling later would land on a detached node once FA_Embed swaps the `<a>`.
- `fb.js` `FA_HANDLES` lists the forms forumotion embeds; those links are skipped. Re-probe
  `embed_link.php` if forumotion changes (curl it with `?url=`).

## Footguns

- `/resolve` for a dead or private FB share link returns the share URL itself (sometimes with
  `?_fb_noscript=1`). The server only counts a result as resolved if it is no longer a `/share/` path
  (`progressed()`), and the client re-checks with `needsResolve()`.
- `/og-proxy` on a login-walled FB page returns "Log in or sign up to view": `fetchOG` in `fb.js`
  treats that as no preview.
- og-proxy fields come HTML-escaped (`&amp;` in image URLs): the client decodes once, then escapes.
- Puppeteer Chrome comes from nixpkgs (`PUPPETEER_EXECUTABLE_PATH`); `node` is not on PATH in an
  interactive shell on dvg-one — the Taskfile uses `nix shell nixpkgs#nodejs`.
