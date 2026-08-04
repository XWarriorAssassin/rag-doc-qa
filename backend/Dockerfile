# --- deps: install once, shared by both build and runtime stages via
# selective copying below, so the final image never contains devDependencies
# or the TypeScript source at all -----------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TypeScript -> dist/ -----------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime: the actual image that ships. Alpine + only production deps
# keeps this small; multer/pdf processing needs no native build tools at
# runtime (pdfjs-dist is pure JS), so alpine's minimal libc is sufficient —
# no need for the full debian-based node image here. ----------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations

# Uploaded PDFs land here (see src/lib/storage.ts) before/while being
# processed. This directory is NOT a substitute for real persistence — see
# the README's storage tradeoffs section — but Render's filesystem is
# writable at runtime, so the app needs somewhere to write to even for the
# brief window between upload and text extraction.
RUN mkdir -p /app/storage

# Runs as a non-root user. The "node" user/group ship built into the
# official image already, no need to create one — just switch to it and
# make sure it owns the one directory this process actually writes to.
RUN chown -R node:node /app/storage
USER node

EXPOSE 4000

# Doesn't hit the DB or OpenRouter — GET /health is a pure liveness check
# (see app.ts), so this can't false-negative just because Neon or
# OpenRouter is having a bad moment.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
