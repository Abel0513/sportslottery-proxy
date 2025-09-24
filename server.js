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

// ---------- 超簡單序列佇列，避免同時多開 ----------
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

// ---------- 主要：/daily ----------
app.post("/daily", async (req, res) => {
  inQueue(async () => {
    const incoming = Object.keys(req.body || {}).length
      ? req.body
      : {
          contentId: { type: "boNavigationList", id: "1356/3410535.1" },
          clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
        };

    let ctx, page;
    try {
      const br = await getBrowser();
      if (!br) throw new Error("browser not available");

      ctx = await br.newContext({
        userAgent: UA,
        extraHTTPHeaders: {
          accept: "application/json, text/plain, */*",
          origin: ORIGIN,
          referer: REFERER
        }
      });
      page = await ctx.newPage();

      // 擋掉大資源
      await page.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (["image", "stylesheet", "font", "media"].includes(t)) return route.abort();
        return route.continue();
      });

      // 先載入 Referer 稍等，讓 cookie / 風控完成
      await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(()=>{});
      await page.waitForTimeout(1000);

      // 在瀏覽器上下文內 fetch，帶 cookie
      const result = await page.evaluate(async ({ TARGET, incoming }) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort("fetch-timeout"), 30_000);
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
          clearTimeout(timer);
        }
      }, { TARGET, incoming });

      if (!result.ok) {
        return res.status(500).json({ error: "browser fetch failed", detail: result.error || "unknown" });
      }

      res.status(result.status)
        .set("content-type", result.ct || "application/json; charset=utf-8")
        .send(result.text);

    } catch (e) {
      // 若是瀏覽器掛掉，下次會自動重啟
      console.error("daily error:", e);
      res.status(500).json({ error: String(e.message || e) });
    } finally {
      try { if (page) await page.close(); } catch {}
      try { if (ctx)  await ctx.close();  } catch {}
    }
  }).catch(err => {
    // 萬一佇列執行錯誤，也要回應
    res.status(500).json({ error: String(err?.message || err) });
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
