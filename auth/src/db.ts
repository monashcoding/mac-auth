/**
 * Database connection: postgres.js driver + Drizzle ORM.
 *
 * A single postgres.js client is shared by the Better Auth adapter and by the
 * boot-time migration runner. DATABASE_URL is assembled by docker-compose from the
 * POSTGRES_* env vars and points at the `postgres` service.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// One long-lived pool for the running server.
export const client = postgres(connectionString);

export const db = drizzle(client, { schema });
