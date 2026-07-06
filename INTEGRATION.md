# Add MAC Login to Your App

This guide lets **any** MAC app use the central auth service for sign-in. Copy it into your
repo and follow it top to bottom — no prior knowledge of the auth service is needed.

Your app stores **no passwords and no user accounts**. Users sign in with Google or
Microsoft on the central service, which hands your app a short-lived signed token (JWT).
Your backend verifies that token **locally** (no network call per request) and keys its own
data by the user's stable `macUserId`.

- **Auth service:** `https://auth.monashcoding.com`
- **You need:** a backend that can read an `Authorization` header, and `npm i jose`.

---

## How it works (30-second version)

```
 User ─sign in─▶ auth.monashcoding.com ─Google/Microsoft─▶ session cookie (.monashcoding.com)
                                                                    │
 Your app ◀─ JWT { macUserId, email, roles, team } ◀─ GET /api/auth/token ◀┘
    └─ verifies the JWT locally (jose + published JWKS) — no call back to auth per request
    └─ stores/loads its data keyed by macUserId
```

- The token is signed with **EdDSA (Ed25519)**. Your app verifies it against the public keys
  at `https://auth.monashcoding.com/api/auth/jwks` (fetched once and cached).
- Tokens live **15 minutes**. The browser's session cookie lasts much longer, so you just
  re-fetch a fresh token when one expires.
- The session cookie is scoped to `.monashcoding.com`, so a user signed into one MAC app is
  already signed into yours (single sign-on) — **if** your app is on a `monashcoding.com`
  subdomain.

---

## Prerequisites

1. **Serve your app on a `*.monashcoding.com` subdomain** (e.g. `jobs.monashcoding.com`).
   - This gives you automatic single sign-on across MAC apps.
   - Every https `*.monashcoding.com` origin is **trusted by the auth service automatically** —
     there is nothing to register and no one to ask. You can integrate today.
   - Off-domain origins (including local dev on `http://localhost:3000`) are *not* trusted by
     default. For local development, ask whoever runs the auth service to add your dev origin
     to its `TRUSTED_ORIGINS` env var, or test against a deployed `*.monashcoding.com` preview.

2. **Install the one dependency** in your backend:
   ```bash
   npm i jose
   ```

That's it — no client IDs, no secrets, no redirect URIs to register on your side. The auth
service owns the Google/Microsoft OAuth apps.

---

## The token contract

Every token your app receives carries exactly these claims:

```json
{
  "macUserId": "<stable per-person id>",
  "email": "<user email>",
  "roles": ["member", "committee", "exec"],
  "team": "Events",
  "ver": 1,
  "iss": "https://auth.monashcoding.com",
  "aud": "mac-suite",
  "exp": 1234567890
}
```

- **`macUserId`** — the canonical, stable identifier for a person. Use it as the foreign key
  in your own tables. **Never key data by email** (emails change).
- **`roles`** — a string array. `member` is the baseline for anyone signed in. `committee` is
  added for anyone on the central committee roster (curated in Notion), `exec` for execs, and
  `admin` for infra superusers (env allowlist, **not** from Notion). Gate committee-only
  features on `roles.includes("committee")`.
- **`team`** — the person's functional team (e.g. `"Events"`), or `null` if they aren't on the
  committee roster. Informational — it tells you *where they sit*, not what they can do.
- `iss` is always `https://auth.monashcoding.com`, `aud` is always `mac-suite`. Your verifier
  checks both.

---

## Step 1 — Verifier (backend, copy-paste)

Save this as `verify.ts` (or `.js` with types stripped) in your backend. It fetches and caches
the public keys and validates every token's signature, issuer, audience, and expiry. Its only
dependency is `jose`.

```ts
/**
 * MAC token verifier. Verifies a Better Auth JWT locally against the auth service's JWKS.
 * The JWKS is fetched once and cached, so verifying a token does NOT call auth per request.
 * Only dependency: `jose`  ->  npm i jose
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_URL = process.env.AUTH_URL ?? "https://auth.monashcoding.com";
const ISSUER = AUTH_URL;
const AUDIENCE = process.env.JWT_AUDIENCE ?? "mac-suite";

// Cached remote JWKS (Ed25519 public keys). Reused across calls — do NOT recreate per request.
const JWKS = createRemoteJWKSet(new URL(`${AUTH_URL}/api/auth/jwks`));

/** The claims a verified MAC token is guaranteed to carry. */
export interface MacClaims {
  macUserId: string;
  email: string;
  roles: string[];
  team: string | null;
  ver: number;
}

/**
 * Verify a MAC-issued JWT. Throws if the signature, issuer, audience, or expiry (`exp`)
 * is invalid. Returns the typed MAC claims on success.
 */
export async function verifyMacToken(token: string): Promise<MacClaims> {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISSUER, // checks `iss`
    audience: AUDIENCE, // checks `aud`
    // `exp` is enforced by jwtVerify automatically.
  });

  return {
    macUserId: payload.macUserId as string,
    email: payload.email as string,
    roles: (payload.roles as string[]) ?? [],
    team: (payload.team as string | null) ?? null,
    ver: (payload.ver as number) ?? 1,
  };
}
```

Set `AUTH_URL=https://auth.monashcoding.com` in your backend env (the file defaults to it, so
this is optional in production).

---

## Step 2 — Start sign-in (frontend)

Social sign-in is a **POST** that returns a URL to redirect the user to. It is **not** a plain
link.

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

After the user returns, their browser holds a session cookie for `.monashcoding.com`.

---

## Step 3 — Get a token (frontend)

```js
const { token } = await fetch("https://auth.monashcoding.com/api/auth/token", {
  credentials: "include",                    // sends the shared cookie
}).then(r => r.json());

// attach it to calls to YOUR backend:
await fetch("/api/whatever", { headers: { Authorization: `Bearer ${token}` } });
```

If `/api/auth/token` returns **401**, the user isn't signed in — send them through Step 2.

---

## Step 4 — Verify on your backend (per request)

```ts
import { verifyMacToken } from "./verify";

const token = req.headers.authorization?.replace("Bearer ", "");
try {
  const claims = await verifyMacToken(token);   // { macUserId, email, roles, team, ver }
  // ... proceed as this user
} catch {
  return res.status(401).end();                 // invalid or expired token
}
```

This is a local cryptographic check — no network call to the auth service.

---

## Step 5 — Key your data by `macUserId`

```ts
// good — stable identity
await db.notes.create({ userId: claims.macUserId, body });

// bad — emails change
// await db.notes.create({ userEmail: claims.email, body });
```

---

## Authorization with roles

```ts
// Committee-only feature:
if (!claims.roles.includes("committee")) return res.status(403).end();

// Team-scoped view (informational):
if (claims.team === "Events") { /* ... */ }
```

`committee`, `exec`, and `team` are **derived** from the central committee roster (curated in
Notion, synced hourly into the auth DB) — you never manage membership per-app. Removing someone
from the roster revokes `committee`/`exec` in their next token everywhere. `admin` is a separate
infra allowlist. Changes appear in a user's next token (within 15 minutes, or immediately after
they re-fetch one).

---

## Token expiry & sign-out

- **Expiry:** tokens last 15 minutes. When a call to your backend 401s because the token
  expired, re-fetch a fresh one from `/api/auth/token` (the cookie is still valid) and retry.
  A small wrapper that fetches-on-401 keeps this invisible to users.
- **Sign out:**
  ```js
  await fetch("https://auth.monashcoding.com/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
  ```
  This clears the shared session across **all** MAC apps.

---

## Endpoint reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/sign-in/social` | POST | Start Google/Microsoft login → returns `{ url }` |
| `/api/auth/token` | GET | Mint a JWT for the current session → `{ token }` |
| `/api/auth/get-session` | GET | Inspect the current session |
| `/api/auth/sign-out` | POST | End the session (all MAC apps) |
| `/api/auth/jwks` | GET | Public keys — your verifier fetches this; you don't call it directly |

All are served from `https://auth.monashcoding.com`.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Sign-in POST is rejected / CORS error | Your app isn't on an https `*.monashcoding.com` origin, and the origin isn't in the auth service's `TRUSTED_ORIGINS`. Deploy to a subdomain, or get your dev origin whitelisted. |
| `/api/auth/token` returns 401 | The user has no session — run the Step 2 sign-in flow first. |
| Cookie not sent / no SSO | You forgot `credentials: "include"` on the fetch, or your app is on a non-`monashcoding.com` domain (the cookie is scoped to `.monashcoding.com`). |
| `verifyMacToken` throws "exp" / expired | Normal after 15 min — re-fetch a token and retry. |
| `verifyMacToken` throws on `aud`/`iss` | Your `AUTH_URL` / `JWT_AUDIENCE` don't match the service (`https://auth.monashcoding.com`, `mac-suite`). |

---

## Checklist

- [ ] App served on a `*.monashcoding.com` subdomain (auto-trusted).
- [ ] `npm i jose`; `verify.ts` copied into the backend.
- [ ] Frontend: POST sign-in → redirect → GET `/api/auth/token` → send `Bearer` to your API.
- [ ] Backend: `verifyMacToken` on every protected request.
- [ ] Data keyed by `claims.macUserId`, not email.
- [ ] (Local dev only) dev origin added to the auth service's `TRUSTED_ORIGINS`.
