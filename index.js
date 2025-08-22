import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import PQueue from 'p-queue';

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

    // HEAD інколи ріже редіректи на FB, тож беремо GET з redirect: 'follow'
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // Трошки “людський” UA, щоб FB не шив апі-бот
        'User-Agent': 'Mozilla/5.0 (compatible; VriendBot/1.0; +https://dimgord.cc)'
      }
    });

    // resp.url — фінальна адреса після всіх редіректів
    return res.json({ finalUrl: resp.url });
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

