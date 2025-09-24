import express from "express";

const app = express();
app.use(express.json());

// 顯示服務正常
app.get("/", (req, res) => {
  res.type("text/plain").send("sportslottery-proxy is running. Try POST /daily");
});

app.get("/ping", (req, res) => res.send("pong 🏓"));
app.get("/health", (req, res) => res.json({ ok: true }));

// 代理 daily API
app.post("/daily", async (req, res) => {
  try {
    const upstream = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";
    const payload =
      req.body && Object.keys(req.body).length
        ? req.body
        : {
            contentId: { type: "boNavigationList", id: "1356/3410535.1" },
            clientContext: { language: "ZH", ipAddress: "0.0.0.0" }
          };

    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Origin": "https://www.sportslottery.com.tw",
        "Referer": "https://www.sportslottery.com.tw/sportsbook/daily-coupons"
      },
      body: JSON.stringify(payload)
    });

    // 直接把上游回應透傳回來（JSON 或錯誤文字都回）
    const ct = r.headers.get("content-type") || "application/json; charset=utf-8";
    const text = await r.text();
    res.status(r.status).set("content-type", ct).send(text);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on :${port}`));
