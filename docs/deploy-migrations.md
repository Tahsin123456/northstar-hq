# Migrations run at deploy, and why the build command looks like that

`npm run build` is `prisma migrate deploy && next build`, not `next build`.

## The failure this prevents

Until the RPM change, every schema change had reached production through
`db push` or through a migration baselined against a database that already
matched. Neither leaves a gap, so nothing had ever exercised the question "how
does a pending migration actually reach production?"

The answer was: it did not. Vercel's build command was `next build`, and
`postinstall` ran `prisma generate` — which regenerates the *client* from the
schema file and never touches the database. So a deploy carrying a new migration
would have shipped code that queries columns the live database does not have.
Prisma's client would be perfectly happy; Postgres would answer
`column "rpmLowMinorPerMillion" does not exist`, and the first person to open
Niches would get a 500 on a page that worked ten minutes earlier.

That failure also arrives *after* a green build, which is the worst shape for
one: nothing in CI or the Vercel dashboard would have gone red.

## Why in the build rather than a separate step

`migrate deploy` is the deploy-safe command by design — it applies pending
migrations in order and refuses to generate, reset or prompt. Putting it ahead of
`next build` means a migration that cannot apply **fails the build**, and a
failed build is never promoted. The alias stays on the previous deployment, whose
code matches the schema the database is actually on.

The alternative — migrating separately, by hand, before or after a push — has
been tried by everyone who has ever run a production database, and the failure
mode is always the same: the one time somebody forgets is the one time it
mattered.

`build:app-only` is kept for the rare case of wanting the Next build alone
without touching a database.

## What this means for writing migrations

Because the migration runs *before* the new code is live, and the old code is
still serving traffic while it runs, every migration must be safe against the
PREVIOUS release for the length of a deploy:

- **Additive is safe.** New nullable columns, new tables, new indexes.
- **Destructive is not.** Dropping or renaming a column the running code still
  selects breaks production between the migration and the cutover. Do it in two
  deploys: stop reading the column, ship; then drop it, ship.
- **No backfill that assumes the new code.** The old code is still writing.

`20260830_niche_pay_kind_and_channel_rules/migration.sql` is worth reading as an
example: its generated form dropped a table and recreated it, and it was
hand-edited into CREATE-then-COPY-then-DROP precisely so live rows survived.

## The niche-money removal, in two deploys

The niche earnings / RPM feature (the `rpmLowMinorPerMillion` column named
above was part of it) was removed on 2026-09-05 following exactly this rule.
The first deploy stopped every reader and writer and took the fields out of
`schema.prisma` with NO migration, so these objects stay in production until
the second deploy drops them:

- `niches.rpmLowMinorPerMillion`, `niches.rpmHighMinorPerMillion`,
  `niches.rpmCurrency` (created by `20260831_niche_rpm_range`)
- `organization_settings.engagedViewShareBasisPoints`
  (`20260831_organization_engaged_view_share`)
- table `channel_view_snapshots` (`20260903_channel_view_snapshots`)

Until that second migration lands, `prisma migrate dev` against a Postgres
database will offer to fold those drops into whatever migration is being
written. Do not accept that: the drop ships on its own, as
`<date>_drop_niche_rpm_and_channel_readings`, once the first deploy is live.
