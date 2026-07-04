/**
 * Express server exposing the Better Auth handler.
 *
 * IMPORTANT: the Better Auth handler is mounted on /api/auth/* BEFORE any JSON body
 * parser — Better Auth needs the raw request body. Only routes declared after it use
 * express.json().
 */
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

// Origins allowed to make credentialed cross-subdomain browser calls (same policy Better
// Auth trusts). MAC apps live on *.monashcoding.com, so their client-side signIn/useSession
// calls to this service are cross-origin and need CORS with credentials.
//
// Any https *.monashcoding.com origin is allowed by default; TRUSTED_ORIGINS adds any
// off-domain extras (e.g. http://localhost:3000 in dev). The `cors` array form does exact
// string matching, so the wildcard is enforced with a function instead.
const extraOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** True for https apps on any *.monashcoding.com subdomain, plus any explicit extras. */
function isAllowedOrigin(origin: string): boolean {
  if (extraOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      (url.hostname === "monashcoding.com" ||
        url.hostname.endsWith(".monashcoding.com"))
    );
  } catch {
    return false;
  }
}

// Behind a TLS-terminating reverse proxy (Traefik): trust the proxy so secure cookies
// and the correct protocol/host are honoured.
app.set("trust proxy", 1);

// CORS for cross-origin app calls. Reflects an allowed origin and sets
// Access-Control-Allow-Credentials so the shared session cookie is accepted. Requests
// with no Origin (server-to-server, health checks) pass through untouched.
app.use(
  cors({
    // Reflect the request origin only when allowed; requests with no Origin
    // (server-to-server, health checks) pass through with `cb(null, true)`.
    origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
    credentials: true,
  }),
);

// Health check — must not require the DB so Docker/uptime checks stay cheap.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Mount Better Auth on /api/auth/* BEFORE express.json (needs the raw body).
app.all("/api/auth/*", toNodeHandler(auth));

// JSON parser for any of our own routes declared after this point.
app.use(express.json());

app.listen(port, () => {
  console.log(`[auth] listening on :${port}`);
});
