/**
 * Express server exposing the Better Auth handler.
 *
 * IMPORTANT: the Better Auth handler is mounted on /api/auth/* BEFORE any JSON body
 * parser — Better Auth needs the raw request body. Only routes declared after it use
 * express.json().
 */
import express from "express";
import cors from "cors";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { db } from "./db.js";
import { runRosterSync, scheduleRosterSync } from "./sync/index.js";

// Infra superusers (NOT from Notion). Used to gate the manual sync endpoint.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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

// Manual roster sync, gated to an infra admin (ADMIN_EMAILS). The scheduled hourly job
// covers normal operation; this is the "apply now" button for recruitment day. Every
// failure path returns JSON and leaves the server running — a Notion outage here just
// yields a 502, never a crash.
app.post("/api/admin/sync-roster", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const email = session?.user?.email?.toLowerCase();
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: "forbidden" });
    }
    const result = await runRosterSync(db);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[roster-sync] admin trigger failed:", err);
    return res
      .status(502)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(port, () => {
  console.log(`[auth] listening on :${port}`);
  // Wire the hourly roster sync. Only schedules a timer — never calls Notion at boot —
  // so a Notion outage can't affect startup or logins.
  scheduleRosterSync(db);
});
