/**
 * MAC token verifier — copy this into any MAC app that needs to authenticate users.
 *
 * It verifies a Better Auth JWT locally against the auth service's JWKS. The JWKS is
 * fetched once and cached by `createRemoteJWKSet` (with its own background refresh),
 * so verifying a token does NOT call the auth service per request.
 *
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
  /** Functional team (e.g. "Events"), or null if the person isn't on the committee roster. */
  team: string | null;
  ver: number;
}

/**
 * Verify a MAC-issued JWT. Throws if the signature, issuer, audience, or expiry
 * (`exp`) is invalid. Returns the typed MAC claims on success.
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

// Allow quick manual testing:  node --experimental-strip-types verify.ts <token>
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const token = process.argv[2];
  if (!token) {
    console.error("usage: verify.ts <jwt>");
    process.exit(1);
  }
  verifyMacToken(token)
    .then((claims) => {
      console.log("VALID:", claims);
    })
    .catch((err) => {
      console.error("INVALID:", err.message);
      process.exit(1);
    });
}
