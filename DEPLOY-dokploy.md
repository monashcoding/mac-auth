# Deploying the auth service (Dokploy + Traefik)

Production runs on the shared MAC Oracle VM (`168.138.27.211`) under **self-hosted Dokploy**
(Docker Swarm). Dokploy's **Traefik** owns ports **80/443** and terminates TLS via Let's
Encrypt. The auth service runs *behind* Traefik as a Dokploy **Compose** service — it does
**not** run its own reverse proxy and does **not** bind host ports.

- Deploy file: **`docker-compose.dokploy.yml`** (no Caddy, no published ports, joins the
  external `dokploy-network` so Traefik can reach it).
- Live URL: `https://auth.monashcoding.com` (direct A record → the VM; Traefik issues the cert).

> Do **not** deploy the service with a bundled Caddy or by binding 80/443 yourself on this
> box — Traefik already owns those ports (`Bind for 0.0.0.0:80 failed: port is already
> allocated`).

---

## 1. Access the Dokploy dashboard

The dashboard isn't publicly exposed; reach it over an SSH tunnel from your machine:

```bash
ssh -i <your-key> -L 3000:localhost:3000 ubuntu@168.138.27.211
# then open http://localhost:3000
```

Login: `projects@monashcoding.com` (password in the committee password manager). If it's lost:
```bash
docker exec -it "$(docker ps -qf name=dokploy.1)" bash -c "pnpm run reset-password"
```

## 2. Create / configure the Compose service

- **Create → Compose** in the MAC project.
- **Source: Git** (a plain Git deploy key — *not* the GitHub App; the App flow fails because
  the dashboard is on `localhost` and GitHub can't reach the webhook).
  - Repository: `git@github.com:monashcoding/mac-auth.git`, branch `main`.
  - Create an **SSH Key** in Dokploy, add its public key to the repo under
    **GitHub → Settings → Deploy keys** (read-only), then select it as the service's SSH key.
- **Compose Path:** `docker-compose.dokploy.yml`  ← must be set; the default `docker-compose.yml`
  no longer exists.
- **Environment tab:** paste the full `.env` (Dokploy injects these; `.env` is never committed).
  The compose only references `${...}`, so an empty Environment tab means empty values — e.g. a
  blank `POSTGRES_PASSWORD` makes Postgres refuse to start. Verify:
  - `BETTER_AUTH_URL=https://auth.monashcoding.com`
  - `TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3001` if both local app ports
    are in use. Origins are exact, so only add `127.0.0.1` variants if developers actually
    browse to those addresses.
  - `POSTGRES_PASSWORD` is **URL/shell-safe** (letters+digits only — no `$ @ : / #`).
  - No value is truncated when pasted (watch long ones like `GOOGLE_CLIENT_ID`, which must end
    in `.apps.googleusercontent.com`).

## 3. Add the domain

**Domains tab → Add Domain:** host `auth.monashcoding.com`, service `auth`, container port
`3000`, HTTPS **on**, certificate **Let's Encrypt**. Dokploy writes the Traefik router labels.

## 4. Deploy

Hit **Deploy** and watch the logs for:
```
[migrate] done.
[auth] listening on :3000
```

---

## Verify

From any machine:
```bash
curl -s https://auth.monashcoding.com/health          # -> {"status":"ok"}
curl -s https://auth.monashcoding.com/api/auth/jwks    # -> Ed25519 JWKS

# Full OAuth check (social sign-in is POST, not a GET link):
curl -s -X POST https://auth.monashcoding.com/api/auth/sign-in/social \
  -H "Content-Type: application/json" \
  -d '{"provider":"google","callbackURL":"https://auth.monashcoding.com/"}'
# -> {"url":"https://accounts.google.com/...","redirect":true}
```
Paste that returned `url` into a browser to walk the real Google consent → callback flow.

### Verify localhost OAuth after this cookie-policy change

The auth service deliberately issues Better Auth cookies with `HttpOnly; Secure;
SameSite=None`. This is required because local MAC apps create the OAuth state cookie and
later use the session through credentialed cross-site requests to the production auth
origin. Better Auth's CSRF and trusted-origin validation remain enabled; do not replace the
explicit `TRUSTED_ORIGINS` allowlist with `*`.

After deploying:

1. Confirm the Dokploy Environment tab contains every **actual** local origin, comma-separated
   (normally `http://localhost:3000,http://localhost:3001`), then redeploy after any change.
2. Use a Chrome Guest profile (or clear cookies for `auth.monashcoding.com`), open the local
   app, enable **Preserve log** in DevTools Network, and start Google sign-in once.
3. Inspect `POST /api/auth/sign-in/social`. It must return the exact requesting origin in
   `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and a redacted
   state cookie equivalent to:
   `__Secure-better-auth.state=<value>; Domain=.monashcoding.com; Path=/; HttpOnly; Secure; SameSite=None`.
4. Confirm that cookie is stored under `https://auth.monashcoding.com` before leaving for
   Google, then confirm the callback succeeds without `state_mismatch` and returns to the
   allowlisted local callback URL.
5. Repeat from both local ports that the apps actually use, then smoke-test the production
   MAC Study and Job Board origins.

`SameSite=None` cannot override a browser setting that blocks third-party cookies entirely.
If DevTools says the cookie was blocked for that reason, the durable next step is a small
allowlisted page on `auth.monashcoding.com` that starts OAuth while the auth domain is the
top-level site. Do not work around that policy by disabling Better Auth's state-cookie,
CSRF, or origin checks.

---

## Troubleshooting: 404 / hanging requests

If `https://auth.monashcoding.com` returns nothing or hangs while the container is healthy,
Traefik almost certainly isn't on the overlay network with the auth container. Check:

```bash
docker inspect dokploy-traefik --format '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}'
```
If `dokploy-network` is missing (only `bridge`), reconnect it:
```bash
docker network connect dokploy-network dokploy-traefik
```
This attachment **persists across reboots**, so it's a one-time fix (Traefik had simply never
been joined to the overlay). No systemd/boot workaround is required.

Redeploys recreate the auth container with a new overlay IP; Traefik follows it automatically
as long as it's attached to `dokploy-network`.

---

## Notes

- OAuth redirect URIs are already registered on Google and Microsoft for
  `https://auth.monashcoding.com/api/auth/callback/{google,microsoft}`.
- Secrets (Dokploy login, Postgres password, OAuth secrets, `BETTER_AUTH_SECRET`) live in the
  committee password manager under `projects@monashcoding.com` — never in git.
