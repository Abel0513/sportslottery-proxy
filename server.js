// server.js - Express + Playwright (persistent context, low-memory, queue+retry)
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((_, res, next) => {
  res.setTimeout(60_000, () => res.status(504).json({ error: "gateway timeout (server)" }));
  next();
});

// ---- 站點常數 ----
const TARGET  = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";
const REFERER = "https://www.sportslottery.com.tw/sportsbook/daily-coupons";
const ORIGIN  = "https://www.sportslottery.com.tw";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---- Persistent Context（單例）----
const USER_DATA_DIR = process.env.PW_USER_DATA_DIR || "/tmp/pw-profile";
let pctx = null;        // persistent context
let booting = null;     // 啟動中 promise

function ensureUserDataDir() {
  try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}
}

async function launchPersistent() {
  ensureUserDataDir();
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    userAgent: UA,
    // 容器環境旗標（避免 sandbox / dev-shm 問題）
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ],
    // 不要儲存太多資源，減記憶體
    bypassCSP: true,
    javaScriptEnabled: true,
    // 預設 headers（同站/同來源）
    extraHTTPHeaders: {
      accept: "application/json, text/plain, */*",
      origin: ORIGIN,
      referer: REFERER
    }
  });

  // 一開始暖機一次，讓 cookie/風控先種好
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(t)) return route.abort();
      return route.continue();
    });
    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(()=>{});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(()=>{});
    await page.waitForTimeout(800);
  } finally {
    await page.close().catch(()=>{});
  }

  ctx.on("close", () => { pctx = null; });
  return ctx;
}

async function getContext() {
  if (pctx) return pctx;
  if (booting) return booting;
  booting = launchPersistent().then(c => (pctx = c)).finally(() => (booting = null));
  return booting;
}

// ---- 請求序列化（避免同時多開頁籤）----
let queue = Promise.resolve();
function inQueue(fn) {
  const run = () => fn().catch(e => { throw e; });
  queue = queue.then(run, run);
  return queue;
}

// ---- 健康檢查 ----
app.get("/", (_, res) => res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily"));
app.get("/health", async (_, res) => {
  res.json({ ok: true, persistent: !!pctx, profile: USER_DATA_DIR });
});
app.post("/reload", async (_, res) => {
  try {
    if (pctx) await pctx.close().catch(()=>{});
    pctx = null;
    await getContext();
    res.json({ reloaded: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- 執行一次請求（使用常駐 context，臨時 page）----
async function runOnce(incoming) {
  const ctx = await getContext();
  let page;
  try {
    page = await ctx.newPage();

    // 擋不必要資源
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "stylesheet", "font", "media"].includes(t)) return route.abort();
      return route.continue();
    });

    // 保險：背景暖 referer（不等）
    page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(()=>{});

    // 在瀏覽器上下文中 fetch（會自帶 cookie）
    const result = await page.evaluate(async ({ TARGET, incoming }) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort("fetch-timeout"), 25_000);
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

    return result;
  } finally {
    if (page) await page.close().catch(()=>{});
  }
}

// ---- /daily：序列化 + 失敗重啟重試一次 ----
app.post("/daily", (req, res) => {
  inQueue(async () => {
    const incoming = Object.keys(req.body || {}).length
      ? req.body
      : { contentId: { type: "boNavigationList", id: "1356/3410535.1" },
          clientContext: { language: "ZH", ipAddress: "0.0.0.0" } };

    try {
      let result = await runOnce(incoming);

      // 如果失敗/瀏覽器關閉/逾時 → 關閉重啟後再試一次
      if (!result?.ok || /Target page|browser has been closed|fetch-timeout/i.test(result?.error || "")) {
        console.warn("first attempt failed; restarting persistent context and retrying...");
        try { if (pctx) await pctx.close().catch(()=>{}); } catch {}
        pctx = null;
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

// ---- 啟動 ----
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("proxy up on :" + port));
