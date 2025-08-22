import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import PQueue from 'p-queue';

const UA = 'ogproxy/1.0 (+https://www.dimgord.cc)'; // щоб нас не банили за пустий UA

function isPrivateHost(host) {
  // брутальний, але ефективний захист від SSRF: блокуємо локальні та RFC1918
  return /^(localhost|127\.0\.0\.1|::1)$/.test(host) ||
         /^10\./.test(host) || /^192\.168\./.test(host) ||
         /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
         /^169\.254\./.test(host);
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    // l.instagram.com → дістаємо справжній таргет із ?u=
    if (/^l\.instagram\.com$/i.test(url.hostname)) {
      const u = url.searchParams.get('u');
      if (u) return normalizeUrl(u);
    }
    // чистимо сміття
    url.searchParams.delete('igshid');
    Array.from(url.searchParams.keys()).forEach((k) => {
      if (/^utm_/i.test(k)) url.searchParams.delete(k);
    });
    return url.toString();
  } catch {
    return raw;
  }
}

async function followRedirects(inUrl) {
  // частина сервісів (fb.me/bit.ly/t.co) не люблять HEAD — беремо GET, але з таймаутом
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch(inUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': UA },
    signal: ctrl
  });
  // у fetch final URL сидить у res.url
  return res.url || inUrl;
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
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    // 1) базова валідація
    let urlObj;
    try { urlObj = new URL(inUrl); } catch { return res.status(400).json({ error: 'bad url' }); }
    if (!/^https?:$/.test(urlObj.protocol)) return res.status(400).json({ error: 'unsupported scheme' });
    if (isPrivateHost(urlObj.hostname)) return res.status(400).json({ error: 'private host blocked' });

    // 2) нормалізуємо одразу (чистимо igshid/utm, розкручуємо l.instagram.com/?u=...)
    let candidate = normalizeUrl(inUrl);

    // 3) якщо це відомі шортенери — йдемо в мережу та даємо fetch'у пройти 30x
    const needNetwork = /^(?:fb\.me|t\.co|bit\.ly|tinyurl\.com|l\.facebook\.com)$/i.test(urlObj.hostname);
    if (needNetwork) {
      try {
        const networkFinal = await followRedirects(candidate);
        return res.json({ finalUrl: normalizeUrl(networkFinal) });
      } catch (e) {
        // якщо щось пішло не так — хоч нормалізований варіант повернемо
        return res.json({ finalUrl: candidate, warning: 'network-resolve-failed' });
      }
    }

    // 4) інакше достатньо нормалізації (для «звичайних» прямих посилань)
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

