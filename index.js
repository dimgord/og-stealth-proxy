import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import PQueue from 'p-queue';

// ---------- resolve helpers ----------
const RESOLVE_UA = 'StealthProxy/1.0 (+https://www.dimgord.cc)';
const RESOLVE_LANG = 'en-US,en;q=0.9,uk-UA;q=0.8';

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

  queue.add(async () => {
    let page;
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
        return res.status(500).json({ error: 'Page navigation error', message: err.message });
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

      if (!metadata.title && !metadata.description && !metadata.image) {
        console.warn('[StealthProxy] Empty metadata — skipping cache');
        return res.status(500).json({ error: 'Empty metadata — possibly bot protection' });
      }

      if (metadata.image && metadata.image.trim() !== '') {
        await redis.set(url, JSON.stringify(metadata), 'EX', 60 * 60 * 10);
        console.log('[StealthProxy] Cached result for', url);
      } else {
        console.log('[StealthProxy] Not cached due to empty image');
      }

      res.json(metadata);
    } catch (err) {
      console.error('[StealthProxy] Error:', err.message);
      res.status(500).json({ error: 'Puppeteer error', message: err.message });
    } finally {
      if (page && !page.isClosed()) {
        await page.close();
      }
    }
  });
});

app.get('/resolve', async (req, res) => {
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
    let host = null;
    try { host = new URL(candidate).hostname; } catch {}

    // 3) список шортенерів/редіректорів, для яких йдемо по мережі
    const needsNetwork = /^(?:fb\.me|l\.facebook\.com|l\.instagram\.com|t\.co|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly)$/i;
    if (host && needsNetwork.test(host)) {
      console.info('[StealthProxy][resolve] network-follow for', candidate);
      try {
        const out = await followRedirectsManual(candidate, { maxHops: 10, timeoutMs: 10000, log: console });
        // фінальна легка нормалізація — на випадок, якщо останній крок теж мав зайві параметри
        out.finalUrl = normalizeUrl(out.finalUrl);
        return res.json({ finalUrl: out.finalUrl, hops: out.hops });
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

