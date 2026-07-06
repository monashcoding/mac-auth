/**
 * Drizzle schema for the MAC central auth service.
 *
 * These tables are the exact shape Better Auth ^1.6 expects (verified against the
 * installed better-auth@1.6.x `get-tables` definitions). Column names are kept as
 * Better Auth's camelCase defaults so the `user`/`session`/`account`/`verification`
 * tables stay byte-for-byte compatible with MonMap for the later table-copy migration.
 *
 * Two extra columns are added to `user`:
 *   - roles:    JSON array string, default '["member"]'
 *   - isMonash: boolean, default false (set by the create hook in auth.ts)
 *
 * The `jwks` table is managed by the Better Auth JWT plugin (it stores the Ed25519
 * signing keypair). We only declare it so drizzle-kit creates/migrates it.
 */
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  // MAC-specific additional fields (exposed to Better Auth with input: false).
  roles: text("roles").notNull().default('["member"]'),
  isMonash: boolean("isMonash").notNull().default(false),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { mode: "date" }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expiresAt", { mode: "date" }),
});

// Committee roster tables (source of the derived committee/exec/team claims). Defined in
// their own module; re-exported here so drizzle-kit generates their migrations from the
// single schema entrypoint. They are NOT part of the Better Auth `schema` barrel below —
// Better Auth only manages the auth tables — but the roster sync/lookup queries import
// them directly.
export { roster, rosterEmail } from "./roster/schema.js";

export const schema = { user, session, account, verification, jwks };
