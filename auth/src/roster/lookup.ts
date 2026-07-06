/**
 * Login-email -> roster claims lookup.
 *
 * login email -> roster_email (indexed PK) -> roster -> deriveClaims. Two small reads.
 * Callers (the mint path) must treat a thrown error as "no roster info" and fall back to
 * base roles — a roster/DB hiccup must never block token minting. See src/auth.ts.
 */
import { eq } from "drizzle-orm";
import type { db as Db } from "../db.js";
import { roster, rosterEmail } from "./schema.js";
import { deriveClaims, normalizeEmail, type DerivedClaims } from "./derive.js";

type Database = typeof Db;

export async function claimsForEmail(
  db: Database,
  email: string,
): Promise<DerivedClaims> {
  const e = normalizeEmail(email);
  const link = await db
    .select()
    .from(rosterEmail)
    .where(eq(rosterEmail.email, e))
    .limit(1);
  if (link.length === 0) return deriveClaims(e, null);

  const row = await db
    .select({ teams: roster.teams, isExec: roster.isExec })
    .from(roster)
    .where(eq(roster.id, link[0].rosterId))
    .limit(1);
  return deriveClaims(e, row[0] ?? null);
}
