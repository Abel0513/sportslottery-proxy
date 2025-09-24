// server.js - Express + Playwright Proxy with retry
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

// ---------- 單例瀏覽器 + 自動重啟 ----------
let browser = null;
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
      "--no-zygote",
      "--single-process"
    ]
  });
  b.on("disconnected", () => {
    browser = null;
  });
  return b;
}

async function getBrowser() {
  if (browser) return browser;
  if (launching) return launching;
  launching = launchBrowser()
    .then(b => (browser = b))
    .finally(() => (launching = null));
  return launching;
}

// ---------- 序列佇列 ----------
let queue = Promise.resolve();
function inQueue(fn) {
  const run = () => fn().catch(e => { throw e; });
  queue = queue.then(run, run);
  return queue;
}

// ---------- 基本路由 ----------
app.get("/", (_req, res) => res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily"));
app.get("/ping", (_req, res) => res.send("pong 🏓"));
app.get("/health", (_req, res) => res.json({ ok: true, browser: !!browser }));

// ---------- 核心函式：跑一次 daily ----------
async function runDailyOnce(incoming) {
  const br = await getBrowser();
  if (!br) throw new Error("browser not available");

  const ctx = await br.newContext({
    userAgent: UA,
    extraHTTPHeaders: {
      accept: "application/json, text/plain, */*",
      origin: ORIGIN,
      referer: REFERER
    }
  });
  const page = await ctx.newPage();

  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(t)) return route.abort();
      return route.continue();
    });

    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(()=>{});
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(()=>{});
    await page.waitForTimeout(800);

    return await page.evaluate(async ({ TARGET, incoming }) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort("fetch-timeout"), 25000);
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
    await page.close().catch(()=>{});
    await ctx.close().catch(()=>{});
  }
}

// ---------- /daily 路由：自動重試一次 ----------
app.post("/daily", async (req, res) => {
  inQueue(async () => {
    const incoming = Object.keys(req.body || {}).length
      ? req.body
      : {
          contentId: { type: "boNavigationList", id: "1356/3410535.1" },
          clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
        };

    try {
      let result = await runDailyOnce(incoming);

      // 如果瀏覽器掛掉 → 重啟再試一次
      if (!result.ok || /Target page|browser has been closed/.test(result.error || "")) {
        console.warn("browser crash, retrying once...");
        browser = null; // 強制重啟
        result = await runDailyOnce(incoming);
      }

      if (!result.ok) {
        return res.status(500).json({ error: "browser fetch failed", detail: result.error || "unknown" });
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

// ---------- 啟動 ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
