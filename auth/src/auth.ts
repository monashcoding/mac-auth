/**
 * Better Auth configuration for the MAC central auth service.
 *
 * - Passwordless: Google + Microsoft social sign-in only (no email/password).
 * - JWT plugin (EdDSA / Ed25519) mints short-lived tokens MAC apps verify locally
 *   against /api/auth/jwks. The plugin generates and stores the keypair itself.
 * - The JWT payload carries `macUserId` (== Better Auth user.id, the canonical id).
 *
 * Option shapes here were verified against the installed better-auth@1.6.x types
 * (jwt plugin `jwt.definePayload`/`expirationTime`, `socialProviders.microsoft.tenantId`,
 * `advanced.crossSubDomainCookies`/`defaultCookieAttributes`,
 * `user.additionalFields`, `databaseHooks`).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { db } from "./db.js";
import { claimsForEmail } from "./roster/lookup.js";
import { schema } from "./schema.js";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const isSecureAuthOrigin = baseURL.startsWith("https://");
const audience = process.env.JWT_AUDIENCE ?? "mac-suite";

// Any https app on a *.monashcoding.com subdomain is trusted by default. Better Auth
// supports wildcard patterns in trustedOrigins, so a new MAC app needs no auth-side
// change to start a flow (it still needs to be served on a monashcoding.com subdomain).
// TRUSTED_ORIGINS remains for anything off-domain (e.g. http://localhost:3000 in dev).
const MONASH_ORIGIN_WILDCARD = "https://*.monashcoding.com";

const trustedOrigins = [
  MONASH_ORIGIN_WILDCARD,
  ...(process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];

const MONASH_DOMAINS = ["monash.edu", "student.monash.edu"];

/** True when the email belongs to a Monash domain (used for later eligibility logic). */
function isMonashEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && MONASH_DOMAINS.includes(domain);
}

/** Safely parse the stored roles JSON string into an array; fall back to ["member"]. */
function parseRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through to default
    }
  }
  return ["member"];
}

/** Union two role lists, preserving order and dropping duplicates. */
function mergeRoles(base: string[], extra: string[]): string[] {
  const out = [...base];
  for (const r of extra) if (!out.includes(r)) out.push(r);
  return out;
}

/**
 * Build the roster-derived part of the claims (roster roles + team) for a login email.
 *
 * CRASH-SAFETY: this is the ONLY roster read on the token-mint path, and it must never
 * throw. The roster is derived from Postgres (never live Notion), so a Notion outage
 * doesn't reach here at all — but a DB hiccup or bad row could. On any failure we log and
 * fall back to no roster roles + null team, so members still get a valid token (with
 * their base roles) instead of being locked out.
 */
async function rosterClaims(email: string): Promise<{ roles: string[]; team: string | null }> {
  try {
    return await claimsForEmail(db, email);
  } catch (err) {
    console.error("[roster] claim derivation failed; minting with base roles:", err);
    return { roles: [], team: null };
  }
}

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),

  // Passwordless — no email/password, no email sending.
  emailAndPassword: {
    enabled: false,
  },

  socialProviders: {
    // `prompt: "select_account"` forces the provider's account chooser during the
    // OAuth handshake so people with several signed-in accounts (e.g. a personal
    // Gmail alongside their student one) consciously pick the right one, rather
    // than the provider silently auto-selecting the wrong account. This only
    // affects the OAuth step itself — it does NOT run when an existing MAC session
    // is reused, so signed-in users are not re-prompted or logged out.
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      prompt: "select_account",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
      // "common" so personal Microsoft accounts (Hotmail/Outlook/Live) work too.
      tenantId: "common",
      prompt: "select_account",
    },
  },

  account: {
    // When a user signs in with Google/Microsoft and a user row already exists with the
    // same (verified) email but no linked account, link them instead of erroring. Safe
    // because both providers return verified emails, and it's scoped to trustedProviders.
    // Needed so migrated password-only users (who have no carried-over credential) can get
    // back into their account via social sign-in on the same email.
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "microsoft"],
    },
  },

  user: {
    additionalFields: {
      // JSON array string. input:false => clients can't set it at signup.
      roles: {
        type: "string",
        input: false,
        required: false,
        defaultValue: '["member"]',
      },
      // Set by the create hook below from the verified email domain.
      isMonash: {
        type: "boolean",
        input: false,
        required: false,
        defaultValue: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Stamp isMonash from the email domain before the row is written.
        before: async (userData) => {
          return {
            data: {
              ...userData,
              isMonash: isMonashEmail(userData.email),
            },
          };
        },
      },
    },
  },

  advanced: {
    // Share the session cookie across *.monashcoding.com subdomains (cheap to set now).
    crossSubDomainCookies: {
      enabled: true,
      domain: ".monashcoding.com",
    },

    // Local MAC apps start OAuth and fetch their resulting session/token from this
    // production auth origin. Those are cross-site credentialed requests, so Better
    // Auth's SameSite=Lax default prevents both the short-lived signed state cookie and
    // the resulting session cookie from being stored/sent. SameSite=None requires Secure
    // on the deployed HTTPS origin; retain Lax/non-Secure for a plain-HTTP local auth server.
    // HttpOnly keeps the cookies inaccessible to application JavaScript. Better Auth's CSRF
    // and trusted-origin checks remain enabled and CORS only reflects allowed origins.
    defaultCookieAttributes: {
      httpOnly: true,
      secure: isSecureAuthOrigin,
      sameSite: isSecureAuthOrigin ? "none" : "lax",
    },
  },

  plugins: [
    jwt({
      jwks: {
        // Ed25519 is the plugin default; set explicitly to lock the contract.
        keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
      },
      jwt: {
        issuer: baseURL,
        audience,
        expirationTime: "15m",
        definePayload: async ({ user }) => {
          // Base roles from the stored user row (defaults to ["member"]), merged with the
          // roster-derived roles (committee/exec/admin). `team` = first functional team.
          const base = parseRoles((user as Record<string, unknown>).roles);
          const { roles: derived, team } = await rosterClaims(user.email);
          return {
            macUserId: user.id,
            email: user.email,
            // Display name from the OAuth profile (Google/Microsoft). Always present, so
            // apps can show a real name instead of falling back to the email.
            name: user.name,
            roles: mergeRoles(base, derived),
            team,
            ver: 1,
          };
        },
        // sub == macUserId (this is also the default, set explicitly for clarity).
        getSubject: ({ user }) => user.id,
      },
    }),
  ],
});

export type Auth = typeof auth;
