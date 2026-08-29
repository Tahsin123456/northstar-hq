"use client";

import * as React from "react";
import { Check, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { BRAND, reportFilename } from "@/lib/brand";
import { buildReport } from "@/lib/report/build-report";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { useNow } from "@/hooks/use-now";
import { customRangeFromDates, fromDateInputValue, toDateInputValue } from "@/lib/date-range";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import {
  UNCONFIGURED_THRESHOLD_LABEL,
  UNCONFIGURED_THRESHOLD_SHORT,
} from "@/lib/analytics/constants";
import { formatCompactNumber, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Report generation.
 *
 * The PDF is built **in the browser from the same dataset object the screens
 * just rendered from**, which is what makes "the PDF must match the dashboard"
 * a structural guarantee rather than a promise. There is no server-side
 * re-query to drift, and no second analytics implementation.
 *
 * `@react-pdf/renderer` is imported lazily: it is a large dependency that most
 * sessions never touch, and loading it on every page view to serve an
 * occasional export would be a poor trade.
 */

interface PeriodOption {
  id: string;
  label: string;
  days: number | null;
}

const PERIOD_OPTIONS: PeriodOption[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "custom", label: "Custom range", days: null },
];

export function GenerateReportDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [periodId, setPeriodId] = React.useState("7d");
  const [customStart, setCustomStart] = React.useState("");
  const [customEnd, setCustomEnd] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { data } = useDataset();
  const { threshold, thresholdSource, niche } = useFilters();
  const now = useNow();

  const nicheName =
    niche === "all"
      ? null
      : niche === "unassigned"
        ? "Uncategorised"
        : (data?.niches.find((n) => n.id === niche)?.name ?? null);

  const selected = PERIOD_OPTIONS.find((p) => p.id === periodId) ?? PERIOD_OPTIONS[0];

  const resolvedRange = React.useMemo(() => {
    // The clock store reports 0 until it subscribes. Rather than reading an
    // impure Date.now() during render, a trailing preset simply has no resolved
    // range for that one frame, and the Download button stays disabled.
    if (selected.days !== null) {
      if (now === 0) return null;
      return { startMs: now - selected.days * 86_400_000, endMs: now };
    }
    const start = fromDateInputValue(customStart);
    const end = fromDateInputValue(customEnd);
    if (!start || !end) return null;
    const sel = customRangeFromDates(start, end);
    return { startMs: sel.customStartMs!, endMs: sel.customEndMs! };
  }, [selected, customStart, customEnd, now]);

  const handleGenerate = async () => {
    if (!data) return;
    if (!resolvedRange) {
      setError("Choose both a start and an end date.");
      return;
    }
    if (resolvedRange.startMs >= resolvedRange.endMs) {
      setError("The start date must be before the end date.");
      return;
    }
    /*
     * A report with no threshold is refused rather than generated with a
     * borrowed one.
     *
     * The PDF is the one artefact that leaves the app and gets circulated
     * without the screen around it, so it is the worst possible place for a
     * figure whose provenance is "the app picked a number". Every page of it —
     * cover, hit rates, Winners, the market comparison — is a statement about
     * the threshold, so there is no honest partial report to fall back to.
     */
    if (threshold === null) {
      setError(
        `${UNCONFIGURED_THRESHOLD_LABEL}. Set a hit rate threshold for ${nicheName ?? "this niche"} before generating a report, or switch to All niches.`,
      );
      return;
    }

    setError(null);
    setGenerating(true);

    try {
      // Loaded on demand — see the note at the top of this file.
      const [{ pdf }, { ReportDocument }] = await Promise.all([
        import("@react-pdf/renderer"),
        import("@/lib/report/report-document"),
      ]);

      const report = buildReport({
        dataset: data,
        range: resolvedRange,
        threshold,
        nicheId: niche === "all" ? null : niche,
        periodLabel: selected.label,
        // Passed through as-is: reporting a temporary override as the account
        // default would misstate how the numbers in the report were produced.
        // "unconfigured" cannot reach here — the guard above returns first —
        // so the report's own narrower union stays honest.
        thresholdSource: thresholdSource === "unconfigured" ? "account" : thresholdSource,
        now: resolvedRange.endMs,
      });

      const blob = await pdf(<ReportDocument report={report} />).toBlob();

      const filename = reportFilename(report.nicheName, new Date(report.generatedAt));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke on the next tick so the download has definitely started.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast.success("Report ready", { description: filename });
      setOpen(false);
    } catch (caught) {
      console.error("[report] generation failed", caught);
      setError(
        caught instanceof Error
          ? `Could not build the report: ${caught.message}`
          : "Could not build the report.",
      );
    } finally {
      setGenerating(false);
    }
  };

  const previousLabel = resolvedRange
    ? `${formatDate(resolvedRange.startMs - (resolvedRange.endMs - resolvedRange.startMs))} – ${formatDate(resolvedRange.startMs)}`
    : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="primary" size="sm">
            <FileText />
            Generate report
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Generate report</DialogTitle>
          <DialogDescription>
            A branded {BRAND.company} PDF, built from exactly the data on screen.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Reporting period</Label>
            <div className="grid grid-cols-2 gap-2">
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setPeriodId(option.id);
                    setError(null);
                  }}
                  aria-pressed={periodId === option.id}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors",
                    periodId === option.id
                      ? "border-accent bg-accent-subtle text-foreground"
                      : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {option.label}
                  {periodId === option.id ? (
                    <Check className="size-3.5 shrink-0 text-accent" />
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {selected.days === null ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="report-start">Start</Label>
                <Input
                  id="report-start"
                  type="date"
                  value={customStart}
                  max={now > 0 ? toDateInputValue(now) : undefined}
                  onChange={(e) => {
                    setCustomStart(e.target.value);
                    setError(null);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="report-end">End</Label>
                <Input
                  id="report-end"
                  type="date"
                  value={customEnd}
                  max={now > 0 ? toDateInputValue(now) : undefined}
                  onChange={(e) => {
                    setCustomEnd(e.target.value);
                    setError(null);
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* What the report will actually contain, before committing to it. */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-sunken p-3 text-[12px]">
            <Row label="Scope" value={nicheName ?? "All niches"} />
            <Row
              label="Hit threshold"
              value={
                threshold === null
                  ? UNCONFIGURED_THRESHOLD_SHORT
                  : `${formatCompactNumber(threshold)} views · ${
                      thresholdSource === "niche"
                        ? `${nicheName} default`
                        : thresholdSource === "override"
                          ? "override"
                          : "account default"
                    }`
              }
            />
            <Row
              label="Period"
              value={
                resolvedRange
                  ? `${formatDate(resolvedRange.startMs)} – ${formatDate(resolvedRange.endMs)}`
                  : "—"
              }
            />
            <Row label="Compared against" value={previousLabel ?? "—"} />
            <Row
              label="Channels"
              value={
                data
                  ? `${data.channels.filter((c) => c.channel.ownershipType === "own").length} ours · ${data.channels.filter((c) => c.channel.ownershipType !== "own").length} tracked`
                  : "—"
              }
            />
          </div>

          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}

          <FieldHint>
            Every figure comes from the same analytics the app displays, so the report and
            the dashboard cannot disagree.
          </FieldHint>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleGenerate}
            loading={generating}
            // Disabled rather than allowed-then-refused: the summary directly
            // above already says "Not configured", so the button being dead is
            // the consistent reading of it rather than a surprise.
            disabled={!data || !resolvedRange || threshold === null}
          >
            {generating ? "Building PDF…" : "Download PDF"}
            {generating ? null : <Download />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right text-foreground">{value}</span>
    </div>
  );
}
