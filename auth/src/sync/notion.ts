/**
 * Notion committee-roster fetch + map.
 *
 * Mirrors the `notioncal-to-gcal` service (token owned by projects@, matching
 * Notion-Version header). This module ONLY talks to Notion; if Notion is down or slow
 * every call here throws/aborts and the caller (the scheduler, CLI, or admin endpoint)
 * is responsible for swallowing it. The auth/token-mint path never imports this file, so
 * a Notion outage cannot affect logins — it only makes the roster go stale until Notion
 * recovers.
 */

export interface RosterRecord {
  notionId: string;
  name: string;
  teams: string[];
  isExec: boolean;
  position: string | null;
  studentEmail: string | null;
  personalEmail: string | null;
  discordHandle: string | null;
  matchEmails: string[]; // normalized, deduped
}

const NOTION_VERSION = process.env.NOTION_VERSION ?? "2022-06-28"; // match notioncal-to-gcal

// Abort a single Notion request after this long so a hung connection can't stall the
// hourly job (or wedge the admin endpoint) indefinitely.
const NOTION_TIMEOUT_MS = Number(process.env.NOTION_TIMEOUT_MS ?? 15000);

/** Read env lazily so a missing token only errors when a sync actually runs. */
function notionConfig(): { token: string; dbId: string } {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_ROSTER_DB_ID;
  if (!token || !dbId) {
    throw new Error(
      "Notion sync not configured: set NOTION_TOKEN and NOTION_ROSTER_DB_ID.",
    );
  }
  return { token, dbId };
}

/** True when both Notion env vars are present (used to decide whether to schedule). */
export function isNotionConfigured(): boolean {
  return !!process.env.NOTION_TOKEN && !!process.env.NOTION_ROSTER_DB_ID;
}

// --- property extractors (property NAMES must match Notion exactly) ---
const rich = (p: any) =>
  (p?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
const email = (p: any) => (p?.email ?? "").trim().toLowerCase();
const select = (p: any) => p?.select?.name ?? null;
const titleP = (p: any) =>
  (p?.title ?? []).map((t: any) => t.plain_text).join("").trim();
const multi = (p: any): string[] =>
  (p?.multi_select ?? []).map((s: any) => s.name);

function mapPage(page: any): RosterRecord | null {
  const props = page.properties ?? {};

  // The "Committee Directory" is a full directory that also holds former members, tagged
  // `Current MAC Role = "Alumni"` — the only reliable current-vs-past signal in the data
  // (the `MAC Membership` checkbox and `Last day at MAC` date are both unreliable). Skip
  // them so alumni don't get committee roles. Removing someone from committee in Notion =
  // re-tagging them Alumni = they drop out of the next sync (revocation-is-deletion).
  const role = select(props["Current MAC Role"]);
  if (role && role.trim().toLowerCase() === "alumni") return null;

  // Some rows still carry the column's instructional placeholder text in Preferred Name;
  // treat it as empty so it doesn't become the person's display name.
  const PLACEHOLDER_NAMES = new Set(["leave blank if not needed"]);
  let preferred = rich(props["Preferred Name"]);
  if (PLACEHOLDER_NAMES.has(preferred.toLowerCase())) preferred = "";
  const first = rich(props["First Name"]);
  const last = rich(props["Last Name"]);
  const name = preferred || `${first} ${last}`.trim() || titleP(props["Name"]);

  const teamRaw: string[] = multi(props["Team"]); // e.g. ["Events","Executive"]
  const isExec = teamRaw.map((t) => t.toLowerCase()).includes("executive");
  // Functional teams = Team minus "Executive". "First Year Reps" is a cohort tag, not a
  // functional team — First Year Reps also carry their embedded team (e.g. Outreach), so we
  // keep the cohort tag in the array (lossless) but sort it to the end. The `team` claim is
  // teams[0], so it resolves to their functional team; a FYR with no other team falls back
  // to "First Year Reps". `sort` is stable, so other teams keep their Notion order.
  const COHORT_TAGS = new Set(["first year reps"]);
  const teams = teamRaw
    .filter((t) => t.toLowerCase() !== "executive")
    .sort(
      (a, b) =>
        (COHORT_TAGS.has(a.toLowerCase()) ? 1 : 0) -
        (COHORT_TAGS.has(b.toLowerCase()) ? 1 : 0),
    );

  const studentEmail = email(props["Student Email"]) || null;
  const preferredEmail = email(props["Preferred Email"]) || null;
  const personalEmail = email(props["Personal Email"]) || null;
  const workEmail = email(props["Work Email"]) || null;

  // ALL of a person's emails are valid login match keys (Student / Preferred / Personal /
  // Work) — they may sign in with any of them via Google/Microsoft.
  const matchEmails = [
    ...new Set(
      [studentEmail, preferredEmail, personalEmail, workEmail].filter(
        (e): e is string => !!e,
      ),
    ),
  ];

  if (matchEmails.length === 0) return null; // no email -> can't match at login; skip

  return {
    notionId: page.id,
    name: name || "(unnamed)",
    teams,
    isExec,
    position: role, // Current MAC Role (informational)
    studentEmail,
    personalEmail,
    discordHandle: rich(props["Discord Handle"]) || null,
    matchEmails,
  };
}

async function queryPage(
  token: string,
  dbId: string,
  cursor: string | undefined,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNotionRoster(): Promise<RosterRecord[]> {
  const { token, dbId } = notionConfig();
  const out: RosterRecord[] = [];
  let cursor: string | undefined;
  do {
    const data = await queryPage(token, dbId, cursor);
    for (const page of data.results ?? []) {
      const r = mapPage(page);
      if (r) out.push(r);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}
