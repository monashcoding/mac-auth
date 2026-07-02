#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-off account migration: MonMap  ->  central MAC auth service.
#
# RAN ONCE on 2026-07-02 on the Oracle box. Kept here as a record of exactly how
# MonMap's 405 accounts were imported — NOT part of any automated deploy.
#
# What it does: copies MonMap's Better Auth `user` + `account` rows into the
# central auth DB, preserving IDs (so macUserId == MonMap's old user.id, keeping
# MonMap's user_plan/user_grade data valid). MonMap's live DB uses snake_case
# columns; the central DB uses Better Auth's camelCase — so this maps them.
#
# Source: host-installed Postgres 16, database `monmap` (accessed via `sudo -u postgres`).
# Target: the central auth Postgres container (mac_auth DB).
#
# Idempotent (ON CONFLICT DO NOTHING) and backs up the central DB first.
# Result of the real run: users 0 -> 405, accounts 405, isMonash 317, 0 orphans.
# ---------------------------------------------------------------------------
set -euo pipefail

CENTRAL=$(docker ps --format '{{.Names}}' | grep -E 'macauth-auth.*-postgres-1' | head -1)
[ -n "$CENTRAL" ] || { echo "central postgres container not found"; exit 1; }
echo "central container: $CENTRAL"
cpsql() { docker exec -i "$CENTRAL" psql -U mac_auth -d mac_auth -v ON_ERROR_STOP=1 "$@"; }

echo "== 0. Backup central DB =="
BK=~/central_backup_pre_monmap_$(date +%Y%m%d-%H%M%S).sql
docker exec "$CENTRAL" pg_dump -U mac_auth -d mac_auth > "$BK"
echo "backup -> $BK ($(wc -l < "$BK") lines)"

echo "== 1. Counts BEFORE =="
echo "  users=$(cpsql -Atqc 'select count(*) from "user"') accounts=$(cpsql -Atqc 'select count(*) from account')"

echo "== 2. Staging schema =="
cpsql <<'SQL'
drop schema if exists import_monmap cascade;
create schema import_monmap;
create table import_monmap.u (id text, name text, email text, email_verified boolean,
  image text, created_at timestamp, updated_at timestamp);
create table import_monmap.a (id text, account_id text, provider_id text, user_id text,
  access_token text, refresh_token text, id_token text, access_token_expires_at timestamp,
  refresh_token_expires_at timestamp, scope text, password text,
  created_at timestamp, updated_at timestamp);
SQL

echo "== 3. Load MonMap -> staging =="
sudo -u postgres pg_dump -d monmap -t '"user"' -t account --data-only --column-inserts --no-owner \
  | sed -E 's/^INSERT INTO (public\.)?"user"/INSERT INTO import_monmap.u/; s/^INSERT INTO (public\.)?account/INSERT INTO import_monmap.a/' \
  | docker exec -i "$CENTRAL" psql -U mac_auth -d mac_auth -v ON_ERROR_STOP=1 >/dev/null
echo "  staged users=$(cpsql -Atqc 'select count(*) from import_monmap.u') accounts=$(cpsql -Atqc 'select count(*) from import_monmap.a')"

echo "== 4. Migrate staging -> real (mapped, ON CONFLICT DO NOTHING) =="
cpsql <<'SQL'
insert into "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt","isMonash",roles)
select id,name,email,email_verified,image,created_at,updated_at,
       (lower(split_part(email,'@',2)) in ('monash.edu','student.monash.edu')), '["member"]'
from import_monmap.u on conflict do nothing;

insert into account (id,"accountId","providerId","userId","accessToken","refreshToken","idToken",
  "accessTokenExpiresAt","refreshTokenExpiresAt",scope,password,"createdAt","updatedAt")
select id,account_id,provider_id,user_id,access_token,refresh_token,id_token,
  access_token_expires_at,refresh_token_expires_at,scope,password,created_at,updated_at
from import_monmap.a on conflict do nothing;
SQL

echo "== 5. Counts AFTER =="
echo "  users=$(cpsql -Atqc 'select count(*) from "user"') accounts=$(cpsql -Atqc 'select count(*) from account') monash=$(cpsql -Atqc 'select count(*) from "user" where "isMonash"')"

echo "== 6. Drop staging =="
cpsql -c 'drop schema import_monmap cascade;' >/dev/null
echo "DONE. backup at $BK"
