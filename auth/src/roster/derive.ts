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
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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

  if (row) {
    roles.push("committee");
    if (row.isExec) roles.push("exec");
  }
  if (ADMIN_EMAILS.includes(normalized)) roles.push("admin"); // independent of roster

  return { roles, team: row?.teams?.[0] ?? null };
}
