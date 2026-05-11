FROM mcr.microsoft.com/playwright:v1.45.3-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
