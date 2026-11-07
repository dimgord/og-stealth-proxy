# Stealth OG Proxy

This is a stealth-capable OpenGraph metadata proxy server using Puppeteer and the `puppeteer-extra-plugin-stealth`.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

## Usage

Query the proxy with:
```
GET /og-proxy?url=https://example.com
```

Other endpoints: `/resolve?url=` (follows short and FB share links), `/can-embed-fb?href=`, `/render?url=`.

## Forum client scripts

`client/fb.js`, `tg.js`, `ig.js` embed Facebook, Telegram and Instagram links in itmtank forum posts.
They are pasted into forumotion's admin (JavaScript codes management, all pages); the proxy only
serves them data. `task live` saves what the forum runs now to `client/live/forum.min.js`.

## Tasks

`task check` · `task restart` (dvg-one, runs from this checkout) · `task logs` · `task probe URL=…` ·
`task live`. Details: `CLAUDE.md`, history: `PROGRESS.md`.
