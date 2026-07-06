# MAC Suite — Central Auth Service

The single identity provider that MAC's apps trust. Users sign in with **Google** or
**Microsoft** (passwordless), and this service mints short-lived, asymmetrically-signed
JWTs (**EdDSA / Ed25519**) that MAC apps verify **locally** against a published JWKS —
no app calls this service per request.

- **Domain:** `https://auth.monashcoding.com`
- **Stack:** Node 22 · TypeScript (ESM) · Express · Better Auth `^1.6.9` · Drizzle ORM · Postgres 16
- **Deploy:** self-hosted **Dokploy** on the shared MAC Oracle VM, behind Dokploy's **Traefik**
  (which terminates TLS via Let's Encrypt). See [`DEPLOY-dokploy.md`](DEPLOY-dokploy.md).
- **Building an app that needs login?** Skip to
  [**Integrating your app**](#integrating-your-app-for-other-mac-repos) — the full copy-paste recipe.

---

## Architecture

The service is a Dokploy **Compose** stack of three containers
([`docker-compose.dokploy.yml`](docker-compose.dokploy.yml)):

| Service    | Image               | Role |
|------------|---------------------|------|
| `auth`     | built from `./auth` | This service (Better Auth on Express). Runs DB migrations on boot, then listens on `:3000` |
| `postgres` | `postgres:16`       | Self-hosted identity store (`user`/`session`/`account`/`verification`/`jwks`) |
| `backup`   | `postgres:16`       | Nightly `pg_dump` with rotation into `./backups` (no host cron, no third-party image) |

Ingress is handled by the shared **Traefik** that Dokploy already runs on the box — this
service does **not** run its own reverse proxy and does **not** publish host ports. Traefik
routes `auth.monashcoding.com` → `auth:3000` over the `dokploy-network`.

The JWT plugin generates and stores its Ed25519 signing keypair itself in the `jwks`
table on first boot — **there are no manual `openssl` steps**. Public keys are served at
`/api/auth/jwks`.

**Canonical identity:** the JWT carries `macUserId`, which is the Better Auth `user.id`.
Keep this as the canonical user identifier across all MAC apps (a later migration will
preserve MonMap's existing `user.id` values as these IDs).

---

## Deploying

Full step-by-step (dashboard access, Git deploy key, environment, domain, verification, and
the Traefik/`dokploy-network` gotcha) is in **[`DEPLOY-dokploy.md`](DEPLOY-dokploy.md)**.

In short: it's a Dokploy **Compose** service pointing at this repo with Compose Path
`docker-compose.dokploy.yml`, the `.env` pasted into Dokploy's Environment tab, and a Domain
(`auth.monashcoding.com`, port `3000`, Let's Encrypt) added in the Domains tab.

Check it's healthy:
```bash
curl -s https://auth.monashcoding.com/health          # -> {"status":"ok"}
curl -s https://auth.monashcoding.com/api/auth/jwks    # -> JWKS with an Ed25519 key
```

### DNS prerequisite

`auth.monashcoding.com` must resolve to the VM (a direct `A` record → the VM's public IP).
Traefik obtains and renews the Let's Encrypt cert automatically once the Domain is added and
DNS resolves — there are no manual cert steps.

---

## Environment

Copy `.env.example` to `.env` for local use, or paste the values into Dokploy's Environment
tab for deployment. **Never commit `.env`** — secrets live in the committee password manager
under `projects@monashcoding.com`.

| Variable | Notes |
|----------|-------|
| `BETTER_AUTH_URL` | Public base URL, e.g. `https://auth.monashcoding.com`. Used as the JWT `iss`. |
| `BETTER_AUTH_SECRET` | Long random secret. Generate with `openssl rand -base64 32`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Self-hosted Postgres credentials. **Keep the password URL/shell-safe — letters+digits only** (`$ @ : / #` break env interpolation and the assembled `DATABASE_URL`; use `openssl rand -hex 24`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. The ID must end in `.apps.googleusercontent.com` (watch for truncation when pasting). |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth client (tenant `common`). |
| `TRUSTED_ORIGINS` | Comma-separated **extra** origins allowed to start auth flows. Every https `*.monashcoding.com` subdomain is trusted automatically, so this is only for off-domain origins (e.g. `http://localhost:3000` in dev). |
| `JWT_AUDIENCE` | JWT `aud` claim — `mac-suite`. |
| `NOTION_TOKEN` / `NOTION_ROSTER_DB_ID` | Notion integration token (owned by `projects@`, shared with `notioncal-to-gcal`) + the committee-roster database id. Drives the derived `committee`/`exec`/`team` claims. If unset, the roster sync is skipped and those claims stay empty — logins still work. |
| `NOTION_VERSION` | Notion API version. Match `notioncal-to-gcal` (default `2022-06-28`). |
| `ADMIN_EMAILS` | Comma-separated infra superusers granted `admin` (NOT from Notion). Also gates `POST /api/admin/sync-roster`. |
| `FORCE_ROSTER_SYNC` | Set to `1` for ONE sync to bypass the >50%-removal guard (recruitment churn), then unset. |

---

## OAuth client registration

Register these **redirect URIs** exactly:

- **Google:** `https://auth.monashcoding.com/api/auth/callback/google`
  (Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client)
- **Microsoft:** `https://auth.monashcoding.com/api/auth/callback/microsoft`
  (Entra ID → App registrations → your app → Authentication → Web → Redirect URIs)

Microsoft uses `tenantId: "common"` so personal Microsoft accounts (Hotmail/Outlook/Live)
work as well as work/school accounts.

---

## JWT payload contract

Apps can rely on exactly these claims (plus standard `sub`, `iat`):

```json
{
  "macUserId": "<user.id>",
  "email": "<user.email>",
  "roles": ["member", "committee", "exec"],
  "team": "Events",
  "ver": 1,
  "iss": "https://auth.monashcoding.com",
  "aud": "mac-suite",
  "exp": 1234567890
}
```

- Algorithm: **EdDSA (Ed25519)**, signed with the key published at `/api/auth/jwks`.
- Access-token lifetime: **15 minutes**.
- `roles` is the union of the user's base roles (`member`) and roles **derived** from the
  committee roster at mint time: `committee` (on the roster), `exec` (`"Executive"` in their
  Notion Team), and `admin` (env allowlist, not from Notion). See [Committee roster](#committee-roster).
- `team` is the person's first functional team (e.g. `"Events"`), or `null` if not on the
  roster. Informational — gate access on `roles`, not `team`.
- `isMonash` is recorded on the `user` row (from `@monash.edu` / `@student.monash.edu`)
  for later eligibility logic — it is **not** in the token and does **not** gate signup.

### How apps verify a token

Copy [`examples/verify.ts`](examples/verify.ts) into the app (only dependency: `jose`).
It fetches and caches the JWKS with `createRemoteJWKSet` and checks `iss`, `aud`, and
`exp`, returning typed `{ macUserId, email, roles, team, ver }` claims. No per-request call
to this service.

---

## Committee roster

Committee membership, team, and exec status are **derived** from the central Notion committee
roster (the **`Committee Directory`** database) and injected into the token — no app keeps its own
membership list. Curate the committee once in Notion; removing someone there revokes their
`committee`/`exec` roles everywhere on their next token.

**How it flows:** `Notion → roster tables (Postgres) → claims`.

- An hourly [`node-cron`](auth/src/sync/index.ts) job fetches the Notion roster and upserts it
  into the `roster` / `roster_email` tables (keyed by the stable Notion page id).
- The `Committee Directory` also holds **former** members (tagged `Current MAC Role = "Alumni"`);
  the sync **skips alumni**, so only current committee get roles. Re-tag someone `Alumni` to
  revoke their access on the next sync.
- At token-mint time, the login email is matched against `roster_email` (any of a person's
  Student / Preferred / Personal / Work emails) and the roles/team are derived. **Nothing is
  stamped on the user row.**
- Tokens are always minted from Postgres, **never from live Notion** — so a Notion outage cannot
  affect logins. It only means the roster stops updating until Notion recovers (the last-synced
  roster keeps serving). If the roster read itself ever fails, the mint path falls back to base
  roles rather than blocking the login.

**Roles:** `committee` (present in the roster), `exec` (`"Executive"` in the person's Notion
Team multi-select), `admin` (env `ADMIN_EMAILS`, independent of Notion).

**First-time setup (per environment):**

1. Set `NOTION_TOKEN`, `NOTION_ROSTER_DB_ID`, `NOTION_VERSION`, and `ADMIN_EMAILS` (see the
   [Environment](#environment) table). In Dokploy these go in the service's Environment tab —
   and they must also be **forwarded in `docker-compose.dokploy.yml`** (compose only injects the
   vars it references; they're already listed there). See [DEPLOY-dokploy.md](DEPLOY-dokploy.md).
2. Share the `Committee Directory` database with the Notion integration that owns `NOTION_TOKEN`
   (the `GcalInt` integration, shared with `notioncal-to-gcal`), or the sync gets a 404.
3. Deploy (migration `0001` creates the roster tables automatically), then run the first sync so
   you don't wait for the hourly job — see **Apply now** below. On boot the logs show
   `[roster-sync] scheduled hourly (0 * * * *).` (or a "not set — skipping" warning if the env
   vars didn't land).

**Operating it:**

- **Apply now** (recruitment day, or the first sync): run the manual sync instead of waiting up to
  an hour. In production (Docker Swarm):
  ```bash
  docker exec "$(docker ps -qf name=auth | head -1)" node dist/sync/cli.js
  # -> [roster-sync] upserted=<n> removed=<n>
  ```
  Locally use `npm run sync-roster`; there's also `POST /api/admin/sync-roster` (gated to
  `ADMIN_EMAILS`, needs an admin session).
- **Guard rail:** a sync that would empty the roster or remove >50% of people is refused (likely a
  bad fetch or fat-fingered Notion edit). For genuine churn, run once with `FORCE_ROSTER_SYNC=1`,
  then unset it.
- **A committee member 403s / has no `committee` role?** First check they aren't tagged `Alumni`.
  Then check the email they log in with is one of their Notion emails (Student / Preferred /
  Personal / Work). A typo in an email is the usual cause — fix it in Notion, then re-sync.
- **Notion token** lives with `projects@`. If rotated, update `NOTION_TOKEN` here **and** in
  `notioncal-to-gcal`.

---

## Integrating your app (for other MAC repos)

This is the full recipe for making any MAC app use this service as its login. The app stores
**no passwords and no accounts** — it trusts JWTs this service mints and keys its own data by
`macUserId`.

```
 User ─sign in─▶ auth.monashcoding.com ─Google/Microsoft─▶ shared session cookie (.monashcoding.com)
                                                                     │
 Your app ◀─ JWT {macUserId,email,roles,team} ◀─ GET /api/auth/token ◀─┘
    └─ verifies the JWT locally (jose + JWKS) — no call back to auth per request
    └─ stores/loads its data keyed by macUserId
```

### Step 0 — one-time registration

1. **Serve the app on a `*.monashcoding.com` subdomain** (e.g. `jobs.monashcoding.com`).
   Cross-app single sign-on relies on a cookie scoped to `.monashcoding.com`, so an app on a
   different domain won't get silent SSO (sign-in still works, just not shared). Being on a
   `*.monashcoding.com` subdomain also means the app's origin is **trusted automatically** —
   no auth-side config or redeploy is needed to onboard it.
2. `npm i jose` and **copy [`examples/verify.ts`](examples/verify.ts)** into the app's backend.

   *(Only if the app is served off-domain — e.g. local dev on `http://localhost:3000` — add
   that origin to `TRUSTED_ORIGINS` in the auth service's Dokploy Environment tab and redeploy.)*

### Step 1 — start sign-in (frontend)

Social sign-in is a **POST** (not a GET link). It returns a URL to redirect the user to:

```js
const res = await fetch("https://auth.monashcoding.com/api/auth/sign-in/social", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",                    // so the session cookie is set
  body: JSON.stringify({
    provider: "google",                      // or "microsoft"
    callbackURL: "https://jobs.monashcoding.com/",   // where to return after login
  }),
});
window.location = (await res.json()).url;    // → Google/Microsoft consent → back to your app
```

After the user returns, the browser holds a session cookie for `.monashcoding.com`.

### Step 2 — get a token (frontend)

```js
const { token } = await fetch("https://auth.monashcoding.com/api/auth/token", {
  credentials: "include",                    // sends the shared cookie
}).then(r => r.json());
// send it to YOUR backend:
await fetch("/api/whatever", { headers: { Authorization: `Bearer ${token}` } });
```

If `/api/auth/token` returns 401, the user isn't signed in — send them through Step 1.

### Step 3 — verify on your backend (per request, local, no network call)

```ts
import { verifyMacToken } from "./verify";   // examples/verify.ts

const auth = req.headers.authorization?.replace("Bearer ", "");
const claims = await verifyMacToken(auth);   // throws if invalid/expired
// claims: { macUserId, email, roles, team, ver }
```

Set `AUTH_URL=https://auth.monashcoding.com` in the app's env (verify.ts reads it).

### Step 4 — key your data by `macUserId`

`claims.macUserId` is the canonical, stable per-person ID. Use it as the foreign key for the
app's own tables — never store the email as the primary key (emails can change).

### Authorization with roles

`claims.roles` (e.g. `["member"]`, `["member","committee","exec"]`) comes straight from the token:

```ts
// Committee-only feature:
if (!claims.roles.includes("committee")) return res.status(403).end();
```

`committee` / `exec` / `team` are derived from the [committee roster](#committee-roster) (Notion,
synced hourly) — you never manage membership per-app. `member` is the baseline for any signed-in
user; `admin` is an infra allowlist. Changes appear on each user's next token.

### Token lifetime & sign-out

- Access tokens live **15 minutes**. When a call 401s on an expired token, re-fetch a fresh
  one from `/api/auth/token` (the session cookie lasts much longer) and retry.
- Sign out with `POST https://auth.monashcoding.com/api/auth/sign-out` (`credentials: "include"`).
  This clears the shared session across all MAC apps.

### Endpoint reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/sign-in/social` | POST | Start Google/Microsoft login → returns `{ url }` |
| `/api/auth/token` | GET | Mint a JWT for the current session → `{ token }` |
| `/api/auth/get-session` | GET | Inspect the current session |
| `/api/auth/sign-out` | POST | End the session |
| `/api/auth/jwks` | GET | Public keys (verify.ts uses this; you don't call it directly) |

---

## Restore from backup

Backups are written to `./backups/<db>-<timestamp>.sql.gz` (inside the Dokploy compose
working directory on the server) on boot and nightly, keeping the last `BACKUP_KEEP_DAYS`
(default 14). Each file is a plain-SQL `pg_dump`, gzipped.

To restore into the running stack (this **replaces** current data for those tables):

```bash
gunzip -c backups/mac_auth-YYYYMMDD-HHMMSS.sql.gz \
  | docker exec -i <postgres-container> psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

For a clean restore into an empty database, stop the `auth` container, drop/recreate the
database, then pipe the dump in as above.

---

## Local development

```bash
cd auth
npm install
# Point DATABASE_URL at any local Postgres 16, then:
npm run db:generate     # drizzle-kit generate (regenerate SQL after schema changes)
npm run db:migrate      # apply migrations
npm run dev             # tsx watch on :3000
```

Regenerate the Better Auth schema after changing `auth.ts` (the CLI is the source of truth
for what the installed Better Auth version expects), then reconcile `src/schema.ts`:

```bash
npx @better-auth/cli generate
```

Migrations under `auth/drizzle/` are **committed** (not regenerated at build) so their
timestamps stay stable — otherwise a rebuild makes the drizzle migrator re-run
already-applied migrations against the live DB and crash. After changing `schema.ts`, run
`npm run db:generate` and **commit** the new migration. (`auth/dist/` stays gitignored.)

### Linting & CI

Code quality is enforced by [Biome](https://biomejs.dev) (lint + format) and GitHub Actions.
Run the same checks CI runs before you push:

```bash
cd auth
npm run lint       # biome check (formatting + lint)
npm run lint:fix   # auto-fix formatting / imports / safe lint issues
npm run typecheck  # tsc --noEmit
npm run ci         # lint + typecheck together (what the CI gate runs)
```

Every push and PR to `main` runs `.github/workflows/ci.yml`: **lint → typecheck → build →
docker build**. Since Dokploy auto-deploys from `main`, a red CI is your signal that the
deploy would ship broken — fix it before merging. `noExplicitAny` at the Notion API
boundary is intentionally a non-blocking warning. Dependabot opens weekly dependency PRs;
CI verifies each one still builds before you merge.

---

## Handover checklist

For a new committee member inheriting this service:

- [ ] Access to the Oracle Cloud tenancy and the VM (SSH key added).
- [ ] Access to the committee password manager (`projects@monashcoding.com`) — this holds the
      **Dokploy admin login**, `BETTER_AUTH_SECRET`, Postgres password, and both OAuth secrets.
- [ ] Can reach the Dokploy dashboard (SSH tunnel to `localhost:3000`, see `DEPLOY-dokploy.md`).
- [ ] DNS control for `monashcoding.com` (to keep `auth.` pointed at the VM).
- [ ] Owner/editor on the **Google Cloud** OAuth client and the **Microsoft Entra** app
      registration; confirm the redirect URIs above are still registered.
- [ ] Verify the stack: `curl .../health`, `curl .../api/auth/jwks`.
- [ ] Verify backups are being written and test a restore.
- [ ] Know how to redeploy: push to `main`, then Deploy in Dokploy.

**Do not** put any secret in this repo. Rotate `BETTER_AUTH_SECRET` and OAuth secrets when
a committee member with access graduates.

---

## What's intentionally NOT here (yet)

- No email/password auth, email sending, or verification/reset flows.
- No user data migration from MonMap (a separate, later deliverable).
- No OIDC Provider plugin (the JWT plugin is sufficient).
- Eventual direction is to manage this box via **Dokploy Cloud** (shared MAC org) rather than
  the self-hosted panel — a later, deliberate migration.
