# One-off account migrations

Scripts here are **historical records** of one-time account imports into the central auth
DB — not part of any automated deploy. They document exactly how existing apps' users were
brought onto the central identity so a future committee can see (and, if ever needed, adapt)
what was done.

## `monmap-import.sh` — MonMap → central (2026-07-02)

Imported MonMap's **405** Better Auth accounts into the central `user`/`account` tables,
**preserving IDs** so `macUserId` == MonMap's original `user.id` (keeping MonMap's
`user_plan`/`user_grade` data valid with zero remapping).

- **Source:** host-installed Postgres 16, DB `monmap` (snake_case columns).
- **Target:** central auth Postgres container, DB `mac_auth` (Better Auth camelCase).
- The script maps snake→camel, defaults `roles`, computes `isMonash` from the email domain,
  backs up the central DB first, and is idempotent (`ON CONFLICT DO NOTHING`).
- **Result:** users 0 → 405, accounts 405, `isMonash` 317, 0 orphans. All accounts `google`.

MonMap's account rows (the Google links) were copied too, so users match their existing
identity on next sign-in — no re-linking needed.

> Container/DB names in the script are specific to the Oracle box at migration time. It is
> kept for the record; re-running is unnecessary (and idempotent if you did).
