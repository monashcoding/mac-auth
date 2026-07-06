/**
 * Drizzle schema for the committee roster.
 *
 * Truth flows Notion -> these tables -> JWT claims. Nothing here is written by the
 * auth flow itself; the hourly sync (src/sync) rebuilds it from the Notion roster.
 *
 * Keyed by the Notion page id (`notionId`), which is stable even when a person's
 * emails change. `roster_email` holds every login email that should match a person
 * (Student / Preferred / Personal), normalized to trim + lowercase, so the mint-time
 * lookup is a single indexed read.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const roster = pgTable("roster", {
  id: uuid("id").defaultRandom().primaryKey(),
  notionId: text("notion_id").notNull().unique(), // stable external key (Notion page id)
  name: text("name").notNull(),
  teams: text("teams").array().notNull().default([]), // functional teams, "Executive" removed
  isExec: boolean("is_exec").notNull().default(false), // "Executive" ∈ Team multi-select
  position: text("position"), // Current MAC Role (informational)
  studentEmail: text("student_email"), // contact/display
  personalEmail: text("personal_email"), // contact/display
  discordHandle: text("discord_handle"), // stored for the future Discord bot; NOT in claims
  source: text("source").notNull().default("notion"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every email that should match this person at login (Student / Preferred / Personal).
export const rosterEmail = pgTable("roster_email", {
  email: text("email").primaryKey(), // normalized: trim + lowercase
  rosterId: uuid("roster_id")
    .notNull()
    .references(() => roster.id, { onDelete: "cascade" }),
});
