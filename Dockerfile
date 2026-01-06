FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 python-is-python3 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
