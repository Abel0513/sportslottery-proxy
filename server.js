// server.js - Express + Playwright Proxy (stable, v1.55.1)
import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setTimeout(60_000, () => res.status(504).json({ error: "gateway timeout (server)" }));
  next();
});

const TARGET  = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";
const REFERER = "https://www.sportslottery.com.tw/sportsbook/daily-coupons";
const ORIGIN  = "https://www.sportslottery.com.tw";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---------- 單例 Browser + Context ----------
let browser = null;
let context = null;
let launching = null;

async function launchBrowser() {
  const b = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-zygote"
    ]
  });
  b.on("disconnected", () => {
    browser = null;
    context = null;
  });
  return b;
}

async function ensureContext() {
  if (!browser) {
    if (!launching) {
      launching = launchBrowser().then(b => (browser = b)).finally(() => (launching = null));
    }
    await launching;
  }
  if (!browser) throw new Error("browser launch failed");

  if (!context) {
    context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        accept: "application/json, text/plain, */*",
        origin: ORIGIN,
        referer: REFERER
      }
    });
    // 初始化 cookie
    const p = await context.newPage();
    try {
      await p.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(()=>{});
      await p.waitForLoadState("networkidle", { timeout: 6_000 }).catch(()=>{});
      await p.waitForTimeout(800);
    } finally {
      await p.close().catch(()=>{});
    }
  }
  return context;
}

// ---------- 序列化 ----------
let queue = Promise.resolve();
function inQueue(fn) {
  const run = () => fn().catch(e => { throw e; });
  queue = queue.then(run, run);
  return queue;
}

// ---------- 健康檢查 ----------
app.get("/", (_req, res) => res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily"));
app.get("/ping", (_req, res) => res.send("pong 🏓"));
app.get("/health", (_req, res) => res.json({ ok: true, browser: !!browser, context: !!context }));

// ---------- 執行一次請求 ----------
async function runOnce(incoming) {
  const ctx = await ensureContext();
  let page = null;
  try {
    page = await ctx.newPage();
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(t)) return route.abort();
      return route.continue();
    });

    return await page.evaluate(async ({ TARGET, incoming }) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort("fetch-timeout"), 25_000);
      try {
        const r = await fetch(TARGET, {
          method: "POST",
          mode: "cors",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "accept": "application/json, text/plain, */*",
            "x-requested-with": "XMLHttpRequest"
          },
          body: JSON.stringify(incoming),
          signal: ac.signal
        });
        const text = await r.text();
        return { ok: true, status: r.status, text, ct: r.headers.get("content-type") || "" };
      } catch (e) {
        return { ok: false, error: String(e) };
      } finally {
        clearTimeout(t);
      }
    }, { TARGET, incoming });
  } finally {
    if (page) await page.close().catch(()=>{});
  }
}

// ---------- /daily ----------
app.post("/daily", async (req, res) => {
  inQueue(async () => {
    const incoming = Object.keys(req.body || {}).length
      ? req.body
      : {
          contentId: { type: "boNavigationList", id: "1356/3410535.1" },
          clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
        };

    try {
      let result = await runOnce(incoming);

      if (!result?.ok || /Target page|browser has been closed|fetch-timeout/i.test(result?.error || "")) {
        console.warn("first attempt failed; restarting browser and retrying...");
        try { if (context) await context.close().catch(()=>{}); } catch {}
        try { if (browser) await browser.close().catch(()=>{}); } catch {}
        browser = null; context = null;
        result = await runOnce(incoming);
      }

      if (!result?.ok) {
        return res.status(500).json({ error: "browser fetch failed", detail: result?.error || "unknown" });
      }

      res.status(result.status)
         .set("content-type", result.ct || "application/json; charset=utf-8")
         .send(result.text);

    } catch (e) {
      console.error("daily error:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  }).catch(err => {
    res.status(500).json({ error: String(err?.message || err) });
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
