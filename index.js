import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import PQueue from 'p-queue';

// Базова папка для профілів Chromium цього сервісу (можеш змінити на /var/tmp/ogproxy)
const PROFILE_BASE = process.env.PPTR_PROFILE_BASE || path.join(os.tmpdir(), 'ogproxy-profile-');

// Кеш поточного профілю
let _profileDir = null;
async function ensureProfileDir() {
  if (_profileDir) return _profileDir;
  _profileDir = await fs.promises.mkdtemp(PROFILE_BASE); // напр., /tmp/ogproxy-profile-abc123
  return _profileDir;
}

// let _browser = null; <--- declared below, in start section
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log('[StealthProxy] Launching browser...');

  const userDataDir = await ensureProfileDir();

  _browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    userDataDir, // ← ← ВАЖЛИВО: унікальна директорія профілю
    args: [
      '--headless',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
//      '--single-process',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-zygote',
      '--disable-default-apps',
      '--disable-features=TranslateUI',
      '--disable-features=NetworkServiceInProcess',
      '--disable-bluetooth',            // щоб не тригерити bluez
      `--user-data-dir=${userDataDir}`, // дублюємо як arg (деякі збірки поважають саме arg)
    ],
    protocolTimeout: 60000,
  });

  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

async function cleanupProfileDir() {
  if (!_profileDir) return;
  try {
    await fs.promises.rm(_profileDir, { recursive: true, force: true });
    console.info('[StealthProxy] Removed profile dir', _profileDir);
  } catch (e) {
    console.warn('[StealthProxy] Failed to remove profile dir', _profileDir, e?.message || e);
  } finally {
    _profileDir = null;
  }
}

// ---------- resolve helpers ----------
const RESOLVE_UA = 'StealthProxy/1.0 (+https://www.dimgord.cc)';
const RESOLVE_LANG = 'en-US,en;q=0.9,uk-UA;q=0.8';

// --- put near other helpers in index.js ---

// гарантовано приводимо до строки
function toUrlString(u) {
  if (typeof u === 'string') return u;
  if (u && typeof u === 'object') {
    // якщо це URL або об’єкт { url: '...' }
    if (typeof u.url === 'string') return u.url;
    if (typeof u.href === 'string') return u.href;
    try { return String(u); } catch { /* fallthrough */ }
  }
  return '';
}

function pickCanonicalFromHtml(html, baseUrl) {
  if (!html) return null;
  let m = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];
  m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];
  m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)[^"']*["']/i);
  if (m?.[1]) return new URL(m[1], baseUrl).toString();
  return null;
}

async function fetchHtmlSimple(url, timeoutMs = 10000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      'accept-language': 'en-US,en;q=0.9,uk-UA;q=0.8',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
      'referer': 'https://www.facebook.com/',
    },
    signal: ctrl,
  });
  const ctype = (res?.headers.get('content-type') || '').toLowerCase();
  const html = ctype.includes('text/html') ? await res.text() : '';
  return { finalUrl: res?.url || url, html };
}

// Останній притулок для /resolve на facebook.com/share/*:
async function resolveViaOgCanonical(candidate) {
  // спроба 1: noscript
  const u0 = new URL(candidate); u0.searchParams.set('_fb_noscript', '1');
  let r = await fetchHtmlSimple(u0.toString());
  let canon = pickCanonicalFromHtml(r.html, r.finalUrl);

  // спроба 2: звичайний www
  if (!canon || canon === candidate) {
    r = await fetchHtmlSimple(candidate);
    canon = pickCanonicalFromHtml(r.html, r.finalUrl) || canon;
  }
  // спроба 3: m.facebook.com
  if (!canon || canon === candidate) {
    const um = new URL(candidate); um.hostname = 'm.facebook.com';
    r = await fetchHtmlSimple(um.toString());
    canon = pickCanonicalFromHtml(r.html, r.finalUrl) || canon;
  }
  // спроба 4: mbasic.facebook.com
  if (!canon || canon === candidate) {
    const ub = new URL(candidate); ub.hostname = 'mbasic.facebook.com';
    r = await fetchHtmlSimple(ub.toString());
    canon = pickCanonicalFromHtml(r.html, r.finalUrl) || canon;
  }
  return canon && canon !== candidate ? canon : null;
}


async function fetchHtml(url, timeoutMs = 10000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': RESOLVE_UA,
      'accept-language': RESOLVE_LANG,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
      'referer': 'https://www.facebook.com/',
    },
    signal: ctrl,
  });
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/html')) return { url: res.url || url, html: '' };
  const html = await res.text();
  return { url: res.url || url, html };
}

function pickCanonicalFromHtml_old(html, baseUrl) {
  if (!html) return null;
  // <meta property="og:url" content="...">
  let m = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1]) return m[1];
  // <link rel="canonical" href="...">
  m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (m && m[1]) return m[1];
  // <meta http-equiv="refresh" content="0; url=...">
  m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)[^"']*["']/i);
  if (m && m[1]) return new URL(m[1], baseUrl).toString();
  // JSON-блоки з "canonical":"https://www.facebook.com/..."
  m = html.match(/"canonical"\s*:\s*"([^"]+facebook\.com[^"]+)"/i);
  if (m && m[1]) return m[1];
  // Скриптові редіректи: window.location = '...'; location.replace("...")
  m = html.match(/location\.(?:href|replace)\((["'])(https?:\/\/[^"']+facebook\.com[^"']+)\1\)/i);
  if (m && m[2]) return m[2];
  // Побутовий евристичний пошук «канонічних» цілей усередині HTML
  const rx = /(https?:\/\/(?:www|m|mbasic)\.facebook\.com\/(?:watch\/?\?v=\d+|videos\/\d+|reel\/[A-Za-z0-9]+|permalink\.php\?[^"'<\s]+|story\.php\?[^"'<\s]+|photo\/\?fbid=\d+))/i;
  m = html.match(rx);
  if (m && m[1]) return m[1];
  // l.facebook.com/l.php?u=...
  m = html.match(/https?:\/\/l\.facebook\.com\/l\.php\?[^"'<>]*\bu=([^&"'<>]+)/i);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]); } catch {}
  }
  return null;
}

async function autoFollow(url, timeoutMs = 10000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(url, {
    method: 'GET',             // FB не любить HEAD для share/*
    redirect: 'follow',
    headers: {
      'user-agent': RESOLVE_UA,
      'accept-language': RESOLVE_LANG,
      'accept': 'text/html,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
      'referer': 'https://www.facebook.com/',
    },
    signal: ctrl,
  });
  return res.url || url;
}

function coerceUrl(raw) {
  // 1) спробувати як є
  const tries = [raw];
  // 2) один раз розкодувати
  try { tries.push(decodeURIComponent(raw)); } catch {}
  // 3) ще раз (деякі фронтенди двічі кодують)
  try { tries.push(decodeURIComponent(tries[tries.length - 1])); } catch {}
  for (let cand of tries) {
    if (!cand) continue;
    cand = cand.trim();
    // якщо без схеми, але схоже на домен — домалюємо https://
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cand) &&
        /^(?:www\.|facebook\.com\/|l\.facebook\.com\/|m\.facebook\.com\/|mbasic\.facebook\.com\/|instagram\.com\/|l\.instagram\.com\/)/i.test(cand)) {
      cand = 'https://' + cand.replace(/^\/+/, '');
    }
    try {
      return new URL(cand); // повертаємо вже URL-об'єкт
    } catch {}
  }
  throw new Error('unparsable');
}

function isPrivateHost(host) {
  return /^(localhost|127\.0\.0\.1|::1)$/.test(host) ||
         /^10\./.test(host) || /^192\.168\./.test(host) ||
         /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
         /^169\.254\./.test(host);
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);

    // unwrap l.facebook.com / l.instagram.com
    if (/^l\.(?:facebook|instagram)\.com$/i.test(url.hostname)) {
      const u = url.searchParams.get('u');
      if (u) return normalizeUrl(u);
    }

    // ---- NEW: hard‑clean FB tracking on group permalinks ----
    const isFb = /(?:^|\.)facebook\.com$/i.test(url.hostname);
    if (isFb) {
      // загальні трекери
      for (const k of Array.from(url.searchParams.keys())) {
        if (/^(utm_|fbclid|refid|sfnsn|mibextid|paipv|ref)$/i.test(k)) {
          url.searchParams.delete(k);
        }
      }
      // особливий кейс: посилання з share_url/rdid у групових permalink
      if (/^\/groups\/[^/]+\/permalink\//i.test(url.pathname)) {
        url.searchParams.delete('rdid');
        url.searchParams.delete('share_url');
        // на всякий — прибираємо hash із цими параметрами
        if (url.hash && /share_url=|rdid=/.test(url.hash)) {
          url.hash = '';
        }
      }
      // часто зустрічається параметр m=1 / ?mibextid= — геть
      if (url.searchParams.get('m') === '1') url.searchParams.delete('m');
    }

    // instagram дрібні хвости
    url.searchParams.delete('igshid');

    // UTM-шум
    for (const k of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(k)) url.searchParams.delete(k);
    }

    return url.toString();
  } catch {
    return raw;
  }
}

async function headOrGet(url, redirectMode = 'manual', method = 'HEAD', signal) {
  try {
    const r = await fetch(url, {
      method,
      redirect: redirectMode,
      headers: {
        'user-agent': RESOLVE_UA,
        'accept-language': RESOLVE_LANG,
        'accept': '*/*',
      },
      signal,
    });
    return r;
  } catch (e) {
    // деякі сервіси не люблять HEAD або кидають під час CONNECT — спробуємо GET
    if (method === 'HEAD') {
      return fetch(url, {
        method: 'GET',
        redirect: redirectMode,
        headers: {
          'user-agent': RESOLVE_UA,
          'accept-language': RESOLVE_LANG,
          'accept': 'text/html,*/*;q=0.8',
        },
        signal,
      });
    }
    throw e;
  }
}

async function followRedirectsManual(startUrl, { maxHops = 10, timeoutMs = 10000, log = console } = {}) {
  const hops = [startUrl];
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    log.info?.('[StealthProxy][resolve] hop', i, '→', current);
    const res = await headOrGet(current, 'manual', 'HEAD', ctrl);
    const loc = res.headers.get('location');
    // якщо немає редіректу — фініш
    if (!loc || res.status < 300 || res.status >= 400) {
      // буває, що сервер одразу віддав 200 (без редіректів)
      const finalUrl = res.url || current;
      return { finalUrl, hops };
    }
    // resolve відносних шляхів
    const nextUrl = new URL(loc, current).toString();
    hops.push(nextUrl);
    current = nextUrl;
  }
  return { finalUrl: current, hops, warning: 'max-hops' };
}

// --- safe puppeteer helpers ---
async function safeClosePage(page, log = console) {
  if (!page) return;
  try {
    // якщо target уже закрився — це кине TargetCloseError; ловимо і ігноруємо
    if (!page.isClosed()) await page.close({ runBeforeUnload: false });
  } catch (e) {
    log.warn?.('[StealthProxy][puppeteer] safeClosePage:', e?.name || e?.message || e);
  }
}

// Нова функція, фабрика замість сторінки
async function gotoWithRetry(createPage, url, {
  attempts = 2, timeout = 15000, waitUntil = 'domcontentloaded', log = console
} = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let page;
    try {
      page = await createPage();
      if (!page || typeof page.goto !== 'function') {
        throw new Error('Not a Puppeteer Page');
      }
      const resp = await page.goto(url, { waitUntil, timeout });
      await delay(300);
      return { page, resp };
    } catch (e) {
      lastErr = e;
      log.warn?.(`[StealthProxy][puppeteer] goto attempt ${i+1}/${attempts} failed:`, e?.message || e);
      // на кожній ітерації закриваємо сторінку без аварій
      try { if (page && !page.isClosed()) await page.close(); } catch {}
    }
  }
  throw lastErr || new Error('goto-failed');
}
 
puppeteer.use(StealthPlugin());

const redis = new Redis();
const app = express();
const queue = new PQueue({ concurrency: 2 });

let _browser = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// CORS — єдине місце, де ми його ставимо
const ALLOWED_ORIGINS = new Set([
  'https://2021-itmtank.forumgamers.net',
  // додай інші домени, якщо треба
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // якщо хочеш дозволяти всім — лиши '*', але ТІЛЬКИ одне значення
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin'); // щоб кеші правильно працювали

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/', (_, res) => {
  res.send('👋 Stealth Puppeteer OG Proxy is running!');
});

// ---------- OG canonical helpers (shared by /og-proxy and /resolve) ----------

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const DEFAULT_UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const DEFAULT_LANG = 'en-US,en;q=0.9,uk-UA;q=0.8';

function extractOg(html, baseUrl) {
  const take = (p) => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'));
    return m ? m[1] : null;
  };
  const title = take('og:title') || take('twitter:title');
  const description = take('og:description') || take('twitter:description');
  let image = take('og:image') || take('twitter:image');
  let url = take('og:url') || baseUrl;
  return { title, description, image, url };
}

async function getOgCanonical(url, from, { useBrowser = true, log = console } = {}) {
  return await queue.add(() => runOg(url, from, { useBrowser, log }));
}

async function runOg(url, from, { useBrowser = true, log = console } = {}) {
  let page = null;           // ← щоб finally завжди бачив змінну
  // 🔒 1) зробимо якісний рядок і нормалізацію
  let raw = toUrlString(url);
  if (!raw) {
    return { status: 400, error: 'invalid-url', message: 'Empty or non-serializable URL' };
  }
  // якщо треба – двічі декодуємо і нормалізуємо
  try { raw = decodeURIComponent(raw); } catch {}
  try { raw = decodeURIComponent(raw); } catch {}
  const targetUrl = normalizeUrl(raw);
  
  // страховка
  if (typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return { status: 400, error: 'invalid-url', message: `Bad targetUrl: ${targetUrl} -> ${typeof targetUrl}` };
  }

  try {
    console.log('[StealthProxy] Navigating to', targetUrl);

    const createPage = async () => {
      const browser = await getBrowser();
      const p = await browser.newPage();
      await p.setUserAgent(DEFAULT_UA);
      await p.setExtraHTTPHeaders({ 'Accept-Language': DEFAULT_LANG });
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await p.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // (опційно)
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      });
      return p;
    };

    const nav = await gotoWithRetry(createPage, targetUrl, { attempts: 2, timeout: 15000, log: console });
    page = nav.page;
    const resp = nav.resp;
    const html = await page.content();
    const finalUrl = (typeof resp?.url === 'function' ? resp.url() : targetUrl);

    // 🧪 додатковий лог типу — щоб більше таке не ловити
    log.info?.('[StealthProxy][og] goto:', finalUrl, 'typeof:', typeof finalUrl);

    const metadata = await extractOg(html, finalUrl);

    console.log('[StealthProxy] metadata:', metadata);

    // 🧠 Кешуємо за ключем, що відповідає ТВОЄМУ читанню з маршруту (og-proxy:<inUrl>, resolve:<inUrl>)
    // Використаємо НОРМАЛІЗОВАНИЙ вхідний URL як ключ (а не finalUrl), щоб хіти збігалися.
    const cacheKey = `${from}:${normalizeUrl(url)}`;
    if (from === 'og-proxy') {
      if (!metadata.title && !metadata.description && !metadata.image) {
        console.warn('[StealthProxy] Empty metadata — skipping cache');
        return { status :500, error: 'Empty metadata — possibly bot protection', message: 'Empty metadata' };
      }
      if (metadata.image && metadata.image.trim() !== '') {
        await redis.set(cacheKey, JSON.stringify(metadata), 'EX', 60 * 60 * 10);
        console.log('[StealthProxy] og-proxy: Cached result for', url);
      } else {
        console.log('[StealthProxy] og-proxy: Not cached due to empty image');
      }
    } else if (from === 'resolve') {
      if (metadata.url && metadata.url !== finalUrl) {
        const cache = { finalUrl: metadata.url };
        await redis.set(cacheKey, JSON.stringify(cache), 'EX', 60 * 60 * 10);
        console.log('[StealthProxy] resolve: Cached result for', url);
      } else {
        console.log('[StealthProxy] resolve: Not cached due to not resolved url');
      }
    }
    return(metadata);
  } catch (err) {
      console.error('[StealthProxy] Error:', err?.message);
      return { status :500, error: 'Puppeteer error', message: err?.message };
  } finally {
      await safeClosePage(page, log);
  }
}

app.get('/og-proxy', async (req, res) => {
  const inUrl = req.query.url;
  if (!inUrl || !/^https?:\/\//.test(inUrl)) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  const cached = await redis.get('og-proxy:'+normalizeUrl(inUrl));  // ← той самий ключ, що і в runOg
  if (cached) {
    console.log('[StealthProxy] Cache hit for', inUrl);
    return res.json(JSON.parse(cached));
  }

  const og = await getOgCanonical(inUrl, 'og-proxy', { useBrowser: true, log: console });
  return res.status(og.status || 200).json(og);
});

app.get('/resolve', async (req, res) => {
  let result;
  try {
    const inUrl = req.query.url;
    if (!inUrl) return res.status(400).json({ error: 'no url' });

    const cached = await redis.get('resolve:'+normalizeUrl(inUrl)); // ← синхронізуємо з runOg
    if (cached) {
      console.log('[StealthProxy] Cache hit for', inUrl);
      return res.json(JSON.parse(cached));
    }

    // 1) толерантний парсинг + авто-додавання https://
    let u;
    try { u = coerceUrl(inUrl); } catch { return res.status(400).json({ error: 'bad url' }); }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'unsupported scheme' });
    if (isPrivateHost(u.hostname)) return res.status(400).json({ error: 'private host blocked' });

    // 2) нормалізація (unwrap + очистка трекінгу)
    let candidate = normalizeUrl(u.toString());
    let host = null, path = '';
    try { const tmp = new URL(candidate); host = tmp.hostname; path = tmp.pathname; } catch {}

    // 3) список шортенерів/редіректорів, для яких йдемо по мережі
    const needsNetworkHost = /^(?:fb\.me|l\.facebook\.com|l\.instagram\.com|t\.co|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly)$/i;
    const isFbShare = host && /(?:^|\.)facebook\.com$/i.test(host) && /^\/share\/[a-z]\/[A-Za-z0-9]+\/?$/i.test(path);

    console.info('[StealthProxy][resolve] host, isFbShare →', host, isFbShare);

    if (host && (needsNetworkHost.test(host) || isFbShare)) {
      console.info('[StealthProxy][resolve] network-follow for', candidate);
      try {
        if (isFbShare) {
          // 3a) швидко: дати fetch'у самому пройти редіректи і взяти res.url
          const auto = await autoFollow(candidate, 10000);
          if (auto && auto !== candidate) {
            const finalUrl = normalizeUrl(auto);
            console.info('[StealthProxy][resolve] auto-follow →', finalUrl);
            return res.json({ finalUrl, method: 'auto' });
          }
          // 3b) manual hops
          const out = await followRedirectsManual(candidate, { maxHops: 10, timeoutMs: 10000, log: console });
          if (out.finalUrl && out.finalUrl !== candidate) {
            const finalUrl = normalizeUrl(out.finalUrl);
            console.info('[StealthProxy][resolve] manual-follow →', finalUrl);
            return res.json({ finalUrl, hops: out.hops, method: 'manual' });
          }
          // 3) FB share/* часто без 30x → HTML/OG fallback
          console.info('[StealthProxy][resolve] share/*: try html/og canonical…');
          const canon = await resolveViaOgCanonical(candidate).catch(()=>null);
          if (canon && canon !== candidate) {
            const finalUrl = normalizeUrl(canon);
            console.info('[StealthProxy][resolve] html/og-canonical →', finalUrl);
            return res.json({ finalUrl, method: 'html-canonical' });
          }
          // 3 0) ОСТАННІЙ ПРИТУЛОК: OG‑proxy шлях — беремо og.url як канонічний
          console.info('[StealthProxy][resolve] fallback to OG canonical…');
          const og = await getOgCanonical(candidate, 'resolve', { useBrowser: true, log: console });
          console.info('[StealthProxy][resolve] result: ', og);
          if (og && og.url) {
            const finalUrl = normalizeUrl(og.url);
            if (finalUrl && finalUrl !== candidate) {
              return res.json({ finalUrl, method: 'og-canonical' });
            }
          }
        }
        // якщо нічого не вийшло — віддаємо нормалізоване як є
        return res.json({ finalUrl: candidate, warning: 'network-resolve-nochange' });
      } catch (e) {
        console.warn('[StealthProxy][resolve] network-follow failed:', e?.message || e);
        // віддаємо хоча б нормалізований варіант
        return res.json({ finalUrl: candidate, warning: 'network-resolve-failed' });
      }
    }

    // 4) для «звичайних» лінків достатньо нормалізації
    console.info('[StealthProxy][resolve] normalized only →', candidate);
    return res.json({ finalUrl: candidate });
  } catch (e) {
    console.error('resolve error', e);
    return res.status(500).json({ error: 'Resolve failed' });
  }
});

// async function canEmbedFbPost(href, timeoutMs = 9000) {
//   const clean = normalizeUrl(String(href || ''));
//   const baseParams = new URLSearchParams({
//     omitscript: 'true',
//     href: clean,
//     locale: 'en_US',
//     show_text: 'true',
//     width: '500',
//   });
//
//   const headers = {
//     'user-agent': DEFAULT_UA,                              // 🔧 desktop UA
//     'accept-language': DEFAULT_LANG,
//     'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
//     'upgrade-insecure-requests': '1',
//     'referer': 'https://www.facebook.com/',                // 🔧 важливо
//     'sec-fetch-site': 'none',
//     'sec-fetch-mode': 'navigate',
//     'sec-fetch-user': '?1',
//     'sec-fetch-dest': 'document',
//   };
//
//   const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
//
//   // helper
//   const tryOnce = async (host) => {
//     const url = `https://${host}/plugins/post.php?` + baseParams.toString();
//     console.log('[StealthProxy] can-embed-fb: url: ', url);
//     const res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: ctrl });
//     const text = await res.text().catch(() => '');
//     console.log('[StealthProxy] can-embed-fb: status:', res.status, 'len:', text.length);
//     if (!text) return false;
//
//     // якщо FB віддає плашку «no longer available» — це явно false
//     if (/This Facebook post is no longer available/i.test(text)) return false;
//
//     // якщо сторінка нормально зібралась (doctype/html або всередині є fb_embed контент) — вважаємо, що можна
//     if (res.ok && /<html|<iframe|class="[^"]*fb_post|data-testid="post_message"/i.test(text)) return true;
//
//     // буває 400, але всередині є робочий html (рідко) — спробуй розпізнати
//     if (!res.ok && /<html|<iframe/i.test(text)) return true;
//
//     return false;
//   };
//
//   // 1) звичайний www
//   let ok = await tryOnce('www.facebook.com');
//   if (ok) return true;
//
//   // 2) mobile fallback — інколи ріже 400 на www, але не на m.
//   ok = await tryOnce('m.facebook.com');
//   return !!ok;
// }
//
// // маршрут (не забудь CORS на рівні app)
// app.get('/can-embed-fb', async (req, res) => {
//   try {
//     const href = normalizeUrl(String(req.query.href || ''));
//     if (!href) return res.status(400).json({ ok: false });
//     const ok = await canEmbedFbPost(href);
//     res.json({ ok });
//   } catch (e) {
//     console.warn('[StealthProxy] can-embed-fb error:', e?.message || e);
//     res.json({ ok: false });
//   }
// });

function buildPluginSrc(host, cleanHref) {
  const qs = new URLSearchParams({
    omitscript: 'true',
    href: cleanHref,
    show_text: 'true',
    locale: 'en_US',
    width: '500',
    // можеш додати: 'ref': 'ogproxy'
  });
  return `https://${host}/plugins/post.php?` + qs.toString();
}

async function probeFbPlugin(src, { referer, timeoutMs = 9000, log = console } = {}) {
  const headers = {
    'user-agent': DEFAULT_UA,
    'accept-language': DEFAULT_LANG,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'upgrade-insecure-requests': '1',
    // ⚠️ ключовий момент — емулюємо реальний referer клієнта
    ...(referer ? { referer } : {}),
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
  };
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

  const res = await fetch(src, { method: 'GET', headers, redirect: 'follow', signal: ctrl });
  const text = await res.text().catch(() => '');
  log.info?.('[StealthProxy] can-embed-fb: status', res.status, 'len', text.length);
  log.info?.('[StealthProxy] can-embed-fb: text', text);

  if (!text) return { ok: false, status: res.status || 0, reason: 'empty' };
  // if (/This Facebook post is no longer available/i.test(text)) {
  //   return { ok: false, status: res.status || 200, reason: 'not-available' };
  // }
  // груба евристика «виглядає як робочий плагін»
  const looksOk = /<html|<iframe|class="[^"]*fb_post|data-testid="post_message"/i.test(text);
  return { ok: looksOk && res.ok, status: res.status || 0, reason: looksOk ? 'ok' : 'unknown', text };
}

app.get('/can-embed-fb', async (req, res) => {
  try {
    const rawHref = String(req.query.href || '');
    if (!rawHref) return res.json({ ok: false, reason: 'no-href' });

    const cleanHref = normalizeUrl(rawHref);

    // емулюємо КЛІЄНТСЬКЕ походження
    const clientOrigin = req.headers.origin || req.query.origin || '';
    const referer = clientOrigin || 'https://www.dimgord.cc/'; // запасний

    // пробуємо www → m
    const srcWWW = buildPluginSrc('www.facebook.com', cleanHref);
    let r = await probeFbPlugin(srcWWW, { referer: 'www.facebook.com', log: console });
    if (r.ok) {
      return res.json({
        ok: true,
        host: 'www.facebook.com',
        cleanHref,
        src: srcWWW,
        // даю ще готовий HTML-фрагмент (на випадок, якщо хочеш просто вставити рядок)
        html: r.text // `<iframe src="${srcWWW}" width="500" height="680" style="border:none;overflow:hidden" scrolling="no" frameborder="0" allow="encrypted-media; picture-in-picture; web-share; clipboard-write"></iframe>`
      });
    }

    const srcM = buildPluginSrc('m.facebook.com', cleanHref);
    r = await probeFbPlugin(srcM, { referer: 'm.facebook.com', log: console });
    if (r.ok) {
      return res.json({
        ok: true,
        host: 'm.facebook.com',
        cleanHref,
        src: srcM,
        html: r.text // `<iframe src="${srcM}" width="500" height="680" style="border:none;overflow:hidden" scrolling="no" frameborder="0" allow="encrypted-media; picture-in-picture; web-share; clipboard-write"></iframe>`
      });
    }

    return res.json({ ok: false, cleanHref, reason: r.reason || 'probe-failed' });
  } catch (e) {
    console.warn('[StealthProxy] can-embed-fb error:', e?.message || e);
    res.json({ ok: false, reason: 'exception' });
  }
});

async function safeCloseBrowser() {
  try { if (_browser) { await _browser.close(); _browser = null; } } catch {}
  await cleanupProfileDir();
}

// Запуск браузера з перезапуском щогодини
(async () => {
  await getBrowser();
  setInterval(async () => {
    try {
      console.log(`[StealthProxy] Scheduled browser restart at ${new Date().toISOString()}`);
      await safeCloseBrowser();
      await getBrowser();
    } catch (err) {
      console.error('[StealthProxy] Error during scheduled restart:', err);
    }
  }, 60 * 60 * 1000); // 1 година
})();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[StealthProxy] Listening on port ${port}`);
});


process.on('exit', async () => {
   await safeCloseBrowser();
 });
process.on('SIGINT', async () => {
  await safeCloseBrowser();
  process.exit(0);
});

// Added error handling 08/24/25 - Слава Україні!
process.on('unhandledRejection', (reason) => {
  console.warn('[StealthProxy] UnhandledRejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error(`Uncaught Exception at ${new Date().toISOString()}:`, err);
  // НЕ робимо process.exit — нехай живе; systemd сам перезапустить якщо справді все погано
});

function logMemoryUsage() {
  const used = process.memoryUsage();
  const format = (bytes) => `${Math.round(bytes / 1024 / 1024 * 100) / 100} MB`;

  console.log(`[StealthProxy] 🧠 Memory Usage — RSS: ${format(used.rss)}, Heap: ${format(used.heapUsed)} / ${format(used.heapTotal)}`);
}

setInterval(logMemoryUsage, 5 * 60 * 1000); // кожні 5 хвилин

