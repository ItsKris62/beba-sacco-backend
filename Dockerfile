# ─────────────────────────────────────────────────────────────────────────────
# Beba SACCO – Multi-stage Dockerfile
# Node 20 LTS Alpine for minimal attack surface and image size.
#
# Stages:
#   deps    – install production npm deps + generate Prisma client
#   builder – compile TypeScript → dist/
#   runner  – lean production image (no devDeps, no source, non-root)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Build tooling needed by native add-ons (argon2, bcrypt)
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package*.json ./
# Install ALL deps here (devDeps needed for Prisma generate in builder)
RUN npm ci

# ── Stage 2: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client from non-standard schema path
RUN npx prisma generate --schema=src/prisma/schema.prisma

# Compile TypeScript
RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security (principle of least privilege)
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nestjs

# Install only the runtime OS libs that native modules need
RUN apk add --no-cache libc6-compat

# Reinstall production-only deps in the final layer so devDeps are excluded
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled app
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

# Copy Prisma client (generated artefacts live in node_modules, already copied above)
# Copy the schema so `prisma migrate deploy` can run at startup if needed
COPY --from=builder --chown=nestjs:nodejs /app/src/prisma ./src/prisma

# Runtime environment defaults (override via docker compose / Kubernetes secrets)
ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER nestjs

# Lightweight healthcheck using the bundled Node runtime (no wget/curl needed)
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "require('http').get({host:'localhost',port:3000,path:'/api/health'}, \
    r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main"]
