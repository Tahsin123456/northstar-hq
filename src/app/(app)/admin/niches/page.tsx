"use client";

import * as React from "react";
import Link from "next/link";
import { Layers, Target } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { nicheColor } from "@/components/niches/niche-chip";
import {
  NicheThresholdDialog,
  useCanConfigureThreshold,
  useHitPaymentCurrency,
} from "@/components/niches/niche-threshold-dialog";
import {
  NICHE_KIND_DESCRIPTION,
  NICHE_KIND_LABEL,
} from "@/lib/niches/niche-kind";
import { formatMoneyTrimmed } from "@/lib/finance/money";
import {
  NeedsRuleBadge,
  NicheByline,
  needsRuleConfiguration,
  unconfiguredFirst,
} from "@/components/niches/niche-threshold-status";
import { useNicheList } from "@/hooks/use-niches";
import type { NicheDTO } from "@/lib/dto";
import { UNCONFIGURED_RULE_SHORT } from "@/lib/analytics/constants";
import { formatNumber, formatThresholdLong, pluralize } from "@/lib/format";
import { formatHitWindow } from "@/lib/analytics/hit-rate";
import { cn } from "@/lib/utils";

/**
 * Admin › Niches — the configuration view of the taxonomy.
 *
 * The Niches page under the main nav answers "how is each niche performing?".
 * This one answers a different question: "which niches are not properly set up,
 * and who do I talk to about them?" That is why it is a list rather than a grid
 * of cards, carries no analytics at all, and leads with the threshold column.
 *
 * WHY IT EXISTS AT ALL
 * An employee with `niches.manage` can create a niche but not threshold it, so
 * an unconfigured niche is a normal, expected product of ordinary work — not an
 * error state. Something has to make the resulting queue visible to the one
 * person who can clear it, or the niche quietly reports no hit rate forever and
 * nobody finds out until somebody asks why a dashboard is blank.
 *
 * Unconfigured niches sort first, and the count is stated above the list, so
 * the work is visible without scrolling. Every row carries its creator, because
 * "what should this number be?" is a question for the person who made the
 * niche, not a decision for the admin to invent alone.
 */
export default function AdminNichesPage() {
  const { data, isLoading, error, refetch } = useNicheList();
  const canConfigure = useCanConfigureThreshold();
  // A hit payment is money, and money needs a currency. The organization's base
  // currency is the only defensible one: `Niche.hitPaymentMinor` has no
  // currency column, because one organization pays in one currency.
  const currency = useHitPaymentCurrency();

  const niches = React.useMemo(
    () => unconfiguredFirst(data?.niches ?? []),
    [data?.niches],
  );

  const unconfigured = niches.filter(needsRuleConfiguration);
  /*
   * Niches that CAN score and CANNOT pay.
   *
   * A separate queue from the one above, deliberately. A niche with half a rule
   * reports nothing anywhere and is visible on every chart; one with a complete
   * rule and no price looks perfectly healthy and quietly pays nobody, which is
   * only discovered on a payroll run. Production only — a watchlist niche has
   * no reason to carry a price and is not somebody's outstanding task.
   */
  const unpriced = niches.filter(
    (niche) =>
      niche.kind === "production" &&
      !needsRuleConfiguration(niche) &&
      niche.hitPaymentMinor === null,
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Niches"
        description="Every niche in the organization, what kind it is, and what counts as a hit in it: a view threshold, the window a Short has to reach it in, and what one hit pays. A niche missing either half of the rule reports no hit rate anywhere in the app; one missing only the payment scores normally and pays nothing. Watchlist niches are followed rather than published into — they are left out of the portfolio hit rate and pay no bonus."
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href="/niches">
              <Layers />
              Niche performance
            </Link>
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading ? (
        <Card className="flex flex-col gap-3 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </Card>
      ) : niches.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers />}
            title="No niches yet"
            description="Niches are created from the Niches page. Once one exists, its hit rule — the view threshold and the hit window — is configured here."
          />
        </Card>
      ) : (
        <>
          {unconfigured.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle/40 px-3 py-2">
              <Target className="size-3.5 shrink-0 text-warning" aria-hidden />
              <p className="text-[12px] text-foreground">
                {formatNumber(unconfigured.length)}{" "}
                {pluralize(unconfigured.length, "niche", "niches")}{" "}
                {unconfigured.length === 1 ? "needs" : "need"} a complete hit rule
                <span className="text-muted-foreground">
                  {" "}
                  — {unconfigured.map((niche) => niche.name).join(", ")}
                </span>
              </p>
            </div>
          ) : null}

          {unpriced.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle/40 px-3 py-2">
              <Target className="size-3.5 shrink-0 text-warning" aria-hidden />
              <p className="text-[12px] text-foreground">
                {formatNumber(unpriced.length)}{" "}
                {pluralize(unpriced.length, "niche", "niches")}{" "}
                {unpriced.length === 1 ? "scores hits but pays" : "score hits but pay"}{" "}
                nothing
                <span className="text-muted-foreground">
                  {" "}
                  — {unpriced.map((niche) => niche.name).join(", ")}. The hit rate is
                  reported normally; the bonus is not, and the payroll run names them
                  before a month can be finalized.
                </span>
              </p>
            </div>
          ) : null}

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <div
                className="min-w-[640px]"
                role="table"
                aria-label="Niches and their hit rules"
              >
                <div role="rowgroup">
                  <div
                    className="grid items-center gap-3 border-b border-border bg-surface-sunken px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground"
                    style={{ gridTemplateColumns: GRID }}
                    role="row"
                  >
                    <div role="columnheader">Niche</div>
                    <div role="columnheader">Kind</div>
                    <div role="columnheader">Hit rule</div>
                    {/* The third number, beside the two it belongs with. A
                        complete rule and no price scores perfectly and pays
                        nobody, which is invisible until a payroll run — so it
                        gets a column here rather than only a warning there. */}
                    <div role="columnheader" className="text-right">
                      Per hit
                    </div>
                    <div role="columnheader">Created by</div>
                    <div role="columnheader" className="text-right">
                      Channels
                    </div>
                    <div role="columnheader" className="sr-only">
                      Actions
                    </div>
                  </div>
                </div>

                <div role="rowgroup">
                  {niches.map((niche) => (
                    <NicheRow
                      key={niche.id}
                      niche={niche}
                      canConfigure={canConfigure}
                      currency={currency}
                    />
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

const GRID =
  "minmax(150px,1.3fr) 92px minmax(150px,1fr) minmax(96px,0.7fr) minmax(110px,1fr) 76px 116px";

function NicheRow({
  niche,
  canConfigure,
  currency,
}: {
  niche: NicheDTO;
  canConfigure: boolean;
  /** The organization's base currency, which is what a hit payment is in. */
  currency: string;
}) {
  const [open, setOpen] = React.useState(false);
  const needsThreshold = needsRuleConfiguration(niche);

  return (
    <>
      <div
        className={cn(
          "grid items-center gap-3 border-b border-border px-4 py-3 last:border-b-0",
          // A tint rather than a border colour: the row is a queue item, and it
          // should be findable while scrolling past thirty configured ones.
          needsThreshold ? "bg-warning-subtle/25" : null,
        )}
        style={{ gridTemplateColumns: GRID }}
        role="row"
      >
        <div role="cell" className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: nicheColor(niche.colorIndex) }}
          />
          <span className="truncate text-[13px] font-medium text-foreground">
            {niche.name}
          </span>
        </div>

        {/* Named with the owner's own word. A watchlist niche is left out of
            the portfolio hit rate and pays nothing, so an admin reading this
            list needs to know which kind a row is before its other columns
            mean anything. */}
        <div role="cell" className="min-w-0">
          <Badge
            variant={niche.kind === "watchlist" ? "neutral" : "near"}
            size="sm"
            className="normal-case tracking-normal"
            title={NICHE_KIND_DESCRIPTION[niche.kind]}
          >
            {NICHE_KIND_LABEL[niche.kind]}
          </Badge>
        </div>

        <div role="cell" className="min-w-0">
          {needsThreshold ? (
            <NeedsRuleBadge niche={niche} />
          ) : (
            <span className="tnum text-[13px] text-foreground">
              {formatThresholdLong(niche.hitThreshold as number)}
              {/*
                Both halves, because both halves are the rule. A cell showing
                only the number would read as the old lifetime bar, which is
                the thing an admin is here to stop the product doing.
              */}
              <span className="text-muted-foreground">
                {" "}
                within {formatHitWindow(niche.hitWindowHours as number)}
              </span>
            </span>
          )}
        </div>

        {/*
          THE PRICE, WITH ITS OWN "not set" STATE.

          Blank would read as zero and zero would read as "a hit here is worth
          nothing", which is the reading that turns a configuration gap into a
          decision somebody thinks was made. A watchlist niche says something
          different again: there is nothing to set, because nobody is paid.
        */}
        <div role="cell" className="tnum text-right text-[13px]">
          {niche.kind === "watchlist" ? (
            <span className="text-subtle-foreground" title="Watchlist niches pay no hit bonus.">
              Not paid
            </span>
          ) : niche.hitPaymentMinor === null ? (
            <span className="text-warning">Not set</span>
          ) : (
            <span className="text-foreground">
              {formatMoneyTrimmed(niche.hitPaymentMinor, currency)}
            </span>
          )}
        </div>

        <div role="cell" className="min-w-0 truncate">
          <NicheByline niche={niche} className="text-[12px]" />
        </div>

        <div role="cell" className="tnum text-right text-[13px] text-muted-foreground">
          {formatNumber(niche.channelCount)}
        </div>

        <div role="cell" className="flex justify-end">
          {canConfigure ? (
            <Button
              // The unconfigured rows are the work; give theirs the weight.
              variant={needsThreshold ? "primary" : "ghost"}
              size="sm"
              onClick={() => setOpen(true)}
            >
              <Target />
              {needsThreshold ? "Set" : "Edit"}
            </Button>
          ) : (
            <span className="text-[11px] text-subtle-foreground">
              {needsThreshold ? UNCONFIGURED_RULE_SHORT : null}
            </span>
          )}
        </div>
      </div>

      <NicheThresholdDialog niche={niche} open={open} onOpenChange={setOpen} />
    </>
  );
}
