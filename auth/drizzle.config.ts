import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config. Used at build/dev time to generate SQL migrations from
 * src/schema.ts into ./drizzle. At runtime the container applies those SQL files
 * with drizzle-orm's migrator (see src/migrate.ts) — drizzle-kit is not needed then.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mac_auth",
  },
});
