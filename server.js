// server.js - Express + Playwright 真瀏覽器代理（穩定版）
import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// 對每個請求設一個總超時（避免 502）
app.use((req, res, next) => {
  res.setTimeout(45_000, () => res.status(504).json({ error: "gateway timeout (server)" }));
  next();
});

// 目標/來源
const TARGET  = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";
const REFERER = "https://www.sportslottery.com.tw/sportsbook/daily-coupons";
const ORIGIN  = "https://www.sportslottery.com.tw";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---- 單例瀏覽器（容器環境必要旗標）----
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
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
  }
  return browser;
}

// ---- 基本路由 ----
app.get("/", (_req, res) => res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily"));
app.get("/ping", (_req, res) => res.send("pong 🏓"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- 主要：/daily 用真瀏覽器發 POST ----
app.post("/daily", async (req, res) => {
  const incoming = Object.keys(req.body || {}).length
    ? req.body
    : {
        contentId: { type: "boNavigationList", id: "1356/3410535.1" },
        clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
      };

  let ctx, page;
  try {
    const br = await getBrowser();
    ctx = await br.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        accept: "application/json, text/plain, */*",
        origin: ORIGIN,
        referer: REFERER
      }
    });
    page = await ctx.newPage();

    // 擋掉不必要資源，減少卡住
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(type)) return route.abort();
      return route.continue();
    });

    // 先進 referer，讓站方種 cookie / 風控初始化
    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800); // 再給一點時間讓 cookie 完成

    // ★ 在瀏覽器上下文內做 fetch，帶上 cookie
    const result = await page.evaluate(async ({ TARGET, incoming }) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort("fetch-timeout"), 25_000);
      try {
        const r = await fetch(TARGET, {
          method: "POST",
          mode: "cors",
          credentials: "include",                 // 關鍵：帶上同站 cookie
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

    if (!result.ok) {
      return res.status(500).json({ error: "browser fetch failed", detail: result.error });
    }

    res.status(result.status)
       .set("content-type", result.ct || "application/json; charset=utf-8")
       .send(result.text);

  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx)  await ctx.close();  } catch {}
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
