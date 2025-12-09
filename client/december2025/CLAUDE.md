# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**og-stealth-proxy** is an OpenGraph metadata proxy service with client-side scripts for embedding social media content on third-party websites. The proxy uses Puppeteer with stealth plugin to bypass bot detection when fetching OG metadata.

## Architecture

### Server (index.js)
Node.js + Express server running on port 3000 with three main endpoints:
- **GET /og-proxy?url=** — Fetches OG metadata (title, description, image, url) using headless Chrome
- **GET /resolve?url=** — Resolves shortened/share URLs to final canonical URLs (fb.me, l.facebook.com, /share/* links)
- **GET /can-embed-fb?href=** — Checks if a Facebook post can be embedded via official FB plugin

Key components:
- **Puppeteer** with `puppeteer-extra-plugin-stealth` for bot detection bypass
- **Redis** for caching OG results (10-hour TTL)
- **PQueue** with concurrency limit of 2 for request queuing
- Browser auto-restarts hourly to prevent memory leaks

### Client Scripts (client/)
jQuery-based scripts injected into forum pages to auto-embed social media content:
- `fb.js` — Facebook posts, videos, reels, photos, events
- `tg.js` — Telegram posts via iframe
- `og-generic.js` — Generic OG preview cards for other URLs
- `december2025/generic.js` — Newer generic implementation for censor.net links

### Browser Extension (extension/)
Chrome extension for development/debugging that logs page messages.

## Development Commands

```bash
# Install dependencies
npm install

# Start server
npm start           # or: node index.js

# Server runs on port 3000 (configurable via PORT env var)
```

## Deployment

The server is deployed as a systemd service on `dimgord.cc`:

```bash
# Service management
sudo systemctl start ogproxy
sudo systemctl stop ogproxy
sudo systemctl restart ogproxy
sudo systemctl status ogproxy

# View logs
journalctl -u ogproxy -f
```

Service file: `ogproxy.service` (copy to `/etc/systemd/system/`)
Nginx config: `dimgord.cc.conf` (routes /og-proxy, /resolve, /can-embed-fb)

## Key Implementation Details

### URL Normalization
`normalizeUrl()` unwraps tracking parameters and redirect wrappers:
- Extracts `u=` param from `l.facebook.com/l.php?u=...`
- Removes UTM params, fbclid, mibextid, refid, etc.
- Cleans rdid/share_url from group permalinks

### Facebook URL Detection (fb.js)
Pattern matchers for different FB content types:
- `isVideo()` — /watch?v=, /videos/, /<user>/videos/
- `isReel()` — /reel/<id>
- `isFbPost()` — /posts/, /permalink.php, /story.php, /photo/
- `isShare()` — /share/[type]/[id] (requires /resolve expansion)

### Stealth Browser Config
Chrome launches with sandbox disabled, single-process mode, and custom user data directory to avoid fingerprinting. Profile directory auto-cleaned on restart.

## CORS Configuration

Allowed origins are whitelisted in `ALLOWED_ORIGINS` set. Currently allows `2021-itmtank.forumgamers.net` plus wildcard fallback.

## Environment Variables

- `PORT` — Server port (default: 3000)
- `PPTR_PROFILE_BASE` — Chromium profile directory base path
- `NODE_ENV` — Set to `production` in systemd service
