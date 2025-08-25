// index.js — StealthProxy (resolve + og-proxy) w/ Redis cache, BullMQ queues, shared Puppeteer & tidy logs

'use strict';

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();

// ----------------------------- Config -----------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

// Redis
const REDIS_URL =
  process.env.REDIS_URL ||
  (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : 'redis://127.0.0.1:6379');

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('ready', () => console.info('[StealthProxy][redis] connected:', REDIS_URL));
connection.on('error', (e) => console.warn('[StealthProxy][redis] error:', e.message || e));

// TTLs
const OG_CACHE_TTL = parseInt(process.env.OG_CACHE_TTL || '3600', 10);
const RESOLVE_CACHE_TTL = parseInt(process.env.RESOLVE_CACHE_TTL || '900', 10);

// User agents / langs
const RESOLVE_UA = 'StealthProxy/1.0 (+https://www.dimgord.cc)';
const DEFAULT_UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const DEFAULT_LANG = 'en-US,en;q=0.9,uk-UA;q=0.8';

// Shared browser
let _browser = null;

// ----------------------------- Helpers -----------------------------
function h(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

async function cacheGetJSON(key) {
  try {
    const v = await connection.get(key);
    if (!v) return null;
    return JSON.parse(v);
  } catch { return null; }
}
async function cacheSetJSON(key, obj, ttlSec) {
  try { await connection.set(key, JSON.stringify(obj), 'EX', ttlSec); } catch {}
}

function isPrivateHost(host) {
  return /^(localhost|127\.0\.0\.1|::1)$/i.test(host) ||
         /^10\./.test(host) || /^192\.168\./.test(host) ||
         /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
         /^169\.254\./.test(host);
}

function coerceUrl(raw) {
  const tries = [raw];
  try { tries.push(decodeURIComponent(raw)); } catch {}
  try { tries.push(decodeURIComponent(tries[tries.length - 1])); } catch {}
  for (let cand of tries) {
    if (!cand) continue;
    cand = cand.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cand) &&
        /^(?:www\.|facebook\.com\/|l\.facebook\.com\/|m\.facebook\.com\/|mbasic\.facebook\.com\/|instagram\.com\/|l\.instagram\.com\/)/i.test(cand)) {
      cand = 'https://' + cand.replace(/^\/+/, '');
    }
    try { return new URL(cand); } catch {}
  }
  throw new Error('unparsable');
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);

    // unwrap l.facebook.com / l.instagram.com
    if (/^l\.(facebook|instagram)\.com$/i.test(url.hostname)) {
      const u = url.searchParams.get('u');
      if (u) return normalizeUrl(u);
    }

    // canon FB host
    if (/^(m|mbasic|lm|l)\.facebook\.com$/i.test(url.hostname)) {
      url.hostname = 'www.facebook.com';
    }

    // clean params
    url.searchParams.delete('igshid');
    const drop = ['_rdr', 'mibextid'];
    for (const k of Array.from(url.searchParams.keys())) {
      if (drop.includes(k) || /^utm_/i.test(k)) url.searchParams.delete(k);
    }

    // fix double slashes
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');

    // force https
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return String(raw)
      .replace(/^http:\/\//i, 'https://')
      .replace(/^https?:\/\/(?:m|mbasic|lm|l)\.facebook\.com/i, 'https://www.facebook.com')
      .replace(/facebook\.com\/\/+/i, 'facebook.com/');
  }
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log('[StealthProxy] Launching browser...');
  _browser = await puppeteer.launch({
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
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// ----------------------------- OG canonical (HTTP → Browser) -----------------------------
function extractOg(html, baseUrl) {
  const pickProp = (p) => (html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i')) || [])[1] || null;
  const pickName = (n) => (html.match(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i')) || [])[1] || null;
  const title = pickProp('og:title') || pickName('twitter:title');
  const description = pickProp('og:description') || pickName('twitter:description');
  const image = pickProp('og:image') || pickName('twitter:image');
  const url = pickProp('og:url') || baseUrl;
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
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
    try { await page.close(); } catch {}
  }
}

// unified entry
async function getOgCanonical(rawUrl, { useBrowser = true, log = console } = {}) {
  try { return await fetchOgViaHttpOnly(rawUrl); }
  catch (e) {
    log.warn?.('[StealthProxy][og] http path failed →', e.message || String(e));
    if (!useBrowser) throw e;
  }
  return await fetchOgViaBrowser(rawUrl, log);
}

// ----------------------------- Resolve helpers -----------------------------
async function fetchHtml(url, timeoutMs = 10000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': RESOLVE_UA,
      'accept-language': DEFAULT_LANG,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
      'referer': 'https://www.facebook.com/',
    },
    signal: ctrl,
  });
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const html = ctype.includes('text/html') ? await res.text() : '';
  return { url: res.url || url, html };
}

function pickCanonicalFromHtml(html, baseUrl) {
  if (!html) return null;

  // og:url
  let m = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1]) return m[1];

  // <link rel="canonical">
  m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (m && m[1]) return m[1];

  // meta refresh
  m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>\s]+)[^"']*["']/i);
  if (m && m[1]) return new URL(m[1], baseUrl).toString();

  // JSON canonical
  m = html.match(/"canonical"\s*:\s*"([^"]+facebook\.com[^"]+)"/i);
  if (m && m[1]) return m[1];

  // Script redirects
  m = html.match(/location\.(?:href|replace)\((["'])(https?:\/\/[^"']+facebook\.com[^"']+)\1\)/i);
  if (m && m[2]) return m[2];

  // Heuristic targets
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

async function headOrGet(url, redirectMode = 'manual', method = 'HEAD', signal) {
  try {
    return await fetch(url, {
      method,
      redirect: redirectMode,
      headers: {
        'user-agent': RESOLVE_UA,
        'accept-language': DEFAULT_LANG,
        'accept': '*/*',
      },
      signal,
    });
  } catch (e) {
    if (method === 'HEAD') {
      return fetch(url, {
        method: 'GET',
        redirect: redirectMode,
        headers: {
          'user-agent': RESOLVE_UA,
          'accept-language': DEFAULT_LANG,
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
    if (!loc || res.status < 300 || res.status >= 400) {
      const finalUrl = res.url || current;
      return { finalUrl, hops };
    }
    const nextUrl = new URL(loc, current).toString();
    hops.push(nextUrl);
    current = nextUrl;
  }
  return { finalUrl: current, hops, warning: 'max-hops' };
}

async function autoFollow(url, timeoutMs = 10000) {
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': RESOLVE_UA,
      'accept-language': DEFAULT_LANG,
      'accept': 'text/html,*/*;q=0.8',
      'upgrade-insecure-requests': '1',
      'referer': 'https://www.facebook.com/',
    },
    signal: ctrl,
  });
  return res.url || url;
}

// ----------------------------- BullMQ -----------------------------
const ogQueue = new Queue('og-canonical', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 1000 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
  },
});
const resolveQueue = new Queue('resolve-expand', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 1000 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 800 },
  },
});

const ogQE = new QueueEvents('og-canonical', { connection });
const resolveQE = new QueueEvents('resolve-expand', { connection });
ogQE.on('completed', ({ jobId }) => console.info('[StealthProxy][queue][og] done', jobId));
ogQE.on('failed', ({ jobId, failedReason }) => console.warn('[StealthProxy][queue][og] fail', jobId, failedReason));
resolveQE.on('completed', ({ jobId }) => console.info('[StealthProxy][queue][resolve] done', jobId));
resolveQE.on('failed', ({ jobId, failedReason }) => console.warn('[StealthProxy][queue][resolve] fail', jobId, failedReason));
Promise.all([ogQE.waitUntilReady(), resolveQE.waitUntilReady()]).catch(()=>{});

// Workers
const ogWorker = new Worker('og-canonical', async (job) => {
  const url = job.data.url;
  const key = `ogcache:${h(url)}`;
  const cached = await cacheGetJSON(key);
  if (cached) return cached;

  const og = await getOgCanonical(url, { useBrowser: true, log: console });
  await cacheSetJSON(key, og, OG_CACHE_TTL);
  return og;
}, { connection, concurrency: parseInt(process.env.OG_CONCURRENCY || '2', 10) });

const resolveWorker = new Worker('resolve-expand', async (job) => {
  const url = job.data.url;
  const cacheKey = `resolv:${h(url)}`;
  const hit = await cacheGetJSON(cacheKey);
  if (hit) { 
    console.info('[StealthProxy][resolve-expand] cache hit: ', hit);
    return hit;
  }

  // tolerant parse
  let u; try { u = coerceUrl(url); } catch { return { finalUrl: url, warning: 'bad-url' }; }
  if (!/^https?:$/.test(u.protocol)) return { finalUrl: url, warning: 'unsupported' };
  if (isPrivateHost(u.hostname)) return { finalUrl: url, warning: 'private' };

  // normalize
  let candidate = normalizeUrl(u.toString());
  let host='', path='';
  try { const tmp = new URL(candidate); host = tmp.hostname; path = tmp.pathname; } catch {}

  const needsNetworkHost = /^(?:fb\.me|l\.facebook\.com|l\.instagram\.com|t\.co|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly)$/i;
  const isFbShare = host && /(?:^|\.)facebook\.com$/i.test(host) && /^\/share\/[a-z]\/[A-Za-z0-9]+\/?$/i.test(path);

  if (host && (needsNetworkHost.test(host) || isFbShare)) {
    // auto-follow
    const auto = await autoFollow(candidate, 10000).catch(()=>null);
    if (auto && auto !== candidate) {
      const finalUrl = normalizeUrl(auto);
      const out = { finalUrl, method: 'auto' };
      await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
      return out;
    }
    // manual hops
    const mh = await followRedirectsManual(candidate, { maxHops: 10, timeoutMs: 10000, log: console }).catch(()=>null);
    if (mh && mh.finalUrl && mh.finalUrl !== candidate) {
      const finalUrl = normalizeUrl(mh.finalUrl);
      const out = { finalUrl, hops: mh.hops, method: 'manual' };
      await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
      return out;
    }
    // HTML canonical (share/*)
    if (isFbShare) {
      let canon = null;
      const uNoScript = new URL(candidate); uNoScript.searchParams.set('_fb_noscript','1');
      const r0 = await fetchHtml(uNoScript.toString(), 10000).catch(()=>({url:candidate,html:''}));
      canon = pickCanonicalFromHtml(r0.html, r0.url);
      if (!canon || canon === candidate) {
        const r1 = await fetchHtml(candidate, 9000).catch(()=>({url:candidate,html:''}));
        canon = pickCanonicalFromHtml(r1.html, r1.url) || canon;
      }
      if (!canon || canon === candidate) {
        const mURL = new URL(candidate); mURL.hostname = 'm.facebook.com';
        const r2 = await fetchHtml(mURL.toString(), 9000).catch(()=>({url:candidate,html:''}));
        canon = pickCanonicalFromHtml(r2.html, r2.url) || canon;
      }
      if (!canon || canon === candidate) {
        const bURL = new URL(candidate); bURL.hostname = 'mbasic.facebook.com';
        const r3 = await fetchHtml(bURL.toString(), 9000).catch(()=>({url:candidate,html:''}));
        canon = pickCanonicalFromHtml(r3.html, r3.url) || canon;
      }
      if (canon && canon !== candidate) {
        const finalUrl = normalizeUrl(canon);
        const out = { finalUrl, method: 'html-canonical' };
        await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
        return out;
      }
      // last resort: OG canonical
      try {
        const og = await getOgCanonical(candidate, { useBrowser: true, log: console });
        if (og && og.url && og.url !== candidate) {
          const finalUrl = normalizeUrl(og.url);
          const out = { finalUrl, method: 'og-canonical' };
          await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
          return out;
        }
      } catch {}
    }
  }

  const out = { finalUrl: candidate, warning: 'nochange' };
  // do not cache fall back
  // await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
  return out;
}, { connection, concurrency: parseInt(process.env.RESOLVE_CONCURRENCY || '2', 10) });

// Helper to add job and wait
async function runAndWait(queue, queueEvents, name, data, jobId, timeoutMs = 20000) {
  console.info('[StealthProxy][queue] add', name, jobId);
  const job = await queue.add(name, data, { jobId });
  const res = await job.waitUntilFinished(queueEvents, timeoutMs);
  return res;
}

// ----------------------------- Routes -----------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/og-proxy', async (req, res) => {
  try {
    let inUrl = req.query.url;
    if (!inUrl) return res.status(400).json({ error: 'no url' });
    inUrl = normalizeUrl(inUrl);

    // cache
    const key = `ogcache:${h(inUrl)}`;
    const cached = await cacheGetJSON(key);
    if (cached) return res.json(cached);

    // queue
    const jobId = `og:${h(inUrl)}`;
    const og = await runAndWait(ogQueue, ogQE, 'og', { url: inUrl }, jobId, 25000);
    await cacheSetJSON(key, og, OG_CACHE_TTL);
    res.json(og);
  } catch (e) {
    console.error('[StealthProxy][og] error', e && e.message ? e.message : e);
    res.status(500).json({ error: 'og-failed', message: String(e) });
  }
});

app.get('/resolve', async (req, res) => {
  try {
    const inUrl = req.query.url;
    if (!inUrl) return res.status(400).json({ error: 'no url' });

    // tolerant parse just to build cache key
    let u;
    try { u = coerceUrl(inUrl); }
    catch { return res.status(400).json({ error: 'bad url' }); }
    const norm = normalizeUrl(u.toString());

    // cache
    const cacheKey = `resolv:${h(norm)}`;
    const cached = await cacheGetJSON(cacheKey);
    if (cached) return res.json(cached);

    // queue
    const jobId = `resolv:${h(norm)}`;
    const out = await runAndWait(resolveQueue, resolveQE, 'resolve', { url: norm }, jobId, 20000);
    await cacheSetJSON(cacheKey, out, RESOLVE_CACHE_TTL);
    res.json(out);
  } catch (e) {
    console.error('[StealthProxy][resolve] error', e && e.message ? e.message : e);
    res.status(500).json({ error: 'resolve-failed', message: String(e) });
  }
});

// ----------------------------- Start & Graceful shutdown -----------------------------
const server = http.createServer(app);
server.listen(PORT, () => console.log('[StealthProxy] Listening on port', PORT));

async function closeQueues() {
  try { await ogWorker.close(); } catch {}
  try { await resolveWorker.close(); } catch {}
  try { await ogQueue.close(); } catch {}
  try { await resolveQueue.close(); } catch {}
  try { await ogQE.close(); } catch {}
  try { await resolveQE.close(); } catch {}
  try { await connection.quit(); } catch {}
}

function setupGraceful(server) {
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[StealthProxy] ${signal} → graceful shutdown`);

    const closeServer = new Promise((resolve) => server.close(resolve));

    const forceExitTimer = setTimeout(() => {
      console.warn('[StealthProxy] force exit after deadline');
      process.exit(0);
    }, 4500).unref();

    try {
      await Promise.race([
        (async () => {
          await closeQueues();
          try { if (_browser) { await _browser.close(); _browser = null; } } catch {}
          await closeServer;
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('deadline')), 4000))
      ]);
    } catch (e) {
      console.warn('[StealthProxy] shutdown partial:', e.message || e);
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

setupGraceful(server);

