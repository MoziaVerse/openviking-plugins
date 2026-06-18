FROM node:22-bookworm-slim

ENV NODE_ENV=development
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN timeout 180s npm install -g opencode-ai@latest \
  --registry=https://registry.npmjs.org/ \
  --fetch-timeout=15000 \
  --fetch-retries=1 \
  --no-audit \
  --no-fund

COPY package.json package-lock.json ./
RUN timeout 180s npm ci \
  --registry=https://registry.npmjs.org/ \
  --fetch-timeout=15000 \
  --fetch-retries=1 \
  --no-audit \
  --no-fund \
  --ignore-scripts

COPY . .

RUN npm run typecheck \
  && npm run install:opencode:local \
  && opencode --version

CMD ["npm", "run", "smoke:opencode:docker"]
