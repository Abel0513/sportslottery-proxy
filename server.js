// server.js - Express + Playwright 真瀏覽器代理
import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const TARGET = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";
const REFERER = "https://www.sportslottery.com.tw/sportsbook/daily-coupons";
const ORIGIN  = "https://www.sportslottery.com.tw";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 單例瀏覽器（効能更好）
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

// 基本測試路由
app.get("/", (req, res) => res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily"));
app.get("/ping", (_req, res) => res.send("pong 🏓"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// 真瀏覽器發出 daily 請求
app.post("/daily", async (req, res) => {
  const incoming = req.body && Object.keys(req.body).length ? req.body : {
    contentId: { type: "boNavigationList", id: "1356/3410535.1" },
    clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
  };

  try {
    const br = await getBrowser();
    const ctx = await br.newContext({
      userAgent: UA,
      extraHTTPHeaders: { accept: "application/json, text/plain, */*", origin: ORIGIN, referer: REFERER }
    });

    const page = await ctx.newPage();
    // 先進入 daily-coupons，讓風控看到正常導航
    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 在瀏覽器上下文中發真正的 POST（會帶上 Cloudflare 設定的 cookie）
    const result = await page.evaluate(async ({ TARGET, incoming }) => {
      const r = await fetch(TARGET, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json, text/plain, */*" },
        body: JSON.stringify(incoming)
      });
      const text = await r.text();
      return { status: r.status, text, ct: r.headers.get("content-type") || "" };
    }, { TARGET, incoming });

    await ctx.close();

    res.status(result.status)
       .set("content-type", result.ct || "application/json; charset=utf-8")
       .send(result.text);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
