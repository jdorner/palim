# ============================================================
# Stage 1: Install dependencies and build frontend
# ============================================================
FROM docker.io/oven/bun:1.3-alpine AS builder

WORKDIR /app

# Install root dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install frontend dependencies and build
COPY frontend/package.json frontend/bun.lock frontend/
RUN cd frontend && bun install --frozen-lockfile

# Copy source for frontend build
COPY shared/ shared/
COPY frontend/ frontend/

RUN cd frontend && bun run build

# ============================================================
# Stage 2: Production image
# ============================================================
FROM docker.io/oven/bun:1.3-alpine

WORKDIR /app

# Copy dependency manifests and install production deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy application source
COPY src/ src/
COPY shared/ shared/
COPY drizzle/ drizzle/
COPY tsconfig.json biome.json ./

# Copy built frontend from builder stage
COPY --from=builder /app/frontend/dist frontend/dist

# Create persistent directories
RUN mkdir -p .work/inbox .work/outbox .work/data .db

# Default environment
ENV NODE_ENV=production

EXPOSE 3000


# Mount at runtime (not baked into image):
#   - .env.production (encrypted secrets)
#   - .env.keys (decryption keys)
# Example:
# > podman build -t palim .
# > podman run -v ./.env.keys:/app/.env.keys -v ./.env.docker:/app/.env.production -p 3000:3000/tcp --name palim -it palim

CMD ["bun", "run", "src/main.ts"]
