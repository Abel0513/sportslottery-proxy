# Playwright official image with Chromium installed
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
# Use npm install (not npm ci) since repo may not include package-lock.json
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
