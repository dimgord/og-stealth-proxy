// stealth-proxy-og.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';

puppeteer.use(StealthPlugin());

const redis = new Redis();
const app = express();

let browser;

/*
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
*/

app.get('/', (_, res) => {
  res.send('👋 Stealth Puppeteer OG Proxy is running!');
});

app.get('/og-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  try {
    const cached = await redis.get(url);
    if (cached) {
      console.log('[StealthProxy] Cache hit for', url);
      return res.json(JSON.parse(cached));
    }

    console.log('[StealthProxy] Navigating to', url);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const metadata = await page.evaluate(() => {
      const getMeta = (prop) =>
        document.querySelector(`meta[property='og:${prop}']`)?.content ||
        document.querySelector(`meta[name='og:${prop}']`)?.content || '';

      return {
        title: getMeta('title') || document.title,
        description: getMeta('description'),
        image: getMeta('image'),
        url: getMeta('url') || location.href,
      };
    });

    await page.close();

    await redis.set(url, JSON.stringify(metadata), 'EX', 60 * 60); // 1h TTL
    console.log('[StealthProxy] Cached result for', url);
    res.json(metadata);
  } catch (err) {
    console.error('[StealthProxy] Error:', err.message);
    res.status(500).json({ error: 'Puppeteer error', message: err.message });
  }
});

const port = process.env.PORT || 3000;
(async () => {
  console.log('[StealthProxy] Launching persistent browser...');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: './.puppeteer_data',
    protocolTimeout: 60000
  });

  app.listen(port, () => {
    console.log(`[StealthProxy] Listening on port ${port}`);
  });
})();

process.on('exit', () => browser?.close());
process.on('SIGINT', () => process.exit());

