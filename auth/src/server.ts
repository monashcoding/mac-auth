/**
 * Express server exposing the Better Auth handler.
 *
 * IMPORTANT: the Better Auth handler is mounted on /api/auth/* BEFORE any JSON body
 * parser — Better Auth needs the raw request body. Only routes declared after it use
 * express.json().
 */
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

// Behind a TLS-terminating reverse proxy (Traefik): trust the proxy so secure cookies
// and the correct protocol/host are honoured.
app.set("trust proxy", 1);

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
