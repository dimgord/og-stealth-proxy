import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import PQueue from 'p-queue';

// ---------- resolve helpers ----------
const RESOLVE_UA = 'StealthProxy/1.0 (+https://www.dimgord.cc)';
const RESOLVE_LANG = 'en-US,en;q=0.9,uk-UA;q=0.8';

// --- put near other helpers in index.js ---

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
    // unwrap l.instagram.com / l.facebook.com ?u=...
    if (/^l\.(?:facebook|instagram)\.com$/i.test(url.hostname)) {
      const u = url.searchParams.get('u');
      if (u) return normalizeUrl(u);
    }
    // clean noise
    url.searchParams.delete('igshid');
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
 
puppeteer.use(StealthPlugin());

const redis = new Redis();
const app = express();
const queue = new PQueue({ concurrency: 5 });

let browser;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

app.get('/', (_, res) => {
  res.send('👋 Stealth Puppeteer OG Proxy is running!');
});

// ---------- OG canonical helpers (shared by /og-proxy and /resolve) ----------
const DEFAULT_UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
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

async function fetchHtmlForOG(rawUrl, timeoutMs = 9000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(rawUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': DEFAULT_UA_MOBILE,
      'accept-language': DEFAULT_LANG,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
    },
    signal: ctrl,
  });
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/html')) throw new Error('non-html');
  const html = await res.text();
  return { url: res.url || rawUrl, html };
}

async function fetchOgViaHttpOnly(rawUrl) {
  const { url: finalUrl, html } = await fetchHtmlForOG(rawUrl, 9000);
  const og = extractOg(html, finalUrl);
  if (!og.title && !og.image && !og.url) throw new Error('og-not-found');
  return og;
}

async function fetchOgViaBrowser(rawUrl, log = console) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA_MOBILE);
    await page.setExtraHTTPHeaders({ 'Accept-Language': DEFAULT_LANG });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    log.info?.('[StealthProxy][og] goto', rawUrl);
    const resp = await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(400);
    const html = await page.content();
    const og = extractOg(html, resp?.url() || rawUrl);
    if (!og.title && !og.image && !og.url) throw new Error('og-empty');
    return og;
  } finally {
    try { await browser.close(); } catch {}
  }
}

// Єдина точка входу: спершу HTTP, якщо треба — браузер
async function getOgCanonical_bad(rawUrl, { useBrowser = true, log = console } = {}) {
  try {
    const og = await fetchOgViaHttpOnly(rawUrl);
    return og;
  } catch (e) {
    log.warn?.('[StealthProxy][og] http path failed →', e.message || String(e));
    if (!useBrowser) throw e;
  }
  // fallback: puppeteer
  const og2 = await fetchOgViaBrowser(rawUrl, log);
  return og2;
}

async function getOgCanonical(url, from, { useBrowser = true, log = console } = {}) {
  queue.add(async () => {
    let page;
    let result;
    try {
      console.log('[StealthProxy] Navigating to', url);
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.setViewport({ width: 1366, height: 768 });

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        consecutiveFailures = 0;
      } catch (err) {
        console.error('[StealthProxy] Error during page.goto:', err.message);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_FAILURES) {
          console.error('[StealthProxy] Too many failures — restarting browser...');
          await browser.close();
          browser = await puppeteer.launch(browserLaunchOpts);
          consecutiveFailures = 0;
        }
        result = { status: 500, error: 'Page navigation error', message: err?.message };
        return result;
        //return res.status(500).json({ error: 'Page navigation error', message: err?.message });
      }

      const metadata = await page.evaluate(() => {
        const getMeta = (prop) =>
          document.querySelector(`meta[property='og:${prop}']`)?.content ||
          document.querySelector(`meta[name='og:${prop}']`)?.content || '';
        return {
          title: getMeta('title') || document.title || '',
          description: getMeta('description') || '',
          image: getMeta('image') || '',
          url: getMeta('url') || location.href || '',
        };
      });

      console.log('[StealthProxy] metadata:', metadata);

      if (from === 'og-proxy') {
        if (!metadata.title && !metadata.description && !metadata.image) {
          console.warn('[StealthProxy] Empty metadata — skipping cache');
          result = { status :500, error: 'Empty metadata — possibly bot protection', message: '' };
          //return res.status(500).json({ error: 'Empty metadata — possibly bot protection' });
          return result;
        }

        if (metadata.image && metadata.image.trim() !== '') {
          await redis.set(url, JSON.stringify(metadata), 'EX', 60 * 60 * 10);
          console.log('[StealthProxy] og-proxy: Cached result for', url);
        } else {
          console.log('[StealthProxy] og-proxy: Not cached due to empty image');
        }
      } else if (from === 'resolve') {
        if (metadata.url !== url) {
          await redis.set(url, JSON.stringify(metadata), 'EX', 60 * 60 * 10);
          console.log('[StealthProxy] resolve: Cached result for', url);
        } else {
          console.log('[StealthProxy] resolve: Not cached due to not resolved url');
        }
      }

      result = metadata;
      //res.json(metadata);
    } catch (err) {
      console.error('[StealthProxy] Error:', err?.message);
      result = { status :500, error: 'Puppeteer error', message: err?.message };
      //res.status(500).json({ error: 'Puppeteer error', message: err.message });
    } finally {
      if (page && !page.isClosed()) {
        await page.close();
      }
      return result;
    }
  });
}

app.get('/og-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  const cached = await redis.get(url);
  if (cached) {
    console.log('[StealthProxy] Cache hit for', url);
    return res.json(JSON.parse(cached));
  }

  const og = await getOgCanonical(url, 'og-proxy', { useBrowser: true, log: console });
  return res.status(og.status || 200).json(og);
});

app.get('/resolve', async (req, res) => {
  let result;
  try {
    const inUrl = req.query.url;
    if (!inUrl) return res.status(400).json({ error: 'no url' });
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
          // 3d) ОСТАННІЙ ПРИТУЛОК: OG‑proxy шлях — беремо og.url як канонічний
            console.info('[StealthProxy][resolve] fallback to OG canonical…');
            const og = await getOgCanonical(candidate, 'resolve', { useBrowser: true, log: console });
            if (og && og.url) {
              const finalUrl = normalizeUrl(og.url);
              if (finalUrl && finalUrl !== candidate) {
                return res.json({ finalUrl, method: 'og-canonical' });
              }
            }
        }
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
        if (isFbShare) {
          console.info('[StealthProxy][resolve] share/*: try html/og canonical…');
          const canon = await resolveViaOgCanonical(candidate).catch(()=>null);
          if (canon && canon !== candidate) {
            const finalUrl = normalizeUrl(canon);
            console.info('[StealthProxy][resolve] html/og-canonical →', finalUrl);
            return res.json({ finalUrl, method: 'html-canonical' });
          }
        }

/*
        // 3c) [FB share] немає 3xx → тягнемо HTML і шукаємо canonical/og/url/refresh/евристики
        if (isFbShare) {
          // 3d) ОСТАННІЙ ПРИТУЛОК: OG‑proxy шлях — беремо og.url як канонічний
          try {
            console.info('[StealthProxy][resolve] fallback to OG canonical…');
            const og = await getOgCanonical(candidate, { useBrowser: true, log: console });
            if (og && og.url) {
              const finalUrl = normalizeUrl(og.url);
              if (finalUrl && finalUrl !== candidate) {
                return res.json({ finalUrl, method: 'og-canonical' });
              }
            }
          } catch (e) {
            console.warn('[StealthProxy][resolve] og-canonical failed:', e.message || String(e));
          }
          console.info('[StealthProxy][resolve] share: try HTML canonical');
          let canon = null;
          // спроба 1: www + _fb_noscript=1
          const uNoScript = new URL(candidate); uNoScript.searchParams.set('_fb_noscript', '1');
          let r = await fetchHtml(uNoScript.toString(), 10000);
          canon = pickCanonicalFromHtml(r.html, r.url);
          // спроба 2: www без noscript
          if (!canon || canon === candidate) {
            r = await fetchHtml(candidate, 9000);
            canon = pickCanonicalFromHtml(r.html, r.url) || canon;
          }
          // спроба 3: m.facebook.com
          if (!canon || canon === candidate) {
            const mURL = new URL(candidate); mURL.hostname = 'm.facebook.com';
            r = await fetchHtml(mURL.toString(), 9000);
            canon = pickCanonicalFromHtml(r.html, r.url) || canon;
          }
          // спроба 4: mbasic.facebook.com
          if (!canon || canon === candidate) {
            const bURL = new URL(candidate); bURL.hostname = 'mbasic.facebook.com';
            r = await fetchHtml(bURL.toString(), 9000);
            canon = pickCanonicalFromHtml(r.html, r.url) || canon;
          }
          if (canon && canon !== candidate) {
            const finalUrl = normalizeUrl(canon);
            console.info('[StealthProxy][resolve] html-canonical →', finalUrl);
            return res.json({ finalUrl, method: 'html-canonical' });
          }
        }
*/
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

const browserLaunchOpts = {
  headless: true,
  executablePath: '/usr/bin/google-chrome-stable',
  userDataDir: '/home/dimgord/.puppeteer_data',
  args: [
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
    '--disable-crash-reporter',
    '--no-zygote',
  ],
  protocolTimeout: 60000,
};

async function launchBrowser() {
  console.log('[StealthProxy] Launching browser...');
  browser = await puppeteer.launch(browserLaunchOpts);
}

// Запуск браузера з перезапуском щогодини
(async () => {
  await launchBrowser();
setInterval(async () => {
  try {
    console.log(`[StealthProxy] Scheduled browser restart at ${new Date().toISOString()}`);
    await browser.close();
    await launchBrowser();
  } catch (err) {
    console.error('[StealthProxy] Error during scheduled restart:', err);
  }
}, 60 * 60 * 1000); // 1 година
})();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[StealthProxy] Listening on port ${port}`);
});

process.on('exit', () => browser?.close());
process.on('SIGINT', () => process.exit());
process.on('uncaughtException', (err) => {
  console.error(`Uncaught Exception at ${new Date().toISOString()}:`, err);
  process.exit(1);
});

function logMemoryUsage() {
  const used = process.memoryUsage();
  const format = (bytes) => `${Math.round(bytes / 1024 / 1024 * 100) / 100} MB`;

  console.log(`[StealthProxy] 🧠 Memory Usage — RSS: ${format(used.rss)}, Heap: ${format(used.heapUsed)} / ${format(used.heapTotal)}`);
}

setInterval(logMemoryUsage, 5 * 60 * 1000); // кожні 5 хвилин

