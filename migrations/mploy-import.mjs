// ---------------------------------------------------------------------------
// mploy -> central auth migration (planner + artifact generator).
//
// mploy uses NextAuth on MongoDB (Atlas); central uses Better Auth on Postgres.
// One person == one macUserId, and MonMap's ids are already the canonical macUserIds,
// so we match each mploy user against central by Google `sub` first, then email:
//
//   - sub already in central      -> reuse that macUserId (they overlap with MonMap)
//   - email already in central    -> reuse that macUserId (+ link their Google account)
//   - neither                     -> new central user, reusing the mploy _id hex as macUserId
//
// This script CHANGES NOTHING. It reads mploy Mongo + two CSV exports of the current
// central data, and writes three artifacts:
//   central_insert.sql  - new user/account rows to load into the central Postgres
//   idmap.json          - { mploy _id hex : macUserId }  (drives the app-data remap)
//   mongo_remap.js      - mongosh script that rewrites userId (ObjectId -> String macUserId)
//                         in mploy's user-keyed collections. RUN ONLY DURING CUTOVER.
//
// Run (on a host that can reach Atlas), see migrations/README.md for the wrapper:
//   MPLOY_MONGO_URI=... MPLOY_DB=default node mploy-import.mjs
// Requires: central_users.csv (id,email) and central_google.csv (userId,sub) alongside.
// ---------------------------------------------------------------------------
import { MongoClient } from "mongodb";
import fs from "node:fs";

const MONGO_URI = process.env.MPLOY_MONGO_URI;
const DB = process.env.MPLOY_DB || "default";
if (!MONGO_URI) throw new Error("set MPLOY_MONGO_URI");

// --- load central lookup exports (produced by psql; see README) ---
const emailToId = new Map(); // email(lower) -> central user id
for (const line of read("central_users.csv")) {
  const [id, email] = line.split(",");
  if (email) emailToId.set(email.trim().toLowerCase(), id.trim());
}
const subToUserId = new Map(); // google sub -> central user id
for (const line of read("central_google.csv")) {
  const [userId, sub] = line.split(",");
  if (sub) subToUserId.set(sub.trim(), userId.trim());
}

function read(f) {
  return fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}
const esc = (s) => (s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'");
const MONASH = ["monash.edu", "student.monash.edu"];
const isMonash = (e) => !!e && MONASH.includes(e.split("@")[1]?.toLowerCase());

const mongo = new MongoClient(MONGO_URI);
await mongo.connect();
const d = mongo.db(DB);
const users = await d.collection("users").find({}).toArray();
const googleAccts = await d.collection("accounts").find({ provider: "google" }).toArray();
const acctByUser = new Map(googleAccts.map((a) => [a.userId.toString(), a]));

const sqlUsers = [];
const sqlAccounts = [];
const idmap = {};
const stats = { total: users.length, reuseBySub: 0, reuseByEmail: 0, created: 0, credentialOnly: 0, linkedGoogle: 0, skippedNoEmail: 0 };

function userRow(id, u, email) {
  const name = u.name || email || "MAC user";
  return `INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt","isMonash",roles) `
    + `VALUES (${esc(id)},${esc(name)},${esc(email)},true,${esc(u.image)},now(),now(),${isMonash(email) ? "true" : "false"},'["member"]') `
    + `ON CONFLICT DO NOTHING;`;
}
// Only the identity fields are migrated (accountId == Google sub). Stale OAuth tokens are
// intentionally dropped — Better Auth re-obtains them on next sign-in and only needs
// (providerId, accountId) to resolve the user.
function accountRow(userId, a) {
  return `INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") `
    + `VALUES (${esc("mploy_" + a._id.toString())},${esc(a.providerAccountId)},'google',${esc(userId)},now(),now()) `
    + `ON CONFLICT DO NOTHING;`;
}

for (const u of users) {
  const mid = u._id.toString();
  const email = (u.email || "").toLowerCase();
  const acct = acctByUser.get(mid);
  const sub = acct?.providerAccountId;

  let macId;
  if (sub && subToUserId.has(sub)) {
    macId = subToUserId.get(sub);
    stats.reuseBySub++;
  } else if (email && emailToId.has(email)) {
    macId = emailToId.get(email);
    stats.reuseByEmail++;
    if (sub && !subToUserId.has(sub)) { sqlAccounts.push(accountRow(macId, acct)); stats.linkedGoogle++; }
  } else if (!email) {
    stats.skippedNoEmail++;
    continue; // can't create a central user without an email (unique/not-null)
  } else {
    macId = mid; // brand-new person: reuse mploy _id hex as the macUserId
    stats.created++;
    sqlUsers.push(userRow(macId, u, email));
    if (sub) sqlAccounts.push(accountRow(macId, acct));
    else stats.credentialOnly++;
  }
  idmap[mid] = macId;
  if (email) emailToId.set(email, macId); // dedupe later mploy users on the same identity
  if (sub) subToUserId.set(sub, macId);
}

fs.writeFileSync("central_insert.sql", [...sqlUsers, ...sqlAccounts].join("\n") + "\n");
fs.writeFileSync("idmap.json", JSON.stringify(idmap));
fs.writeFileSync(
  "mongo_remap.js",
  `// RUN ONLY DURING CUTOVER (changes userId ObjectId -> String macUserId).\n`
  + `//   mongosh "<MPLOY_MONGO_URI>" mongo_remap.js\n`
  + `const idmap = ${JSON.stringify(idmap)};\n`
  + `const d = db.getSiblingDB(${JSON.stringify(DB)});\n`
  + `for (const c of ["applications","application_cycles","application_status_events"]) {\n`
  + `  let n = 0;\n`
  + `  for (const [mid, mac] of Object.entries(idmap)) {\n`
  + `    n += d[c].updateMany({ userId: ObjectId(mid) }, { $set: { userId: mac } }).modifiedCount;\n`
  + `  }\n`
  + `  print(c + ": remapped " + n);\n`
  + `}\n`,
);

console.log("=== mploy -> central migration plan (DRY RUN, nothing applied) ===");
console.log(stats);
console.log(`new user rows:    ${sqlUsers.length}`);
console.log(`new account rows: ${sqlAccounts.length}`);
console.log("wrote: central_insert.sql, idmap.json, mongo_remap.js");
await mongo.close();
