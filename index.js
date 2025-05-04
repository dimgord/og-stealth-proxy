// stealth-proxy-og.js with Redis caching
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';
import crypto from 'crypto';

puppeteer.use(StealthPlugin());
const app = express();
const redis = new Redis();

app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/', (_, res) => {
  res.send('👋 Stealth Puppeteer OG Proxy with Redis is running!');
});

app.get('/og-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  const cacheKey = `og:${crypto.createHash('md5').update(url).digest('hex')}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[Redis] Cache hit for ${url}`);
      return res.json(JSON.parse(cached));
    }
  } catch (e) {
    console.warn('[Redis] Cache lookup failed:', e.message);
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

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

    await browser.close();

    // Cache the result for 6 hours
    try {
      await redis.set(cacheKey, JSON.stringify(metadata), 'EX', 21600);
      console.log(`[Redis] Cached result for ${url}`);
    } catch (e) {
      console.warn('[Redis] Failed to cache:', e.message);
    }

    res.json(metadata);
  } catch (err) {
    console.error('[StealthProxy] Error:', err.message);
    res.status(500).json({ error: 'Puppeteer error', message: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[StealthProxy] Listening on port ${port}`);
});

