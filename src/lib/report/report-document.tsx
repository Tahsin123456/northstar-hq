import * as React from "react";
import {
  Document,
  Page,
  Path,
  Polyline,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
} from "@react-pdf/renderer";
import type { ReportData, ReportChannelRow, ReportShort } from "./build-report";
import type { MarketSharePoint } from "@/lib/analytics/market-share";
import { formatTrendDelta, trendGlyph, type Trend } from "@/lib/analytics/trends";

/**
 * =========================================================================
 * THE PDF
 * =========================================================================
 *
 * A real vector PDF, not a screenshot of the dashboard.
 *
 * WHY @react-pdf/renderer RATHER THAN PRINT-TO-PDF
 * Browser printing gives you whatever the print stylesheet happens to do:
 * unpredictable page breaks, a browser-chosen filename, headers and footers
 * the user has to remember to disable, and charts rasterised at screen
 * resolution. This renders text as text and charts as vectors, controls its own
 * pagination, numbers its own pages, and produces a correctly named file with
 * one click — which is what "presentable in a management meeting" requires.
 *
 * Charts are drawn with PDF primitives (Rect, Path, Polyline) rather than
 * embedded images, so they stay sharp at any zoom and add almost nothing to
 * the file size.
 *
 * The palette is the light half of the application's design tokens — a report
 * is printed and read on paper, where the dark UI theme would be unusable.
 */

const C = {
  ink: "#14161a",
  muted: "#5c626b",
  subtle: "#8a9099",
  line: "#e4e5e8",
  lineSoft: "#f0f0f2",
  surface: "#ffffff",
  sunken: "#fafafb",
  accent: "#4f4fc9",
  accentSoft: "#eeeefc",
  success: "#12875a",
  danger: "#c33a3a",
  neutral: "#6a707a",
} as const;

const s = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 52,
    paddingHorizontal: 44,
    fontSize: 9,
    color: C.ink,
    fontFamily: "Helvetica",
    backgroundColor: C.surface,
  },

  // --- header / footer ---
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    paddingBottom: 10,
    marginBottom: 18,
  },
  wordmark: { fontSize: 13, fontFamily: "Helvetica-Bold", letterSpacing: -0.3 },
  wordmarkSub: { fontSize: 7.5, color: C.subtle, marginTop: 2, letterSpacing: 0.6 },
  headerRight: { alignItems: "flex-end" },
  footer: {
    position: "absolute",
    bottom: 26,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.lineSoft,
    paddingTop: 8,
    fontSize: 7.5,
    color: C.subtle,
  },

  // --- cover ---
  coverBlock: { marginTop: 150, marginBottom: 40 },
  coverRule: { width: 44, height: 3, backgroundColor: C.accent, marginBottom: 22 },
  coverTitle: { fontSize: 30, fontFamily: "Helvetica-Bold", letterSpacing: -0.8 },
  coverPeriod: { fontSize: 13, color: C.muted, marginTop: 10 },
  coverMetaRow: { flexDirection: "row", marginTop: 34, gap: 34 },
  coverMetaLabel: { fontSize: 7, color: C.subtle, letterSpacing: 0.7 },
  coverMetaValue: { fontSize: 10, marginTop: 3, fontFamily: "Helvetica-Bold" },

  // --- structure ---
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
    letterSpacing: -0.2,
  },
  sectionSub: { fontSize: 8, color: C.muted, marginBottom: 12, lineHeight: 1.5 },
  section: { marginBottom: 24 },

  // --- KPI grid ---
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  kpiCard: {
    width: "31.8%",
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 5,
    padding: 11,
    backgroundColor: C.sunken,
  },
  kpiLabel: { fontSize: 6.8, color: C.subtle, letterSpacing: 0.7 },
  kpiValue: { fontSize: 17, fontFamily: "Helvetica-Bold", marginTop: 5, letterSpacing: -0.4 },
  kpiTrend: { fontSize: 7.5, marginTop: 4 },
  kpiNote: { fontSize: 6, color: C.subtle, marginTop: 5, lineHeight: 1.35 },

  // --- tables ---
  tHead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    paddingBottom: 5,
    marginBottom: 2,
  },
  tHeadCell: { fontSize: 6.8, color: C.subtle, letterSpacing: 0.6 },
  tRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.lineSoft,
    paddingVertical: 6,
    alignItems: "center",
  },
  tCell: { fontSize: 8.5 },

  note: { fontSize: 7, color: C.subtle, marginTop: 8, lineHeight: 1.5 },
  bullet: { flexDirection: "row", marginBottom: 6 },
  bulletDot: { width: 10, fontSize: 8.5, color: C.accent },
  bulletText: { flex: 1, fontSize: 9, lineHeight: 1.55 },
});

// ---------------------------------------------------------------------------
// Formatting — local copies so the PDF never depends on browser-only helpers.
// ---------------------------------------------------------------------------

function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trim(value / 1000)}K`;
  if (abs < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000, 2)}B`;
}
function trim(v: number, d = 1): string {
  return v.toFixed(d).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
function pct(value: number | null | undefined, d = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(d)}%`;
}
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
function fmtShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function metricValue(m: { value: number | null; format: string }): string {
  if (m.value === null) return "—";
  switch (m.format) {
    case "percent":
      return pct(m.value);
    case "count":
      return String(Math.round(m.value));
    case "decimal":
      return m.value.toFixed(1);
    default:
      return compact(m.value);
  }
}

/** Trend colour follows meaning, matching the on-screen rule exactly. */
function trendColor(trend: Trend): string {
  if (!trend.hasComparison) return C.subtle;
  if (trend.isImprovement === true) return C.success;
  if (trend.isImprovement === false) return C.danger;
  return C.neutral;
}
function trendText(trend: Trend): string {
  if (!trend.hasComparison) return "—";
  return `${trendGlyph(trend.movement)} ${formatTrendDelta(trend)}`;
}

// ---------------------------------------------------------------------------
// Vector charts
// ---------------------------------------------------------------------------

/** Donut, drawn as two arcs. Share sits in the middle as text. */
function ShareDonut({ share, size = 118 }: { share: ReportData["marketShare"]; size?: number }) {
  const pctValue = share.sharePercent ?? 0;
  const r = size / 2;
  const stroke = size * 0.17;
  const radius = r - stroke / 2;

  const arc = (fromPct: number, toPct: number): string => {
    // Guard the degenerate full-circle case, which an arc path cannot express.
    const span = Math.min(99.999, Math.max(0.001, toPct - fromPct));
    const a0 = (fromPct / 100) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((fromPct + span) / 100) * 2 * Math.PI - Math.PI / 2;
    const x0 = r + radius * Math.cos(a0);
    const y0 = r + radius * Math.sin(a0);
    const x1 = r + radius * Math.cos(a1);
    const y1 = r + radius * Math.sin(a1);
    const large = span > 50 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1}`;
  };

  return (
    <View style={{ width: size, height: size, position: "relative" }}>
      <Svg width={size} height={size}>
        <Path d={arc(0, 100)} stroke={C.line} strokeWidth={stroke} fill="none" />
        {pctValue > 0 ? (
          <Path d={arc(0, pctValue)} stroke={C.accent} strokeWidth={stroke} fill="none" />
        ) : null}
      </Svg>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 19, fontFamily: "Helvetica-Bold", letterSpacing: -0.5 }}>
          {pct(share.sharePercent)}
        </Text>
        <Text
          style={{
            fontSize: 5.6,
            color: C.subtle,
            letterSpacing: 0.6,
            marginTop: 2,
            textAlign: "center",
          }}
        >
          TRACKED SHARE
        </Text>
      </View>
    </View>
  );
}

/** Market share over time, as a polyline with a baseline and end labels. */
function ShareTrendChart({
  points,
  width = 300,
  height = 92,
}: {
  points: readonly MarketSharePoint[];
  width?: number;
  height?: number;
}) {
  const usable = points.filter((p) => p.sharePercent !== null);
  if (usable.length < 2) {
    return (
      <View
        style={{
          height,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 4,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 7.5, color: C.subtle }}>
          Not enough periods to plot a share trend
        </Text>
      </View>
    );
  }

  const padL = 26;
  const padR = 8;
  const padT = 8;
  const padB = 16;
  const max = Math.max(...usable.map((p) => p.sharePercent ?? 0));
  const yMax = Math.min(100, Math.max(10, Math.ceil((max * 1.3) / 5) * 5));

  const x = (i: number) =>
    padL + (i / Math.max(1, usable.length - 1)) * (width - padL - padR);
  const y = (v: number) => padT + (1 - v / yMax) * (height - padT - padB);

  const coords = usable.map((p, i) => `${x(i)},${y(p.sharePercent ?? 0)}`).join(" ");

  return (
    <Svg width={width} height={height}>
      {/* Two gridlines only — a report chart needs a scale, not a grid. */}
      {[0, yMax / 2, yMax].map((v) => (
        <Path
          key={v}
          d={`M ${padL} ${y(v)} L ${width - padR} ${y(v)}`}
          stroke={C.lineSoft}
          strokeWidth={0.75}
        />
      ))}
      {[0, yMax].map((v) => (
        <Text key={`l${v}`} x={2} y={y(v) + 2.5} style={{ fontSize: 5.8, fill: C.subtle }}>
          {`${v}%`}
        </Text>
      ))}

      <Polyline points={coords} stroke={C.accent} strokeWidth={1.6} fill="none" />

      {usable.map((p, i) => (
        <Rect
          key={p.bucketStartMs}
          x={x(i) - 1.4}
          y={y(p.sharePercent ?? 0) - 1.4}
          width={2.8}
          height={2.8}
          fill={C.accent}
        />
      ))}

      <Text x={padL} y={height - 4} style={{ fontSize: 5.8, fill: C.subtle }}>
        {usable[0].label}
      </Text>
      <Text
        x={width - padR - 28}
        y={height - 4}
        style={{ fontSize: 5.8, fill: C.subtle }}
      >
        {usable[usable.length - 1].label}
      </Text>
    </Svg>
  );
}

/** Horizontal comparison bars — ours against the market, on one scale. */
function VsBar({ label, ours, market, format }: {
  label: string;
  ours: number | null;
  market: number | null;
  format: "percent" | "views";
}) {
  const max = Math.max(ours ?? 0, market ?? 0, 1);
  const fmt = (v: number | null) => (format === "percent" ? pct(v) : compact(v));
  const w = 150;

  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontSize: 6.8, color: C.subtle, letterSpacing: 0.6, marginBottom: 4 }}>
        {label.toUpperCase()}
      </Text>
      {(
        [
          ["Ours", ours, C.accent],
          ["Market", market, "#c9cbd1"],
        ] as const
      ).map(([name, value, color]) => (
        <View key={name} style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}>
          <Text style={{ width: 32, fontSize: 7.5, color: C.muted }}>{name}</Text>
          <View style={{ width: w, height: 8, backgroundColor: C.lineSoft, borderRadius: 2 }}>
            <View
              style={{
                width: Math.max(2, ((value ?? 0) / max) * w),
                height: 8,
                backgroundColor: color,
                borderRadius: 2,
              }}
            />
          </View>
          <Text style={{ marginLeft: 8, fontSize: 8, fontFamily: "Helvetica-Bold" }}>
            {fmt(value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function Header({ report }: { report: ReportData }) {
  return (
    <View style={s.header} fixed>
      <View>
        <Text style={s.wordmark}>{report.brand.product}</Text>
        <Text style={s.wordmarkSub}>{report.brand.company.toUpperCase()}</Text>
      </View>
      <View style={s.headerRight}>
        <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold" }}>
          {report.brand.reportName}
        </Text>
        <Text style={{ fontSize: 7.5, color: C.subtle, marginTop: 2 }}>
          {report.nicheName ? `${report.nicheName} · ` : ""}
          {report.periodLabel} · bar {compact(report.threshold)}
        </Text>
      </View>
    </View>
  );
}

function Footer({ report }: { report: ReportData }) {
  return (
    <View style={s.footer} fixed>
      <Text>
        {report.brand.product} · {report.brand.company}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}

function SectionHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <View>
      <Text style={s.sectionTitle}>{title}</Text>
      {sub ? <Text style={s.sectionSub}>{sub}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function ReportDocument({ report }: { report: ReportData }) {
  const periodText = `${fmtDate(report.range.startMs)} – ${fmtDate(report.range.endMs)}`;

  return (
    <Document
      title={`${report.brand.product} ${report.brand.reportName}`}
      author={report.brand.company}
      subject={`Shorts performance, ${periodText}`}
    >
      {/* ---------- Cover ---------- */}
      <Page size="A4" style={s.page}>
        <View style={s.coverBlock}>
          <View style={s.coverRule} />
          <Text style={{ fontSize: 10, color: C.accent, letterSpacing: 1.4, marginBottom: 10 }}>
            {report.brand.product.toUpperCase()}
          </Text>
          <Text style={s.coverTitle}>{report.brand.reportName}</Text>
          <Text style={s.coverPeriod}>{periodText}</Text>

          <View style={s.coverMetaRow}>
            <View>
              <Text style={s.coverMetaLabel}>PREPARED FOR</Text>
              <Text style={s.coverMetaValue}>{report.brand.company}</Text>
            </View>
            <View>
              <Text style={s.coverMetaLabel}>SCOPE</Text>
              <Text style={s.coverMetaValue}>{report.nicheName ?? "All niches"}</Text>
            </View>
            <View>
              {/* NOT "HIT THRESHOLD" ANY MORE. A hit is each Short's own niche
                  threshold reached inside that niche's window, so a report
                  spanning four niches contains Shorts judged four ways and no
                  single number on a cover can name the rule. What this figure
                  genuinely is, and all it ever affects now, is which Shorts the
                  tables highlight. */}
              <Text style={s.coverMetaLabel}>VIEW BAR (DISPLAY)</Text>
              <Text style={s.coverMetaValue}>{compact(report.threshold)} views</Text>
              <Text style={{ fontSize: 6.6, color: C.subtle, marginTop: 2 }}>
                {report.thresholdSource === "niche"
                  ? `${report.nicheName} default`
                  : report.thresholdSource === "override"
                    ? "Manual override for this report"
                    : "Account default"}
              </Text>
            </View>
            <View>
              {/* The exclusions, on the cover, in the artefact that outlives
                  every screen. A PDF gets forwarded and read six months later
                  by somebody who cannot hover a tooltip, so "22% over 40
                  decided" has to be legible without one. */}
              <Text style={s.coverMetaLabel}>HIT RATE BASIS</Text>
              <Text style={s.coverMetaValue}>
                {/*
                  "N decided of M Shorts" on its own makes whatever figure sits
                  beside it look strongly evidenced, which is the opposite of
                  what it means when the unrecorded pile is what pinned the
                  numerator to zero. In that state the count that matters is
                  named first, because it is the reason there is no percentage.
                */}
                {report.hits.evidenceLimited
                  ? `${report.hits.tally.unknown} unrecorded · ${report.hits.judged} decided`
                  : `${report.hits.judged} decided of ${report.hits.judged + report.hits.excluded} Shorts`}
              </Text>
              <Text style={{ fontSize: 6.6, color: C.subtle, marginTop: 2 }}>
                {report.hits.tally.pending > 0
                  ? `${report.hits.tally.pending} still in window · `
                  : ""}
                {report.hits.tally.unknown > 0
                  ? `${report.hits.tally.unknown} unrecorded · `
                  : ""}
                {report.hits.tally.unscoreable > 0
                  ? `${report.hits.tally.unscoreable} no rule`
                  : ""}
                {report.hits.excluded === 0 ? "Nothing excluded" : ""}
              </Text>
            </View>
            <View>
              <Text style={s.coverMetaLabel}>CHANNELS</Text>
              <Text style={s.coverMetaValue}>
                {report.ownChannelCount} ours · {report.competitorChannelCount} tracked
              </Text>
            </View>
          </View>

          <Text style={{ ...s.note, marginTop: 40, maxWidth: 380 }}>
            Compared against the preceding {report.periodLabel.toLowerCase()} (
            {fmtShortDate(report.comparisonRange.startMs)} –{" "}
            {fmtShortDate(report.comparisonRange.endMs)}). Generated{" "}
            {fmtDate(report.generatedAt)}.
          </Text>
        </View>
        <Footer report={report} />
      </Page>

      {/* ---------- Executive summary ---------- */}
      <Page size="A4" style={s.page}>
        <Header report={report} />

        <View style={s.section}>
          <SectionHeading
            title="Executive summary"
            sub={`Shorts uploaded between ${fmtShortDate(report.range.startMs)} and ${fmtShortDate(report.range.endMs)}, measured against the preceding equivalent period.`}
          />
          <View style={s.kpiGrid}>
            {report.summary.map((metric) => (
              <View key={metric.key} style={s.kpiCard}>
                <Text style={s.kpiLabel}>{metric.label.toUpperCase()}</Text>
                <Text style={s.kpiValue}>{metricValue(metric)}</Text>
                <Text style={{ ...s.kpiTrend, color: trendColor(metric.trend) }}>
                  {trendText(metric.trend)}
                </Text>
                {/* The caveat under the figure it applies to, not in a footnote
                    at the bottom of a page nobody reads to the end of. Present
                    only on the metrics that carry one, so it stays worth
                    reading where it does appear. */}
                {metric.note ? <Text style={s.kpiNote}>{metric.note}</Text> : null}
              </View>
            ))}
          </View>
          <Text style={s.note}>
            Comparisons use current view counts. Shorts uploaded in the earlier window
            have had longer to accumulate views, so the previous period is slightly
            flattered and the current one understated.
          </Text>
        </View>

        {report.insights.length > 0 ? (
          <View style={s.section}>
            <SectionHeading
              title="Key insights"
              sub="Generated directly from the figures above. No causal claims are inferred."
            />
            {report.insights.map((line, i) => (
              <View key={i} style={s.bullet}>
                <Text style={s.bulletDot}>•</Text>
                <Text style={s.bulletText}>{line}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Footer report={report} />
      </Page>

      {/* ---------- Our vs Market ---------- */}
      <Page size="A4" style={s.page}>
        <Header report={report} />

        <View style={s.section}>
          <SectionHeading
            title="Our channels vs the tracked market"
            sub={`${report.ownChannelCount} of our channels against ${report.competitorChannelCount} tracked competitors${report.nicheName ? ` in ${report.nicheName}` : ""}.`}
          />

          <View style={{ flexDirection: "row", gap: 26, marginBottom: 18 }}>
            <View style={{ alignItems: "center" }}>
              <ShareDonut share={report.marketShare} />
              <Text
                style={{
                  fontSize: 7.5,
                  marginTop: 8,
                  color: trendColor(report.marketShareTrend),
                }}
              >
                {trendText(report.marketShareTrend)} vs previous period
              </Text>
            </View>

            <View style={{ flex: 1 }}>
              <View style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 7, color: C.subtle, letterSpacing: 0.6 }}>
                  OUR SHORTS VIEWS
                </Text>
                <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 2 }}>
                  {compact(report.marketShare.ourViews)}
                </Text>
                <Text style={{ fontSize: 7, color: C.subtle, letterSpacing: 0.6, marginTop: 8 }}>
                  TRACKED COMPETITOR VIEWS
                </Text>
                <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 2 }}>
                  {compact(report.marketShare.competitorViews)}
                </Text>
              </View>
              <Text style={{ ...s.note, marginTop: 0 }}>
                Tracked market share is our share of Shorts views among the channels
                currently tracked for this scope. It is not total YouTube market share —
                the denominator contains only tracked channels.
              </Text>
            </View>
          </View>

          <Text style={{ fontSize: 7, color: C.subtle, letterSpacing: 0.6, marginBottom: 6 }}>
            TRACKED MARKET SHARE OVER TIME
          </Text>
          <ShareTrendChart points={report.marketShareSeries} width={505} height={96} />
        </View>

        <View style={s.section}>
          <SectionHeading title="Head to head" />
          <View style={{ flexDirection: "row", gap: 34 }}>
            <View style={{ flex: 1 }}>
              <VsBar
                label="Hit rate"
                ours={report.comparison.metrics.find((m) => m.key === "hitRate")?.ours ?? null}
                market={report.comparison.metrics.find((m) => m.key === "hitRate")?.market ?? null}
                format="percent"
              />
              <VsBar
                label="Median views"
                ours={report.comparison.metrics.find((m) => m.key === "medianViews")?.ours ?? null}
                market={
                  report.comparison.metrics.find((m) => m.key === "medianViews")?.market ?? null
                }
                format="views"
              />
            </View>
            <View style={{ flex: 1 }}>
              <VsBar
                label="Views per upload"
                ours={
                  report.comparison.metrics.find((m) => m.key === "viewsPerUpload")?.ours ?? null
                }
                market={
                  report.comparison.metrics.find((m) => m.key === "viewsPerUpload")?.market ?? null
                }
                format="views"
              />
              <VsBar
                label="Top 10% average"
                ours={report.comparison.metrics.find((m) => m.key === "topDecile")?.ours ?? null}
                market={
                  report.comparison.metrics.find((m) => m.key === "topDecile")?.market ?? null
                }
                format="views"
              />
            </View>
          </View>
          <Text style={s.note}>
            Upload frequency is deliberately excluded from the scorecard: posting more is a
            strategy choice, not a performance result.
          </Text>
        </View>

        <Footer report={report} />
      </Page>

      {/* ---------- Channels + intelligence ---------- */}
      <Page size="A4" style={s.page}>
        <Header report={report} />

        <View style={s.section}>
          <SectionHeading
            title="Our channel performance"
            sub="Each of our channels this period, ranked by Shorts views."
          />
          {report.ourChannels.length === 0 ? (
            <Text style={{ fontSize: 8.5, color: C.muted }}>
              No channels are marked as ours in this scope.
            </Text>
          ) : (
            <>
              <View style={s.tHead}>
                <Text style={{ ...s.tHeadCell, flex: 2.4 }}>CHANNEL</Text>
                <Text style={{ ...s.tHeadCell, flex: 1, textAlign: "right" }}>VIEWS</Text>
                <Text style={{ ...s.tHeadCell, flex: 1, textAlign: "right" }}>HIT RATE</Text>
                <Text style={{ ...s.tHeadCell, flex: 1, textAlign: "right" }}>MEDIAN</Text>
                <Text style={{ ...s.tHeadCell, flex: 0.8, textAlign: "right" }}>UPLOADS</Text>
                <Text style={{ ...s.tHeadCell, flex: 1.1, textAlign: "right" }}>GROWTH</Text>
              </View>
              {report.ourChannels.map((row) => (
                <ChannelRow key={row.channel.id} row={row} />
              ))}
            </>
          )}
        </View>

        <View style={s.section}>
          <SectionHeading
            title="Biggest winners"
            sub="Highest-viewed Shorts across the tracked set this period."
          />
          <ShortsTable shorts={report.topWinners} mode="views" />
        </View>

        <View style={s.section}>
          <SectionHeading
            title="Biggest outliers"
            sub="Shorts that most exceeded their own channel's median. The clearest signal of what to study."
          />
          <ShortsTable shorts={report.topOutliers} mode="multiple" />
        </View>

        <Footer report={report} />
      </Page>
    </Document>
  );
}

function ChannelRow({ row }: { row: ReportChannelRow }) {
  return (
    <View style={s.tRow}>
      <Text style={{ ...s.tCell, flex: 2.4 }}>{row.channel.displayName}</Text>
      <Text style={{ ...s.tCell, flex: 1, textAlign: "right" }}>
        {compact(row.metrics.totalViews)}
      </Text>
      <Text style={{ ...s.tCell, flex: 1, textAlign: "right" }}>
        {/*
          THE RANGE, ON PAPER, WHERE THE 0.0% WOULD HAVE BEEN.

          `pct` guards null and non-finite, and an evidence-limited rate is
          neither — it is a real `0` — so this cell printed "0.0%" for a channel
          whose every bar-clearing Short went unrecorded. On a screen the reader
          can hover the figure and find that out. This is the artefact that
          outlives the screen, which is the argument the cover block above makes
          for printing exclusions rather than footnoting them; it applies to
          this cell more sharply than to anything else in the file, because a
          per-channel 0.0% in a forwarded PDF is read as a verdict on a person's
          work.
        */}
        {row.metrics.hits.evidenceLimited
          ? `${pct(row.metrics.hits.lowerBound, 0)}–${pct(row.metrics.hits.upperBound, 0)}`
          : pct(row.metrics.hits.rate)}
      </Text>
      <Text style={{ ...s.tCell, flex: 1, textAlign: "right" }}>
        {compact(row.metrics.medianViews)}
      </Text>
      <Text style={{ ...s.tCell, flex: 0.8, textAlign: "right" }}>
        {row.metrics.totalShorts}
      </Text>
      <Text
        style={{
          ...s.tCell,
          flex: 1.1,
          textAlign: "right",
          color: trendColor(row.viewsTrend),
          fontSize: 7.5,
        }}
      >
        {trendText(row.viewsTrend)}
      </Text>
    </View>
  );
}

function ShortsTable({
  shorts,
  mode,
}: {
  shorts: readonly ReportShort[];
  mode: "views" | "multiple";
}) {
  if (shorts.length === 0) {
    return (
      <Text style={{ fontSize: 8.5, color: C.muted }}>
        No Shorts met the criteria in this period.
      </Text>
    );
  }

  return (
    <>
      <View style={s.tHead}>
        <Text style={{ ...s.tHeadCell, width: 14 }}>#</Text>
        <Text style={{ ...s.tHeadCell, flex: 3 }}>SHORT</Text>
        <Text style={{ ...s.tHeadCell, flex: 1.4 }}>CHANNEL</Text>
        <Text style={{ ...s.tHeadCell, flex: 1, textAlign: "right" }}>VIEWS</Text>
        <Text style={{ ...s.tHeadCell, flex: 1, textAlign: "right" }}>
          {mode === "multiple" ? "× MEDIAN" : "NICHE"}
        </Text>
      </View>
      {shorts.map((short, i) => (
        <View key={short.youtubeVideoId} style={s.tRow}>
          <Text style={{ ...s.tCell, width: 14, color: C.subtle }}>{i + 1}</Text>
          <Text style={{ ...s.tCell, flex: 3, paddingRight: 8 }}>
            {short.title.length > 62 ? `${short.title.slice(0, 62)}…` : short.title}
          </Text>
          <Text style={{ ...s.tCell, flex: 1.4, color: C.muted, fontSize: 8 }}>
            {short.channelName.length > 18
              ? `${short.channelName.slice(0, 18)}…`
              : short.channelName}
          </Text>
          <Text style={{ ...s.tCell, flex: 1, textAlign: "right" }}>
            {compact(short.views)}
          </Text>
          <Text
            style={{
              ...s.tCell,
              flex: 1,
              textAlign: "right",
              color: mode === "multiple" ? C.success : C.muted,
              fontSize: mode === "multiple" ? 8.5 : 7.5,
            }}
          >
            {mode === "multiple"
              ? short.outlierMultiple === null
                ? "—"
                : `${short.outlierMultiple >= 10 ? Math.round(short.outlierMultiple) : short.outlierMultiple.toFixed(1)}×`
              : (short.nicheNames[0] ?? "—")}
          </Text>
        </View>
      ))}
    </>
  );
}
