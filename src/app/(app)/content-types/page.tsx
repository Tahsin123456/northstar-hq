"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ContentTypeManager } from "@/components/content-types/content-type-manager";
import { useOptionalSession } from "@/components/providers/session-provider";
import { useContentTypeCatalogue } from "@/hooks/use-content-types";
import { formatNumber } from "@/lib/format";

/**
 * THE content-type screen — the one centralised catalogue, and the only place
 * it is edited.
 *
 * It went away as an editing surface last round, when a content type belonged
 * to a niche and every verb on this page had to name one before it could do
 * anything. That is reversed: a content type is a flat org-wide tag again, so
 * the page named after the thing is the page that manages it. There is no
 * second editing surface on a niche any more — that page has since been removed
 * altogether — for the reason there was never meant to be two: a taxonomy
 * written from two screens is a taxonomy whose rules drift.
 *
 * SEARCH IS SERVER-SIDE, and that is why this page keeps its own query rather
 * than reading the catalogue out of the dataset like every chip in the app
 * does. The usage counts come back with the rows; filtering a cached list in
 * the browser would show a match whose counts were fetched under a different
 * question.
 */
export default function ContentTypesPage() {
  const session = useOptionalSession();
  const canManage = session?.can("niches.manage") ?? false;

  const [search, setSearch] = React.useState("");
  const trimmed = search.trim();
  const searching = trimmed.length > 0;

  const { data, isLoading, error, refetch } = useContentTypeCatalogue({
    includeInactive: true,
    search: trimmed,
  });

  const contentTypes = React.useMemo(() => data?.contentTypes ?? [], [data]);

  const totals = React.useMemo(() => {
    const active = contentTypes.filter((type) => type.isActive).length;
    return { active, archived: contentTypes.length - active };
  }, [contentTypes]);

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Content types"
        description="What a Short is, as opposed to which slice of the operation made it. One list for the whole team — tag a channel with what it makes, and a Short with what it turned out to be."
      />

      <div className="relative max-w-xs">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground"
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search content types"
          aria-label="Search content types"
          className="pl-8"
        />
        {searching ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2"
            onClick={() => setSearch("")}
          >
            <X />
          </Button>
        ) : null}
      </div>

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : searching && contentTypes.length === 0 ? (
        <Card className="px-4 py-6">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing matches &ldquo;{trimmed}&rdquo;. Clear the search to see the whole
            catalogue.
          </p>
        </Card>
      ) : (
        <>
          {searching ? (
            <p className="px-1 text-[12px] text-muted-foreground">
              {formatNumber(contentTypes.length)}{" "}
              {contentTypes.length === 1 ? "match" : "matches"} for &ldquo;{trimmed}
              &rdquo;
              {totals.archived > 0
                ? ` · ${formatNumber(totals.archived)} archived`
                : ""}
              {" · "}
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-accent transition-colors hover:text-accent-hover"
              >
                clear
              </button>
            </p>
          ) : null}

          <ContentTypeManager
            contentTypes={contentTypes}
            /*
             * Reordering is refused while a search is active, and refused here
             * rather than fudged: the server takes the COMPLETE order and this
             * list is a subset, so the only ways to send one would be to invent
             * positions for the hidden rows or to hold a second unfiltered copy
             * and hope the two agree. Hiding the controls says so honestly.
             */
            reorderable={!searching}
            canManage={canManage}
          />
        </>
      )}
    </PageContainer>
  );
}
