# Dockerfile for Railway - ensures python, ffmpeg, libopus, build tools and Node 22
FROM node:22-bullseye

# Install system deps: python (and ensure 'python' binary), build tools, ffmpeg, opus
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    build-essential \
    pkg-config \
    ffmpeg \
    libopus-dev \
    libsodium-dev \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (cache)
COPY package*.json ./

# Install production deps
# Use npm ci and omit dev dependencies
RUN npm ci --omit=dev

# Copy rest of app
COPY . .

# Expose not necessary for Discord bot, but keep default
ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD 1

CMD ["node", "index.js"]
