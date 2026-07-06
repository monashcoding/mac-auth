/**
 * Apply a fetched roster to Postgres: upsert by notionId, rebuild each person's match
 * emails, and delete anyone no longer in Notion (revocation-is-deletion).
 *
 * Guard rail: refuse a sync that empties the roster or removes >50% of people — that's
 * almost always a bad fetch or a fat-fingered Notion edit, not real churn. Override with
 * FORCE_ROSTER_SYNC=1 for genuine recruitment turnover. The whole apply runs in one
 * transaction, so a mid-sync failure leaves the previous roster intact.
 */
import { eq, inArray } from "drizzle-orm";
import type { db as Db } from "../db.js";
import { roster, rosterEmail } from "../roster/schema.js";
import type { RosterRecord } from "./notion.js";

type Database = typeof Db;

export interface ApplyResult {
  upserted: number;
  removed: number;
  emailCollisions: string[];
}

export async function applyRoster(db: Database, incoming: RosterRecord[]): Promise<ApplyResult> {
  const existing = await db.select({ id: roster.id, notionId: roster.notionId }).from(roster);
  const existingIds = new Map(existing.map((r) => [r.notionId, r.id]));
  const incomingIds = new Set(incoming.map((r) => r.notionId));
  const toRemove = [...existingIds.keys()].filter((nid) => !incomingIds.has(nid));

  const force = process.env.FORCE_ROSTER_SYNC === "1";
  if (!force) {
    if (incoming.length === 0) {
      throw new Error("Refusing roster sync: Notion returned an empty roster.");
    }
    if (existingIds.size > 0 && toRemove.length > existingIds.size / 2) {
      throw new Error(
        `Refusing roster sync: would remove ${toRemove.length} of ` +
          `${existingIds.size} people (>50%). Check the fetch. ` +
          `Set FORCE_ROSTER_SYNC=1 if intended.`,
      );
    }
  }

  // An email can only map to one person (roster_email.email is a PK). If two Notion rows
  // list the same email, the first sync wins; collect the rest to surface as a warning.
  const emailCollisions: string[] = [];
  const seenEmails = new Set<string>();

  await db.transaction(async (tx) => {
    for (const rec of incoming) {
      const [row] = await tx
        .insert(roster)
        .values({
          notionId: rec.notionId,
          name: rec.name,
          teams: rec.teams,
          isExec: rec.isExec,
          position: rec.position,
          studentEmail: rec.studentEmail,
          personalEmail: rec.personalEmail,
          discordHandle: rec.discordHandle,
          source: "notion",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: roster.notionId,
          set: {
            name: rec.name,
            teams: rec.teams,
            isExec: rec.isExec,
            position: rec.position,
            studentEmail: rec.studentEmail,
            personalEmail: rec.personalEmail,
            discordHandle: rec.discordHandle,
            updatedAt: new Date(),
          },
        })
        .returning({ id: roster.id });

      // Rebuild this person's match emails.
      await tx.delete(rosterEmail).where(eq(rosterEmail.rosterId, row.id));
      const fresh = rec.matchEmails.filter((e) => {
        if (seenEmails.has(e)) {
          emailCollisions.push(e);
          return false;
        }
        seenEmails.add(e);
        return true;
      });
      if (fresh.length > 0) {
        await tx
          .insert(rosterEmail)
          .values(fresh.map((e) => ({ email: e, rosterId: row.id })))
          .onConflictDoNothing(); // an email maps to one person; first wins
      }
    }

    if (toRemove.length > 0) {
      const ids = toRemove.map((nid) => existingIds.get(nid)!) as string[];
      await tx.delete(roster).where(inArray(roster.id, ids)); // cascades roster_email
    }
  });

  return { upserted: incoming.length, removed: toRemove.length, emailCollisions };
}
