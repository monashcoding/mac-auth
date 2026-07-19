import assert from "node:assert/strict";
import { after, test } from "node:test";

// auth.ts constructs the Drizzle adapter at import time. postgres.js connects lazily, so
// this non-routable URL is sufficient for inspecting the generated cookie policy without
// querying a database or making any network request.
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
process.env.BETTER_AUTH_URL = "https://auth.monashcoding.com";
process.env.BETTER_AUTH_SECRET = "test-only-secret-that-is-at-least-32-characters";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.MICROSOFT_CLIENT_ID = "test-microsoft-client-id";
process.env.MICROSOFT_CLIENT_SECRET = "test-microsoft-client-secret";

const [{ auth }, { client }] = await Promise.all([import("./auth.js"), import("./db.js")]);

after(async () => {
  await client.end({ timeout: 0 });
});

test("OAuth state and session cookies support credentialed localhost requests", async () => {
  const context = await auth.$context;
  const stateCookie = context.createAuthCookie("state", { maxAge: 300 });
  const sessionCookie = context.authCookies.sessionToken;

  for (const cookie of [stateCookie, sessionCookie]) {
    assert.equal(cookie.attributes.httpOnly, true);
    assert.equal(cookie.attributes.secure, true);
    assert.equal(cookie.attributes.sameSite, "none");
    assert.equal(cookie.attributes.domain, ".monashcoding.com");
    assert.equal(cookie.attributes.path, "/");
  }

  assert.equal(stateCookie.name, "__Secure-better-auth.state");
  assert.equal(stateCookie.attributes.maxAge, 300);
});
