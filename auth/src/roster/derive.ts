/**
 * Role & team derivation.
 *
 * Roles/team are *derived* at token-mint time by joining the login email against the
 * roster row — never stamped on the user record. Truth flows Notion -> roster -> claims.
 *
 *   - Presence in the roster == committee.
 *   - `exec` comes from the "Executive" tag in the Notion Team multi-select (isExec).
 *   - `admin` is a separate trust level from an env allowlist, independent of Notion.
 *   - `team` is the first functional team (a person almost always has exactly one).
 *   - Shared team service accounts (events@, marketing@, …) aren't people in the roster,
 *     so they're mapped here to committee + their team, independent of Notion.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Shared team inboxes/service accounts that log in as a whole team rather than a person.
 * They're not in the Notion roster, so we grant them `committee` + their team here (like
 * `admin`, this is an intentional allowlist independent of Notion). Keys MUST be normalized
 * (lowercase). Team values match the Notion team vocabulary so downstream apps see one set
 * of names (recruitment maps to People and Culture — its parent team).
 */
const TEAM_ACCOUNTS: Record<string, string> = {
  "events@monashcoding.com": "Events",
  "marketing@monashcoding.com": "Marketing",
  "recruitment@monashcoding.com": "People and Culture",
  "sponsorship@monashcoding.com": "Sponsorship",
  "projects@monashcoding.com": "Projects",
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface DerivedClaims {
  /** Roster-derived roles only: some combination of "committee", "exec", "admin". */
  roles: string[];
  /** First functional team, or null if not on the roster. */
  team: string | null;
}

export function deriveClaims(
  email: string,
  row: { teams: string[] | null; isExec: boolean } | null,
): DerivedClaims {
  const roles: string[] = [];
  const normalized = normalizeEmail(email);
  let team = row?.teams?.[0] ?? null;

  if (row) {
    roles.push("committee");
    if (row.isExec) roles.push("exec");
  } else if (normalized in TEAM_ACCOUNTS) {
    // Shared team service account (not a roster person): committee + its mapped team.
    roles.push("committee");
    team = TEAM_ACCOUNTS[normalized];
  }
  if (ADMIN_EMAILS.includes(normalized)) roles.push("admin"); // independent of roster

  return { roles, team };
}
