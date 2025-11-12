FROM node:20-bullseye

# Cài Python + build-essential + ffmpeg + libopus
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ffmpeg libopus-dev libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "index.js"]
