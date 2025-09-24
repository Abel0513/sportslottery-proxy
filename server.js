import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Daily-coupons proxy
app.post("/daily", async (req, res) => {
  try {
    const upstream = "https://www-talo-ssb-pr.sportslottery.com.tw/services/content/get";

    // 如果前端沒帶 payload，就用你測試過的固定 JSON
    const payload =
      req.body && Object.keys(req.body).length > 0
        ? req.body
        : {
            contentId: { type: "boNavigationList", id: "1356/3410535.1" },
            clientContext: { language: "ZH", ipAddress: "0.0.0.0" },
          };

    const r = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Origin: "https://www.sportslottery.com.tw",
        Referer: "https://www.sportslottery.com.tw/sportsbook/daily-coupons",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Railway port
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Proxy running on port ${port}`);
});
