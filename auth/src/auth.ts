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
 * `advanced.crossSubDomainCookies`, `user.additionalFields`, `databaseHooks`).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { db } from "./db.js";
import { schema } from "./schema.js";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const audience = process.env.JWT_AUDIENCE ?? "mac-suite";

const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

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
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
      // "common" so personal Microsoft accounts (Hotmail/Outlook/Live) work too.
      tenantId: "common",
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
        definePayload: ({ user }) => ({
          macUserId: user.id,
          email: user.email,
          roles: parseRoles((user as Record<string, unknown>).roles),
          ver: 1,
        }),
        // sub == macUserId (this is also the default, set explicitly for clarity).
        getSubject: ({ user }) => user.id,
      },
    }),
  ],
});

export type Auth = typeof auth;
