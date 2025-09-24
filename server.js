// server.js
// Node 18+ / Express + Playwright 瀏覽器代理

import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const TARGET = process.env.TARGET_URL
  || 'https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get';
const REFERER = 'https://www.sportslottery.com.tw/sportsbook/daily-coupons';
const ORIGIN  = 'https://www.sportslottery.com.tw';
const UPSTREAM_COOKIE = process.env.UPSTREAM_COOKIE || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/daily', async (req, res) => {
  try {
    const payload = req.body;
    const br = await getBrowser();
    const ctx = await br.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        'accept': 'application/json, text/plain, */*',
        'origin': ORIGIN,
        'referer': REFERER
      }
    });

    if (UPSTREAM_COOKIE) {
      const cookiePairs = UPSTREAM_COOKIE.split(';').map(s => s.trim()).filter(Boolean);
      const cookies = cookiePairs.map(s => {
        const idx = s.indexOf('=');
        return {
          name: s.slice(0, idx),
          value: s.slice(idx + 1),
          domain: '.sportslottery.com.tw',
          path: '/',
          httpOnly: true,
          sameSite: 'Lax'
        };
      });
      await ctx.addCookies(cookies);
    }

    const page = await ctx.newPage();
    await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const result = await page.evaluate(async ({ TARGET, payload }) => {
      const r = await fetch(TARGET, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      return { status: r.status, text, ct: r.headers.get('content-type') || '' };
    }, { TARGET, payload });

    await ctx.close();

    res.setHeader('content-type', result.ct || 'application/json; charset=utf-8');
    res.status(result.status).send(result.text);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log('proxy up on :' + PORT));
