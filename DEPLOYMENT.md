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

### Migrations

This project currently uses `db push` rather than a migration history, which
suits a single-deployment internal tool. **If more than one person will deploy
this, switch to migrations before the first production write:**

```bash
npx prisma migrate dev --name init      # once, to capture the current schema
npx prisma migrate deploy               # in CI/CD on every release
```

`db push` has no down-migration and no record of what changed. That is
acceptable while the database is disposable and stops being acceptable the day
it holds real financial data.

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
