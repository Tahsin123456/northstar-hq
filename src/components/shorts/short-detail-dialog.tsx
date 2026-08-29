"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { NicheRefDTO } from "@/lib/dto";
import { Avatar } from "@/components/ui/avatar";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NicheChips } from "@/components/niches/niche-chip";
import { ShortContentTypePanel } from "@/components/content-types/short-content-type-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { useVideoContentTypeResolutions } from "@/hooks/use-content-types";
import { EMPTY_RESOLUTION } from "@/lib/content-types/resolve";
import { youtubeShortsUrl, youtubeThumbnailUrl } from "@/lib/format";

/**
 * One Short, on its own.
 *
 * This is the app's only single-Short surface — everywhere else a Short is a row
 * in a ranked list — so it is where the brief's "surface the current content
 * type alongside its niche, and let it be changed there" has to land. It grew
 * out of the notes dialog rather than beside it: a second dialog for the same
 * Short would have made "open the notes" and "open the Short" two different
 * gestures with two different answers to what a Short is.
 *
 * THE TWO TAXONOMIES ARE BOTH LABELLED. On a table row they are two runs of
 * chips in a metadata line and the distinction is carried entirely by the dot
 * shape — round for a niche, squared for a content type. That is enough when you
 * are scanning and already know the convention; it is not enough when you have
 * stopped on one Short to decide what it is. So here they get headings, and the
 * shapes go on doing their job underneath.
 *
 * THEY ARE STACKED RATHER THAN SIDE BY SIDE, which they were until content types
 * grew an inside. A niche is one run of chips and always will be; a Short's
 * content types are up to three groups and a footnote about a tag that is not
 * there. Half a dialog is not a fair column for that, and squeezing it in would
 * have meant collapsing the very distinction the section exists to draw.
 *
 * The niche is READ-ONLY and the content type is not, which is not an oversight:
 * a niche belongs to the CHANNEL, so changing it here would silently refile every
 * other Short the channel ever published. A content type on a channel does reach
 * every Short beneath it — but this panel never edits the channel's, only what
 * THIS Short adds to them or refuses of them.
 *
 * The niche is shown as CONTEXT, not as a constraint. It used to decide which
 * content types the picker offered, back when a type belonged to a niche; that
 * is no longer true — the picker offers the organization's whole catalogue, and
 * any Short may carry any tag. What the niche still earns its place for is
 * telling the reader what they are looking at before they label it.
 */
export interface ShortDetailTarget {
  /** The internal `Video` row id — what the assignment endpoint takes. */
  readonly videoId: string;
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelAvatarUrl: string | null;
  /** The niches of the channel that published it. */
  readonly niches: readonly NicheRefDTO[];
}

export function ShortDetailDialog({
  short,
  open,
  onOpenChange,
}: {
  /** `null` keeps the dialog closed and its body unmounted. */
  short: ShortDetailTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6">Short</DialogTitle>
          <DialogDescription className="truncate">
            {short?.title ?? ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pt-0">
          {open && short ? <ShortDetailBody short={short} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ShortDetailBody({ short }: { short: ShortDetailTarget }) {
  /*
   * Read live rather than taken as a prop.
   *
   * The caller opened this dialog from a row it captured at click time. If the
   * labels came with that snapshot, the chips here would go on showing the old
   * set after the picker below wrote a new one — the control patches the
   * dataset in place, so reading the index each render is what keeps the two
   * halves of the same dialog agreeing with each other.
   */
  const contentTypeIndex = useVideoContentTypeResolutions();
  const resolution = contentTypeIndex.get(short.videoId) ?? EMPTY_RESOLUTION;

  return (
    <>
      <div className="flex items-start gap-3">
        <a
          href={youtubeShortsUrl(short.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={youtubeThumbnailUrl(short.youtubeVideoId)}
            alt=""
            width={44}
            height={60}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-[60px] w-11 rounded object-cover ring-1 ring-border"
          />
        </a>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <a
            href={youtubeShortsUrl(short.youtubeVideoId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-accent"
            title={short.title}
          >
            <span className="line-clamp-2">{short.title}</span>
            <ExternalLink className="size-3 shrink-0 opacity-50" />
          </a>

          <Link
            href={`/channels/${short.channelId}`}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar src={short.channelAvatarUrl} name={short.channelName} size={14} />
            <span className="max-w-[220px] truncate">{short.channelName}</span>
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
        <Field label="Niche">
          {/* Not editable here — see the note on this file. `limit` is high
              because the row is the full width of the dialog, and a channel in
              three niches is worth reading in full rather than as "+2". */}
          <NicheChips
            niches={short.niches}
            limit={3}
            size="sm"
            emptyLabel="Not in a niche"
          />
        </Field>

        {/* The two taxonomies are separate claims about the Short and are read
            separately; without the rule the niche chips and the inherited
            content types run together into one undifferentiated field. */}
        <div aria-hidden className="h-px bg-border" />

        <ShortContentTypePanel videoId={short.videoId} resolution={resolution} />
      </div>

      <NotesPanel
        targetType="video"
        targetId={short.videoId}
        title="Notes on this Short"
        compact
        className="border-0 bg-transparent"
      />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </span>
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  );
}
