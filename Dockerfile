# Match Playwright version in image (1.55.1)
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
# Use npm install (no lockfile required)
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
