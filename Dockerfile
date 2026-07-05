# Образ для docker-compose (необязательный способ запуска).
FROM node:22-slim

# better-sqlite3 требует инструментов сборки для нативного модуля.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
