"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Send,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/components/providers/session-provider";
import {
  useNotificationSettings,
  useSendNotificationTest,
  useSendPayrollNotification,
  useUpdateNotificationSettings,
} from "@/hooks/use-payroll";
import { ApiError } from "@/lib/api-client";
import { formatDateTime, formatRelativeTime, pluralize } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import type { PayrollNotificationStatusDTO } from "@/lib/dto";

/**
 * Telegram — where the monthly payroll summary goes, and whether it arrived.
 *
 * WHAT IS AND IS NOT IN THIS PAYLOAD
 * The bot token is reported as a boolean and nothing else. `telegram-env.ts`
 * has exactly one export that returns the value and it is called in exactly one
 * place, the fetch URL; nothing on this screen has ever seen it. The chat id IS
 * shown and editable, because an admin has to be able to correct what they
 * typed, and a chat id grants nothing on its own — posting to a chat needs the
 * token and the bot's membership of that chat.
 *
 * WHY THE LAST DELIVERY IS THE MOST IMPORTANT ROW HERE
 * The real send happens at midnight on the 1st with nobody watching. A failure
 * writes itself onto the PayrollNotification row and into the audit log, and
 * then waits to be noticed — and nobody goes looking through an audit log for a
 * message they have no reason to believe did not arrive. The brief is explicit
 * that a failed delivery must be visible; this card is where it is visible, in
 * the same place as the switches that would have caused it.
 *
 * TWO PERMISSIONS, DELIBERATELY
 * Editing the destination is `settings.manage` — an operator fixing a chat id
 * should not need to be handed everybody's salary to do it. Sending anything is
 * `payroll.manage`, because a send BROADCASTS what the team earns. Both gates
 * are enforced by the routes; the checks here only avoid showing controls that
 * would 403.
 */
export function TelegramCard({ className }: { className?: string }) {
  const session = useSession();
  const { data, isLoading, error } = useNotificationSettings();

  const maySettings = session.can("settings.manage");
  const maySend = session.can("payroll.manage");

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="size-3.5 text-subtle-foreground" />
          Telegram notifications
        </CardTitle>
        <CardDescription>
          Where the monthly payroll summary is posted on payday, and whether the
          last one arrived.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : error || !data ? (
          <p className="text-[13px] text-muted-foreground">
            {error instanceof ApiError
              ? error.message
              : "Notification settings could not be loaded."}
          </p>
        ) : (
          <>
            <ReadinessLine
              tokenConfigured={data.telegram.tokenConfigured}
              chatConfigured={data.telegram.chatConfigured}
              configured={data.telegram.configured}
              missing={data.telegram.missing}
            />

            {/* Keyed on the stored value, so the field remounts — and re-seeds
                — only when the destination genuinely changed. Without the key,
                a draft somebody is mid-way through typing would either survive
                a real external change or be wiped by an effect on every
                background refetch; with it, React's own reset-state-with-a-key
                rule does the job and no effect reaches into the input. */}
            <ChatIdField
              key={data.settings.telegramChatId ?? ""}
              chatId={data.settings.telegramChatId}
              disabled={!maySettings}
            />

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <ToggleRow
                id="telegram-enabled"
                label="Telegram is switched on"
                description="The master switch for this chat. Off means nothing is posted, including tests."
                checked={data.settings.telegramEnabled}
                disabled={!maySettings}
                field="telegramEnabled"
              />
              <ToggleRow
                id="payroll-notifications-enabled"
                label="Post the monthly payroll summary"
                description="Mutes the payday message without disconnecting Telegram."
                checked={data.settings.payrollNotificationsEnabled}
                disabled={!maySettings}
                field="payrollNotificationsEnabled"
              />
            </div>

            <LastDelivery
              last={data.lastPayrollNotification}
              maySend={maySend}
            />

            {maySend ? (
              <TestButton disabled={!data.settings.telegramEnabled} />
            ) : null}

            {!maySettings ? (
              <p className="flex items-start gap-2 text-[12px] leading-relaxed text-subtle-foreground">
                <Settings2 className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Changing where notifications go needs the settings permission.
                  You can see the state here but not edit it.
                </span>
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// READINESS
// ---------------------------------------------------------------------------

/**
 * The two halves reported separately, because they are fixed by different
 * people in different places: the token is a deployment environment variable an
 * operator sets, the chat id is data an admin types into the field below.
 * Collapsing them into one "not configured" would send somebody hunting through
 * hosting config for something they could have fixed here in ten seconds.
 */
function ReadinessLine({
  tokenConfigured,
  chatConfigured,
  configured,
  missing,
}: {
  tokenConfigured: boolean;
  chatConfigured: boolean;
  configured: boolean;
  missing: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <ReadinessPill ok={tokenConfigured} label="Bot token" />
        <ReadinessPill ok={chatConfigured} label="Destination chat" />
      </div>

      {!configured && missing.length > 0 ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Still to set: {missing.join(", ")}.
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        The bot token is never sent to the browser — only whether one exists.
      </p>
    </div>
  );
}

function ReadinessPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px]",
        ok ? "text-success" : "text-muted-foreground",
      )}
    >
      {ok ? (
        <CheckCircle2 className="size-3.5" />
      ) : (
        <AlertTriangle className="size-3.5 text-warning" />
      )}
      {label}
      <span className="text-subtle-foreground">{ok ? "set" : "not set"}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// DESTINATION
// ---------------------------------------------------------------------------

function ChatIdField({
  chatId,
  disabled,
}: {
  chatId: string | null;
  disabled: boolean;
}) {
  const update = useUpdateNotificationSettings();
  // Seeded once per mount. The caller keys this component on the stored value,
  // so a change to the destination made anywhere else remounts it with the new
  // one — see the comment at the call site.
  const [value, setValue] = React.useState(chatId ?? "");

  const trimmed = value.trim();
  const dirty = trimmed !== (chatId ?? "");

  async function onSave() {
    try {
      // An emptied field means "no destination". The server normalises "" to
      // null so the database never holds two spellings of absence.
      await update.mutateAsync({ telegramChatId: trimmed === "" ? null : trimmed });
      toast.success(
        trimmed === ""
          ? "The destination chat was cleared."
          : "The destination chat was saved.",
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That chat id could not be saved.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="telegram-chat-id">Destination chat</Label>
      <div className="flex gap-2">
        <Input
          id="telegram-chat-id"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="-1001234567890"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || update.isPending}
          className="tnum"
        />
        {dirty ? (
          <Button
            variant="primary"
            onClick={onSave}
            loading={update.isPending}
            className="shrink-0"
          >
            Save
          </Button>
        ) : null}
      </div>
      <FieldHint>
        The numeric chat id, negative for a group or supergroup, or an
        @channelusername. The bot has to be a member of the chat before it can
        post there.
      </FieldHint>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SWITCHES
// ---------------------------------------------------------------------------

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  field,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  field: "telegramEnabled" | "payrollNotificationsEnabled";
}) {
  const update = useUpdateNotificationSettings();

  async function onChange(next: boolean) {
    try {
      await update.mutateAsync({ [field]: next });
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That setting could not be saved.",
      );
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled || update.isPending}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE LAST DELIVERY
// ---------------------------------------------------------------------------

function LastDelivery({
  last,
  maySend,
}: {
  last: PayrollNotificationStatusDTO | null;
  maySend: boolean;
}) {
  const now = useNow();
  const resend = useSendPayrollNotification();

  if (!last) {
    return (
      <div className="border-t border-border pt-4">
        <SectionLabel>Last payroll summary</SectionLabel>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          No payroll summary has been sent from this workspace yet. The scheduled
          job posts one on the 1st of each month, after the previous month is
          finalized.
        </p>
      </div>
    );
  }

  // Bound to a const so the handler below closes over a value TypeScript can
  // still see as non-null; narrowing a parameter does not survive into a nested
  // function, and a `!` inside the handler would be the wrong fix.
  const entry = last;
  const failed = entry.status === "failed";
  const sent = entry.status === "sent";
  /**
   * A month that could not be announced at all — muted, or no chat id.
   *
   * Styled as a warning rather than a failure because nothing broke: the
   * workspace is configured this way. It is still called out, because the thing
   * it replaces is worse — before this state was recorded, the card showed the
   * last month that DID send, and an admin reading it concluded that this
   * month's summary had gone out.
   */
  const skipped = entry.status === "skipped";

  async function onResend() {
    try {
      const { attempt } = await resend.mutateAsync({
        year: entry.year,
        month: entry.month,
        // A failed or skipped row is re-claimable without force — the claim in
        // notification-service re-takes anything that is not "sent". `force` is
        // for re-sending something that already succeeded, which this is not.
        force: false,
      });

      if (attempt.status === "sent") {
        toast.success(`${entry.periodLabel} payroll summary sent.`);
      } else {
        toast.error(
          attempt.detail ?? "The summary still could not be delivered.",
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That summary could not be re-sent.",
      );
    }
  }

  return (
    <div className="border-t border-border pt-4">
      <SectionLabel>Last payroll summary</SectionLabel>

      <div
        className={cn(
          "mt-2 flex flex-col gap-2 rounded-lg border px-4 py-3",
          failed
            ? "border-danger/30 bg-danger-subtle"
            : skipped
              ? "border-warning/30 bg-warning-subtle"
              : "border-border bg-surface-sunken",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            {failed ? (
              <AlertTriangle className="size-4 text-danger" />
            ) : skipped ? (
              <AlertTriangle className="size-4 text-warning" />
            ) : sent ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <RefreshCw className="size-4 text-muted-foreground" />
            )}
            {entry.periodLabel}
            <span
              className={cn(
                "font-normal",
                failed ? "text-danger" : skipped ? "text-warning" : "text-muted-foreground",
              )}
            >
              {failed
                ? "was not delivered"
                : skipped
                  ? "was never announced"
                  : sent
                    ? "was delivered"
                    : "is still in flight"}
            </span>
          </span>

          {/* `sentAt` only exists on a success; a failure's only timestamp is
              when the row last moved, which is when it failed. */}
          <span className="tnum text-[11px] text-subtle-foreground">
            {now === 0
              ? formatDateTime(entry.sentAt ?? entry.updatedAt)
              : formatRelativeTime(entry.sentAt ?? entry.updatedAt, now)}
          </span>
        </div>

        {/* On a skipped row `lastError` is not an error but the setting that
            stopped the send — "Payroll notifications are muted", "No Telegram
            chat id is configured" — which is the sentence that tells an admin
            which switch above to change. */}
        {(failed || skipped) && entry.lastError ? (
          <p
            className={cn(
              "text-[12px] leading-relaxed",
              failed ? "text-danger" : "text-warning",
            )}
          >
            {entry.lastError}
          </p>
        ) : null}

        {entry.attempts > 1 ? (
          <p className="text-[11px] text-subtle-foreground">
            {entry.attempts} {pluralize(entry.attempts, "attempt")}.
          </p>
        ) : null}

        {/* Offered on a skipped row too, and not only on a failed one: once the
            switch above is back on, this button is the only way a month that
            was never announced can still be sent. "again" would be a lie for
            one of those, hence the two wordings. */}
        {(failed || skipped) && maySend ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={onResend}
              loading={resend.isPending}
            >
              <RefreshCw />
              {failed
                ? `Send ${entry.periodLabel} again`
                : `Send ${entry.periodLabel} now`}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE TEST
// ---------------------------------------------------------------------------

/**
 * Proves the wiring without broadcasting anybody's pay.
 *
 * The test message contains no payroll figures at all, which is what makes it
 * safe to press on a Tuesday afternoon in front of the whole team's chat. It
 * also deliberately does not touch the PayrollNotification row — a test is not
 * a payroll notification, and letting one occupy a period's row would either
 * block the real send or make the record claim a summary went out when none
 * did.
 */
function TestButton({ disabled }: { disabled: boolean }) {
  const test = useSendNotificationTest();

  async function onTest() {
    try {
      const { attempt } = await test.mutateAsync();

      if (attempt.status === "sent") {
        toast.success("Test message delivered.", {
          description: "Check the chat — the bot posted just now.",
        });
      } else {
        toast.error(
          attempt.detail ?? "The test message could not be delivered.",
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "The test message could not be sent.",
      );
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button
        variant="secondary"
        size="sm"
        onClick={onTest}
        loading={test.isPending}
        disabled={disabled}
      >
        <Send />
        Send test message
      </Button>
      <span className="text-[12px] text-muted-foreground">
        {disabled
          ? "Switch Telegram on first."
          : "Contains no payroll figures — safe to press any time."}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
      {children}
    </h4>
  );
}
