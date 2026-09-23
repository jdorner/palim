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
# Stage 2: Production dependencies
# ============================================================
# Installing dependencies is isolated in its own stage so the large "just-bash"
# tarball is extracted exactly once. Raising the open-file-descriptor limit for
# the install avoids intermittent "Fail extracting tarball" errors on Alpine,
# where Bun extracts many files concurrently (just-bash unpacks ~900 files).
FROM docker.io/oven/bun:1.3-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN ulimit -n 65535 && bun install --frozen-lockfile --production

# ============================================================
# Stage 3: Production image
# ============================================================
FROM docker.io/oven/bun:1.3-alpine

WORKDIR /app

# Reuse the already-extracted production dependencies from the deps stage
# instead of running a second install/extract in the final image.
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules node_modules

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
