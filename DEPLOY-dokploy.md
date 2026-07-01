# Deploying auth on the shared Oracle box (Dokploy + Traefik)

The Oracle VM (`168.138.27.211`) is a **shared** MAC infrastructure host running
**Docker Swarm + Dokploy**. Dokploy's **Traefik** already owns ports **80/443** and
terminates TLS with Let's Encrypt. Other services (Twenty CRM, listmonk, discord bots,
a minecraft server, etc.) share it.

**Do NOT run Caddy or bind 80/443 yourself on this box** — that's what caused
`Bind for 0.0.0.0:80 failed: port is already allocated`. Auth must sit *behind* Traefik
like every other service. Use `docker-compose.dokploy.yml` (no Caddy, no host ports).

DNS is already correct: `auth.monashcoding.com` → `168.138.27.211` (direct A record), so
Traefik can issue a cert as soon as the router exists.

---

## First: clean up the failed attempt

The earlier `docker compose up` left a created-but-dead Caddy container and a
half-started stack. Remove it so it doesn't linger or retry port 80:

```bash
cd ~/mac-auth
docker compose down            # tears down mac-auth-{caddy,auth,postgres,backup}
docker ps -a | grep mac-auth   # confirm nothing named mac-auth-* remains
```

(This does **not** touch the Dokploy/Traefik/CRM containers — different project.)

---

## Deploy via the Dokploy dashboard (recommended)

1. Open the Dokploy dashboard (the same UI you used for the CRM).
2. **Create → Compose** service in the MAC project.
3. **Source:** this Git repo (`mac-auth`), branch `main`.
4. **Compose file path:** `docker-compose.dokploy.yml`.
5. **Environment:** paste the contents of your `.env` into Dokploy's Environment tab
   (Dokploy injects these — you don't commit `.env`). Make sure:
   - `BETTER_AUTH_URL=https://auth.monashcoding.com`
   - `TRUSTED_ORIGINS` lists the real app origins (not localhost).
6. **Domains tab → Add Domain:**
   - Host: `auth.monashcoding.com`
   - Service: `auth`
   - Container port: `3000`
   - HTTPS: **on**, certificate: **Let's Encrypt**
   Dokploy writes the Traefik labels and attaches the container to `dokploy-network`.
7. **Deploy.** Watch the build/deploy logs.

### Verify

```bash
# On the box:
docker ps | grep auth
curl -s https://auth.monashcoding.com/health        # -> {"status":"ok"}
curl -s https://auth.monashcoding.com/api/auth/jwks  # -> Ed25519 JWKS
```

If the cert isn't issued immediately, give Traefik a minute (ACME HTTP-01 on port 80),
then retry the HTTPS curl.

---

## After it's up

- **OAuth redirect URIs** are already registered for the production
  `https://auth.monashcoding.com/api/auth/callback/{google,microsoft}` URLs — good.
- **Twenty CRM** is unused and heavy (server + worker + postgres + redis). Once auth is
  confirmed healthy, consider decommissioning it in Dokploy to free RAM. Not required for
  auth to work.
