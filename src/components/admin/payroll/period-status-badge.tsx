import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { periodState } from "./payroll-format";
import type {
  PayrollPaymentStatus,
  PayrollPeriodHeaderDTO,
} from "@/server/services/payroll-service";

/**
 * Whether a period's figures are still moving.
 *
 * This is the single most important thing on either payroll screen, which is
 * why it is a component rather than a ternary repeated in five places. A draft
 * total presented with the same weight as a finalized one invites somebody to
 * pay against a number that changed an hour later.
 *
 * The colour carries meaning here rather than decoration: amber for something
 * still in motion, accent for a frozen document, green for money that has gone
 * out. The tooltip spells the same thing out in words, because colour alone is
 * not an accessible way to say "this is not final".
 */
export function PeriodStatusBadge({
  period,
  className,
}: {
  period: PayrollPeriodHeaderDTO;
  className?: string;
}) {
  const state = periodState(period);
  const variant =
    state.tone === "draft" ? "near" : state.tone === "paid" ? "hit" : "accent";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={variant}
          size="sm"
          className={className}
          // The tone is repeated as text for anyone who cannot see it, and it
          // is the tooltip that carries the consequence.
          aria-label={`${state.label}. ${state.meaning}`}
        >
          {state.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">{state.meaning}</TooltipContent>
    </Tooltip>
  );
}

/** Whether one person's line has been settled. */
export function PaymentStatusBadge({ status }: { status: PayrollPaymentStatus }) {
  return status === "paid" ? (
    <Badge variant="hit" size="sm" className="normal-case tracking-normal">
      Paid
    </Badge>
  ) : (
    <Badge variant="outline" size="sm" className="normal-case tracking-normal">
      Pending
    </Badge>
  );
}
