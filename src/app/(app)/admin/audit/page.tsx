"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Lock,
  ScrollText,
  User,
  X,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useAdminUsers, useAuditLog } from "@/hooks/use-admin";
import { useNow } from "@/hooks/use-now";
import type { AuditLogQuery } from "@/lib/api-client";
import type { AuditEntryDTO } from "@/server/audit/audit-service";
import {
  AUDIT_CATEGORIES,
  auditActionLabel,
  shouldRecordNetworkContext,
} from "@/lib/audit/actions";
import { EM_DASH, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The audit log.
 *
 * WHAT THIS SCREEN IS, AND WHAT IT IS NOT
 * It answers "who changed access, who touched money, who connected an account"
 * — every row is a deliberate act somebody would expect to be attributable.
 * It is not a record of who read what, how long they looked at a competitor, or
 * when they were at their desk; `src/lib/audit/actions.ts` decides that, and
 * this screen is written to make the distinction visible rather than to quietly
 * benefit from it. Hence the note above the table about network details, and
 * hence IP and user-agent living in a detail row instead of standing as columns
 * that would imply every entry carries them.
 *
 * Raw action keys never reach the page: `auditActionLabel` is the only way an
 * action is rendered, so a new key added server-side degrades to itself rather
 * than to a blank cell, and nobody has to read "finance.entry_deleted".
 */

/** One request's worth of rows. The server clamps `limit` to 200 regardless. */
const PAGE_SIZE = 50;

/** Matches the toolbar triggers on the analytics pages (see scope-filters.tsx). */
const TRIGGER_CLASS =
  "group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong";

type CategoryId = (typeof AUDIT_CATEGORIES)[number]["id"] | "all";

export default function AuditLogPage() {
  const { can } = useSession();

  // An affordance, not the boundary: /api/admin/audit requires `audit.view` on
  // every request. Gating here only spares somebody a 403 they could do nothing
  // about — and stops the request being sent at all, which is why the screen
  // itself lives in a child component.
  if (!can("audit.view")) {
    return (
      <PageContainer>
        <Card>
          <EmptyState
            icon={<Lock />}
            title="You don't have access to the audit log"
            description="Reading the log is its own permission, separate from managing users — an administrator can grant you “View audit log”."
          />
        </Card>
      </PageContainer>
    );
  }

  return <AuditLogScreen />;
}

function AuditLogScreen() {
  const [category, setCategory] = React.useState<CategoryId>("all");
  const [actorId, setActorId] = React.useState<string>("all");
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());

  /**
   * Paging state carries the filter combination it belongs to.
   *
   * Changing a filter therefore resets to page one *during the same render*
   * rather than in an effect. An effect would paint one frame at page four of
   * the newly filtered log first, firing four requests for pages nobody asked
   * for and then throwing three of them away.
   */
  const [paging, setPaging] = React.useState({ key: "all|all", pages: 1 });
  const filterKey = `${category}|${actorId}`;
  const pageCount = paging.key === filterKey ? paging.pages : 1;

  const filters = React.useMemo<AuditLogQuery>(() => {
    const prefix = AUDIT_CATEGORIES.find((entry) => entry.id === category)?.prefix;
    return {
      ...(prefix ? { actionPrefix: prefix } : {}),
      ...(actorId === "all" ? {} : { actorUserId: actorId }),
    };
  }, [category, actorId]);

  /**
   * The first page, and the source of the headline total.
   *
   * Its query key is identical to the one the first `<AuditPageRows>` builds,
   * so React Query serves both from a single request — this is a read of the
   * cache, not a second fetch. Taking the total from *this* page rather than
   * the most recent one keeps the count on screen while a later page loads,
   * instead of blanking every time somebody presses Load more.
   */
  const head = useAuditLog({ ...filters, limit: PAGE_SIZE, offset: 0 });

  const total = head.data?.total ?? 0;
  const loaded = Math.min(pageCount * PAGE_SIZE, total);
  const hasMore = loaded < total;
  const isFiltered = category !== "all" || actorId !== "all";

  const toggleExpanded = React.useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Audit log"
        description="Who changed access, money, channels and connections — the actions a person took deliberately and would expect to be attributable. What people read or search for is never recorded."
      />

      {head.error ? (
        <Card>
          <ErrorState error={head.error} onRetry={() => head.refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryFilter value={category} onChange={setCategory} />
            <ActorFilter
              value={actorId}
              onChange={setActorId}
              entries={head.data?.entries ?? []}
            />
            {isFiltered ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCategory("all");
                  setActorId("all");
                }}
              >
                <X />
                Clear
              </Button>
            ) : null}

            <span className="tnum ml-auto text-[12px] text-muted-foreground">
              {head.isLoading ? EM_DASH : formatNumber(total)}{" "}
              {total === 1 ? "event" : "events"}
              {isFiltered ? " matching" : ""}
            </span>
          </div>

          {/*
            The one line of copy that keeps this screen honest. People read a
            column header as "this is collected about everyone"; saying up front
            where network details do and do not exist is cheaper than letting
            somebody infer the worse answer from a blank cell.
          */}
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            IP address and device are recorded only for security-relevant events — sign-ins,
            changes to access, account connections and financial exports. Ordinary activity
            is attributed to a person and a time, and nothing more.
          </p>

          <Card className="overflow-hidden">
            {!head.isLoading && total === 0 ? (
              <EmptyState
                icon={<ScrollText />}
                title={isFiltered ? "No events match these filters" : "Nothing recorded yet"}
                description={
                  isFiltered
                    ? "Try a wider category, or clear the actor filter."
                    : "The log fills as people sign in, change access, edit finances and connect accounts. Nothing is written until somebody does one of those things."
                }
              />
            ) : (
              <>
                {/*
                  `useAuditLog` holds the previous result while a new filter
                  loads, so the table never blanks mid-investigation. Dimming it
                  is what stops that kindness becoming a lie: for a beat these
                  rows and that total describe the *previous* filter, and saying
                  so is cheaper than letting somebody read a stale count as the
                  answer to the question they just asked.
                */}
                <div
                  className={cn(
                    "overflow-x-auto transition-opacity duration-150",
                    head.isPlaceholderData && "opacity-50",
                  )}
                >
                  <table
                    className="w-full min-w-[880px] border-collapse text-left"
                    aria-label="Audit log, newest first"
                  >
                    <thead>
                      <tr className="border-b border-border bg-surface-sunken">
                        <Th className="w-[168px]">Time</Th>
                        <Th className="w-[150px]">Actor</Th>
                        <Th className="w-[186px]">Action</Th>
                        <Th>Summary</Th>
                        <Th className="w-[176px]">Target</Th>
                        <th scope="col" className="w-[44px] px-3 py-2 pr-4">
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>

                    {/*
                      One <tbody> per loaded page — valid HTML, and it means
                      each page owns its own query instead of the page
                      re-requesting every row it already has each time the list
                      grows. Pages already on screen keep their data while the
                      new one loads.
                    */}
                    {Array.from({ length: pageCount }, (_, index) => (
                      // Keyed by position, not by filter: a change of filter
                      // must not remount these, or the rows would blank to a
                      // skeleton while the total above them still showed the
                      // previous result.
                      <AuditPageRows
                        key={index}
                        filters={filters}
                        offset={index * PAGE_SIZE}
                        expanded={expanded}
                        onToggle={toggleExpanded}
                      />
                    ))}
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="tnum text-[12px] text-muted-foreground">
                    {head.isLoading
                      ? "Loading…"
                      : `Showing ${formatNumber(loaded)} of ${formatNumber(total)}`}
                  </span>

                  {hasMore ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPaging({ key: filterKey, pages: pageCount + 1 })}
                    >
                      Load {Math.min(PAGE_SIZE, total - loaded)} more
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One page of the log.
 *
 * Deliberately its own component so the `useAuditLog` call it owns is scoped to
 * this page's offset. Mounting another one is what "Load more" does.
 */
function AuditPageRows({
  filters,
  offset,
  expanded,
  onToggle,
}: {
  filters: AuditLogQuery;
  offset: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const { data, isLoading } = useAuditLog({ ...filters, limit: PAGE_SIZE, offset });
  const now = useNow();

  if (isLoading) {
    return (
      <tbody>
        {Array.from({ length: offset === 0 ? 8 : 3 }, (_, index) => (
          <tr key={index} className="border-b border-border">
            <td colSpan={6} className="px-4 py-3">
              <Skeleton className="h-4 w-full" />
            </td>
          </tr>
        ))}
      </tbody>
    );
  }

  return (
    <tbody>
      {(data?.entries ?? []).map((entry) => {
        const open = expanded.has(entry.id);
        return (
          <React.Fragment key={entry.id}>
            <tr className="border-b border-border transition-colors duration-100 hover:bg-surface-hover">
              <td className="px-3 py-2.5 pl-4 align-top">
                <div className="tnum text-[12px] text-foreground">
                  {formatDateTime(entry.createdAt)}
                </div>
                <div className="text-[11px] text-subtle-foreground">
                  {formatRelativeTime(entry.createdAt, now === 0 ? undefined : now)}
                </div>
              </td>

              <td className="px-3 py-2.5 align-top">
                {/* A null actor is the scheduler, not a missing name — say so
                    rather than rendering an em dash that reads as lost data. */}
                <div
                  className={cn(
                    "truncate text-[12px]",
                    entry.actorName ? "text-foreground" : "text-subtle-foreground",
                  )}
                >
                  {entry.actorName ?? "System"}
                </div>
              </td>

              <td className="px-3 py-2.5 align-top">
                <span className="text-[12px] font-medium text-foreground">
                  {auditActionLabel(entry.action)}
                </span>
              </td>

              <td className="px-3 py-2.5 align-top">
                <span className="text-[12px] leading-relaxed text-muted-foreground">
                  {entry.summary}
                </span>
              </td>

              <td className="px-3 py-2.5 align-top">
                {entry.targetLabel || entry.targetType ? (
                  <>
                    <div className="truncate text-[12px] text-foreground">
                      {entry.targetLabel ?? EM_DASH}
                    </div>
                    {entry.targetType ? (
                      <div className="text-[11px] text-subtle-foreground">
                        {entry.targetType.replace(/_/g, " ")}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[12px] text-subtle-foreground">{EM_DASH}</span>
                )}
              </td>

              <td className="px-3 py-2.5 pr-4 align-top">
                <button
                  type="button"
                  onClick={() => onToggle(entry.id)}
                  aria-expanded={open}
                  aria-controls={`audit-detail-${entry.id}`}
                  aria-label={open ? "Hide details" : "Show details"}
                  className="inline-flex size-6 items-center justify-center rounded text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </button>
              </td>
            </tr>

            {open ? (
              <tr id={`audit-detail-${entry.id}`} className="border-b border-border">
                <td colSpan={6} className="bg-surface-sunken px-4 py-3">
                  <AuditEntryDetail entry={entry} />
                </td>
              </tr>
            ) : null}
          </React.Fragment>
        );
      })}
    </tbody>
  );
}

/**
 * The parts of an entry that do not belong in a column.
 *
 * IP and user-agent are the reason this row exists. Only a minority of actions
 * carry them, so a column would be mostly blank and would invite the reading
 * that the blanks are a gap rather than a decision — `shouldRecordNetworkContext`
 * is the same predicate the writer used, so this can state which of the two it
 * is for every single row.
 */
function AuditEntryDetail({ entry }: { entry: AuditEntryDTO }) {
  const networkRecorded = shouldRecordNetworkContext(entry.action);
  const metadata = Object.entries(entry.metadata ?? {});

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="IP address">
          {networkRecorded ? (
            <span className="tnum">{entry.ipAddress ?? "Not captured"}</span>
          ) : (
            <span className="text-subtle-foreground">Not recorded for this action</span>
          )}
        </DetailField>

        <DetailField label="Device">
          {networkRecorded ? (
            <span className="break-words">{entry.userAgent ?? "Not captured"}</span>
          ) : (
            <span className="text-subtle-foreground">Not recorded for this action</span>
          )}
        </DetailField>

        <DetailField label="Actor account">
          {entry.actorId ? (
            <span className="font-mono text-[11px]">{entry.actorId}</span>
          ) : (
            <span className="text-subtle-foreground">
              {entry.actorName ? "Account no longer linked" : "System"}
            </span>
          )}
        </DetailField>

        <DetailField label="Event id">
          <span className="font-mono text-[11px]">{entry.id}</span>
        </DetailField>
      </dl>

      {metadata.length > 0 ? (
        <div className="border-t border-border pt-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Recorded details
          </div>
          {/* Keys are shown raw and monospaced on purpose: this is the data the
              server wrote, and prettifying the field names would misrepresent
              what is actually stored. */}
          <dl className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {metadata.map(([key, value]) => (
              <div key={key} className="flex min-w-0 gap-2">
                <dt className="shrink-0 font-mono text-[11px] text-subtle-foreground">
                  {key}
                </dt>
                <dd className="min-w-0 break-words text-[12px] text-muted-foreground">
                  {formatMetadataValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("px-3 py-2 first:pl-4", className)}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {children}
      </span>
    </th>
  );
}

/** Metadata is `unknown` by type and JSON by origin — rendered, never guessed at. */
function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "string") return value.length > 0 ? value : EM_DASH;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function CategoryFilter({
  value,
  onChange,
}: {
  value: CategoryId;
  onChange: (value: CategoryId) => void;
}) {
  const label =
    AUDIT_CATEGORIES.find((entry) => entry.id === value)?.label ?? "All categories";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS}>
          <Layers className="size-3.5 text-subtle-foreground" />
          <span className="text-muted-foreground">Category</span>
          <span className="max-w-[150px] truncate text-foreground">{label}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as CategoryId)}
        >
          <DropdownMenuRadioItem value="all">All categories</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {AUDIT_CATEGORIES.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActorOption {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * Filter by who did it.
 *
 * The full directory is the better list, but reading it needs `users.manage`,
 * and `audit.view` is deliberately a separate permission — the whole point of
 * the split is that somebody can investigate an incident without also being
 * handed the ability to change who has access. Asking for the directory anyway
 * would hand that person a 403 on a screen they are entitled to use, so the
 * control falls back to the actors already visible in the log.
 */
function ActorFilter({
  value,
  onChange,
  entries,
}: {
  value: string;
  onChange: (value: string) => void;
  entries: readonly AuditEntryDTO[];
}) {
  const { can } = useSession();

  if (can("users.manage")) {
    return <DirectoryActorFilter value={value} onChange={onChange} />;
  }

  const seen = new Map<string, ActorOption>();
  for (const entry of entries) {
    if (entry.actorId && !seen.has(entry.actorId)) {
      seen.set(entry.actorId, { id: entry.actorId, label: entry.actorName ?? "Unnamed" });
    }
  }

  return (
    <ActorMenu
      value={value}
      onChange={onChange}
      options={[...seen.values()]}
      note="People appearing in the newest entries."
    />
  );
}

function DirectoryActorFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { data, isLoading } = useAdminUsers();

  // Deactivated accounts stay in the list. Their history is exactly what
  // somebody comes to this screen to read, and dropping them would make the
  // most interesting person in the log the one who cannot be selected.
  const options = React.useMemo<ActorOption[]>(
    () =>
      [...(data?.users ?? [])]
        .map((user) => ({
          id: user.id,
          label: user.name ?? user.email ?? "Unnamed",
          hint: user.status === "active" ? user.roleLabel : user.status,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [data],
  );

  return (
    <ActorMenu
      value={value}
      onChange={onChange}
      options={options}
      note={isLoading ? "Loading the directory…" : undefined}
    />
  );
}

function ActorMenu({
  value,
  onChange,
  options,
  note,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly ActorOption[];
  note?: string;
}) {
  const label = options.find((option) => option.id === value)?.label ?? "Anyone";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS}>
          <User className="size-3.5 text-subtle-foreground" />
          <span className="text-muted-foreground">Actor</span>
          <span className="max-w-[150px] truncate text-foreground">{label}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="all">Anyone</DropdownMenuRadioItem>

          {options.length > 0 ? <DropdownMenuSeparator /> : null}

          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-[11px] text-subtle-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {note ? (
          <>
            <DropdownMenuSeparator />
            {/* A sentence, not a heading — the component's uppercase default
                is meant for section labels. */}
            <DropdownMenuLabel className="text-[11px] font-normal normal-case tracking-normal">
              {note}
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
