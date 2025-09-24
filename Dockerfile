# 內建好 Chromium 與所有依賴
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .
ENV NODE_ENV=production
# Railway 會注入 $PORT，server.js 已用 process.env.PORT
EXPOSE 3000
CMD ["npm","start"]
