"use client";

import * as React from "react";
import { RotateCcw, Square, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { ChannelContentTypeRuleDTO, ChannelDTO, ContentTypeDTO } from "@/lib/dto";
import { RULE_AUTO_CLOSE_STREAK } from "@/lib/content-types/rules";
import {
  useContentTypesFromDataset,
  useSetChannelRuleWindow,
} from "@/hooks/use-content-types";
import { useOptionalSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContentTypeChip } from "@/components/content-types/content-type-chip";
import { cn } from "@/lib/utils";

/**
 * ==========================================================================
 * WHAT THIS CHANNEL MAKES, AND WHEN IT MADE IT
 * ==========================================================================
 *
 * THE VISIBLE, REVERSIBLE STATE. A rule can retire itself — three people-made
 * corrections in a row and it stops claiming new uploads — and a rule that
 * retires silently is indistinguishable from a bug. The toast catches whoever
 * was standing there when it happened; this catches everybody else, and catches
 * them where they come to ask "why has this channel stopped being tagged?".
 *
 * IT IS A TIMELINE, NOT A SET OF CHIPS, and that is the substance of what
 * replaced the old block rather than a presentation choice. What used to be here
 * was a tag picker with Save and Cancel: the channel's complete tag list, edited
 * as a whole, true of everything it had ever published and everything it ever
 * would. That control could not express the one thing that is always true of a
 * channel — that it changes — so a channel which switched format in March could
 * either go on falsely tagging every new upload or lose the label on the year
 * that genuinely was rankings. Neither is a thing anybody wants.
 *
 * SO THERE IS NO "EDIT" BUTTON HERE. Tags reach a channel from the Short that
 * prompted the thought — "Apply to this channel" in the picker — because that is
 * where somebody actually forms the opinion, and because the act needs a Short's
 * publish date to be about anything. What this block offers is the other half:
 * stopping a rule, and putting one back.
 *
 * THREE STATES, AND EACH ONE READS DIFFERENTLY ON PURPOSE:
 *
 *   • APPLYING — still claiming new uploads. The ordinary state.
 *   • RETIRED — the app stopped it, after three removals. Says so, says from
 *     when, and says why, because a person who did not do it will otherwise
 *     assume something broke.
 *   • CLOSED — somebody stopped it deliberately. The same shape, without the
 *     explanation, because there is nothing to explain.
 *
 * Every one of them re-opens or closes in a single click. That is what makes the
 * automatic path safe to have at all: it is a heuristic over three data points
 * and it will sometimes be wrong, and the answer to that is that it is announced
 * and undone in one action rather than made harder to trip.
 */
export function ChannelContentTypeRules({
  channel,
  shortsCount,
}: {
  channel: ChannelDTO;
  /**
   * Shorts on this channel, in total.
   *
   * The channel's WHOLE stored history, not the selected period — the page's
   * date filter has no bearing on what a rule applies to, and a number that slid
   * around as somebody changed the window would be describing something other
   * than the rules above it.
   */
  shortsCount: number;
}) {
  const session = useOptionalSession();
  // Assigning, not managing — see the note in content-type-control.tsx.
  const canManage = session?.can("research.write") ?? false;

  const catalogue = useContentTypesFromDataset();
  const byId = React.useMemo(
    () => new Map(catalogue.map((type) => [type.id, type])),
    [catalogue],
  );

  /*
   * Open rules first, then closed ones, each newest-first within its group.
   *
   * The order answers the question people arrive with. "What is this channel
   * tagged as right now?" is the common one and it must not require reading
   * past a year of retired rules; "when did it stop?" is the second, and it is
   * answered by the group below. Chronological within each group because a
   * channel's rules are a history and shuffling them alphabetically would make
   * the story unreadable.
   */
  const { applying, ended } = React.useMemo(() => {
    const applying: ChannelContentTypeRuleDTO[] = [];
    const ended: ChannelContentTypeRuleDTO[] = [];
    for (const rule of channel.contentTypeRules) {
      (rule.effectiveUntil === null ? applying : ended).push(rule);
    }
    applying.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    ended.sort((a, b) => (b.effectiveUntil ?? 0) - (a.effectiveUntil ?? 0));
    return { applying, ended };
  }, [channel.contentTypeRules]);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Content types</CardTitle>
          <CardDescription>
            What this channel makes, and the stretch of its output each answer
            covers.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {channel.contentTypeRules.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {canManage
              ? "Not tagged yet. Tag a Short below and choose “Apply to this channel” — the whole back catalogue and everything it publishes next inherits it."
              : "Not tagged yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {applying.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                contentType={byId.get(rule.contentTypeId)}
                channel={channel}
                canManage={canManage}
              />
            ))}
            {ended.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                contentType={byId.get(rule.contentTypeId)}
                channel={channel}
                canManage={canManage}
              />
            ))}
          </div>
        )}

        {/*
         * Shown in every state, including to a viewer who cannot edit at all.
         * Read-only it is the explanation of why a Short in the table below
         * carries a tag nobody put there — and, on a channel with a retired
         * rule, why the recent ones do not.
         */}
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          A rule tags every Short published inside its dates —{" "}
          {shortsReached(shortsCount)} to draw from. A Short can add its own on
          top, or drop one it inherits; take one off {RULE_AUTO_CLOSE_STREAK}{" "}
          uploads in a row and the rule stops applying to new ones by itself.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * One rule, in whichever of its three states it is in.
 *
 * The chip, the window, and the one button that changes it. Written as a single
 * row rather than three variants because the difference between them is a
 * sentence and a verb — building three components would be three places to
 * forget that closing and re-opening are the same request.
 */
function RuleRow({
  rule,
  contentType,
  channel,
  canManage,
}: {
  rule: ChannelContentTypeRuleDTO;
  /**
   * Absent when the catalogue has not loaded, never because the type is gone —
   * deleting a type in use is refused, and archived ones still ship.
   */
  contentType: ContentTypeDTO | undefined;
  channel: ChannelDTO;
  canManage: boolean;
}) {
  const setWindow = useSetChannelRuleWindow();
  const open = rule.effectiveUntil === null;
  const retired = !open && rule.autoClosedAt !== null;

  const name = contentType?.name ?? "This content type";

  const submit = (effectiveUntil: number | null) =>
    setWindow.mutate(
      { channelId: channel.id, ruleId: rule.id, effectiveUntil },
      {
        onSuccess: () =>
          toast.success(
            effectiveUntil === null
              ? `“${name}” applies to new uploads on ${channel.displayName} again`
              : `“${name}” stops applying to new uploads on ${channel.displayName}`,
          ),
        onError: (error) =>
          toast.error("Could not change that rule", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border px-2.5 py-2",
        open ? "border-border" : "border-dashed border-border",
      )}
    >
      {contentType ? (
        <ContentTypeChip contentType={contentType} muted={!open} size="md" />
      ) : (
        <span className="text-[12px] text-subtle-foreground">{name}</span>
      )}

      <span
        className={cn(
          "text-[11px] leading-relaxed",
          open ? "text-muted-foreground" : "text-subtle-foreground",
        )}
      >
        {open ? (
          <>Applies from {formatRuleDate(rule.effectiveFrom)} onwards</>
        ) : (
          <>
            {formatRuleDate(rule.effectiveFrom)} &ndash;{" "}
            {formatRuleDate(rule.effectiveUntil ?? 0)}
          </>
        )}
        {retired ? (
          <>
            {" · "}
            {/*
             * THE SENTENCE THAT STOPS THIS LOOKING LIKE A BUG.
             *
             * Not "closed automatically", which invites "by what?". It names the
             * evidence — three people took the tag off — so a reader can decide
             * whether they agree, which is the only thing they can usefully do
             * with the fact.
             */}
            <span className="text-warning">
              retired itself &mdash; {RULE_AUTO_CLOSE_STREAK} Shorts in a row had
              it removed
            </span>
          </>
        ) : null}
        {/*
         * A streak in progress, shown BEFORE it completes rather than only
         * after. Somebody who is one removal from retiring a rule they rely on
         * should find that out while it is still their decision.
         */}
        {open && rule.consecutiveOverrides > 0 ? (
          <>
            {" · "}
            <span className="text-warning">
              {rule.consecutiveOverrides} of {RULE_AUTO_CLOSE_STREAK} removals
              {rule.overrideStreakFrom !== null
                ? ` since ${formatRuleDate(rule.overrideStreakFrom)}`
                : null}
            </span>
          </>
        ) : null}
      </span>

      {canManage ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          loading={setWindow.isPending}
          onClick={() => submit(open ? Date.now() : null)}
          title={
            open
              ? `Stop applying ${name} to uploads from today. Everything already published keeps it.`
              : `Let ${name} apply to new uploads on this channel again`
          }
        >
          {setWindow.isPending ? null : open ? (
            <Square />
          ) : retired ? (
            <Undo2 />
          ) : (
            <RotateCcw />
          )}
          {open ? "Stop applying" : "Re-open"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * "all 412 of this channel's Shorts", and the two ways that phrasing falls over.
 *
 * A channel with one Short reads badly as "all 1", and a channel with none — a
 * freshly added one, or a long-form account — has no number worth printing at
 * all, but the sentence is still true and still worth saying: a rule will reach
 * whatever it publishes next.
 */
function shortsReached(count: number): string {
  if (count === 0) return "no Shorts stored yet";
  if (count === 1) return "one Short";
  return `${count.toLocaleString()} Shorts`;
}

/**
 * "4 March 2025" — the same phrasing as the toast and the audit log.
 *
 * UTC on all three, so a reader comparing them never finds two different days
 * because one was formatted against a browser in a different zone.
 */
function formatRuleDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
