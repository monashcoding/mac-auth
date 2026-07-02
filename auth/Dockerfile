# Multi-stage build for the MAC auth service (Node 22, ESM, TypeScript).
# Builds on any arch, including the Oracle Cloud ARM (aarch64) target.

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Install all deps (incl. dev) for compiling TS.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Compile TS -> dist. Migrations are COMMITTED under ./drizzle and are NOT generated here:
# regenerating at build time gives each build fresh migration timestamps, which makes the
# drizzle migrator re-run already-applied migrations against the live DB (CREATE TABLE ->
# "already exists") and crash. Committed migrations keep those timestamps stable.
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only production deps at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled app + committed SQL migrations.
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

EXPOSE 3000

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
