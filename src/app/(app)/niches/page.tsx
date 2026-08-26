"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  StickyNote,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ErrorState } from "@/components/common/error-state";
import { Avatar } from "@/components/ui/avatar";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { nicheColor } from "@/components/niches/niche-chip";
import { NotesPanel } from "@/components/notes/notes-panel";
import { useChannelRows, type ChannelRow } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import {
  useCreateNiche,
  useDeleteNiche,
  useRenameNiche,
  useUpdateNicheThreshold,
} from "@/hooks/use-niches";
import { useFilters } from "@/components/providers/filters-provider";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics";
import type { NicheDTO } from "@/lib/dto";
import { EM_DASH, formatCompactNumber, formatNumber, formatPercent } from "@/lib/format";
import { THRESHOLD_PRESETS } from "@/lib/analytics/constants";
import { cn } from "@/lib/utils";

/**
 * Niches — organisation with just enough analytics to be worth visiting.
 *
 * Deliberately *not* a second dashboard. Each card answers "is this niche worth
 * my attention?" in four numbers and then hands off to the real dashboard,
 * filtered. Rebuilding charts and tables per niche would duplicate the product
 * and give two places where the same number could disagree.
 */
export default function NichesPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { threshold } = useFilters();
  const [createOpen, setCreateOpen] = React.useState(false);

  const rows = useChannelRows(data);
  const niches = data?.niches ?? [];

  const unassigned = React.useMemo(
    () => rows.filter((row) => row.channel.niches.length === 0),
    [rows],
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Niches"
        // Each card is scored at its own configured threshold, so naming a
        // single figure here would contradict the numbers directly below it.
        description={`How each niche is performing, each scored at its own hit threshold (${formatCompactNumber(threshold)} where none is set). Click one to open the dashboard filtered to it.`}
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            New niche
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PeriodSelector />
            <ThresholdSelector />
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-44 w-full rounded-lg" />
              ))}
            </div>
          ) : niches.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Layers />}
                title="No niches yet"
                description="Group your tracked channels by topic — GTA, Minecraft, Finance, Fitness, whatever matches how you actually work. Nothing is preset; you define them."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    <Plus />
                    Create your first niche
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {niches.map((niche) => (
                <NicheCard
                  key={niche.id}
                  niche={niche}
                  rows={rows}
                  accountThreshold={threshold}
                />
              ))}
            </div>
          )}

          {unassigned.length > 0 ? (
            <UncategorisedCard rows={unassigned} />
          ) : null}
        </>
      )}

      <CreateNicheDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageContainer>
  );
}

function NicheCard({
  niche,
  rows,
  accountThreshold,
}: {
  niche: NicheDTO;
  rows: readonly ChannelRow[];
  accountThreshold: number;
}) {
  const { range } = useFilters();
  // This niche's own definition of a hit, falling back to the account default.
  const effectiveThreshold = niche.hitThreshold ?? accountThreshold;
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [thresholdOpen, setThresholdOpen] = React.useState(false);

  const members = React.useMemo(
    () => rows.filter((row) => row.channel.niches.some((n) => n.id === niche.id)),
    [rows, niche.id],
  );

  // Recomputed at this niche's threshold rather than reusing row.metrics,
  // which was calculated at whatever the page-level threshold happens to be.
  const summary = React.useMemo(
    () =>
      calculatePortfolioSummary(
        members.map((row) => ({
          id: row.channel.id,
          name: row.channel.displayName,
          metrics: calculateChannelMetrics({
            videos: row.videos,
            range,
            threshold: effectiveThreshold,
          }),
        })),
      ),
    [members, range, effectiveThreshold],
  );

  const best = summary.topChannel;

  return (
    <>
      <Card className="group relative flex flex-col p-4 transition-colors duration-150 hover:border-border-strong">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: nicheColor(niche.colorIndex) }}
            />
            <Link
              href={`/?niche=${encodeURIComponent(niche.id)}`}
              className="truncate text-[14px] font-medium text-foreground transition-colors hover:text-accent"
            >
              {niche.name}
              <span className="absolute inset-0" aria-hidden />
            </Link>
          </div>

          <div className="relative z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${niche.name}`}
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setThresholdOpen(true)}>
                  <Target />
                  Hit threshold
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNotesOpen(true)}>
                  <StickyNote />
                  Niche notes
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete niche
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
          <MiniStat label="Channels" value={formatNumber(members.length)} />
          <MiniStat label="Shorts" value={formatNumber(summary.totalShorts)} />
          <MiniStat
            label={`Hit rate ≥${formatCompactNumber(effectiveThreshold)}`}
            value={formatPercent(summary.averageHitRate)}
          />
        </div>

        <div className="mt-3 flex min-h-[32px] items-center justify-between gap-2 border-t border-border pt-3">
          {best ? (
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground">
                Top channel
              </div>
              <div className="truncate text-[12px] text-foreground">
                {best.name}{" "}
                <span className="tnum text-subtle-foreground">
                  {formatPercent(best.hitRate)}
                </span>
              </div>
            </div>
          ) : (
            <span className="text-[12px] text-subtle-foreground">
              {members.length === 0
                ? "No channels assigned yet"
                : "No Shorts in this period"}
            </span>
          )}

          <ArrowRight className="size-3.5 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </Card>

      <NicheThresholdDialog
        niche={niche}
        open={thresholdOpen}
        onOpenChange={setThresholdOpen}
      />
      <NicheNotesDialog niche={niche} open={notesOpen} onOpenChange={setNotesOpen} />
      <RenameNicheDialog niche={niche} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteNicheDialog
        niche={niche}
        channelCount={members.length}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

/**
 * Channels with no niche.
 *
 * Surfaced rather than hidden: unfiled channels are invisible to every niche
 * filter, so a user who never sees this list would never know their taxonomy
 * has gaps.
 */
function UncategorisedCard({ rows }: { rows: readonly ChannelRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-[13px] font-medium text-foreground">Uncategorised</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {rows.length} tracked {rows.length === 1 ? "channel is" : "channels are"} not in
          any niche. Assign one from the channel menu, or open the channel and use its
          niche control.
        </p>
      </div>

      <Card className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.channel.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar src={row.channel.avatarUrl} name={row.channel.displayName} size={26} />
            <Link
              href={`/channels/${row.channel.id}`}
              className="min-w-0 flex-1 truncate text-[13px] text-foreground transition-colors hover:text-accent"
            >
              {row.channel.displayName}
            </Link>
            <span className="tnum shrink-0 text-[12px] text-muted-foreground">
              {row.metrics.hitRate === null ? EM_DASH : formatPercent(row.metrics.hitRate)}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </span>
      <span className="tnum truncate text-[15px] font-medium text-foreground">{value}</span>
    </div>
  );
}

function CreateNicheDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <CreateNicheForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateNicheForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [name, setName] = React.useState("");
  const create = useCreateNiche();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: ({ niche }) => {
        toast.success(`Niche “${niche.name}” created`);
        onOpenChange(false);
      },
      onError: (error) =>
        toast.error("Could not create that niche", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New niche</DialogTitle>
        <DialogDescription>
          A niche is just a label you define — use whatever matches how you organise
          your research.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="niche-name">Name</Label>
        <Input
          id="niche-name"
          autoFocus
          value={name}
          maxLength={48}
          placeholder="e.g. GTA"
          onChange={(event) => setName(event.target.value)}
        />
        <FieldHint>Names are case-insensitive, so “GTA” and “gta” are the same niche.</FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          Create niche
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameNicheDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <RenameNicheForm niche={niche} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameNicheForm({
  niche,
  onOpenChange,
}: {
  niche: NicheDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState(niche.name);
  const rename = useRenameNiche();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    rename.mutate(
      { id: niche.id, name: trimmed },
      {
        onSuccess: () => {
          toast.success("Niche renamed");
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not rename that niche", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Rename niche</DialogTitle>
        <DialogDescription>
          Every channel filed under it keeps its assignment.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="rename-niche">Name</Label>
        <Input
          id="rename-niche"
          autoFocus
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
        />
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending} disabled={!name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteNicheDialog({
  niche,
  channelCount,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  channelCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteNiche();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{niche.name}”?</DialogTitle>
          <DialogDescription>This removes the label, nothing else.</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {channelCount === 0
              ? "No channels are filed under this niche."
              : `${channelCount} ${channelCount === 1 ? "channel" : "channels"} will become uncategorised.`}{" "}
            No channel is removed from your tracker and no Shorts, view counts or history
            are affected — a niche is only a label.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(niche.id, {
                onSuccess: ({ unassignedChannels }) => {
                  toast.success(`Niche “${niche.name}” deleted`, {
                    description:
                      unassignedChannels > 0
                        ? `${unassignedChannels} ${unassignedChannels === 1 ? "channel is" : "channels are"} now uncategorised.`
                        : undefined,
                  });
                  onOpenChange(false);
                },
                onError: (error) =>
                  toast.error("Could not delete that niche", {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              })
            }
          >
            Delete niche
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NicheNotesDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6">{niche.name} notes</DialogTitle>
          <DialogDescription>
            Context about this niche as a whole — what is driving performance, what
            formats are working.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="pt-0">
          {open ? (
            <NotesPanel
              targetType="niche"
              targetId={niche.id}
              title="Niche notes"
              compact
              className="border-0 bg-transparent"
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-niche hit threshold.
 *
 * A hit is not one number across a whole portfolio: 1M is a reasonable bar for
 * a large gaming niche and an impossible one for a niche science channel.
 * Configuring it here means every analytic for that niche — hit rate, charts,
 * Winners, Our vs Market, the PDF — switches definition automatically when the
 * niche is selected, with no manual step.
 */
function NicheThresholdDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <NicheThresholdForm niche={niche} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NicheThresholdForm({
  niche,
  onOpenChange,
}: {
  niche: NicheDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = React.useState(
    niche.hitThreshold === null ? "" : String(niche.hitThreshold),
  );
  const [error, setError] = React.useState<string | null>(null);
  const save = useUpdateNicheThreshold();

  const commit = (hitThreshold: number | null) => {
    save.mutate(
      { id: niche.id, hitThreshold },
      {
        onSuccess: () => {
          toast.success(
            hitThreshold === null
              ? `${niche.name} now follows the account default`
              : `${niche.name} hit threshold set to ${formatCompactNumber(hitThreshold)}`,
          );
          onOpenChange(false);
        },
        onError: (e) =>
          toast.error("Could not save that threshold", {
            description: e instanceof Error ? e.message : undefined,
          }),
      },
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // An empty field clears the override rather than erroring — that is the
        // natural way to say "just use the account default".
        const cleaned = value.replace(/[,\s_]/g, "");
        if (!cleaned) {
          commit(null);
          return;
        }
        const parsed = Number(cleaned);
        if (!Number.isFinite(parsed) || parsed < 1) {
          setError("Enter a positive number, or leave it empty to use the account default.");
          return;
        }
        commit(Math.trunc(parsed));
      }}
    >
      <DialogHeader>
        <DialogTitle>{niche.name} hit threshold</DialogTitle>
        <DialogDescription>
          What counts as a hit in this niche. Selecting {niche.name} anywhere in the app
          uses this number automatically.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="niche-threshold">Views required</Label>
          <Input
            id="niche-threshold"
            autoFocus
            inputMode="numeric"
            placeholder="e.g. 750000"
            value={value}
            invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
          {error ? (
            <FieldHint tone="danger">{error}</FieldHint>
          ) : (
            <FieldHint>Leave empty to follow the account default set in Settings.</FieldHint>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {THRESHOLD_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setValue(String(preset));
                setError(null);
              }}
              className={cn(
                "tnum rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
                Number(value) === preset
                  ? "border-accent bg-accent-subtle text-foreground"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              ≥ {formatCompactNumber(preset)}
            </button>
          ))}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save threshold
        </Button>
      </DialogFooter>
    </form>
  );
}
