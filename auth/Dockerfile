# Multi-stage build for the MAC auth service (Node 22, ESM, TypeScript).
# Builds on any arch, including the Oracle Cloud ARM (aarch64) target.

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Install all deps (incl. dev) for compiling TS and generating migrations.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src

# Compile TS -> dist and generate SQL migrations from the schema into ./drizzle.
RUN npm run build \
 && npx drizzle-kit generate

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only production deps at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled app + generated migrations.
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

EXPOSE 3000

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
