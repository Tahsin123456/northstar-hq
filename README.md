# Shorts Hit Rate

Analytics for researching YouTube Shorts channels, built around a single question:

> **Out of every 100 Shorts this channel publishes, how many reach their niche's view
> threshold inside its hit window?**

Total views reward one lucky video. **Hit rate** rewards a repeatable system — and that
distinction is what this tool is designed to make obvious. The window is what keeps it
honest: without one, a Short that crawled to a million over three years scored the same as
one that got there in a day, and simply publishing more made the number fall.

---

## Quick start

```bash
npm install
```

Create your local config:

```bash
cp .env.example .env.local
```

Add a YouTube Data API v3 key to `.env.local` (see [Environment variables](#environment-variables)),
then create the database and start:

```bash
npm run setup
```

```bash
npm run dev
```

Open <http://localhost:3000>.

The app boots and renders fine **without** an API key — it shows a setup prompt instead of
crashing — but channels cannot be added or refreshed until one is configured.

---

## Environment variables

Copy `.env.example` → `.env.local`. `.env.local` is git-ignored; `.env.example` is the
committed template and contains no secrets.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `YOUTUBE_API_KEY` | **Yes** | — | YouTube Data API v3 key. |
| `DATABASE_URL` | **Yes** | `file:./prisma/dev.db` | SQLite file path or a PostgreSQL connection string. |
| `SHORTS_PROBE_ENABLED` | No | `true` | Allow the `youtube.com/shorts/{id}` verification request. |
| `SHORTS_PROBE_CONCURRENCY` | No | `6` | Max parallel verification requests. |
| `SHORTS_PROBE_TIMEOUT_MS` | No | `8000` | Per-request timeout. |
| `YOUTUBE_LOOKBACK_DAYS` | No | `400` | How far back a refresh walks a channel's uploads. |
| `YOUTUBE_MAX_PAGES` | No | `40` | Hard cap on uploads-playlist pages per refresh (40 × 50 = 2,000 videos). |
| `REFRESH_INTERVAL_MINUTES` | No | `360` | How long before a channel is considered stale. |

### Getting a YouTube API key

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → Credentials** → **Create credentials → API key**.
4. Recommended: restrict the key to the YouTube Data API v3.
5. Put it in `.env.local` as `YOUTUBE_API_KEY=…` and restart the dev server.

The default quota is **10,000 units/day**. This app is built to stay well inside it — see
[Quota](#quota-budgeting) below.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server. |
| `npm run build` / `npm start` | Production build and serve. |
| `npm run setup` | Create/sync the database and generate the Prisma client. |
| `npm run db:push` | Push the schema to the database. |
| `npm run db:studio` | Open Prisma Studio to browse the data. |
| `npm run db:report` | Print what's stored: row counts, how each video was classified and by which signal, the refresh audit trail, and quota spent in the last 24h. |
| `npm run db:reset` | **Destructive.** Drop and recreate all tables. |
| `npm test` | Run the test suite. |
| `npm run typecheck` | TypeScript, no emit. |
| `npm run lint` | ESLint. |

---

## Database: SQLite or PostgreSQL, one schema

`prisma/schema.prisma` is the single canonical schema and targets **PostgreSQL**.

Prisma does not allow the datasource provider to come from an environment variable, so
`scripts/prisma-run.mjs` reads `DATABASE_URL` and, for a SQLite URL, generates
`prisma/.generated/schema.sqlite.prisma` — byte-for-byte identical except the one
`provider` line.

This works because the schema is written against the **intersection** of the two
connectors: no `enum` blocks, no scalar list fields, no `@db.*` native types. Both
databases therefore get the same tables, columns and indexes.

To switch to PostgreSQL, change one line in `.env.local` and re-run setup:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/shorts_hitrate?schema=public"
```

```bash
npm run setup
```

No code changes required.

---

## How Shorts are detected

**This is the most important part of the system, and the place where the YouTube API's
limitations bite hardest.**

### The problem

The YouTube Data API v3 has **no field that identifies a video as a Short**. There is no
`isShort`, no `shortsMetadata`, nothing in `snippet`, `contentDetails` or `status`. That is
a hard limitation of the official API.

### Why `duration < 60s` is wrong

The naive heuristic fails in both directions:

- Since October 2024 a Short may be **up to 3 minutes**, so a 90-second Short is missed.
- A 45-second landscape trailer or clip uploaded normally is **not** a Short, but a
  duration-only rule counts it.

Because hit rate is a **ratio**, an error in the denominator silently corrupts the one
number the product exists to report. Detection has to be better than a duration check.

### The strategy

`src/server/services/youtube/shorts-detector.ts` layers four signals and records an
explicit confidence for every verdict:

1. **Duration gate** — longer than the Shorts maximum ⇒ definitively not a Short.
   Free, certain, and settles most long-form uploads with zero network traffic.
2. **Shorts URL verification** — request `youtube.com/shorts/{id}` without following
   redirects. YouTube serves `200` for a genuine Short and `303`-redirects to
   `/watch?v=…` for anything else. **This is YouTube's own classification, read back from
   YouTube, and it costs no API quota.**
3. **Aspect ratio** — requesting `part=player&maxHeight=…` makes YouTube size the embed to
   the video's real aspect ratio. Vertical-or-square plus a short duration is precisely
   YouTube's own eligibility rule, so this reconstructs the decision when the URL check is
   unavailable.
4. **Live content** — live broadcasts and premieres are never Shorts.

### Conservative by construction

If the signals do not clear the confidence floor, the video is classified `uncertain`,
`isShort` stays `false`, and the reason is stored on the row. **An uncertain video cannot
enter the numerator or the denominator of a hit rate.** Guessing "probably a Short" would
corrupt the metric; abstaining merely narrows the sample.

Every exclusion is auditable in the UI — the channel detail page has a panel listing each
excluded video with the classifier's recorded reason, method and confidence.

Verdicts are **cached permanently** per video, so the verification request happens once per
new video, not once per refresh.

---

## Niches and ownership

Channels are organised by **niche** (user-defined categories — GTA, Finance, whatever
fits) and tagged as **own** or **competitor**.

Both live on `TrackedChannel`, not `Channel`. `Channel` is deduplicated across users — one
row per YouTube channel — while "this is *our* channel" and "this belongs in *my* GTA
niche" describe a user's relationship to a channel, not the channel itself. Putting them on
`Channel` would leak one user's taxonomy into another's the moment auth is added.

```
AppUser ──< Niche
   │            │
   └──< TrackedChannel ──< TrackedChannelNiche >── Niche
              │  ownershipType: "own" | "competitor"
              └── Channel (global, deduplicated)
```

`TrackedChannelNiche` is a real join table, so a channel can sit in several niches at once
("Gaming" + "GTA") and filtering is an indexed join rather than a string scan.

**Migration safety.** Adding these was additive: `ownershipType` defaults to `"competitor"`,
so every pre-existing channel kept working with the correct default, and niches start empty.
Nothing needed backfilling and no rows were touched. Channels with no niche are not given a
phantom "Uncategorised" record — they simply have no assignments, and the filter menu offers
an *Uncategorised* option so they stay findable.

**Filtering** is client-side like every other filter. Niche and ownership are predicates
applied *before* metrics are read, so a scoped view reports the scoped set's numbers —
"GTA + Our Channels" gives the average hit rate of those channels, not a filtered view of a
global average. Selecting a niche costs zero network requests.

**Visual distinction** is one indicator, not four: a small `Own` badge beside the channel
name. No background tint, no border, no extra row height. Competitors get no marker at all,
which keeps the table quiet given most rows are competitors. Own channels stay in the same
ranked dataset — there is no separate table — with an optional *Our channels first* ordering
that partitions before sorting while preserving the hit-rate ranking inside each group.

---

## Hit rate: the exact definition

**A hit is `hitThreshold` views reached within `hitWindowHours` of publishing.** Both are
set per niche by an admin, and a niche needs both before anything filed under it can be
scored — half a rule is not a rule.

```
hit rate = hits ÷ decided Shorts × 100
```

- **Denominator** — Shorts whose *upload date* falls inside the selected period **and whose
  outcome has been decided**. Never the channel's whole back catalogue, and never a Short
  that is still inside its window.
- **Numerator** — Shorts that reached their niche's threshold inside their niche's window.
  Inclusive at the bar: exactly 1,000,000 counts at a 1M threshold; 999,999 does not.
- **Nothing decided ⇒ `null`, rendered as an em dash — never `0%`.** 0% would claim "these
  Shorts were judged and none hit", which is a different and false statement from "these
  Shorts have not been judged".

### The four outcomes

Every Short lands on exactly one, and only the first two are in the ratio.

| Outcome | Meaning | In the rate? |
| --- | --- | --- |
| **hit** | Reached the bar inside the window. Either seen at the close, or seen earlier and already past it — views only rise, so over the bar on day 2 is a hit on day 7. | numerator + denominator |
| **miss** | The window shut and it was short. Also reachable with no history at all: if lifetime views today are still under the bar, it cannot have cleared it inside a window that has closed. That one inference judges 80% of the existing library — 1,530 of 1,904 Shorts. | denominator |
| **pending** | The window is still open. Unfinished, not failed. | neither |
| **unknown** | The window shut, nobody was recording during it, and the Short *did* eventually pass the bar — so it may have taken two days or two years. 374 Shorts. | neither, and **counted** |

`unknown` is excluded *and shown*, never dropped silently: these are disproportionately
the winners, so hiding them biases every rate downward while looking clean. Every rate
therefore ships with `lowerBound` (every unknown was too slow) and `upperBound` (every
unknown was a hit) beside it.

### Why the clock exists

The old rule compared **lifetime** views to a fixed bar, with no notion of age. Measured on
this account's real corpus, the same channels scored **5.9%** for Shorts under seven days
old and **18.8%** at 30–90 days — a 3x spread bought entirely with the calendar. Publishing
more made the number fall, which is the opposite of what a performance metric is for.
Judging every Short over the same stretch of its own life removes that bias by
construction rather than correcting for it afterwards.

### The distinction that trips people up

The period decides **which uploads are counted**. Each Short's own **niche rule** decides
which of them count as hits — not the view-bar control in the toolbar, which shades tables
and scales the "vs bar" column and moves no rate at all. And it is *not* "views accumulated
during the last 30 days": the YouTube Data API does not expose per-window view deltas for
someone else's channel, and this app does not pretend otherwise. This definition is
surfaced as a tooltip throughout the UI.

### Where it is decided, and where it is only read

`evaluateHit` in `src/lib/analytics/hit-rate.ts` is the one function that turns evidence
into a verdict. `hit-evaluation-service` runs it once per (organization, video) and
materialises the answer on `VideoHitEvaluation`; a settled hit or miss is frozen and never
recomputed, because a miss inferred from "lifetime is still under the bar" would decay into
`unknown` once the Short later crept past it. Everything downstream — the dashboard, the
charts, the PDF, payroll — **counts stored verdicts** and never re-derives one.

---

## Architecture

```
src/
├─ lib/analytics/       Pure, isomorphic analytics engine (no I/O, no React)
│   ├─ hit-rate.ts        evaluateHit (THE definition), calculateHitRate, tallyShorts
│   ├─ filters.ts         getShortsInDateRange — Shorts-only + date window
│   ├─ stats.ts           mean, median, percentile, consistencyScore
│   ├─ distribution.ts    calculateViewDistribution
│   ├─ channel-metrics.ts calculateChannelMetrics, calculatePortfolioSummary
│   └─ series.ts          calculateHitRateSeries, calculateHitRateTrend
│
├─ server/
│   ├─ env.ts            Zod-validated environment, parsed once at startup
│   ├─ errors.ts         Error taxonomy: code + status + user-facing message
│   ├─ http.ts           Route wrapper — uniform error envelope, no leaks
│   └─ services/
│       ├─ youtube/      ALL YouTube API access lives behind this barrel
│       │   ├─ client.ts           Requests, retry/backoff, quota accounting
│       │   ├─ channel-resolver.ts URL / @handle / UC-id / video-URL → channel
│       │   ├─ shorts-detector.ts  Classification (see above)
│       │   └─ parse-duration.ts   ISO 8601 durations
│       ├─ channel-sync.ts    Fetch → classify → upsert → snapshot pipeline
│       ├─ channel-service.ts Add / rename / remove / restore / refresh
│       └─ dataset-service.ts Assembles the client payload
│
├─ app/api/            Route handlers (thin: validate, call a service, serialise)
└─ components/         UI, grouped by feature
```

**No YouTube call happens outside `src/server/services/youtube/`**, and no component ever
sees a raw API response — the boundary is enforced by only exporting normalised types.

### Why filters never refetch

`GET /api/dataset` returns every stored video once, **each carrying its decided hit
verdict**. Period, niche, view bar, search, sort and comparison are all derived **in the
browser** by the same analytics engine the server uses.

The React Query key is `["dataset"]` — it deliberately contains **neither the period nor the
view bar**. Changing 1M → 500K, or 30D → 90D, therefore *cannot* invalidate the cache or
trigger a request. The requirement is enforced structurally rather than by convention.

The windowed rule did not cost this property, though it moved where the work happens. A hit
depends on a snapshot series the browser does not hold, so the client cannot decide one —
and does not: the verdict is decided server-side and ships on the row as five small fields
(`outcome`, the rule applied, and the reading that produced it). Changing a filter re-tallies
verdicts already in memory. The one thing that genuinely requires the server is **changing a
niche's rule**, which re-decides stored verdicts — a mutation with an invalidation behind
it, not a filter.

### Historical snapshots

`Video` holds the latest counters for fast reads; `VideoSnapshot` accumulates an
append-only time series of the same counters, with `videoAgeHours` precomputed so
"views after 24h / 48h / 7d" is a range scan.

Snapshots are written on every refresh, at most once per `snapshotIntervalMinutes` per
video and only when a counter actually moved. **The collection runs from day one** — the
groundwork for growth-velocity and historical-hit-rate analytics is accumulating data now,
not waiting on a future migration.

---

## Quota budgeting

The YouTube Data API charges per call, and `search.list` costs **100 units** — a hundred
times everything else. This app **never uses it** for video retrieval:

| Operation | Endpoint | Cost |
| --- | --- | --- |
| Resolve a channel | `channels.list` (`forHandle` / `id`) | 1 unit |
| Discover uploads | `playlistItems.list` | 1 unit per 50 videos |
| Fetch statistics | `videos.list` | 1 unit per 50 videos |
| Verify a Short | `youtube.com/shorts/{id}` | **0 units** |
| Channel search (last resort only) | `search.list` | 100 units |

A channel with 300 uploads inside the lookback window costs roughly **13 units** out of
10,000/day. Paging stops as soon as the uploads playlist — which is ordered newest-first —
passes the lookback cutoff.

`search.list` is reached only when a handle lookup *and* a username lookup have both
already failed.

---

## Refresh

- **Manual, per channel** — the refresh button. Always runs; the staleness interval exists
  to throttle automatic sweeps, not to argue with a deliberate click.
- **Manual, all channels** — the refresh icon beside "Data updated …".
- **Automatic** — not built in, by design. `POST /api/refresh` refreshes only channels
  older than the staleness threshold, so it is safe to call on a tight schedule. Point
  cron, a Vercel Cron job, or a worker at it:

  ```bash
  curl -X POST http://localhost:3000/api/refresh
  ```

The freshness indicator shows the **oldest** fetch time across tracked channels, not the
newest — when comparing channels, the honest claim is only as strong as the stalest input.

---

## Testing

```bash
npm test
```

189 tests covering the analytics engine, scope filtering and the YouTube service layer,
including every acceptance case from the specification:

| Case | Expectation |
| --- | --- |
| 40 decided Shorts, 12 hits | `30%` |
| 0 Shorts | `null` — not `0%` |
| Shorts published, none decided | `null` — not `0%` |
| 100 decided, 0 hits | `0%` |
| 100 decided, 100 hits | `100%` |
| Date filtering | Shorts outside the period are never counted |
| Threshold boundary | 1,000,000 clears a 1M bar inside the window; 999,999 does not |
| Window boundary | Identical evidence reads `pending` at hour 167 and `hit` at hour 168 |
| Pending exclusion | A Short inside its window is in neither half of the ratio |
| Unknown exclusion | Counted and reported; widens the bounds rather than lowering the rate |
| Long-form exclusion | Long-form never contributes to any Shorts metric |

Plus: an exhaustive invariant sweep over the classifier's entire signal space (asserting
`isShort` can never be true below the confidence floor, and that an over-long video can
never be classified as a Short regardless of other signals), channel-input parsing across
every URL form, ISO-8601 duration edge cases, local-vs-UTC date handling, and niche /
ownership scoping — including that a scoped summary reports the scoped set's own average
rather than a filtered global one, and that a deleted niche id in a stale URL degrades to
an empty result instead of silently showing everything.

### Network integration tests

```bash
npm run test:integration
```

Skipped by default so `npm test` stays hermetic. These reach youtube.com — using **no API
quota and no API key** — to verify the one external assumption the classifier rests on:

| Case | Live result | Verdict |
| --- | --- | --- |
| `dQw4w9WgXcQ` — 3:33 landscape | `303` → `/watch` | not a Short |
| `jNQXAC9IVRw` — **0:19** landscape | `303` → `/watch` | not a Short |
| Ids discovered from a real `/shorts` tab | `200` | Short |
| Nonexistent id | `404` | unavailable |

The second row is the one that matters: *"Me at the zoo"* is 19 seconds long, so a
`duration < 60s` heuristic counts it as a Short and corrupts the denominator of every hit
rate. YouTube redirects it, and the probe correctly rejects it. Run this if YouTube ever
changes how it serves the Shorts URL.

---

## Verified against live data

Results from a real run against three tracked channels (191 videos):

**Classification** — 191 videos, **zero unresolved**:

| Verdict | Signal | Videos |
| --- | --- | ---: |
| `short` | `url_probe` | 156 |
| `not_short` | `duration_gate` (free, no network) | 34 |
| `not_short` | `url_probe` | 1 |

Both failure modes of the naive `duration < 60s` heuristic showed up in real data:

- **It would have missed hits.** 12 Shorts run longer than 60s, including one at **108s
  with 16.3M views** — a hit that a duration rule drops from the numerator.
- **It would have counted a non-Short.** A **10-second** video was correctly excluded
  because YouTube redirected `/shorts/{id}` to `/watch`. A duration rule puts it in the
  denominator and drags the hit rate down.

**Quota** — adding three channels and refreshing one cost **20 units** total, against a
10,000/day allowance. A 73-video channel syncs for 5 units.

**Classification caching** — re-refreshing an already-synced channel classified **0**
videos and took 1.9s versus 12.2s on first add.

**Zero-refetch filtering** — with the network layer instrumented in the browser, four
period switches, three sort changes and three view-bar changes (1M → 500K → 50M) produced
**0 network requests**. Note that the last of those no longer moves a hit rate: the bar
shades and sorts, and each Short's verdict was decided against its own niche's rule.

---

## Intelligence layer

Three pages share one scoring engine (`src/lib/analytics/outliers.ts`), so a Short carries
the same multiple wherever it appears.

**Winners** — what is breaking out right now. Defaults to the last 7 days and to competitor
channels, because its job is market discovery.

**Outliers** — the same scoring over longer windows, ranked purely by multiple.

**Saved** — the research library: collections, notes, and the views journey.

### Outlier multiple

```
outlier multiple = short views ÷ that channel's median short views
```

Ranking by absolute views just surfaces big channels. A 5M-view Short from a channel that
habitually does 4M is a 1.25×; a 4M-view Short from a channel whose median is 100K is a
**42×** — and only the second is worth studying.

**Median, not mean.** The mean is contaminated by the very thing being measured: one 40M
Short drags a channel average so high that the next breakout looks ordinary. The median is
unmoved by outliers.

**Minimum sample.** A median over two Shorts is a coin flip, so below
`MIN_SHORTS_FOR_BASELINE` (5) no multiple is reported — the UI shows **Insufficient data**
rather than a large and meaningless number. Five is the smallest sample where a median has
a genuine majority behind it.

**Baseline window.** Separate from the feed window, and at least 90 days. Judging a
2-day-old Short against a 2-day median would compare it to one sibling.

**Views per day** is withheld under 24 hours — 40K views in two hours is not "480K/day",
and presenting that extrapolation would rank brand-new uploads above genuinely successful
ones.

---

## Our vs Market

Splits a niche into your channels and the competitor pool and compares pooled output.

Metrics are computed over each side's **combined Shorts**, not by averaging per-channel
figures — otherwise a channel that posted twice would count as heavily as one that posted
eighty times.

**Upload frequency is deliberately not scored.** Every other metric declares that higher is
better; this one declares that it is neither. Posting more is a strategy choice, and a team
running a lower-volume, higher-craft format would be marked as "losing" by any scoreboard
that treats volume as a win. It is shown for context and excluded from the tally.

Rates are compared in **percentage points**, magnitudes as a relative percentage. Reporting
a hit rate moving 21% → 28% as "+33%" is a standard way to mislead.

---

## Total views: what it actually measures

```
Total = sum of CURRENT views of Shorts UPLOADED during the period
```

**This will not match YouTube Studio, and that is not a bug.** Studio reports views
*earned* in the last N days across a channel's entire back catalogue, including videos
uploaded years ago. This app reports the lifetime views of videos *uploaded* in the window.
Different questions, different answers.

The card is labelled **"Views of period uploads"** rather than "Total views", with the full
definition in its tooltip, so the distinction is visible where it is read rather than
buried in documentation.

The Studio-style figure needs a view count for each video at both ends of the window.
`VideoSnapshot` has been collecting exactly that since day one, and `getViewsDefinition()`
reports whether coverage is sufficient yet. Until it spans the requested window the app
says so rather than approximating from current totals.

The pipeline was audited against the raw database: no duplicate videos, no unavailable
Shorts counted, no timezone drift — and the dashboard total reconciles exactly with an
independent recount of the underlying dataset.

---

## Notes, saving and collections

`Note` uses three nullable foreign keys (channel / niche / video) rather than a
polymorphic `(targetType, targetId)` pair, so referential integrity and cascade deletes are
real: a note cannot outlive what it annotates.

`SavedShort` captures `viewsAtSave`, `channelMedianAtSave` and `outlierMultipleAtSave` at
the moment of saving. These are **point-in-time facts, not a cache** — the value of saving
a Short early is seeing later how far it ran, so re-saving deliberately leaves the original
capture untouched. The Saved page renders it as `1.2M → 4.8M`.

`viewsAtSave` is read server-side from the database, never accepted from the client: a
historical record has to be trustworthy.

Deleting a collection removes the folder, not the Shorts inside it — the same principle as
deleting a niche.

---

## Known limitations

These are constraints of the official API, not shortcuts. Where one exists, the closest
reliable alternative is implemented rather than faked.

1. **No Shorts flag in the API.** Addressed by the layered classifier above. The URL
   verification is the authoritative signal; if your network blocks `youtube.com`, set
   `SHORTS_PROBE_ENABLED=false` and detection falls back to duration + aspect ratio at
   lower confidence.

2. **No per-window view counts.** The API returns a video's *lifetime* view count only.
   "Views gained in the last 30 days" is not obtainable for a channel you do not own. Hit
   rate is therefore defined on **current** views of Shorts **uploaded** in the period —
   documented in the UI so the number is never misread. The `VideoSnapshot` table is
   accumulating the data that will eventually make windowed deltas possible from our own
   observations.

3. **Uploads playlist omits some videos.** A channel's `uploads` playlist excludes private
   and some members-only videos. Those are invisible to any API consumer.

4. **Hidden counters.** Channels can hide subscriber counts and creators can hide likes or
   disable comments. These are stored as `null` and render as an em dash — never as `0`.

5. **Deleted or privated videos.** Videos that vanish from the API are flagged
   `isAvailable = false` and retained, rather than deleted — their collected history is
   real data.

6. **Daily quota.** 10,000 units/day by default. Exhaustion is reported as a distinct,
   actionable error and never as a generic failure; stored data continues to work.

---

## Assumptions made

- **Single implicit local user.** V1 ships without authentication, but every user-scoped
  concept already hangs off `AppUser`. Adding real auth means changing one function
  (`getCurrentUser` in `src/server/services/user-service.ts`) to read a session — no schema
  migration, no service rewrites.
- **Removal is a soft delete.** Historical view counts can never be re-collected after the
  fact, so removing a channel flips a flag rather than deleting rows. Re-adding restores
  the full history.
- **Trailing periods are exact durations**, anchored to now — "last 7 days" means the last
  168 hours. Custom ranges snap to local midnight and include the whole end day.
- **Average hit rate** on the dashboard is the mean of per-channel rates, not pooled
  hits ÷ pooled Shorts (both are shown). The pooled ratio is dominated by whichever channel
  uploads most; the mean of rates answers "how does a typical tracked channel perform?".
  Channels with no Shorts contribute no rate rather than a zero.
- **Consistency score** uses quartile dispersion rather than standard deviation, because
  view counts are heavily right-skewed and a single outlier would otherwise drag an
  otherwise-steady channel's score to the floor.

---

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript (strict, no `any`) · Tailwind CSS v4 ·
Radix UI primitives · Recharts · Prisma 6 · PostgreSQL / SQLite · Zod · TanStack Query ·
Vitest
