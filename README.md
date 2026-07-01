# MAC Suite — Central Auth Service

The single identity provider that MAC's apps trust. Users sign in with **Google** or
**Microsoft** (passwordless), and this service mints short-lived, asymmetrically-signed
JWTs (**EdDSA / Ed25519**) that MAC apps verify **locally** against a published JWKS —
no app calls this service per request.

- **Domain:** `https://auth.monashcoding.com`
- **Stack:** Node 22 · TypeScript (ESM) · Express · Better Auth `^1.6.9` · Drizzle ORM · Postgres 16 · Caddy
- **Deploy target:** Oracle Cloud ARM VM, via a single `docker compose up -d`

---

## Architecture

Four Docker Compose services:

| Service    | Image                | Role |
|------------|----------------------|------|
| `caddy`    | `caddy:2-alpine`     | Reverse proxy + automatic Let's Encrypt HTTPS for `auth.monashcoding.com` |
| `auth`     | built from `./auth`  | This service (Better Auth on Express). Runs DB migrations on boot, then starts |
| `postgres` | `postgres:16`        | Self-hosted identity store (`user`/`session`/`account`/`verification`/`jwks`) |
| `backup`   | `postgres:16`        | Nightly `pg_dump` with rotation into `./backups` (no host cron, no third-party image) |

The JWT plugin generates and stores its Ed25519 signing keypair itself in the `jwks`
table on first boot — **there are no manual `openssl` steps**. Public keys are served at
`/api/auth/jwks`.

**Canonical identity:** the JWT carries `macUserId`, which is the Better Auth `user.id`.
Keep this as the canonical user identifier across all MAC apps (a later migration will
preserve MonMap's existing `user.id` values as these IDs).

---

## One-command run

Prerequisites: Docker + Docker Compose on the host, DNS + ports in place (see below), and
a filled `.env`.

```bash
cp .env.example .env      # then fill in the blanks (see "Environment" below)
docker compose up -d      # brings up all four services
```

Check it's healthy:

```bash
curl https://auth.monashcoding.com/health          # -> {"status":"ok"}
curl https://auth.monashcoding.com/api/auth/jwks    # -> JWKS with an Ed25519 key

# Local (no TLS/Caddy):
curl http://localhost:3000/health
```

Start a sign-in from a browser:

```
https://auth.monashcoding.com/api/auth/sign-in/social?provider=google
https://auth.monashcoding.com/api/auth/sign-in/social?provider=microsoft
```

---

## DNS / ports prerequisite

Before `docker compose up -d` can obtain certificates:

1. **DNS:** point an `A` (and/or `AAAA`) record for `auth.monashcoding.com` at the Oracle
   VM's public IP.
2. **Ports:** open inbound **80** and **443** (TCP, and 443/UDP for HTTP/3) on both the
   Oracle Cloud **security list / NSG** and the VM's host firewall (e.g. `iptables`/`ufw`).
   Port 80 is required for the ACME HTTP challenge; 443 serves traffic.

Caddy will not get a certificate until DNS resolves to this host and port 80 is reachable
from the internet.

---

## Environment

Copy `.env.example` to `.env` and fill it in. **Never commit `.env`** — secrets live in the
committee password manager under `projects@monashcoding.com`.

| Variable | Notes |
|----------|-------|
| `BETTER_AUTH_URL` | Public base URL, e.g. `https://auth.monashcoding.com`. Used as the JWT `iss`. |
| `BETTER_AUTH_SECRET` | Long random secret. Generate with `openssl rand -base64 32`. |
| `ACME_EMAIL` | Email for Let's Encrypt expiry notices. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Self-hosted Postgres credentials. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client. |
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

After a user has a session (via the sign-in redirect above), the app's backend can mint a
JWT with the session cookie:

```
GET https://auth.monashcoding.com/api/auth/token
Cookie: <better-auth session cookie>
-> { "token": "<jwt>" }
```

The session cookie is scoped to `.monashcoding.com`, so it is shared across MAC app
subdomains.

---

## Restore from backup

Backups are written to `./backups/<db>-<timestamp>.sql.gz` on boot and nightly, keeping
the last `BACKUP_KEEP_DAYS` (default 14). Each file is a plain-SQL `pg_dump`, gzipped.

To restore into a running stack:

```bash
# Pick the dump you want:
ls -la backups/

# Restore it into the postgres service (this REPLACES current data for those tables):
gunzip -c backups/mac_auth-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

For a clean restore into an empty database, drop and recreate the database first (stop the
`auth` service, `dropdb`/`createdb`, then pipe the dump in as above).

---

## Local development

```bash
cd auth
npm install
# Point DATABASE_URL at any Postgres 16, then:
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

- [ ] Access to the Oracle Cloud tenancy and the auth VM (SSH key added).
- [ ] Access to the committee password manager (`projects@monashcoding.com`) — this holds
      `BETTER_AUTH_SECRET`, Postgres password, and both OAuth client secrets.
- [ ] DNS control for `monashcoding.com` (to keep `auth.` pointed at the VM).
- [ ] Owner/editor on the **Google Cloud** OAuth client and the **Microsoft Entra** app
      registration.
- [ ] Confirm the redirect URIs above are still registered on both providers.
- [ ] Confirm ports 80/443 are open on the Oracle security list and the VM firewall.
- [ ] Verify the stack: `docker compose ps`, `curl .../health`, `curl .../api/auth/jwks`.
- [ ] Verify backups are being written: `ls -la backups/` and test a restore in staging.
- [ ] Know how to redeploy: `git pull && docker compose up -d --build`.

**Do not** put any secret in this repo. Rotate `BETTER_AUTH_SECRET` and OAuth secrets when
a committee member with access graduates.

---

## What's intentionally NOT here (yet)

- No email/password auth, email sending, or verification/reset flows.
- No user data migration from MonMap (a separate, later deliverable).
- No OIDC Provider plugin (the JWT plugin is sufficient).
