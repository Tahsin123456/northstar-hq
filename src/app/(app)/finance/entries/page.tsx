"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import { useFilters } from "@/components/providers/filters-provider";
import { useNow } from "@/hooks/use-now";
import {
  financeRangeFor,
  useCreateFinanceEntry,
  useDeleteFinanceEntry,
  useFinanceEntries,
  useFinanceOverview,
  useUpdateFinanceEntry,
} from "@/hooks/use-finance";
import { ApiError } from "@/lib/api-client";
import type {
  FinanceCategoryDTO,
  FinanceChannelRef,
  FinanceEntryDTO,
  FinanceKind,
} from "@/lib/finance/types";
import type {
  FinanceEntryCreateInput,
  FinanceEntryUpdateInput,
} from "@/server/services/finance-service";
import {
  CURRENCIES,
  MAX_MONEY_MINOR,
  formatMoney,
  parseMoneyToMinor,
} from "@/lib/finance/money";
import { toDateInputValue } from "@/lib/date-range";
import { EM_DASH, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Finance → Entries. The ledger itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE DATA ON THIS SCREEN COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────
 * Two reads, each doing the job it was built for.
 *
 * The rows come from `useFinanceEntries`, which filters SERVER-side. Narrowing
 * to one channel's expenses by slicing an array already in the browser would be
 * wrong here in a way it is not on the tracker: `listEntriesPage` caps how many
 * rows come back at all, so a client-side filter over a capped array silently
 * searches the newest N entries rather than the period. Sending the filter to
 * Prisma means the cap applies to the narrowed set, which is the set the user
 * asked about.
 *
 * The reference lists — categories, channels, currencies with a configured rate
 * — come from `useFinanceOverview`. It sits behind exactly this screen's
 * permission (`finance.view`), and its `channels` array is scoped the same way
 * the write path validates a channel, so the entry form physically cannot offer
 * something the API will reject. It is also keyed on the same snapped range as
 * the Finance dashboard, so arriving from there costs nothing.
 *
 * Both are gated on the clock (see `LedgerSection`): `useNow()` reads 0 until
 * the first tick, and a trailing period resolved against 0 is a window ending
 * in 1969.
 */
export default function FinanceEntriesPage() {
  const session = useSession();
  const nowMs = useNow();

  const [kind, setKind] = React.useState<KindFilter>("all");
  const [channelId, setChannelId] = React.useState<string>(ALL);
  const [categoryId, setCategoryId] = React.useState<string>(ALL);

  const [composing, setComposing] = React.useState<FinanceKind | null>(null);

  const overview = useFinanceOverview();
  const categories = overview.data?.categories ?? [];
  const channels = overview.data?.channels ?? [];
  const rates = overview.data?.rates ?? [];

  /**
   * Narrowing the kind drops a category that belongs to the other side.
   *
   * "Revenue" plus an expense category is a pair that can only ever return
   * nothing, and an empty table is a puzzle rather than an answer. Resolved in
   * the handler — the only place the impossible pair can be created — rather
   * than in an effect that would fire a second render to correct the first.
   */
  const selectKind = (next: KindFilter) => {
    setKind(next);
    if (next === "all") return;
    const current = categories.find((category) => category.id === categoryId);
    if (current && current.kind !== next) setCategoryId(ALL);
  };

  const hasFilters = kind !== "all" || channelId !== ALL || categoryId !== ALL;

  if (!session.can("finance.view")) {
    return (
      <PageContainer>
        <Card>
          <EmptyState
            icon={<Lock />}
            title="You don't have access to the ledger"
            description="Finance entries are behind the finance.view permission. An administrator can grant it from Admin → Members."
          />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Entries"
        description="Every transaction recorded against the business, in the currency it was actually transacted in. The converted figure is shown alongside it, never instead of it."
        actions={
          <>
            {/* Outside the permission gate: a viewer still needs to be able to
                see which categories and rates the numbers were filed under. */}
            <Button variant="ghost" size="sm" asChild>
              <Link href="/finance/settings">Categories &amp; rates</Link>
            </Button>

            <IfPermitted
              to="finance.manage"
              fallback={
                // `finance.view` without `finance.manage` is a real, deliberate
                // combination — a Channel Director shown the numbers but not
                // given the pen. They get the ledger, not buttons that 403.
                <Badge variant="outline" className="gap-1.5">
                  <Lock className="size-3" />
                  Read-only
                </Badge>
              }
            >
              <Button variant="secondary" size="sm" onClick={() => setComposing("revenue")}>
                <Plus />
                Add earnings
              </Button>
              <Button variant="primary" size="sm" onClick={() => setComposing("expense")}>
                <Plus />
                Add expense
              </Button>
            </IfPermitted>
          </>
        }
      />

      {overview.error ? (
        <Card>
          <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PeriodSelector />

            <FilterSelect
              label="Kind"
              value={kind}
              onChange={(value) => selectKind(value as KindFilter)}
              options={[
                { value: "all", label: "Revenue and expenses" },
                { value: "revenue", label: "Revenue" },
                { value: "expense", label: "Expenses" },
              ]}
            />

            <FilterSelect
              label="Channel"
              value={channelId}
              onChange={setChannelId}
              options={[
                { value: ALL, label: "All channels" },
                ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
              ]}
            />

            <FilterSelect
              label="Category"
              value={categoryId}
              onChange={setCategoryId}
              options={[
                { value: ALL, label: "All categories" },
                ...categories
                  .filter((category) => kind === "all" || category.kind === kind)
                  .map((category) => ({
                    value: category.id,
                    label: category.name,
                    // Archived categories stay filterable: an entry filed under
                    // one is otherwise unreachable from this screen.
                    hint: category.isArchived ? "archived" : undefined,
                  })),
              ]}
            />

            {hasFilters ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setKind("all");
                  setChannelId(ALL);
                  setCategoryId(ALL);
                }}
              >
                <X />
                Clear filters
              </Button>
            ) : null}
          </div>

          {nowMs > 0 ? (
            <LedgerSection
              kind={kind}
              channelId={channelId}
              categoryId={categoryId}
              hasFilters={hasFilters}
              categories={categories}
              channels={channels}
              onCompose={setComposing}
            />
          ) : (
            <LedgerSkeleton />
          )}
        </>
      )}

      <EntryDialog
        kind={composing}
        entry={null}
        categories={categories}
        channels={channels}
        ratedCurrencies={ratedCurrencySet(rates, overview.data?.baseCurrency ?? null)}
        baseCurrency={overview.data?.baseCurrency ?? null}
        onOpenChange={(open) => {
          if (!open) setComposing(null);
        }}
      />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// THE LEDGER
// ---------------------------------------------------------------------------

const ALL = "__all__";

type KindFilter = FinanceKind | "all";

/**
 * Owns the ledger read.
 *
 * Split out so the parent can decline to render it until `useNow()` has ticked.
 * `useFinanceEntries` takes no `enabled` flag — nor should it, it is a plain
 * read — so the way to not ask for a 1969 window is to not mount the component
 * that asks.
 */
function LedgerSection({
  kind,
  channelId,
  categoryId,
  hasFilters,
  categories,
  channels,
  onCompose,
}: {
  kind: KindFilter;
  channelId: string;
  categoryId: string;
  hasFilters: boolean;
  categories: readonly FinanceCategoryDTO[];
  channels: readonly FinanceChannelRef[];
  onCompose: (kind: FinanceKind) => void;
}) {
  const { range } = useFilters();
  // Snapped to whole UTC days, matching how `occurredOn` is stored and keeping
  // the query key stable across the 30-second clock tick.
  const ledgerWindow = financeRangeFor(range);

  const ledger = useFinanceEntries({
    startMs: ledgerWindow.startMs,
    endMs: ledgerWindow.endMs,
    kind: kind === "all" ? undefined : kind,
    channelId: channelId === ALL ? undefined : channelId,
    categoryId: categoryId === ALL ? undefined : categoryId,
  });

  const [editing, setEditing] = React.useState<FinanceEntryDTO | null>(null);
  const [deleting, setDeleting] = React.useState<FinanceEntryDTO | null>(null);

  const overview = useFinanceOverview();
  const baseCurrency = overview.data?.baseCurrency ?? null;
  const rates = overview.data?.rates ?? [];

  if (ledger.isError) {
    return (
      <Card>
        <ErrorState error={ledger.error} onRetry={() => ledger.refetch()} />
      </Card>
    );
  }

  if (ledger.isPending) return <LedgerSkeleton />;

  const entries = ledger.data.entries;
  const totals = totalsForShown(entries);

  return (
    <div className="flex flex-col gap-3">
      {ledger.data.truncated ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-subtle px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="text-[13px] font-medium text-foreground">
              This period holds more entries than one page can carry
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              The rows below are the most recent ones, not the whole period, so they
              cannot be totalled here. Narrow the period or add a filter. The figures on
              the Finance dashboard are computed in the database and remain exact.
            </p>
          </div>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {entries.length === 0 ? (
          <EmptyState
            icon={<ReceiptText />}
            title={hasFilters ? "Nothing matches those filters" : "No entries in this period"}
            description={
              hasFilters
                ? "Widen the period or clear a filter. Entries are filed under the day the money moved, not the day they were recorded."
                : "Record what the operation earned and what it spent, and the Finance dashboard starts answering whether it is profitable."
            }
            action={
              hasFilters ? undefined : (
                <IfPermitted to="finance.manage">
                  <Button variant="primary" onClick={() => onCompose("revenue")}>
                    <Plus />
                    Add earnings
                  </Button>
                </IfPermitted>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-sunken">
                  <Th>Date</Th>
                  <Th>Kind</Th>
                  <Th align="right">Amount</Th>
                  <Th>Category</Th>
                  <Th>Channel</Th>
                  <Th>
                    <span className="inline-flex items-center gap-1">
                      Platform / vendor
                      <InfoTip>
                        One column because the two never coexist: revenue is earned on a
                        platform, an expense is paid to a vendor.
                      </InfoTip>
                    </span>
                  </Th>
                  <Th>Notes</Th>
                  <Th>Recorded by</Th>
                  <Th align="right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    onEdit={() => setEditing(entry)}
                    onDelete={() => setDeleting(entry)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {entries.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-1 text-[12px] text-muted-foreground">
          <span className="tnum">
            {formatNumber(entries.length)} {pluralize(entries.length, "entry", "entries")} shown
          </span>

          {/*
           * Totals over the ROWS SHOWN, and only when they can be trusted.
           *
           * Two ways they cannot be. A truncated page is the newest N rows
           * rather than the period, so its sum is an understatement wearing the
           * clothes of a result — checked here, because truncation is a
           * property of the response, not of the rows. And `totalsForShown`
           * itself refuses when the rows were not all converted into the same
           * reporting currency, since adding those gives a figure with no unit.
           *
           * Either way the period's real headline figures live on the Finance
           * dashboard, where they come from a grouped aggregate with no cap.
           */}
          {ledger.data.truncated ? (
            <span>Totals unavailable while the period is truncated</span>
          ) : totals ? (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                Revenue{" "}
                <span className="tnum text-foreground">
                  {formatMoney(totals.revenueMinor, totals.currency)}
                </span>
              </span>
              <span>
                Expenses{" "}
                <span className="tnum text-foreground">
                  {formatMoney(totals.expenseMinor, totals.currency)}
                </span>
              </span>
              <span>
                Net{" "}
                <span
                  className={cn(
                    "tnum",
                    totals.netMinor < 0 ? "text-danger" : "text-foreground",
                  )}
                >
                  {formatMoney(totals.netMinor, totals.currency, {
                    signDisplay: "exceptZero",
                  })}
                </span>
              </span>
              <span className="text-subtle-foreground">
                converted to {totals.currency}, for the rows shown
              </span>
            </span>
          ) : (
            <span>
              These rows were converted into more than one reporting currency, so they
              cannot be added together.
            </span>
          )}
        </div>
      ) : null}

      <EntryDialog
        kind={editing?.kind ?? null}
        entry={editing}
        categories={categories}
        channels={channels}
        ratedCurrencies={ratedCurrencySet(rates, baseCurrency)}
        baseCurrency={baseCurrency}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <DeleteEntryDialog
        entry={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

function EntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: FinanceEntryDTO;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const counterparty = entry.kind === "revenue" ? entry.platform : entry.vendor;

  return (
    <tr className="group border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40">
      <td className="tnum whitespace-nowrap px-4 py-2.5 text-[12px] text-muted-foreground">
        {formatLedgerDate(entry.occurredOn)}
      </td>

      <td className="px-4 py-2.5">
        <KindBadge kind={entry.kind} />
      </td>

      <td className="px-4 py-2.5 text-right">
        <AmountCell entry={entry} />
      </td>

      <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
        {entry.categoryName ?? (
          <span className="text-subtle-foreground">Uncategorised</span>
        )}
      </td>

      <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
        {entry.channelName ?? (
          <span className="inline-flex items-center gap-1 text-subtle-foreground">
            <Building2 className="size-3" />
            Company-wide
          </span>
        )}
      </td>

      <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
        {counterparty ?? <span className="text-subtle-foreground">{EM_DASH}</span>}
      </td>

      <td className="max-w-[240px] px-4 py-2.5">
        {entry.notes ? (
          <span className="block truncate text-[12px] text-muted-foreground" title={entry.notes}>
            {entry.notes}
          </span>
        ) : (
          <span className="text-[12px] text-subtle-foreground">{EM_DASH}</span>
        )}
      </td>

      <td className="whitespace-nowrap px-4 py-2.5 text-[12px] text-subtle-foreground">
        {entry.createdByName ?? EM_DASH}
      </td>

      <td className="px-4 py-2.5 text-right">
        <IfPermitted to="finance.manage">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for the ${formatMoney(entry.amountMinor, entry.currency)} ${entry.kind} entry on ${formatLedgerDate(entry.occurredOn)}`}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                Edit entry
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem tone="danger" onSelect={onDelete}>
                <Trash2 />
                Delete entry
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </IfPermitted>
      </td>
    </tr>
  );
}

/**
 * Revenue is tinted, expense is not.
 *
 * The obvious alternative — green in, red out — turns an ordinary month into a
 * wall of red, and red in this app means something is wrong. An expense is not
 * a problem; it is the other half of the ledger. So the chip marks direction
 * without editorialising, and `text-danger` stays reserved for the one figure
 * that genuinely warrants it: a negative net.
 */
function KindBadge({ kind }: { kind: FinanceKind }) {
  return kind === "revenue" ? (
    <Badge variant="hit" size="sm">
      Revenue
    </Badge>
  ) : (
    <Badge variant="neutral" size="sm">
      Expense
    </Badge>
  );
}

/**
 * The amount, in the currency it was transacted in.
 *
 * The original is the source of truth and is therefore the primary line. The
 * converted figure appears under it only when the two differ, annotated with
 * the rate that was in force on the day the entry was written — not today's.
 * Showing only the conversion would quietly restate what somebody was actually
 * invoiced.
 */
function AmountCell({ entry }: { entry: FinanceEntryDTO }) {
  const converted = entry.currency !== entry.baseCurrency;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="tnum text-[13px] font-medium text-foreground">
        {formatMoney(entry.amountMinor, entry.currency)}
      </span>
      {converted ? (
        <span
          className="tnum text-[11px] text-subtle-foreground"
          title={`Converted at 1 ${entry.currency} = ${entry.exchangeRate} ${entry.baseCurrency}, the rate configured when this entry was recorded.`}
        >
          ≈ {formatMoney(entry.baseAmountMinor, entry.baseCurrency, { withCode: true })}
        </span>
      ) : null}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function LedgerSkeleton() {
  return (
    <Card className="flex flex-col gap-2 p-4">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full rounded" />
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ENTRY DIALOG
// ---------------------------------------------------------------------------

interface EntryDraft {
  /** `YYYY-MM-DD`. A calendar date, which is what the ledger stores. */
  occurredOn: string;
  amountText: string;
  currency: string;
  categoryId: string | null;
  channelId: string | null;
  platform: string;
  vendor: string;
  notes: string;
}

/**
 * One dialog, two entry points.
 *
 * "Add earnings" and "Add expense" are separate buttons because they ask
 * different questions — a platform against a vendor, revenue categories against
 * expense ones — and a single form with a kind toggle would make the user
 * answer the toggle before the form meant anything. The *implementation* is
 * shared because the part that must not diverge is the money: one parse, one
 * preview, one set of bounds. Two copies of `parseMoneyToMinor` is how the two
 * halves of a ledger end up disagreeing about what "1.234" means.
 */
function EntryDialog({
  kind,
  entry,
  categories,
  channels,
  ratedCurrencies,
  baseCurrency,
  onOpenChange,
}: {
  kind: FinanceKind | null;
  entry: FinanceEntryDTO | null;
  categories: readonly FinanceCategoryDTO[];
  channels: readonly FinanceChannelRef[];
  ratedCurrencies: ReadonlySet<string>;
  baseCurrency: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {kind ? (
          <EntryForm
            kind={kind}
            entry={entry}
            categories={categories}
            channels={channels}
            ratedCurrencies={ratedCurrencies}
            baseCurrency={baseCurrency}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EntryForm({
  kind,
  entry,
  categories,
  channels,
  ratedCurrencies,
  baseCurrency,
  onOpenChange,
}: {
  kind: FinanceKind;
  entry: FinanceEntryDTO | null;
  categories: readonly FinanceCategoryDTO[];
  channels: readonly FinanceChannelRef[];
  ratedCurrencies: ReadonlySet<string>;
  baseCurrency: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const nowMs = useNow();
  const create = useCreateFinanceEntry();
  const update = useUpdateFinanceEntry();
  const isEdit = entry !== null;

  const [draft, setDraft] = React.useState<EntryDraft>(() =>
    entry
      ? {
          occurredOn: toEntryDateValue(entry.occurredOn),
          amountText: minorToInputText(entry.amountMinor, entry.currency),
          currency: entry.currency,
          categoryId: entry.categoryId,
          channelId: entry.channelId,
          platform: entry.platform ?? "",
          vendor: entry.vendor ?? "",
          notes: entry.notes ?? "",
        }
      : {
          // `useNow()` is 0 until the first tick; falling back to an empty field
          // is better than defaulting the date to 1 January 1970.
          occurredOn: nowMs > 0 ? toDateInputValue(nowMs) : "",
          amountText: "",
          currency: baseCurrency ?? CURRENCIES[0].code,
          categoryId: null,
          channelId: null,
          platform: "",
          vendor: "",
          notes: "",
        },
  );

  const patch = <K extends keyof EntryDraft>(key: K, value: EntryDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  // The same parser the API validates with, so what this preview says will be
  // stored is what gets stored.
  const parsedMinor = draft.amountText.trim()
    ? parseMoneyToMinor(draft.amountText, draft.currency)
    : null;

  const amountError = amountProblem(draft.amountText, parsedMinor);
  const dateError = draft.occurredOn ? null : "Pick the date the money moved.";

  const currencyHasRate =
    draft.currency === baseCurrency || ratedCurrencies.has(draft.currency);

  const selectable = categories.filter(
    (category) => category.kind === kind && !category.isArchived,
  );
  // An entry already filed under an archived category keeps showing it, so the
  // edit dialog does not present a blank where a real label exists. Because the
  // save sends a diff, leaving it alone sends no `categoryId` at all — which is
  // the only way the server will accept it: `assertCategory` refuses an
  // archived id on any write that names one.
  const current = entry?.categoryId
    ? (categories.find((category) => category.id === entry.categoryId) ?? null)
    : null;
  const categoryOptions =
    current && current.isArchived ? [current, ...selectable] : selectable;

  const [serverError, setServerError] = React.useState<ApiError | null>(null);

  const pending = create.isPending || update.isPending;
  const nothingChanged =
    isEdit && parsedMinor !== null && Object.keys(buildPatch(entry, draft, parsedMinor)).length === 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (parsedMinor === null || amountError || dateError) return;
    setServerError(null);

    const onError = (error: unknown) => {
      // The server's rejections here are sentences written for a person, and
      // they name the fix — "no exchange rate is set for EUR", "that category
      // has been archived". They belong inside the dialog, above the button
      // that failed, where they stay readable while the fields are corrected.
      // A toast would take the one thing worth reading and time it out.
      if (error instanceof ApiError) {
        setServerError(error);
        return;
      }
      toast.error(
        isEdit ? "Could not save that entry" : `Could not record that ${kind} entry`,
      );
    };

    if (isEdit) {
      const body = buildPatch(entry, draft, parsedMinor);
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      update.mutate(
        { id: entry.id, patch: body },
        {
          onSuccess: () => {
            toast.success("Entry updated");
            onOpenChange(false);
          },
          onError,
        },
      );
      return;
    }

    create.mutate(buildCreatePayload(kind, draft, parsedMinor), {
      onSuccess: () => {
        toast.success(
          kind === "revenue"
            ? `Recorded ${formatMoney(parsedMinor, draft.currency)} of earnings`
            : `Recorded a ${formatMoney(parsedMinor, draft.currency)} expense`,
        );
        onOpenChange(false);
      },
      onError,
    });
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? kind === "revenue"
              ? "Edit earnings"
              : "Edit expense"
            : kind === "revenue"
              ? "Add earnings"
              : "Add expense"}
        </DialogTitle>
        <DialogDescription>
          {kind === "revenue"
            ? "Money the operation brought in. File it against the channel that earned it, or leave it company-wide."
            : "Money the operation paid out. File it against a channel when it belongs to one, or leave it company-wide."}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" htmlFor="entry-date" error={dateError}>
            <Input
              id="entry-date"
              type="date"
              value={draft.occurredOn}
              invalid={Boolean(dateError)}
              onChange={(event) => patch("occurredOn", event.target.value)}
            />
            <FieldHint>The day the money moved, not the day you are recording it.</FieldHint>
          </Field>

          <Field label="Currency" htmlFor="entry-currency">
            <FieldSelect
              id="entry-currency"
              value={draft.currency}
              onChange={(value) => patch("currency", value)}
              options={CURRENCIES.map((currency) => ({
                value: currency.code,
                label: `${currency.code} — ${currency.name}`,
                hint:
                  currency.code === baseCurrency
                    ? "base"
                    : ratedCurrencies.has(currency.code)
                      ? undefined
                      : "no rate set",
              }))}
            />
            {currencyHasRate ? null : (
              <FieldHint tone="danger">
                No exchange rate is configured for {draft.currency}, so this entry cannot be
                converted into the reporting currency and will be refused.{" "}
                <Link href="/finance/settings" className="text-accent underline-offset-4 hover:underline">
                  Set one under Finance → Settings
                </Link>
                .
              </FieldHint>
            )}
          </Field>
        </div>

        <Field label="Amount" htmlFor="entry-amount" error={amountError}>
          <Input
            id="entry-amount"
            autoFocus
            inputMode="decimal"
            autoComplete="off"
            placeholder="1,234.56"
            value={draft.amountText}
            invalid={Boolean(amountError)}
            onChange={(event) => patch("amountText", event.target.value)}
          />
          {amountError ? null : parsedMinor === null ? (
            <FieldHint>
              Type it however you write it — 1,234.56 and 1.234,56 both read as the same
              amount.
            </FieldHint>
          ) : (
            <FieldHint>
              Stored as{" "}
              <span className="tnum font-medium text-foreground">
                {formatMoney(parsedMinor, draft.currency, { withCode: true })}
              </span>{" "}
              <span className="text-subtle-foreground">
                ({formatNumber(parsedMinor)} minor units — the ledger holds whole cents, never
                a fraction of one)
              </span>
            </FieldHint>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="entry-category">
            <FieldSelect
              id="entry-category"
              value={draft.categoryId ?? NONE}
              onChange={(value) => patch("categoryId", value === NONE ? null : value)}
              options={[
                { value: NONE, label: "Uncategorised" },
                ...categoryOptions.map((category) => ({
                  value: category.id,
                  label: category.name,
                  hint: category.isArchived ? "archived" : undefined,
                })),
              ]}
            />
            {categoryOptions.length === 0 ? (
              <FieldHint>
                No {kind} categories yet.{" "}
                <Link href="/finance/settings" className="text-accent underline-offset-4 hover:underline">
                  Add some under Finance → Settings
                </Link>
                .
              </FieldHint>
            ) : null}
          </Field>

          <Field label="Channel" htmlFor="entry-channel">
            <FieldSelect
              id="entry-channel"
              value={draft.channelId ?? NONE}
              onChange={(value) => patch("channelId", value === NONE ? null : value)}
              options={[
                { value: NONE, label: "Company-wide" },
                ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
              ]}
            />
            <FieldHint>
              Company-wide entries count towards the business but against no single
              channel&rsquo;s profit.
            </FieldHint>
          </Field>
        </div>

        {kind === "revenue" ? (
          <Field label="Platform" htmlFor="entry-platform">
            <Input
              id="entry-platform"
              value={draft.platform}
              maxLength={64}
              autoComplete="off"
              placeholder="YouTube Ads, sponsorship, affiliate…"
              onChange={(event) => patch("platform", event.target.value)}
            />
            <FieldHint>
              Where the money came from. Spelling is matched case-insensitively, so
              &ldquo;YouTube Ads&rdquo; and &ldquo;youtube ads&rdquo; stay one slice of the
              revenue breakdown.
            </FieldHint>
          </Field>
        ) : (
          <Field label="Vendor or payee" htmlFor="entry-vendor">
            <Input
              id="entry-vendor"
              value={draft.vendor}
              maxLength={120}
              autoComplete="off"
              placeholder="Who was paid"
              onChange={(event) => patch("vendor", event.target.value)}
            />
          </Field>
        )}

        <Field label="Notes" htmlFor="entry-notes">
          <textarea
            id="entry-notes"
            value={draft.notes}
            rows={2}
            maxLength={2000}
            placeholder="Invoice number, what it covered, anything the next person will need"
            onChange={(event) => patch("notes", event.target.value)}
            className={cn(
              "w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] text-foreground",
              "placeholder:text-subtle-foreground",
              "transition-colors hover:border-border-strong",
              "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
            )}
          />
        </Field>

        {serverError ? (
          <div className="flex items-start gap-2.5 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="text-[12px] leading-relaxed text-foreground">
              {serverError.message}
              {/*
               * The missing-rate 400 carries `{ fromCurrency, toCurrency }` in
               * its details. Keying the link off that structure rather than off
               * the message text means the shortcut appears for exactly the
               * error it fixes, and does not start appearing on other 400s the
               * day somebody rewords one.
               */}
              {typeof serverError.details?.fromCurrency === "string" ? (
                <>
                  {" "}
                  <Link
                    href="/finance/settings"
                    className="text-accent underline-offset-4 hover:underline"
                  >
                    Set a rate under Finance → Settings
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={parsedMinor === null || Boolean(amountError) || Boolean(dateError) || nothingChanged}
        >
          {isEdit ? "Save changes" : kind === "revenue" ? "Record earnings" : "Record expense"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteEntryDialog({
  entry,
  onOpenChange,
}: {
  entry: FinanceEntryDTO | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteFinanceEntry();

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this entry?</DialogTitle>
          <DialogDescription>
            Every total that included it moves as soon as it is gone.
          </DialogDescription>
        </DialogHeader>

        {entry ? (
          <DialogBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <KindBadge kind={entry.kind} />
                  <span className="tnum text-[12px] text-muted-foreground">
                    {formatLedgerDate(entry.occurredOn)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[12px] text-muted-foreground">
                  {entry.categoryName ?? "Uncategorised"} ·{" "}
                  {entry.channelName ?? "Company-wide"}
                </p>
              </div>
              <span className="tnum shrink-0 text-[14px] font-medium text-foreground">
                {formatMoney(entry.amountMinor, entry.currency)}
              </span>
            </div>

            <p className="text-[12px] leading-relaxed text-muted-foreground">
              The ledger has no undo — the row is removed outright. What survives is the
              audit record, which keeps the amount and currency precisely because the row
              will not be there to look up afterwards.
            </p>
          </DialogBody>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              if (!entry) return;
              remove.mutate(entry.id, {
                onSuccess: () => {
                  toast.success("Entry deleted");
                  onOpenChange(false);
                },
                onError: (error) =>
                  toast.error("Could not delete that entry", {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              });
            }}
          >
            <Trash2 />
            Delete entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SELECT CONTROLS
//
// This app has no native <select> anywhere — every choice is a Radix dropdown
// with a radio group, so that the menu matches the rest of the surface in both
// themes. These two wrappers are the toolbar and form-field flavours of that
// pattern; a raw <select> here would be the only OS-styled widget on the page.
// ---------------------------------------------------------------------------

const NONE = "__none__";

interface SelectOption {
  value: string;
  label: string;
  /** Rendered dimmed after the label — "archived", "no rate set". */
  hint?: string;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[150px] truncate text-foreground">{selected?.label}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-h-[320px] min-w-[220px] overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="truncate">{option.label}</span>
              {option.hint ? (
                <span className="ml-1.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
                  {option.hint}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FieldSelect({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
}) {
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 text-sm text-foreground",
            "transition-colors duration-150 hover:border-border-strong",
            "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
          )}
        >
          <span className="truncate">
            {selected?.label ?? <span className="text-subtle-foreground">Select…</span>}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-subtle-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="max-h-[300px] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="truncate">{option.label}</span>
              {option.hint ? (
                <span className="ml-1.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
                  {option.hint}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * A ledger date, formatted in UTC.
 *
 * NOT `formatDate` from lib/format, and this is not a style preference.
 * `occurredOn` is a calendar date pinned to UTC midnight — deliberately, so the
 * day an amount is filed under does not depend on who is looking at it. Running
 * it through `toLocaleDateString` would resolve that instant in the reader's
 * zone, and for anyone west of UTC every single date in this table would render
 * one day early. A ledger that disagrees with the invoice about which day the
 * money moved is not a cosmetic problem.
 */
const LEDGER_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatLedgerDate(ms: number): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  return LEDGER_DATE_FORMAT.format(new Date(ms));
}

/** `YYYY-MM-DD` read in UTC, for the same reason as above. */
function toEntryDateValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Minor units back into something the amount field can hold.
 *
 * Plain digits and a dot, never a localised group separator: the value goes
 * straight back into `parseMoneyToMinor`, and a round trip through the user's
 * locale is a chance for the number to change on the way.
 */
function minorToInputText(minor: number, currency: string): string {
  const digits = CURRENCIES.find((c) => c.code === currency)?.minorUnits ?? 2;
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const magnitude = String(Math.abs(minor)).padStart(digits + 1, "0");
  return `${sign}${magnitude.slice(0, -digits)}.${magnitude.slice(-digits)}`;
}

/**
 * Inline validation that mirrors the server's own bounds.
 *
 * Not a substitute for it — the API validates everything again — but a rejected
 * amount should be visible while the field still has focus, not after a round
 * trip.
 */
function amountProblem(text: string, parsed: number | null): string | null {
  if (!text.trim()) return null;
  if (parsed === null) {
    return "That is not an amount this can read. Try 1234.56, 1,234.56 or 1.234,56.";
  }
  if (parsed <= 0) {
    return "Enter an amount greater than zero — whether it is money in or money out is decided by which form you are in.";
  }
  if (parsed > MAX_MONEY_MINOR) {
    return "That amount is too large to record as a single entry. Split it across entries.";
  }
  return null;
}

function buildCreatePayload(
  kind: FinanceKind,
  draft: EntryDraft,
  amountMinor: number,
): FinanceEntryCreateInput {
  return {
    kind,
    occurredOn: draft.occurredOn,
    amountMinor,
    currency: draft.currency,
    categoryId: draft.categoryId,
    channelId: draft.channelId,
    // Each side of the ledger owns one of these. Sending the other as null
    // matches what the service stores anyway, and keeps the request honest
    // about which form produced it.
    platform: kind === "revenue" ? nullableText(draft.platform) : null,
    vendor: kind === "expense" ? nullableText(draft.vendor) : null,
    notes: nullableText(draft.notes),
  };
}

/**
 * An edit sends a DIFF, not the whole form. Two reasons, both real.
 *
 * `assertCategory` refuses an archived category on any write that names one.
 * An entry filed under a category that has since been archived is a completely
 * ordinary thing to want to edit — fixing a typo in its note, say — and sending
 * the unchanged `categoryId` along with it would have the server reject the
 * save with a message about a category the user never touched.
 *
 * `kind` is never in the patch: it is fixed by which dialog opened, and sending
 * it would make the service treat the save as a possible side-change and
 * re-evaluate the fields that belong to the other half of the ledger.
 *
 * The money fields are safe to send unconditionally — the service compares them
 * by value before deciding to re-rate — but they are diffed here too, so that
 * "nothing changed" is a state this form can recognise and not submit at all.
 */
function buildPatch(
  entry: FinanceEntryDTO,
  draft: EntryDraft,
  amountMinor: number,
): FinanceEntryUpdateInput {
  const body: {
    occurredOn?: string;
    amountMinor?: number;
    currency?: string;
    categoryId?: string | null;
    channelId?: string | null;
    platform?: string | null;
    vendor?: string | null;
    notes?: string | null;
  } = {};

  if (draft.occurredOn !== toEntryDateValue(entry.occurredOn)) {
    body.occurredOn = draft.occurredOn;
  }
  if (amountMinor !== entry.amountMinor) body.amountMinor = amountMinor;
  if (draft.currency !== entry.currency) body.currency = draft.currency;
  if (draft.categoryId !== entry.categoryId) body.categoryId = draft.categoryId;
  if (draft.channelId !== entry.channelId) body.channelId = draft.channelId;

  if (entry.kind === "revenue") {
    const platform = nullableText(draft.platform);
    if (platform !== entry.platform) body.platform = platform;
  } else {
    const vendor = nullableText(draft.vendor);
    if (vendor !== entry.vendor) body.vendor = vendor;
  }

  const notes = nullableText(draft.notes);
  if (notes !== entry.notes) body.notes = notes;

  return body;
}

/** Empty text is an absent field, not an empty string stored in the column. */
function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The currencies that can currently be converted into the reporting currency.
 *
 * `toCurrency` is checked rather than assumed. Conversion only ever runs
 * against the organization's base currency, so a rate pointing anywhere else —
 * a leftover from a previous base — would not make its `fromCurrency`
 * enterable, and offering it as though it were is how somebody discovers on
 * submit that the entry cannot be recorded.
 */
function ratedCurrencySet(
  rates: readonly { fromCurrency: string; toCurrency: string; rate: number }[],
  baseCurrency: string | null,
): ReadonlySet<string> {
  if (!baseCurrency) return new Set();
  return new Set(
    rates
      .filter(
        (rate) =>
          rate.toCurrency === baseCurrency && Number.isFinite(rate.rate) && rate.rate > 0,
      )
      .map((rate) => rate.fromCurrency),
  );
}

/**
 * Exact totals for the rows on screen, or `null` when there are none to give.
 *
 * `null` in two cases. Empty, obviously. And when the rows were not all
 * converted into the same reporting currency — possible for a ledger that spans
 * a change of base currency, since each entry stores the one it was converted
 * into at the time. Adding those together produces a number with no unit, which
 * is worse than no number at all.
 *
 * Truncation is the caller's check, not this function's: it is a property of
 * the response rather than of the rows, and these rows would sum perfectly
 * happily to a figure that is simply not the period's.
 *
 * The addition itself is exact: `baseAmountMinor` is an integer, which is the
 * whole reason money in this app is never a float.
 */
function totalsForShown(entries: readonly FinanceEntryDTO[]): {
  currency: string;
  revenueMinor: number;
  expenseMinor: number;
  netMinor: number;
} | null {
  if (entries.length === 0) return null;

  const currency = entries[0].baseCurrency;
  let revenueMinor = 0;
  let expenseMinor = 0;

  for (const entry of entries) {
    if (entry.baseCurrency !== currency) return null;
    if (entry.kind === "revenue") revenueMinor += entry.baseAmountMinor;
    else expenseMinor += entry.baseAmountMinor;
  }

  return { currency, revenueMinor, expenseMinor, netMinor: revenueMinor - expenseMinor };
}
