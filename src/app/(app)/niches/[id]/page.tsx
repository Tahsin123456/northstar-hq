"use client";

import * as React from "react";
import { use } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, Layers, Shapes } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { nicheColor } from "@/components/niches/niche-chip";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  NeedsThresholdBadge,
  NicheByline,
  needsThresholdConfiguration,
} from "@/components/niches/niche-threshold-status";
import { useDataset } from "@/hooks/use-dataset";
import { UNCONFIGURED_THRESHOLD_SHORT } from "@/lib/analytics/constants";
import { formatCompactNumber, formatNumber } from "@/lib/format";

/**
 * A niche, and how it is configured.
 *
 * CONTENT TYPES ARE NO LONGER HERE. They lived on this page for one round,
 * because the catalogue was `[nicheId, slug]`-unique and every verb on it had
 * to name a niche. That is reversed — a content type is a flat org-wide tag,
 * one list for the whole team — so the vocabulary went back to `/content-types`
 * and this page stopped being a second place to edit a taxonomy it does not
 * own. What is left below is the configuration that genuinely belongs to a
 * niche and has nowhere else to live: its threshold, its author, its channels.
 *
 * Deliberately NOT a per-niche dashboard. The card on `/niches` already answers
 * "is this niche worth my attention?" and the Overview answers it properly when
 * filtered; a third set of charts here would be a third place the same number
 * could disagree with itself.
 */
export default function NicheDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error, refetch } = useDataset();

  const niche = React.useMemo(
    () => data?.niches.find((n) => n.id === id) ?? null,
    [data, id],
  );

  const channels = React.useMemo(
    () =>
      (data?.channels ?? []).filter((entry) =>
        entry.channel.niches.some((n) => n.id === id),
      ),
    [data, id],
  );

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  if (isLoading || !data) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </PageContainer>
    );
  }

  if (!niche) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <BackLink />
        <Card>
          <EmptyState
            icon={<Layers />}
            title="Niche not found"
            description="It may have been deleted, or it belongs to a part of the tracker you are not assigned to."
            action={
              <Button variant="secondary" asChild>
                <Link href="/niches">Back to niches</Link>
              </Button>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  const needsThreshold = needsThresholdConfiguration(niche);

  return (
    <PageContainer className="flex flex-col gap-5">
      <BackLink />

      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: nicheColor(niche.colorIndex) }}
            />
            <span className="truncate">{niche.name}</span>
          </span>
        }
        description="Which slice of the operation these channels belong to, and how the numbers are read here. What a Short IS — its content type — is a separate, organization-wide tag."
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href={`/?niche=${encodeURIComponent(niche.id)}`}>
              <BarChart3 />
              Open dashboard
            </Link>
          </Button>
        }
      />

      {/* The configuration facts, in one strip. Not analytics — these are the
          settings that decide how every other screen reads this niche, and the
          threshold in particular is the one an admin is most often here to
          fix. */}
      <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-4">
        <Fact
          label="Channels"
          value={formatNumber(channels.length)}
          hint={channels.length === 0 ? "None assigned yet" : undefined}
        />
        <Fact
          label="Hit threshold"
          value={
            niche.hitThreshold === null
              ? UNCONFIGURED_THRESHOLD_SHORT
              : `≥ ${formatCompactNumber(niche.hitThreshold)}`
          }
          muted={niche.hitThreshold === null}
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {needsThreshold ? <NeedsThresholdBadge /> : null}
          <NicheByline niche={niche} />
          <SetNicheThresholdButton
            niche={niche}
            label={needsThreshold ? "Set threshold" : "Change threshold"}
            variant="ghost"
          />
        </div>
      </Card>

      {/*
       * A signpost, not a panel.
       *
       * Somebody who managed this niche's vocabulary here last week has to be
       * told where it went, and told once rather than left to search. Linking
       * beats re-mounting the manager: the catalogue is shared, so an editing
       * surface here would be editing every niche's list while appearing to
       * edit this one.
       */}
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Shapes aria-hidden className="size-4 shrink-0 text-subtle-foreground" />
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
          Content types are one shared list for the whole team, not this niche&rsquo;s
          own — any channel and any Short can carry any of them.
        </p>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/content-types">Manage content types</Link>
        </Button>
      </Card>

      {channels.length === 0 ? (
        <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
          No channels are filed under {niche.name} yet, so it contributes nothing to the
          dashboard. File a channel under this niche from{" "}
          <Link href="/channels" className="text-accent hover:text-accent-hover">
            Channels
          </Link>
          .
        </p>
      ) : null}
    </PageContainer>
  );
}

function BackLink() {
  return (
    <Link
      href="/niches"
      className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      All niches
    </Link>
  );
}

function Fact({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  /** For a value that is a word rather than a figure — "Not configured". */
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </span>
      <span
        className={
          muted
            ? "text-[13px] font-medium text-subtle-foreground"
            : "tnum text-[16px] font-medium text-foreground"
        }
      >
        {value}
      </span>
      {hint ? <span className="text-[11px] text-subtle-foreground">{hint}</span> : null}
    </div>
  );
}
