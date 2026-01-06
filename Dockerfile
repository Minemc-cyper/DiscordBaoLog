FROM node:22.12.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python-is-python3 ffmpeg \
    make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
