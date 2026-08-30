# Deploying Northstar HQ

Northstar HQ is an internal application. It is not designed to be public, and
nothing in it should be reachable without a session.

**Do not deploy it anywhere public until you have completed the "Before you go
live" checklist at the bottom of this file.**

---

## 1. What you are deploying

```
                 ┌──────────────┐
   YouTube API ─▶│  Sync worker │──┐
   (read-only)   └──────────────┘  │
                                   ▼
   Google OAuth ─▶ encrypted   ┌──────────────┐
   (own channels)  tokens ────▶│   Database   │
                               └──────┬───────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              Web dashboard      PDF reports         Finance
```

The important property: **the dashboard reads the database, never the YouTube
API.** Syncing happens on a schedule, in the background. That is what keeps the
app fast and keeps it inside the 10,000 unit/day YouTube quota — a per-page-view
fetch model would exhaust that in an afternoon.

---

## 2. Prerequisites

| Requirement | Why |
|---|---|
| Node.js 20+ (22 LTS recommended) | The app uses `node:crypto` scrypt and AES-GCM |
| PostgreSQL 14+ | SQLite is for local development only — see §3 |
| A domain with HTTPS | Session cookies are `Secure` in production and will not be sent over plain HTTP |

---

## 3. Database

Local development uses SQLite. **Production must use PostgreSQL.** SQLite is a
single file with one writer; it cannot survive multiple app instances, and it
gives you no point-in-time recovery for financial records.

The Prisma schema is written against the intersection of both connectors — no
enums, no scalar lists, no `@db.*` native types — so the same schema runs on
either. `scripts/prisma-run.mjs` rewrites the `provider` line automatically
based on `DATABASE_URL`.

```bash
DATABASE_URL="postgresql://user:pass@host:5432/northstar_hq?schema=public&sslmode=require"
npm run db:push
```

### Migrations — read this before you wire up a release pipeline

**This is now a migrated schema.** `prisma/migrations/` exists and is the
history, so `npm run db:migrate` (`prisma migrate deploy`) is the release
command and it does apply changes. Run it against production on every deploy
that carries a schema change; `db push` should not be pointed at production
again.

Locally, where `DATABASE_URL` is the SQLite file, `npm run db:push` is still
the way to bring `prisma/dev.db` up to date — the migration SQL is written for
PostgreSQL and is not replayed against SQLite.

The warning this section used to carry is still worth knowing, because it is
how the trap re-arms: `prisma migrate deploy` with no migration history finds
nothing to apply, prints "No migration found", and **exits successfully**. In
CI that is the worst possible shape of failure — a green deploy step that never
touched the database, followed by an application talking to a schema one release
behind. If `prisma/migrations/` is ever lost or not committed, the deploy goes
quiet rather than red.

`db push` suits a single-deployment internal tool — but it has no
down-migration and keeps no record of what changed. That is acceptable while
the database is disposable and stops being acceptable the day it holds real
financial data.

#### Creating the migration history

Do this against **PostgreSQL**, not your local SQLite file: migrations are
generated as raw SQL for one engine, and `prisma-run.mjs` only uses the
canonical Postgres schema when `DATABASE_URL` is not a `file:` URL.

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/northstar_hq?schema=public"
```

If the database is **empty** — one command captures the current schema and
applies it:

```bash
node scripts/prisma-run.mjs migrate dev --name init
```

If the database **already exists** because you ran `db push` — do not run
`migrate dev`, it will offer to reset the database and take the finance records
with it. Write the same SQL out by hand and mark it as already applied
(Prisma calls this baselining):

```bash
mkdir -p prisma/migrations/0_init

# `migrate diff` takes the schema path itself, so it is invoked directly rather
# than through prisma-run.mjs, which appends its own --schema flag.
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql

node scripts/prisma-run.mjs migrate resolve --applied 0_init
```

Either way, **commit `prisma/migrations/`** — it is the history, and a deploy
that cannot see it is back to applying nothing. From that point on
`npm run db:migrate` is the release command and `npm run db:push` should not be
run against production again; every schema change gets a
`node scripts/prisma-run.mjs migrate dev --name <what-changed>` and arrives in
the same commit as the code that needs it.

### Moving your local data to production

```bash
# 1. Point DATABASE_URL at Postgres and create the schema
npm run db:push

# 2. Create the organization and seed finance categories
node scripts/backfill-organization.mjs
```

The backfill script is idempotent and safe to re-run.

---

## 4. Environment variables

Copy `.env.example` and fill it in. Every variable is documented there. The
minimum for a working production deployment:

```
DATABASE_URL=postgresql://...
SESSION_SECRET=<32 bytes base64>
APP_URL=https://northstarhq.com
YOUTUBE_API_KEY=<for competitor tracking>
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Never commit `.env.local`.** It is git-ignored, and `.gitignore` allows only
`.env.example` through.

### Rotating secrets

| Variable | Effect of rotating |
|---|---|
| `SESSION_SECRET` | Everyone is signed out immediately. This is also your emergency "revoke all sessions" lever. |
| `APP_ENCRYPTION_KEY` | Stored YouTube connections can no longer be decrypted and must be reconnected. Back it up with your database. |
| `CRON_SECRET` | Update your scheduler at the same time or syncing stops. |

---

## 5. Hosting

Any Node host works. The app has no filesystem dependencies in production and
no native modules.

### Vercel

The path of least resistance, and `vercel.json` below wires up the scheduled
sync:

```json
{
  "crons": [{ "path": "/api/cron/sync", "schedule": "0 * * * *" }]
}
```

Vercel sends `Authorization: Bearer $CRON_SECRET`, which the sync route already
accepts. Set every environment variable in the project settings, and set
`APP_URL` to your production domain.

Note: Vercel's function timeout applies to `/api/refresh` (300s) and
`/api/channels/[id]/refresh` (120s). If you track many channels, prefer letting
the hourly cron do the work rather than manual full sweeps.

### A container / VPS

```bash
npm ci
npm run db:push          # or: npx prisma migrate deploy
npm run build
npm start                # listens on $PORT, default 3000
```

Put it behind a reverse proxy that terminates TLS (Caddy, nginx, Traefik). The
proxy must set `X-Forwarded-For`, which is what the rate limiter uses to
identify a client.

Schedule the sync with cron:

```bash
0 * * * * curl -fsS -X POST https://northstarhq.com/api/cron/sync \
  -H "x-cron-secret: $CRON_SECRET" > /dev/null
```

---

## 6. First run

1. Deploy with authentication configured.
2. Visit `https://your-domain/` — you will be redirected to `/setup`.
3. Create the owner account. **This screen appears exactly once**; it closes
   permanently the moment an active admin exists, and cannot be reopened from
   outside the database.
4. Sign in and invite your team from **Admin → Users**.

If email is not configured, the invite dialog gives you a one-time link to send
yourself. That is a supported path, not a degraded one — no administrator ever
handles another person's password either way.

---

## 7. Backups

Financial records and audit logs are the data you cannot reconstruct. Channel
and video data can be re-fetched from YouTube; earnings, expenses and the audit
trail cannot.

```bash
# Nightly, retained off-host
pg_dump "$DATABASE_URL" | gzip > northstar-$(date +%F).sql.gz
```

Also back up `APP_ENCRYPTION_KEY` somewhere separate from the database dump.
A dump without the key leaves the YouTube connections unrecoverable; a key
stored alongside the dump defeats the point of encrypting them.

Test a restore before you need one.

---

## 8. Error logging

Errors are written to the server log with full context; the client only ever
receives `{ error: { code, message } }` with a message written for a person —
never a stack trace or an upstream payload.

For a hosted deployment, forward stdout/stderr to your platform's log drain. If
you add an error tracker (Sentry or similar), **scrub the request body on auth
routes** — otherwise the first thing it captures is a password.

---

## 9. Before you go live

Work through this list. It is ordered by how much damage skipping the item does.

- [ ] `SESSION_SECRET` is set, is 32+ random bytes, and is not the development value
- [ ] `DATABASE_URL` points at PostgreSQL, not SQLite
- [ ] `APP_URL` is the real HTTPS origin (invitation and reset links are built from it)
- [ ] HTTPS is enforced and HTTP redirects to it
- [ ] The owner account has been created and `/setup` now redirects to `/login`
- [ ] `.env.local` is not in version control and no secret is hardcoded anywhere
- [ ] A signed-out browser gets a redirect on every page and a 401 on every `/api/*` data route
- [ ] Deactivating a test user immediately blocks their next request
- [ ] A non-admin account cannot reach `/api/finance/*`, `/api/admin/*` or any `*.manage` route
- [ ] `CRON_SECRET` is set and the scheduler is calling `/api/cron/sync` successfully
- [ ] Database backups are running and a restore has been tested
- [ ] `APP_ENCRYPTION_KEY` is backed up separately from the database
- [ ] `npm run build`, `npm run typecheck`, `npm run lint` and `npm test` all pass

---

## 10. Operational notes

**YouTube quota.** The default is 10,000 units/day. A channel refresh costs
roughly 1 unit per 50 videos, so an hourly sync of a few dozen channels is
comfortably affordable. `SYNC_MAX_CHANNELS_PER_RUN` caps a single run;
`/api/refresh` is additionally rate-limited per user.

**Sessions.** Absolute lifetime `SESSION_TTL_HOURS` (default 14 days), idle
timeout `SESSION_IDLE_TIMEOUT_MINUTES` (default 12 hours). Both are enforced on
every request against the database row, not against a token's contents — which
is why revoking access is instant.

**Audit retention.** The scheduled sync prunes audit events older than a year.
Keeping them forever is not automatically better: an unpruned log becomes a
growing store of personal data with no defined purpose.

**Scaling.** The app is stateless apart from the database, so multiple instances
work as-is. Sessions are database rows and the rate limiter is a database table
precisely so that a second instance does not double every allowance.
