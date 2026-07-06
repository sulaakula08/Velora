# Образ для деплоя (Railway/Render/Fly) и docker-compose.
FROM node:22-slim

# better-sqlite3 требует инструментов сборки для нативного модуля.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/data

# По умолчанию храним БД в /app/data. ЭТУ ПАПКУ НУЖНО СМОНТИРОВАТЬ как постоянный
# том, иначе при каждом редеплое/рестарте контейнера база (подключения Composio,
# токены, история) обнуляется — и бот «забывает», что Gmail/Календарь подключены.
# На Railway: Project → Volume → mount path /app/data (переменную задавать не нужно).
ENV DB_PATH=/app/data/velora.db

CMD ["node", "dist/index.js"]
