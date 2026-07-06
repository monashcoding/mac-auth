/**
 * Roster sync entrypoints.
 *
 *   - runRosterSync: fetch Notion + apply once. Throws on failure so callers (CLI, admin
 *     endpoint) can report it; the scheduled job swallows it.
 *   - scheduleRosterSync: hourly node-cron job. Cadence is set by how fast a removal must
 *     land (1h + token TTL), not by how often the roster changes.
 *
 * Crash-safety: the schedule only wires a timer at boot — it does NOT call Notion, so a
 * Notion outage can never break startup. Each hourly run is wrapped so a failed fetch
 * (Notion down, timeout, bad response) is logged and the process keeps running on the
 * last-good roster in Postgres.
 */
import cron from "node-cron";
import type { db as Db } from "../db.js";
import { type ApplyResult, applyRoster } from "./apply.js";
import { fetchNotionRoster, isNotionConfigured } from "./notion.js";

type Database = typeof Db;

export async function runRosterSync(db: Database): Promise<ApplyResult> {
  const r = await applyRoster(db, await fetchNotionRoster());
  console.log(
    `[roster-sync] upserted=${r.upserted} removed=${r.removed}` +
      (r.emailCollisions.length
        ? ` collisions=${r.emailCollisions.length} (${[...new Set(r.emailCollisions)].join(", ")})`
        : ""),
  );
  return r;
}

export function scheduleRosterSync(db: Database): void {
  if (!isNotionConfigured()) {
    console.warn(
      "[roster-sync] NOTION_TOKEN/NOTION_ROSTER_DB_ID not set — skipping schedule. " +
        "Roster claims will be empty until configured.",
    );
    return;
  }
  cron.schedule("0 * * * *", () => {
    runRosterSync(db).catch((e) =>
      console.error("[roster-sync] hourly run failed (roster left unchanged):", e),
    );
  });
  console.log("[roster-sync] scheduled hourly (0 * * * *).");
}
