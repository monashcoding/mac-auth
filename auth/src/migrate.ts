/**
 * Boot-time migration runner.
 *
 * Applies any pending SQL migrations from ./drizzle using drizzle-orm's migrator,
 * which needs only the generated SQL files at runtime (not drizzle-kit). The `auth`
 * container runs this before starting the server (see Dockerfile CMD).
 *
 * Uses its own short-lived connection (max: 1) so it can close cleanly and exit.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const migrationClient = postgres(connectionString, { max: 1 });

async function main() {
  console.log("[migrate] applying pending migrations...");
  await migrate(drizzle(migrationClient), { migrationsFolder: "./drizzle" });
  console.log("[migrate] done.");
  await migrationClient.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
