"use client";

import * as React from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import {
  useCreateFinanceCategory,
  useExchangeRates,
  useFinanceCategories,
  useFinanceOverview,
  useSetExchangeRates,
  useUpdateFinanceCategory,
} from "@/hooks/use-finance";
import type { ExchangeRateInput } from "@/lib/api-client";
import type { ExchangeRateDTO, FinanceCategoryDTO, FinanceKind } from "@/lib/finance/types";
import { CURRENCIES, findCurrency } from "@/lib/finance/money";
import { EM_DASH, formatNumber, formatRelativeTime, pluralize } from "@/lib/format";
import { useNow } from "@/hooks/use-now";

/**
 * Finance → Settings. The two things that decide how the ledger reads.
 *
 * Categories are the shape of the business — what it earns from, what it spends
 * on — and exchange rates are what makes a multi-currency ledger addable at all.
 * They sit together because both are edited rarely, by the same person, and
 * both change what the entry form is allowed to offer.
 *
 * Everything on this page is behind `finance.view` to read and `finance.manage`
 * to change, so a Channel Director given sight of the numbers sees the
 * vocabulary without the controls.
 */
export default function FinanceSettingsPage() {
  const session = useSession();

  // The rate table needs the organization's reporting currency, and this is the
  // only client-visible source of it: `listExchangeRates` returns rows, and a
  // company that has not configured any would leave a page built from those
  // rows unable to say what it is converting *into*. Keyed on the same snapped
  // range as the Finance dashboard, so arriving from there costs no request.
  const overview = useFinanceOverview();
  const categories = useFinanceCategories();
  const rates = useExchangeRates();

  if (!session.can("finance.view")) {
    return (
      <PageContainer>
        <Card>
          <EmptyState
            icon={<Lock />}
            title="You don't have access to finance settings"
            description="Categories and exchange rates are behind the finance.view permission. An administrator can grant it from Admin → Members."
          />
        </Card>
      </PageContainer>
    );
  }

  const error = overview.error ?? categories.error ?? rates.error;

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Finance settings"
        description="The categories entries are filed under, and the rates foreign amounts are converted at."
        actions={
          <>
            {/* The badge replaces nothing — a viewer still needs the way back. */}
            {session.can("finance.manage") ? null : (
              <Badge variant="outline" className="gap-1.5">
                <Lock className="size-3" />
                Read-only
              </Badge>
            )}
            <Button variant="secondary" size="sm" asChild>
              <Link href="/finance/entries">Back to entries</Link>
            </Button>
          </>
        }
      />

      {error ? (
        <Card>
          <ErrorState
            error={error}
            onRetry={() => {
              void overview.refetch();
              void categories.refetch();
              void rates.refetch();
            }}
          />
        </Card>
      ) : (
        <>
          <CategoriesSection
            categories={categories.data?.categories ?? []}
            isLoading={categories.isPending}
          />

          <RatesSection
            rates={rates.data?.rates ?? []}
            baseCurrency={overview.data?.baseCurrency ?? null}
            isLoading={rates.isPending || overview.isPending}
          />
        </>
      )}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// CATEGORIES
// ---------------------------------------------------------------------------

function CategoriesSection({
  categories,
  isLoading,
}: {
  categories: readonly FinanceCategoryDTO[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        <CardDescription>
          Two separate vocabularies, because a category belongs to one side of the ledger:
          an expense cannot be filed under &ldquo;Ad revenue&rdquo;, and the API refuses the
          attempt rather than quietly accepting it.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className="h-52 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <CategoryColumn
              kind="revenue"
              title="Revenue categories"
              description="What the money came in for — ad revenue, sponsorships, affiliate."
              categories={categories.filter((category) => category.kind === "revenue")}
            />
            <CategoryColumn
              kind="expense"
              title="Expense categories"
              description="What the money went out on — editors, thumbnails, software, ads."
              categories={categories.filter((category) => category.kind === "expense")}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryColumn({
  kind,
  title,
  description,
  categories,
}: {
  kind: FinanceKind;
  title: string;
  description: string;
  categories: readonly FinanceCategoryDTO[];
}) {
  const active = categories.filter((category) => !category.isArchived);
  const archived = categories.filter((category) => category.isArchived);

  const [renaming, setRenaming] = React.useState<FinanceCategoryDTO | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      <div className="rounded-lg border border-border">
        {active.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-subtle-foreground">
            No {kind} categories yet. Entries can still be recorded without one — they show
            as uncategorised.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {active.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                onRename={() => setRenaming(category)}
              />
            ))}
          </ul>
        )}
      </div>

      <IfPermitted to="finance.manage">
        <AddCategoryForm kind={kind} />
      </IfPermitted>

      {archived.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div>
            <h4 className="text-[12px] font-medium text-muted-foreground">
              Archived ({archived.length})
            </h4>
            <p className="mt-0.5 text-[11px] leading-relaxed text-subtle-foreground">
              Archiving is not deleting. Every entry already filed under one of these keeps
              its label, so last quarter&rsquo;s breakdown still reads the way it did when
              it was reported — the category is simply no longer offered on new entries.
            </p>
          </div>

          <ul className="divide-y divide-border rounded-lg border border-border opacity-60">
            {archived.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                onRename={() => setRenaming(category)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <RenameCategoryDialog
        category={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      />
    </div>
  );
}

function CategoryRow({
  category,
  onRename,
}: {
  category: FinanceCategoryDTO;
  onRename: () => void;
}) {
  const update = useUpdateFinanceCategory();

  const setArchived = (isArchived: boolean) =>
    update.mutate(
      { id: category.id, patch: { isArchived } },
      {
        onSuccess: () =>
          toast.success(
            isArchived
              ? `“${category.name}” archived — its existing entries keep the label`
              : `“${category.name}” is available again`,
          ),
        onError: (error) =>
          toast.error(
            isArchived ? "Could not archive that category" : "Could not restore that category",
            { description: error instanceof Error ? error.message : undefined },
          ),
      },
    );

  return (
    <li className="group flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {category.name}
      </span>

      <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
        {category.entryCount === 0
          ? "unused"
          : `${formatNumber(category.entryCount)} ${pluralize(category.entryCount, "entry", "entries")}`}
      </span>

      <IfPermitted to="finance.manage">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${category.name}`}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRename}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            {category.isArchived ? (
              <DropdownMenuItem onSelect={() => setArchived(false)}>
                <ArchiveRestore />
                Restore
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => setArchived(true)}>
                <Archive />
                Archive
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </IfPermitted>
    </li>
  );
}

function AddCategoryForm({ kind }: { kind: FinanceKind }) {
  const [name, setName] = React.useState("");
  const create = useCreateFinanceCategory();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    create.mutate(
      { kind, name: trimmed },
      {
        onSuccess: ({ category }) => {
          toast.success(`“${category.name}” added`);
          setName("");
        },
        onError: (error) =>
          toast.error("Could not add that category", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <Input
        value={name}
        maxLength={48}
        autoComplete="off"
        aria-label={`New ${kind} category`}
        placeholder={kind === "revenue" ? "e.g. Sponsorships" : "e.g. Editing"}
        onChange={(event) => setName(event.target.value)}
        className="h-8 text-[13px]"
      />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        loading={create.isPending}
        disabled={!name.trim()}
        className="shrink-0"
      >
        <Plus />
        Add
      </Button>
    </form>
  );
}

function RenameCategoryDialog({
  category,
  onOpenChange,
}: {
  category: FinanceCategoryDTO | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={category !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {category ? (
          <RenameCategoryForm category={category} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameCategoryForm({
  category,
  onOpenChange,
}: {
  category: FinanceCategoryDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState(category.name);
  const update = useUpdateFinanceCategory();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === category.name) {
      onOpenChange(false);
      return;
    }

    update.mutate(
      { id: category.id, patch: { name: trimmed } },
      {
        onSuccess: () => {
          toast.success("Category renamed");
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not rename that category", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Rename category</DialogTitle>
        <DialogDescription>
          Every entry filed under it keeps its filing — only the label changes, everywhere
          at once.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="category-name">Name</Label>
        <Input
          id="category-name"
          autoFocus
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
        />
        <FieldHint>
          {category.entryCount === 0
            ? "Nothing is filed under it yet."
            : `${formatNumber(category.entryCount)} ${pluralize(category.entryCount, "entry", "entries")} will show the new name.`}
        </FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending} disabled={!name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// EXCHANGE RATES
// ---------------------------------------------------------------------------

/**
 * Bounds copied from `exchangeRateInputSchema`.
 *
 * Not a claim about which rates exist — a guard against a misplaced decimal
 * point, which is how a rate is wrong far more often than by being genuinely
 * extreme. Duplicated here so the message arrives while the field still has
 * focus; the server validates it again regardless.
 */
const MIN_RATE = 0.000001;
const MAX_RATE = 1_000_000;

function RatesSection({
  rates,
  baseCurrency,
  isLoading,
}: {
  rates: readonly ExchangeRateDTO[];
  baseCurrency: string | null;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-3.5 text-subtle-foreground" />
          Exchange rates
        </CardTitle>
        <CardDescription>
          {baseCurrency ? (
            <>
              Every figure the business is reported in is converted into{" "}
              <span className="font-medium text-foreground">{baseCurrency}</span>, the
              reporting currency. A rate says how much one unit of a foreign currency is
              worth in {baseCurrency}.
            </>
          ) : (
            "Every figure the business is reported in is converted into a single reporting currency."
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/*
         * The product's central financial guarantee, stated on the screen where
         * somebody is about to change a rate rather than buried in a help page.
         * It is the reason `FinanceEntry` stores `exchangeRate` per row at all.
         */}
        <div className="rounded-lg border border-border bg-surface-sunken px-4 py-3">
          <p className="text-[13px] font-medium text-foreground">
            Changing a rate affects new entries only.
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Every entry stores the rate it was converted at, on the day it was recorded.
            Editing the table below does not touch a single existing row: last month&rsquo;s
            revenue stays exactly the figure it was reported as, and no historical total
            ever moves because somebody updated a rate today.
          </p>
        </div>

        {isLoading ? (
          <Skeleton className="h-56 w-full rounded-lg" />
        ) : baseCurrency ? (
          <RatesTable rates={rates} baseCurrency={baseCurrency} />
        ) : (
          <p className="text-[12px] text-muted-foreground">
            The reporting currency could not be read, so rates cannot be edited safely from
            here. Reload the page; if it persists, the organization&rsquo;s settings row is
            unreadable.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface RateRow {
  code: string;
  name: string;
  /** What is stored today, or null when this currency has never had a rate. */
  stored: ExchangeRateDTO | null;
  text: string;
}

function RatesTable({
  rates,
  baseCurrency,
}: {
  rates: readonly ExchangeRateDTO[];
  baseCurrency: string;
}) {
  const nowMs = useNow();
  const save = useSetExchangeRates();
  const session = useSession();
  const canManage = session.can("finance.manage");

  // Only rates that convert into the reporting currency are editable here.
  // Conversion never uses any other pair, so a row pointing elsewhere would be
  // a control that changes nothing.
  const stored = React.useMemo(
    () => rates.filter((rate) => rate.toCurrency === baseCurrency),
    [rates, baseCurrency],
  );

  /**
   * State holds only what has been TYPED, never a copy of the saved table.
   *
   * Mirroring the fetched rates into state and re-syncing them from an effect
   * is the obvious shape and the wrong one: it costs a second render on every
   * refetch, and it decides — badly — what to do when a background refetch
   * lands mid-edit. Deriving each field as "the edit, or else what is stored"
   * gives the right answer in both directions for free. A colleague's saved
   * change reaches every field nobody is currently typing in, and reaches none
   * that somebody is.
   */
  const [edits, setEdits] = React.useState<ReadonlyMap<string, string>>(() => new Map());

  const rows = React.useMemo<RateRow[]>(
    () =>
      CURRENCIES.filter((currency) => currency.code !== baseCurrency).map((currency) => {
        const match = stored.find((rate) => rate.fromCurrency === currency.code) ?? null;
        return {
          code: currency.code,
          name: currency.name,
          stored: match,
          text: edits.get(currency.code) ?? (match ? String(match.rate) : ""),
        };
      }),
    [stored, baseCurrency, edits],
  );

  const changed = rows.filter((row) => {
    const parsed = parseRate(row.text);
    return parsed !== null && parsed !== row.stored?.rate;
  });

  const invalid = rows.some((row) => row.text.trim() !== "" && parseRate(row.text) === null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (changed.length === 0 || invalid) return;

    const payload: ExchangeRateInput[] = [];
    for (const row of changed) {
      const rate = parseRate(row.text);
      // Unreachable — `changed` is already the rows that parsed — but narrowing
      // it here beats casting away the null the parser is honest about.
      if (rate === null) continue;
      payload.push({
        fromCurrency: row.code,
        // Sent explicitly rather than left to the server's default, so the pair
        // written is unambiguously the one this table showed.
        toCurrency: baseCurrency,
        rate,
        source: "manual",
      });
    }
    if (payload.length === 0) return;

    save.mutate(payload, {
      onSuccess: () => {
        // Drop the local edits so the fields fall back to what the server now
        // holds — which the write's own invalidation is already refetching.
        setEdits(new Map());
        toast.success(
          `${payload.length} ${pluralize(payload.length, "rate")} saved — existing entries are unchanged`,
        );
      },
      onError: (error) =>
        toast.error("Could not save those rates", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Currency
              </th>
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Rate to {baseCurrency}
              </th>
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Source
              </th>
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Last changed
              </th>
            </tr>
          </thead>

          <tbody>
            {/*
             * The reporting currency, shown and not editable. A currency's rate
             * against itself is always 1 — the API rejects an attempt to set one
             * — so this row exists to answer "what is everything converted
             * into?" without inviting an edit that cannot succeed.
             */}
            <tr className="border-b border-border bg-surface-sunken/40">
              <td className="px-4 py-2.5">
                <span className="flex items-center gap-2 text-[13px] text-foreground">
                  {baseCurrency}
                  <Badge variant="accent" size="sm">
                    Reporting currency
                  </Badge>
                </span>
              </td>
              <td className="tnum px-4 py-2.5 text-[13px] text-muted-foreground">1</td>
              <td className="px-4 py-2.5 text-[12px] text-subtle-foreground">{EM_DASH}</td>
              <td className="px-4 py-2.5 text-[12px] text-subtle-foreground">{EM_DASH}</td>
            </tr>

            {rows.map((row) => {
              const isInvalid = row.text.trim() !== "" && parseRate(row.text) === null;

              return (
                <tr key={row.code} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="text-[13px] text-foreground">{row.code}</div>
                    <div className="text-[11px] text-subtle-foreground">{row.name}</div>
                  </td>

                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="whitespace-nowrap text-[12px] text-subtle-foreground">
                        1 {symbolOrCode(row.code)} =
                      </span>
                      <Input
                        value={row.text}
                        inputMode="decimal"
                        autoComplete="off"
                        disabled={!canManage}
                        invalid={isInvalid}
                        aria-label={`Rate from ${row.code} to ${baseCurrency}`}
                        placeholder={row.stored ? undefined : "not set"}
                        onChange={(event) => {
                          const text = event.target.value;
                          setEdits((previous) => new Map(previous).set(row.code, text));
                        }}
                        className="h-8 max-w-[140px] text-[13px]"
                      />
                      <span className="whitespace-nowrap text-[12px] text-subtle-foreground">
                        {baseCurrency}
                      </span>
                    </div>
                    {isInvalid ? (
                      <FieldHint tone="danger" className="mt-1">
                        {rateProblem(row.text)}
                      </FieldHint>
                    ) : null}
                  </td>

                  <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
                    {row.stored ? row.stored.source : <span className="text-subtle-foreground">{EM_DASH}</span>}
                  </td>

                  <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
                    {row.stored ? (
                      nowMs > 0 ? (
                        formatRelativeTime(row.stored.updatedAt, nowMs)
                      ) : (
                        EM_DASH
                      )
                    ) : (
                      <span className="text-subtle-foreground">never set</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
          A currency with no rate cannot be used on an entry at all — the API refuses it and
          says so, rather than guessing at a conversion. Clearing a field leaves whatever is
          already stored in place; there is no way to remove a rate from here, because
          entries recorded at it stay readable either way.
        </p>

        <IfPermitted to="finance.manage">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={changed.length === 0 || invalid}
            className="shrink-0"
          >
            {changed.length === 0
              ? "No changes"
              : `Save ${changed.length} ${pluralize(changed.length, "rate")}`}
          </Button>
        </IfPermitted>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Text a person typed -> a rate, or `null` if it cannot be read.
 *
 * Deliberately NOT `parseMoneyToMinor`. A rate is not an amount of money: it
 * has no minor units to scale by, and the thousands-separator heuristics that
 * make "1.234" read as 1234 for a two-decimal currency would be exactly wrong
 * here, where 1.234 is a perfectly ordinary rate. So this accepts one decimal
 * separator, dot or comma, and nothing else.
 */
function parseRate(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, "");
  if (!trimmed) return null;
  // One separator, either convention. Two would be a grouped figure, which a
  // rate never is.
  if ((trimmed.match(/[.,]/g)?.length ?? 0) > 1) return null;

  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  if (value < MIN_RATE || value > MAX_RATE) return null;
  return value;
}

/** The message for whichever way `parseRate` said no. */
function rateProblem(text: string): string {
  const trimmed = text.trim().replace(/\s/g, "").replace(",", ".");
  const value = Number(trimmed);

  if (!Number.isFinite(value)) return "Rates are a plain number, like 0.031 or 32.4.";
  if (value < MIN_RATE) return "That rate is too small to be a real conversion.";
  if (value > MAX_RATE) return "That rate looks like a misplaced decimal point.";
  return "Rates are a plain number, like 0.031 or 32.4.";
}

function symbolOrCode(code: string): string {
  return findCurrency(code)?.symbol ?? code;
}
