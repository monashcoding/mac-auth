# MAC Suite — Central Auth Service

The single identity provider that MAC's apps trust. Users sign in with **Google** or
**Microsoft** (passwordless), and this service mints short-lived, asymmetrically-signed
JWTs (**EdDSA / Ed25519**) that MAC apps verify **locally** against a published JWKS —
no app calls this service per request.

- **Domain:** `https://auth.monashcoding.com`
- **Stack:** Node 22 · TypeScript (ESM) · Express · Better Auth `^1.6.9` · Drizzle ORM · Postgres 16
- **Deploy:** self-hosted **Dokploy** on the shared MAC Oracle VM, behind Dokploy's **Traefik**
  (which terminates TLS via Let's Encrypt). See [`DEPLOY-dokploy.md`](DEPLOY-dokploy.md).

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
| `TRUSTED_ORIGINS` | Comma-separated app origins allowed to start auth flows. |
| `JWT_AUDIENCE` | JWT `aud` claim — `mac-suite`. |

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
  "roles": ["member"],
  "ver": 1,
  "iss": "https://auth.monashcoding.com",
  "aud": "mac-suite",
  "exp": 1234567890
}
```

- Algorithm: **EdDSA (Ed25519)**, signed with the key published at `/api/auth/jwks`.
- Access-token lifetime: **15 minutes**.
- `roles` is a parsed array (stored in the DB as a JSON string).
- `isMonash` is recorded on the `user` row (from `@monash.edu` / `@student.monash.edu`)
  for later eligibility logic — it is **not** in the token and does **not** gate signup.

### How apps verify a token

Copy [`examples/verify.ts`](examples/verify.ts) into the app (only dependency: `jose`).
It fetches and caches the JWKS with `createRemoteJWKSet` and checks `iss`, `aud`, and
`exp`, returning typed `{ macUserId, email, roles, ver }` claims. No per-request call to
this service.

---

## Getting a token in an app

Social sign-in is a **POST** endpoint (not a GET link). An app starts the flow via the
Better Auth client, or directly:

```bash
curl -s -X POST https://auth.monashcoding.com/api/auth/sign-in/social \
  -H "Content-Type: application/json" \
  -d '{"provider":"google","callbackURL":"https://yourapp.monashcoding.com/"}'
# -> { "url": "https://accounts.google.com/...", "redirect": true }
```

Redirect the user to that `url`. After they have a session, the app's backend can mint a JWT
with the session cookie:

```
GET https://auth.monashcoding.com/api/auth/token
Cookie: <better-auth session cookie>
-> { "token": "<jwt>" }
```

The session cookie is scoped to `.monashcoding.com`, so it is shared across MAC app
subdomains.

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

`auth/drizzle/` (generated SQL) and `auth/dist/` are gitignored; the Docker build
regenerates the migrations from `src/schema.ts`.

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
