# 使用 Playwright 官方映像（含 Chromium v1.55.1）
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# 安裝依賴
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 複製專案程式碼
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm","start"]
