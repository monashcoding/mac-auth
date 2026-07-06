/**
 * Manual roster sync — what you actually run on recruitment day.
 *
 *   npm run sync-roster
 *
 * Fetches Notion and applies once, then exits. Non-zero exit on failure so it's visible
 * in a terminal / CI. Uses the shared long-lived client, closed on the way out.
 */
import { db, client } from "../db.js";
import { runRosterSync } from "./index.js";

runRosterSync(db)
  .then(async () => {
    await client.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[roster-sync] manual sync failed:", err);
    await client.end().catch(() => {});
    process.exit(1);
  });
